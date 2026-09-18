import { projectsDb, userDb } from '@/modules/database/index.js';
import { isPublicWorkspacePath } from '@/shared/project-visibility.js';
import { AppError } from '@/shared/utils.js';

/**
 * 项目权限的读与写(eo:从 `projects.routes.ts` 抽出来)。
 *
 * 抽出来的唯一理由是**批量权限设置要走同一份实现**。三档语义里有两条不是
 * 一眼能看出来的("有效公共"要算无主+公共目录、personal/shared 必须让项目
 * 有主),这种东西写两遍必然漂,而漂出来的那条缝就是权限洞。
 */

export type ProjectVisibilityChoice = 'personal' | 'public' | 'shared';

export interface ProjectPermissionsView {
  visibility: ProjectVisibilityChoice;
  sharedUserIds: number[];
}

export interface PermissionsActor {
  id?: number | null;
  username?: string | null;
  isRoot?: boolean;
}

/** 当前权限档位(与创建向导同一三选)+ 授权名单。项目不存在返回 null。 */
export function readProjectPermissionsView(projectId: string): ProjectPermissionsView | null {
  const row = projectsDb.getProjectById(projectId);
  if (!row) return null;
  const sharedUserIds = projectsDb.getProjectSharedUserIds(projectId);
  // 「个人」不能只看 visibility 列和授权名单 —— 一个**无主**项目若落在公共目录
  // (PRISM_PUBLIC_WORKSPACE)下,对所有人可见,那其实是「公共」。此前这里把它
  // 显示成「个人」,于是用户选「个人」保存后看着没变、实际一直是公共。所以
  // "有效公共"要把这种无主+公共目录的情况也算进去,对话框才显示真实状态。
  const unowned = row.owner_user_id === null || row.owner_user_id === undefined;
  const effectivelyPublic = row.visibility === 'public'
    || (unowned && isPublicWorkspacePath(row.project_path));
  return {
    visibility: effectivelyPublic
      ? 'public'
      : sharedUserIds.length > 0
        ? 'shared'
        : 'personal',
    sharedUserIds,
  };
}

/**
 * 只有 root 或 owner 能改权限 —— 共享接收方「可见不可管」,公共项目的路人同理。
 * (可见性由调用方先用 `resolveVisibleProjectRoot` 挡:看不见的人拿 404,
 * 看得见但非管理者 403。)
 */
export function canManageProject(projectId: string, actor: PermissionsActor | undefined): boolean {
  if (actor?.isRoot === true) return true;
  const owner = projectsDb.getProjectOwner(projectId);
  return owner !== undefined && owner !== null
    && typeof actor?.id === 'number' && owner === actor.id;
}

/**
 * gk:谁能**永久删除**一个项目。
 *
 * 与 `canManageProject`(改权限 / 改所有者)只差一处:**无主项目**。
 * `owner_user_id IS NULL` 在这个库里的语义是"公共项目",它没有"负责人"这一档
 * 可以收紧到 —— 而无主项目是常态(监视器在磁盘上扫到新路径时就是不带 owner 地
 * 建行)。把无主也判成"只有 root 能永久删",等于把普通用户删自己在终端里开出来的
 * 项目这件事也堵掉了,那是 gj 能做的事。改权限没有这个顾虑:公共项目的权限本来
 * 就只该 root 动。
 *
 * 项目不存在时返回 false(调用方先过可见性,那条路会回 404)。
 */
export function canDeleteProject(projectId: string, actor: PermissionsActor | undefined): boolean {
  if (actor?.isRoot === true) return true;
  const owner = projectsDb.getProjectOwner(projectId);
  if (owner === undefined) return false;
  if (owner === null) return true;
  return typeof actor?.id === 'number' && owner === actor.id;
}

/**
 * gn:谁能**归档**一个项目 —— 与永久删除同一条规则。
 *
 * 归档以前是"看得见就能做",与会话归档同口径。但项目归档和会话归档不是一回事:
 * 归档一个项目,它会从**所有人**的活跃侧栏里消失,而按钮上没有任何"这不是你的
 * 项目"的提示。2026-09-15 实测,非 root 的 `test` 就这么把 root 的 `lqm` 整个
 * 归档掉了(可一键还原、没丢数据,但所有人当场都看不见它了)。
 *
 * 所以收紧到与 `canDeleteProject` 同一条:root / owner 放行,**无主项目**没有
 * "负责人"这一档所以回落到可见性。会话级的归档不受影响 —— 共享项目里的协作者
 * 照样能归档自己看得见的会话,那只影响他自己的列表。
 *
 * 故意委托给 `canDeleteProject` 而不是复制一份判据:两者必须永远一致,
 * 复制出来的第二份迟早会漂。
 */
export function canArchiveProject(projectId: string, actor: PermissionsActor | undefined): boolean {
  return canDeleteProject(projectId, actor);
}

/**
 * 校验一次权限设置的入参。**不写库** —— 批量场景要在动第一个项目之前就
 * 把"用户 id 不存在""选了指定用户却没选人"这类错一次性问清楚,
 * 而不是改了三个项目之后在第四个上抛出来。
 */
export function parsePermissionsInput(body: Record<string, unknown>): {
  visibility: ProjectVisibilityChoice;
  sharedUserIds: number[];
} {
  const choice = typeof body.visibility === 'string' ? body.visibility : '';
  if (!['personal', 'public', 'shared'].includes(choice)) {
    throw new AppError('visibility must be one of personal | public | shared', {
      code: 'INVALID_PROJECT_VISIBILITY',
      statusCode: 400,
    });
  }
  if (choice !== 'shared') {
    return { visibility: choice as ProjectVisibilityChoice, sharedUserIds: [] };
  }

  const rawIds = Array.isArray(body.sharedUserIds) ? body.sharedUserIds : [];
  const parsedIds = [...new Set(
    rawIds
      .map((value) => (typeof value === 'number' ? value : Number.parseInt(String(value), 10)))
      .filter((value) => Number.isInteger(value) && value > 0),
  )];
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
  return { visibility: 'shared', sharedUserIds: parsedIds };
}

/**
 * 落地一次权限设置。三档互斥。
 *
 * 关键:**personal / shared 必须让项目有主**。只把 visibility 列清成 null 是
 * 不够的 —— 一个无主项目若在公共目录下,对所有人可见,清 visibility 也还是
 * 公共(用户报过的"改回个人还是公共"就是这个)。所以当前无主时,把归属认领
 * 给操作者(对话框「个人 = 仅自己和 root 可见」里的"自己");已有主则不动,
 * 避免 root 帮别人改权限时顺手夺走归属。
 */
export function applyProjectPermissions(
  projectId: string,
  input: { visibility: ProjectVisibilityChoice; sharedUserIds: number[] },
  actingUserId: number | null,
): ProjectPermissionsView | null {
  if (input.visibility === 'public') {
    projectsDb.setProjectVisibility(projectId, 'public');
    projectsDb.setProjectShares(projectId, [], actingUserId);
    return readProjectPermissionsView(projectId);
  }

  projectsDb.setProjectVisibility(projectId, null);
  const currentOwner = projectsDb.getProjectOwner(projectId);
  if ((currentOwner === null || currentOwner === undefined) && actingUserId != null) {
    projectsDb.setProjectOwner(projectId, actingUserId);
  }
  // owner 本来就可见,不必授权给自己 —— 每个项目的 owner 可能不同,
  // 所以这一步**按项目算**,不能在解析入参时一次性剔掉。
  const owner = projectsDb.getProjectOwner(projectId) ?? null;
  const grants = input.visibility === 'shared'
    ? input.sharedUserIds.filter((id) => id !== owner)
    : [];
  // 剔掉 owner 之后一个人都不剩 = 「指定用户」里只指定了所有者自己,那是个空动作。
  // 报错而不是悄悄退化成「个人」—— 后者会让人以为自己成功共享出去了。
  if (input.visibility === 'shared' && grants.length === 0) {
    throw new AppError('选择「指定用户」时至少要选一位所有者以外的用户', {
      code: 'SHARED_USERS_REQUIRED',
      statusCode: 400,
    });
  }
  projectsDb.setProjectShares(projectId, grants, actingUserId);
  return readProjectPermissionsView(projectId);
}
