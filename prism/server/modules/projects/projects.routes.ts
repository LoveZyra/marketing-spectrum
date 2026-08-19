import express from 'express';

import { auditLogDb, projectsDb, resolveVisibleProjectRoot, userDb } from '@/modules/database/index.js';
import { createProject, updateProjectDisplayName } from '@/modules/projects/services/project-management.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { readRequestViewer } from '@/shared/project-visibility.js';
import { getArchivedProjectsWithSessions, getProjectSessionsPage, getProjectsWithSessions } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
import { deleteOrArchiveProject, restoreArchivedProject } from '@/modules/projects/services/project-delete.service.js';
import { applyLegacyStarredProjectIds, toggleProjectStar } from '@/modules/projects/services/project-star.service.js';

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
router.get(
  '/shareable-users',
  asyncHandler(async (req, res) => {
    const callerId = readUser(req)?.id ?? null;
    const users = userDb.listBasicUsers().filter((entry) => entry.id !== callerId);
    res.json(createApiSuccessResponse({ users }));
  }),
);

// ----------------- 项目权限管理(改存量项目) -----------------

/** 当前权限档位(与创建向导同一三选)+ 授权名单。 */
const readProjectPermissionsView = (projectId: string) => {
  const row = projectsDb.getProjectById(projectId);
  if (!row) return null;
  const sharedUserIds = projectsDb.getProjectSharedUserIds(projectId);
  return {
    visibility: row.visibility === 'public'
      ? ('public' as const)
      : sharedUserIds.length > 0
        ? ('shared' as const)
        : ('personal' as const),
    sharedUserIds,
  };
};

/**
 * 只有 root 或 owner 能改权限 —— 共享接收方"可见不可管",公共项目的路人同理。
 * (可见性由 assertVisibleProject 先挡:看不见的人拿到 404,看得见但非管理者 403。)
 */
const canManageProject = (req: express.Request, projectId: string): boolean => {
  const user = readUser(req);
  if (user?.isRoot === true) return true;
  const owner = projectsDb.getProjectOwner(projectId);
  return owner !== undefined && owner !== null
    && typeof user?.id === 'number' && owner === user.id;
};

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

    const body = (req.body ?? {}) as Record<string, unknown>;
    const choice = typeof body.visibility === 'string' ? body.visibility : '';
    if (!['personal', 'public', 'shared'].includes(choice)) {
      throw new AppError('visibility must be one of personal | public | shared', {
        code: 'INVALID_PROJECT_VISIBILITY',
        statusCode: 400,
      });
    }

    let sharedUserIds: number[] = [];
    if (choice === 'shared') {
      const ownerId = projectsDb.getProjectOwner(projectId) ?? null;
      const rawIds = Array.isArray(body.sharedUserIds) ? body.sharedUserIds : [];
      const parsedIds = [...new Set(
        rawIds
          .map((value) => (typeof value === 'number' ? value : Number.parseInt(String(value), 10)))
          .filter((value) => Number.isInteger(value) && value > 0),
      )].filter((id) => id !== ownerId); // owner 本来就可见,不必授权给自己
      if (parsedIds.length === 0) {
        throw new AppError('选择「指定用户」时至少要选一位用户', {
          code: 'SHARED_USERS_REQUIRED',
          statusCode: 400,
        });
      }
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

    // 三档互斥,与创建向导同语义:public 清授权名单;personal 两者皆清。
    projectsDb.setProjectVisibility(projectId, choice === 'public' ? 'public' : null);
    projectsDb.setProjectShares(projectId, sharedUserIds, readUser(req)?.id ?? null);

    res.json(createApiSuccessResponse(readProjectPermissionsView(projectId)));
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

    // 反归档越权:传别人的已归档路径,createProject 会把它 isArchived=0 复活并
    // 回传对方的真实 projectId —— 既改了别人的状态,又是文件 IDOR 的"拿 id"桥。
    // 已存在的行若对当前用户不可见,直接拒。不存在的路径正常走新建。
    const existing = projectsDb.getProjectPath(projectPath);
    if (existing && !resolveVisibleProjectRoot(readRequestViewer(req), existing.project_id)) {
      throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
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

    const projectCreationResult = await createProject({
      projectPath,
      customName,
      ownerUserId: callerId,
      visibility: rawVisibility === 'public' ? 'public' : null,
      sharedUserIds,
    });

    res.json({
      success: true,
      project: projectCreationResult.project,
      message:
        projectCreationResult.outcome === 'reactivated_archived'
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

    if (!projectsDb.setProjectOwner(projectId, ownerUserId)) {
      throw new AppError(`Project "${projectId}" was not found.`, {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }

    auditLogDb.record({
      userId: actor.id ?? null,
      username: actor.username ?? null,
      event: 'project_owner_changed',
      detail: `${projectId} -> ${ownerUserId === null ? 'public' : `user ${ownerUserId}`}`,
    });

    res.json({ success: true, projectId, ownerUserId });
  }),
);

router.put('/:projectId/rename', (req, res) => {
  try {
    const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
    if (!assertVisibleProject(req, res, projectId)) return;
    const { displayName } = req.body as { displayName?: unknown };
    updateProjectDisplayName(projectId, displayName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to rename project' });
  }
});

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
    restoreArchivedProject(projectId);
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
    await deleteOrArchiveProject(projectId, force);
    res.json({ success: true });
  }),
);

export default router;
