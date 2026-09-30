import { auditLogDb, getConnection, projectsDb, userDb } from '@/modules/database/index.js';
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
 * hl(动态 P2-7):**与 `canManageProject` 完全同一条规则** —— 无主项目只有 root 能删。
 *
 * gj / gk 时的口径是"无主 = 看得见就能永久删":无主项目是常态(监视器扫到新路径
 * 就不带 owner 地建行),不这样普通用户删不掉自己在终端里开出来的项目。但 2026-09-28
 * 动态检测的复现是另一面:公共目录(PRISM_PUBLIC_WORKSPACE)下的无主项目对**所有**
 * 登录用户可见,于是任何人都能把它连转录一起永久删掉、或归档让所有人当场看不见。
 * 一个"谁都能删"的公共目录比"要找 root 删"危险得多,用户拍板改成只给 root。
 * 想自己管的项目走「项目权限」认领成有主项目即可(applyProjectPermissions 会把
 * 无主项目的归属给操作者)。
 *
 * 项目不存在时返回 false(调用方先过可见性,那条路会回 404)。
 */
export function canDeleteProject(projectId: string, actor: PermissionsActor | undefined): boolean {
  return canManageProject(projectId, actor);
}

/**
 * gn:谁能**归档**一个项目 —— 与永久删除同一条规则。
 *
 * 归档以前是"看得见就能做",与会话归档同口径。但项目归档和会话归档不是一回事:
 * 归档一个项目,它会从**所有人**的活跃侧栏里消失,而按钮上没有任何"这不是你的
 * 项目"的提示。2026-09-15 实测,非 root 的 `test` 就这么把 root 的 `lqm` 整个
 * 归档掉了(可一键还原、没丢数据,但所有人当场都看不见它了)。
 *
 * 所以收紧到与 `canDeleteProject` 同一条:root / owner 放行;hl(动态 P2-7)起
 * 无主项目也只给 root。
 *
 * 故意委托给 `canDeleteProject` 而不是复制一份判据:两者必须永远一致,
 * 复制出来的第二份迟早会漂。
 */
export function canArchiveProject(projectId: string, actor: PermissionsActor | undefined): boolean {
  return canDeleteProject(projectId, actor);
}

/**
 * hl(09-24 P2-15):谁能**还原**一个归档的项目 —— 与归档对称。
 *
 * 此前还原只要"看得见":协作者能撤销属主的归档。归档与还原是同一个开关的两个方向,
 * 一个只给 owner / root、另一个人人可按,等于开关只锁了一半。
 */
export function canRestoreProject(projectId: string, actor: PermissionsActor | undefined): boolean {
  return canArchiveProject(projectId, actor);
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
  // hk(审计 P1-8):**先把要写的全部算好、校验完,再在一个事务里写。**
  // 原来先清公开、给无主项目设属主,**然后**才校验「指定用户不能只有所有者自己」并抛 400 ——
  // 接口报失败,项目却已经从公开变成了个人(无主项目还变成了操作者的)。单条与批量入口都中。
  if (input.visibility === 'public') {
    getConnection().transaction(() => {
      projectsDb.setProjectVisibility(projectId, 'public');
      projectsDb.setProjectShares(projectId, [], actingUserId);
    })();
    return readProjectPermissionsView(projectId);
  }

  const currentOwner = projectsDb.getProjectOwner(projectId);
  const claimOwnership = (currentOwner === null || currentOwner === undefined) && actingUserId != null;
  // owner 本来就可见,不必授权给自己 —— 每个项目的 owner 可能不同,
  // 所以这一步**按项目算**,不能在解析入参时一次性剔掉。
  const ownerAfter = claimOwnership ? actingUserId : (currentOwner ?? null);
  const grants = input.visibility === 'shared'
    ? input.sharedUserIds.filter((id) => id !== ownerAfter)
    : [];
  // 剔掉 owner 之后一个人都不剩 = 「指定用户」里只指定了所有者自己,那是个空动作。
  // 报错而不是悄悄退化成「个人」—— 后者会让人以为自己成功共享出去了。
  if (input.visibility === 'shared' && grants.length === 0) {
    throw new AppError('选择「指定用户」时至少要选一位所有者以外的用户', {
      code: 'SHARED_USERS_REQUIRED',
      statusCode: 400,
    });
  }

  getConnection().transaction(() => {
    projectsDb.setProjectVisibility(projectId, null);
    if (claimOwnership) projectsDb.setProjectOwner(projectId, actingUserId as number);
    projectsDb.setProjectShares(projectId, grants, actingUserId);
  })();
  return readProjectPermissionsView(projectId);
}

/**
 * hl(动态 P2-5):**转移属主,原 owner 自动进授权名单。**
 *
 * 此前(单条与批量两处)只改 `owner_user_id`:root 把项目转给别人之后,原 owner 连自己
 * 跑了几天的会话都看不见了(项目非公开时对他不可见)。转移归属改的是"谁负责",不该
 * 顺手把人踢出去;要真想收回访问,新 owner 在「项目权限」里把他删掉即可。
 * 公开项目人人可见,不必加;转给自己(原 owner = 新 owner)也不必。改 owner 与写 shares
 * 在一个事务里。单条与批量共用这一份,不许分叉。
 *
 * 只做写库 + 审计;调用方自己负责 root 判定、目标用户存在性校验与广播。
 * 项目不存在返回 null。
 */
export function transferProjectOwner(
  projectId: string,
  ownerUserId: number | null,
  actor: PermissionsActor & { ip?: string | null; userAgent?: string | null },
): { previousOwner: number | null; grantedPreviousOwner: boolean } | null {
  const before = projectsDb.getProjectById(projectId);
  if (!before) return null;
  const previousOwner = before.owner_user_id ?? null;
  const grantedPreviousOwner = previousOwner !== null
    && previousOwner !== ownerUserId
    && before.visibility !== 'public';
  const actingUserId = typeof actor.id === 'number' ? actor.id : null;

  getConnection().transaction(() => {
    projectsDb.setProjectOwner(projectId, ownerUserId);
    if (grantedPreviousOwner) {
      const shares = new Set(projectsDb.getProjectSharedUserIds(projectId));
      shares.add(previousOwner as number);
      if (ownerUserId !== null) shares.delete(ownerUserId); // 新 owner 本来就可见
      projectsDb.setProjectShares(projectId, [...shares], actingUserId);
    }
  })();

  auditLogDb.record({
    userId: actingUserId,
    username: actor.username ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    event: 'project_owner_changed',
    // hl(动态 P2-9):记 targetUserId,「与我有关的操作记录」才查得到"我的项目被转走 / 转给我"。
    targetUserId: ownerUserId ?? previousOwner,
    detail: `${projectId} -> ${ownerUserId === null ? 'public' : `user ${ownerUserId}`}`
      + `${previousOwner !== null ? ` (from user ${previousOwner})` : ''}`,
  });

  return { previousOwner, grantedPreviousOwner };
}
