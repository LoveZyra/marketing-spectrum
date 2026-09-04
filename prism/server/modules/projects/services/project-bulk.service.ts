import { auditLogDb, projectsDb, resolveVisibleProjectRoot, userDb } from '@/modules/database/index.js';
import { deleteOrArchiveProject } from '@/modules/projects/services/project-delete.service.js';
import {
  applyProjectPermissions, canManageProject, type PermissionsActor, type ProjectVisibilityChoice,
} from '@/modules/projects/services/project-permissions.service.js';
import { setProjectStarForActor } from '@/modules/projects/services/project-star.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * 项目的批量操作(eo)。
 *
 * ## 为什么逐条鉴权,而不是一条 SQL 扫完
 *
 * "全选 → 删除"如果做成一个不逐条鉴权的接口,就等于给了一把能扫掉别人项目的
 * 扫帚。所以这里**每一个 id 都过一遍**可见性(`resolveVisibleProjectRoot`),
 * 改权限/改所有者还要再过一遍管理权(root 或 owner)。慢一点无所谓,一次几十
 * 上百个项目,人还在等着看结果。
 *
 * ## 为什么"看不见"是跳过而不是报错
 *
 * 报错等于告诉调用方那个 id 存在。与会话的批量接口(`bulkSessionAction`)同一
 * 口径:跳过、计数、不解释。
 *
 * ## 为什么一条失败不中断其余
 *
 * 批量操作里最糟的结果是"删了一半然后抛异常" —— 调用方既不知道成了哪些,
 * 也不知道该不该重试。逐条 catch,最后给一份**能对账的**结果:成功的 id、
 * 跳过的 id(带原因)、失败的 id(带原因)。
 */

export type BulkProjectAction =
  | 'archive'      // 软删:只置 isArchived 标记
  | 'delete'       // 硬删:连会话 jsonl 与 attachments 一起清(项目目录本身不动)
  | 'star'
  | 'unstar'
  | 'permissions'
  | 'owner';

export interface BulkProjectOutcome {
  requested: number;
  succeeded: string[];
  /** 看得见但不该动的(没有管理权),或压根看不见的。 */
  skipped: Array<{ projectId: string; reason: string }>;
  failed: Array<{ projectId: string; reason: string }>;
}

export interface BulkProjectInput {
  action: BulkProjectAction;
  projectIds: string[];
  /** action=permissions 时必填(入参已在路由层用 parsePermissionsInput 校验过)。 */
  permissions?: { visibility: ProjectVisibilityChoice; sharedUserIds: number[] };
  /** action=owner 时必填;null = 置为无主。 */
  ownerUserId?: number | null;
}

export interface BulkViewer {
  userId: number | string | null;
  username: string | null;
}

/** 一次批量最多动多少个。只是防手滑/防滥用 —— 上千个会让请求跑很久且没有进度可言。 */
export const BULK_PROJECT_LIMIT = 500;

export async function bulkProjectAction(
  input: BulkProjectInput,
  viewer: BulkViewer,
  actor: PermissionsActor,
): Promise<BulkProjectOutcome> {
  const ids = [...new Set(input.projectIds)];
  const succeeded: string[] = [];
  const skipped: BulkProjectOutcome['skipped'] = [];
  const failed: BulkProjectOutcome['failed'] = [];

  // 改所有者是 root 专属,且目标用户必须存在 —— 在动第一个项目**之前**就问清楚,
  // 而不是改了三个之后在第四个上抛出来。
  if (input.action === 'owner') {
    if (actor.isRoot !== true) {
      throw new AppError('Administrator access required', { code: 'ROOT_REQUIRED', statusCode: 403 });
    }
    const target = input.ownerUserId;
    if (target !== null && target !== undefined) {
      if (!Number.isInteger(target) || target <= 0 || !userDb.getUserById(target)) {
        throw new AppError('ownerUserId must be a positive integer or null', {
          code: 'INVALID_OWNER',
          statusCode: 400,
        });
      }
    }
  }

  const actingUserId = typeof actor.id === 'number' ? actor.id : null;

  for (const projectId of ids) {
    if (!resolveVisibleProjectRoot(viewer, projectId)) {
      skipped.push({ projectId, reason: 'not-visible' });
      continue;
    }
    // 改权限 / 改所有者要额外的管理权;删除与收藏沿用单个操作的口径(可见即可)。
    if ((input.action === 'permissions' || input.action === 'owner')
      && !canManageProject(projectId, actor)) {
      skipped.push({ projectId, reason: 'not-manageable' });
      continue;
    }

    try {
      switch (input.action) {
        case 'archive':
          await deleteOrArchiveProject(projectId, false);
          break;
        case 'delete':
          await deleteOrArchiveProject(projectId, true);
          break;
        case 'star':
          setProjectStarForActor(projectId, actingUserId, true);
          break;
        case 'unstar':
          setProjectStarForActor(projectId, actingUserId, false);
          break;
        case 'permissions':
          if (!input.permissions) {
            throw new AppError('缺少权限设置', { code: 'MISSING_PERMISSIONS', statusCode: 400 });
          }
          applyProjectPermissions(projectId, input.permissions, actingUserId);
          break;
        case 'owner': {
          const owner = input.ownerUserId ?? null;
          if (!projectsDb.setProjectOwner(projectId, owner)) {
            throw new AppError('项目不存在', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
          }
          auditLogDb.record({
            userId: actingUserId,
            username: actor.username ?? null,
            event: 'project_owner_changed',
            detail: `${projectId} -> ${owner === null ? 'public' : `user ${owner}`}`,
          });
          break;
        }
      }
      succeeded.push(projectId);
    } catch (error) {
      failed.push({ projectId, reason: error instanceof Error ? error.message : '未知错误' });
    }
  }

  // 删除是不可逆的,不管成没成都留一条账 —— 事后"谁把那批项目删了"要查得到。
  if (input.action === 'delete' || input.action === 'archive') {
    auditLogDb.record({
      userId: actingUserId,
      username: actor.username ?? null,
      event: input.action === 'delete' ? 'projects_bulk_deleted' : 'projects_bulk_archived',
      detail: `请求 ${ids.length} 个,成功 ${succeeded.length} 个:${succeeded.join(', ')}`,
    });
  }

  return { requested: ids.length, succeeded, skipped, failed };
}
