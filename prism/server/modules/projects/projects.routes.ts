import express from 'express';

import { projectsDb, resolveVisibleProjectRoot, userDb } from '@/modules/database/index.js';
import { createProject, updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { broadcastProjectChange, prepareProjectChangeBroadcast } from '@/modules/websocket/index.js';
import { listProjectTemplates } from '@/modules/projects/services/project-template.service.js';
import { AppError, asyncHandler, createApiSuccessResponse, validateWorkspacePath } from '@/shared/utils.js';
import { readRequestViewer } from '@/shared/project-visibility.js';
import { clientIp } from '@/shared/client-ip.js';
import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { applyLegacyStarredProjectIds, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';
import {
  BULK_PROJECT_LIMIT, bulkProjectAction, type BulkProjectAction,
} from '@/modules/projects/services/project-bulk.service.js';
import {
  applyProjectPermissions,
  canArchiveProject as canActorArchiveProject,
  canManageProject as canActorManageProject, parsePermissionsInput,
  canRestoreProject as canActorRestoreProject,
  readProjectPermissionsView, transferProjectOwner,
} from '@/modules/projects/services/project-permissions.service.js';

const router = express.Router();

type AuthenticatedUser = {
  id?: number;
  username?: string;
  isRoot?: boolean;
};

const readUser = (req: express.Request): AuthenticatedUser | undefined =>
  (req as express.Request & { user?: AuthenticatedUser }).user;

/**
 * Which owner scope this caller's list should use.
 *
 * `null` means "no filter" and is returned for root — and also when there is no
 * user on the request at all, which is the platform-mode path. Erring towards
 * the unfiltered list there is deliberate: platform deployments authenticate
 * upstream and have always shown every project.
 */
/**
 * 归属校验:这个调用者能不能操作这个项目。看不见就回 404 并返回 false。
 *
 * 之前 `/:projectId` 那组增删改查(rename / star / restore / delete / sessions)
 * 只按 id 找路径就动手,不问归属 —— 拿到别人的 projectId 就能删库删转录。
 * 这道门和文件模块用同一个 path-aware 判定(无主项目只有在公共目录下才对非 root
 * 可见)。回 404 而非 403:与"不存在"同形,不泄露 id 有效性。
 */
const assertVisibleProject = (req: express.Request, res: express.Response, projectId: string): boolean => {
  if (resolveVisibleProjectRoot(readRequestViewer(req), projectId)) {
    return true;
  }
  res.status(404).json({ error: 'Project not found' });
  return false;
};

const visibilityScopeFor = (req: express.Request): number | null => {
  const user = readUser(req);
  if (!user || user.isRoot || typeof user.id !== 'number') {
    return null;
  }
  return user.id;
};

function readQueryStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return '';
}

function readOptionalNumericQueryValue(value: unknown): number | null {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function parseNonNegativeIntQuery(value: unknown, name: string, fallback: number): number {
  const rawValue = readQueryStringValue(value).trim();
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    throw new AppError(`${name} must be a non-negative integer`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsedValue;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const skipSynchronization =
      readQueryStringValue(req.query.skipSynchronization).trim() === '1' ||
      readQueryStringValue(req.query.skipSync).trim() === '1';
    const sessionsLimit = readOptionalNumericQueryValue(req.query.sessionsLimit) ?? undefined;
    const sessionsOffset = readOptionalNumericQueryValue(req.query.sessionsOffset) ?? undefined;
    const projects = await getProjectsWithSessions({
      skipSynchronization,
      sessionsLimit,
      sessionsOffset,
      visibleTo: visibilityScopeFor(req),
      // 收藏按"我是谁"算,与可见范围无关 —— root 的 visibleTo 是 null(不过滤),
      // 但 root 的收藏只能看 root 自己那份。
      starsFor: readUser(req)?.id ?? null,
    });
    res.json(projects);
  }),
);

router.get(
  '/archived',
  asyncHandler(async (req, res) => {
    const projects = await getArchivedProjectsWithSessions({
      visibleTo: visibilityScopeFor(req),
      starsFor: readUser(req)?.id ?? null,
    });
    res.json(createApiSuccessResponse({ projects }));
  }),
);

/**
 * 「指定用户」授权选择器的用户名录:id + username,只含 active 且已批准的账号。
 * 挂在 /api/projects 下走统一登录鉴权;不含任何敏感字段。放在 /:projectId 组
 * 之前注册,免得 "shareable-users" 被当成一个 projectId 吞掉。
 */
/**
 * 可用的项目模板。
 *
 * 不做权限区分:模板是服务器上的公共脚手架(运维放进 `PRISM_PROJECT_TEMPLATES_DIR`),
 * 谁都能用、内容里也不该有秘密。真正的门在复制那一侧:符号链接一律拒、已有文件不覆盖、
 * 文件数与总字节封顶,见 project-template.service.ts 顶部那段。
 *
 * 和 `/archived`、`/shareable-users` 一样是单段字面量路由,必须注册在 `/:projectId` 那一族
 * 前面,否则一条裸的 `router.get('/:projectId')` 就会把它悄悄吃掉,报的还是 404 而不是冲突。
 */
router.get(
  '/templates',
  asyncHandler(async (_req: express.Request, res: express.Response) => {
    res.json(createApiSuccessResponse({ templates: await listProjectTemplates() }));
  }),
);

router.get(
  '/shareable-users',
  asyncHandler(async (req, res) => {
    const callerId = readUser(req)?.id ?? null;
    const users = userDb.listBasicUsers().filter((entry) => entry.id !== callerId);
    res.json(createApiSuccessResponse({ users }));
  }),
);

// ----------------- 项目权限管理(改存量项目) -----------------

/**
 * 只有 root 或 owner 能改权限 —— 共享接收方「可见不可管」,公共项目的路人同理。
 * (可见性由 assertVisibleProject 先挡:看不见的人拿到 404,看得见但非管理者 403。)
 *
 * 实现在 project-permissions.service 里 —— 批量权限设置走同一份,不许分叉。
 */
const canManageProject = (req: express.Request, projectId: string): boolean =>
  canActorManageProject(projectId, readUser(req));

router.get(
  '/:projectId/permissions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    if (!assertVisibleProject(req, res, projectId)) return;
    if (!canManageProject(req, projectId)) {
      throw new AppError('只有项目所有者或 root 可以管理权限', {
        code: 'PROJECT_PERMISSIONS_FORBIDDEN',
        statusCode: 403,
      });
    }
    res.json(createApiSuccessResponse(readProjectPermissionsView(projectId)));
  }),
);

router.put(
  '/:projectId/permissions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    if (!assertVisibleProject(req, res, projectId)) return;
    if (!canManageProject(req, projectId)) {
      throw new AppError('只有项目所有者或 root 可以管理权限', {
        code: 'PROJECT_PERMISSIONS_FORBIDDEN',
        statusCode: 403,
      });
    }

    const input = parsePermissionsInput((req.body ?? {}) as Record<string, unknown>);
    // 改权限前先收"现在谁看得见"的名单:改完之后被收回可见性的人要收到 removed。
    const announce = prepareProjectChangeBroadcast(projectId);
    const view = applyProjectPermissions(projectId, input, readUser(req)?.id ?? null);
    announce('permissions');
    res.json(createApiSuccessResponse(view));
  }),
);

/**
 * 项目的批量操作(归档 / 彻底删 / 收藏 / 取消收藏 / 权限 / 改所有者)。
 *
 * 注册在 `/:projectId` 那一组之前,否则 `bulk` 会被当成一个 projectId 吞掉。
 *
 * 鉴权全在服务层逐条做,这里只负责把入参问清楚:action 认不认、id 数量合不合规、
 * 权限入参是否成立。在动第一个项目之前报错,而不是改了三个之后才抛。
 */
router.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : '';
    const known: BulkProjectAction[] = ['archive', 'delete', 'star', 'unstar', 'permissions', 'owner'];
    if (!known.includes(action as BulkProjectAction)) {
      throw new AppError(`action must be one of ${known.join(' | ')}`, {
        code: 'INVALID_BULK_ACTION',
        statusCode: 400,
      });
    }

    const projectIds = Array.isArray(body.projectIds)
      ? body.projectIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    if (projectIds.length === 0 || projectIds.length > BULK_PROJECT_LIMIT) {
      throw new AppError(`projectIds must contain 1 to ${BULK_PROJECT_LIMIT} ids`, {
        code: 'INVALID_BULK_IDS',
        statusCode: 400,
      });
    }

    const result = await bulkProjectAction(
      {
        action: action as BulkProjectAction,
        projectIds,
        permissions: action === 'permissions' ? parsePermissionsInput(body) : undefined,
        ownerUserId: action === 'owner'
          ? (body.ownerUserId === null ? null : Number(body.ownerUserId))
          : undefined,
      },
      readRequestViewer(req),
      readUser(req) ?? {},
    );
    res.json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/:projectId/sessions',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    if (!assertVisibleProject(req, res, projectId)) return;
    const limit = parseNonNegativeIntQuery(req.query.limit, 'limit', 20);
    const offset = parseNonNegativeIntQuery(req.query.offset, 'offset', 0);
    const sessionsPage = await getProjectSessionsPage(projectId, { limit, offset });
    res.json(sessionsPage);
  }),
);

router.post(
  '/create-project',
  asyncHandler(async (req, res) => {
    const requestBody = req.body as Record<string, unknown>;
    const projectPath = typeof requestBody.path === 'string' ? requestBody.path : '';
    const customName = typeof requestBody.customName === 'string' ? requestBody.customName : null;

    if (requestBody.workspaceType !== undefined) {
      throw new AppError('workspaceType is no longer supported. Use the single create-project flow.', {
        code: 'LEGACY_WORKSPACE_TYPE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    if (requestBody.githubUrl || requestBody.githubTokenId || requestBody.newGithubToken) {
      throw new AppError('Repository cloning is no longer supported', {
        code: 'CLONE_NOT_SUPPORTED',
        statusCode: 400,
        details: 'Create the project from a directory that already exists on the server.',
      });
    }

    // 防反归档越权:传别人的已归档路径,createProject 会把它复活(isArchived=0)并回传对方的
    // 真实 projectId,既改了别人的状态,又成了文件 IDOR 拿 id 的桥。已存在的行若对当前用户
    // 不可见,直接拒;不存在的路径正常走新建。
    //
    // 原始路径与 realpath 两种形态都要查:createProject 按 realpath 落库,只查原始路径的话,
    // 一个指向别人已归档项目的软链就能绕过可见性判定,把别人的项目复活。
    const pathValidation = await validateWorkspacePath(projectPath);
    const candidatePaths = [...new Set([projectPath, pathValidation.resolvedPath].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ))];
    const existing = candidatePaths.map((candidate) => projectsDb.getProjectPath(candidate)).find(Boolean) ?? null;
    if (existing && !resolveVisibleProjectRoot(readRequestViewer(req), existing.project_id)) {
      throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    }
    // 命中的是一个已归档项目:这一步实质是"还原",按还原的门走(owner / root),
    // 看得见但不是负责人的协作者不能借"新建"把别人归档的项目拉回来。
    if (existing && Boolean(existing.isArchived) && !canActorRestoreProject(existing.project_id, readUser(req))) {
      throw new AppError('这个路径对应一个已归档的项目,只有它的负责人或管理员可以还原。', {
        code: 'PROJECT_RESTORE_FORBIDDEN',
        statusCode: 403,
      });
    }

    // 权限三选:personal(默认,仅自己)/ public(所有登录用户)/ shared(指定用户)。
    const rawVisibility = typeof requestBody.visibility === 'string' ? requestBody.visibility : 'personal';
    if (!['personal', 'public', 'shared'].includes(rawVisibility)) {
      throw new AppError('visibility must be one of personal | public | shared', {
        code: 'INVALID_PROJECT_VISIBILITY',
        statusCode: 400,
      });
    }

    const callerId = readUser(req)?.id ?? null;
    let sharedUserIds: number[] = [];
    if (rawVisibility === 'shared') {
      const rawIds = Array.isArray(requestBody.sharedUserIds) ? requestBody.sharedUserIds : [];
      const parsedIds = [...new Set(
        rawIds
          .map((value) => (typeof value === 'number' ? value : Number.parseInt(String(value), 10)))
          .filter((value) => Number.isInteger(value) && value > 0),
      )].filter((id) => id !== callerId); // 创建者本来就是 owner,不必授权给自己
      if (parsedIds.length === 0) {
        throw new AppError('选择「指定用户」时至少要选一位用户', {
          code: 'SHARED_USERS_REQUIRED',
          statusCode: 400,
        });
      }
      // 只接受真实存在的账号 —— 防拼错/防拿接口塞垃圾行。
      const knownIds = new Set(userDb.listBasicUsers().map((entry) => entry.id));
      const unknown = parsedIds.filter((id) => !knownIds.has(id));
      if (unknown.length > 0) {
        throw new AppError(`未知用户 id: ${unknown.join(', ')}`, {
          code: 'UNKNOWN_SHARED_USER',
          statusCode: 400,
        });
      }
      sharedUserIds = parsedIds;
    }

    // 从模板创建。只取字符串,合法性交给 resolveTemplateDir(形状收死,不做
    // resolve-then-prefix-check 那种每次都要重新论证的写法)。
    const templateId = typeof requestBody.templateId === 'string' && requestBody.templateId.trim()
      ? requestBody.templateId.trim()
      : null;

    const projectCreationResult = await createProject({
      projectPath,
      customName,
      ownerUserId: callerId,
      visibility: rawVisibility === 'public' ? 'public' : null,
      sharedUserIds,
      templateId,
    });

    const revived = projectCreationResult.outcome === 'reactivated_archived';
    /*
     * 只有请求体显式带了 visibility 才改复活项目的权限。缺省时的 `personal` 是新建项目的默认值,
     * 拿它覆盖一个归档前是「指定用户」的项目,等于静默收回所有人的访问。向导只在用户动过权限
     * 选择器时才发这个字段(见 ProjectCreationWizard 的 permissionTouched);也不能改成"等于默认值
     * 就不应用",那样用户有意改回「个人」就永远不生效。
     */
    const explicitVisibility = typeof requestBody.visibility === 'string';
    if (revived && explicitVisibility) {
      /*
       * 复活归档路径时,createProjectPath 的 ON CONFLICT 分支按设计不改归属与权限,所以用户在
       * 向导里选的可见性 / 共享要在这里另行应用,否则会被静默丢掉。用「项目权限」同一份实现
       * (无主项目会被认领给操作者,有主项目不夺归属);上面那道门保证走到这里的人本来就能管这个项目。
       */
      applyProjectPermissions(
        projectCreationResult.project.projectId,
        { visibility: rawVisibility as 'personal' | 'public' | 'shared', sharedUserIds },
        callerId,
      );
    }
    // 新建 / 复活都推给能看见的人。
    broadcastProjectChange(projectCreationResult.project.projectId, revived ? 'revived' : 'created');

    res.json({
      success: true,
      project: projectCreationResult.project,
      revived,
      ...(projectCreationResult.template ? { template: projectCreationResult.template } : {}),
      message: revived
        ? 'Archived project path reused successfully'
        : 'Project created successfully',
    });
  }),
);

/**
 * One-time (or idempotent) migration: apply legacy `localStorage` starred projectIds to the DB, then clear client storage.
 */
router.post(
  '/migrate-legacy-stars',
  asyncHandler(async (req, res) => {
    const projectIds = Array.isArray((req.body as { projectIds?: unknown })?.projectIds)
      ? ((req.body as { projectIds: unknown[] }).projectIds as unknown[]).map((x) => String(x))
      : [];
    const { updated } = applyLegacyStarredProjectIds(projectIds, readUser(req)?.id ?? null);
    res.json({ success: true, updated });
  }),
);

/**
 * Reassign a project, or make it public with `{ "ownerUserId": null }`.
 *
 * Root only. Ownership is what the sidebar filters on, so letting a
 * non-owner rewrite it would make the filter meaningless.
 */
router.patch(
  '/:projectId/owner',
  asyncHandler(async (req, res) => {
    const actor = readUser(req);
    if (!actor?.isRoot) {
      throw new AppError('Administrator access required', {
        code: 'ROOT_REQUIRED',
        statusCode: 403,
      });
    }

    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    const rawOwner = (req.body as { ownerUserId?: unknown })?.ownerUserId;

    let ownerUserId: number | null;
    if (rawOwner === null) {
      ownerUserId = null;
    } else if (typeof rawOwner === 'number' && Number.isInteger(rawOwner) && rawOwner > 0) {
      if (!userDb.getUserById(rawOwner)) {
        throw new AppError('Target user does not exist', {
          code: 'OWNER_NOT_FOUND',
          statusCode: 400,
        });
      }
      ownerUserId = rawOwner;
    } else {
      throw new AppError('ownerUserId must be a positive integer or null', {
        code: 'INVALID_OWNER',
        statusCode: 400,
      });
    }

    // 名单在转移之前收;原 owner 自动授权、审计带 targetUserId 都在 transferProjectOwner 里。
    const announce = prepareProjectChangeBroadcast(projectId);
    const transfer = transferProjectOwner(projectId, ownerUserId, {
      id: actor.id ?? null,
      username: actor.username ?? null,
      isRoot: true,
      ip: clientIp(req) ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    if (!transfer) {
      throw new AppError(`Project "${projectId}" was not found.`, {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }
    announce('owner');

    res.json({ success: true, projectId, ownerUserId, previousOwnerGranted: transfer.grantedPreviousOwner });
  }),
);

/**
 * 改显示名与改权限 / 归档同门:只有 owner / root。`custom_project_name` 是全局的一列,
 * 一个人改了名,所有人的侧栏一起变,所以光"看得见"不够。
 * 用 asyncHandler:入参不合法(类型 / 超长)由 AppError 回 400,而不是一律 500。
 */
router.put(
  '/:projectId/rename',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    if (!assertVisibleProject(req, res, projectId)) return;
    if (!canManageProject(req, projectId)) {
      throw new AppError('只有项目负责人或管理员可以修改项目名称', {
        code: 'PROJECT_RENAME_FORBIDDEN',
        statusCode: 403,
      });
    }
    const { displayName } = req.body as { displayName?: unknown };
    updateProjectDisplayName(projectId, displayName);
    broadcastProjectChange(projectId, 'renamed');
    res.json({ success: true });
  }),
);

router.post(
  '/:projectId/toggle-star',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    if (!assertVisibleProject(req, res, projectId)) return;
    const { isStarred } = toggleProjectStar(projectId, readUser(req)?.id ?? null);
    res.json({ success: true, isStarred });
  }),
);

router.post(
  '/:projectId/restore',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    if (!assertVisibleProject(req, res, projectId)) return;
    // 还原与归档对称:只有 owner / root。
    if (!canActorRestoreProject(projectId, readUser(req))) {
      throw new AppError('只有项目负责人或管理员可以还原这个项目。', {
        code: 'PROJECT_RESTORE_FORBIDDEN',
        statusCode: 403,
      });
    }
    restoreArchivedProject(projectId);
    broadcastProjectChange(projectId, 'restored');
    res.json(createApiSuccessResponse({ projectId, isArchived: false }));
  }),
);

/**
 * - `force` not set / false: archive project in DB only (`isArchived` = 1; hidden from active list).
 * - `force=true`: remove DB row, delete session rows for that path, remove all `*.jsonl` under the Claude project dir.
 */
router.delete(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    if (!assertVisibleProject(req, res, projectId)) return;
    const force = req.query.force === 'true';
    const user = readUser(req);
    /*
      永久删除与归档都只给 owner / root:归档一个项目,它会从所有人的活跃侧栏里消失。
      无主(公共目录)项目只给 root,见 canDeleteProject。
    */
    if (!canActorArchiveProject(projectId, user)) {
      throw new AppError(
        force
          ? '只有项目负责人或管理员可以永久删除这个项目;你可以把它归档。'
          : '只有项目负责人或管理员可以归档这个项目。',
        {
          code: force ? 'PROJECT_DELETE_FORBIDDEN' : 'PROJECT_ARCHIVE_FORBIDDEN',
          statusCode: 403,
        },
      );
    }
    // 名单要在行动之前收(删掉之后判不出谁看得见)。
    const announce = prepareProjectChangeBroadcast(projectId);
    await deleteOrArchiveProject(projectId, force, {
      userId: user?.id ?? null,
      username: user?.username ?? null,
      ip: clientIp(req) ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });
    announce(force ? 'deleted' : 'archived');
    res.json({ success: true });
  }),
);

export default router;
