import { promises as fs } from 'node:fs';
import path from 'node:path';

import { attachmentsDb, auditLogDb, projectsDb, scheduledTasksDb, sessionsDb, getConnection } from '@/modules/database/index.js';
import { sessionsService, type SessionActor } from '@/modules/providers/index.js';
import { ATTACHMENT_DIR_NAME } from '@/shared/attachment-storage.js';
import { AppError } from '@/shared/utils.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('projects');

/**
 * - Soft delete (`force` false): set `isArchived` on the `projects` row and disable its scheduled
 *   tasks (hide from the active list; DB only).
 * - Force (`force` true): every session under that `project_path` goes to the trash (row + display
 *   log + transcript, see sessions.service), attachments are purged, then the `projects` row is removed.
 *
 * force 时每条会话都走与单条永久删除同一条路(进最近删除、收 runtime、审计、推 `session_removed`),
 * 并且先整体预检:任何一条在跑 / 被终端接管 / 有排队消息,整个删除拒绝,一条都不动。
 * 删一半再抛,比不删更难解释。
 */
export async function deleteOrArchiveProject(
  projectId: string,
  force: boolean,
  actor: SessionActor | null = null,
): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const auditBase = {
    userId: actor && actor.userId !== null && Number.isFinite(Number(actor.userId)) ? Number(actor.userId) : null,
    username: actor?.username ?? null,
    ip: actor?.ip ?? null,
    userAgent: actor?.userAgent ?? null,
    targetUserId: row.owner_user_id ?? null,
  };

  if (!force) {
    // 归档同时停用这个项目上的定时任务,否则任务照跑,还会把项目重建出来。
    // 还原项目不自动恢复它们(留给人决定,见 disableByProjectPath)。
    const archiveProject = getConnection().transaction(() => {
      projectsDb.updateProjectIsArchivedById(projectId, true);
      return scheduledTasksDb.disableByProjectPath(row.project_path);
    });
    const disabledTasks = archiveProject();
    if (disabledTasks > 0) log.info(`[projects] 归档项目 ${row.project_path}:停用 ${disabledTasks} 个定时任务`);
    auditLogDb.record({
      ...auditBase,
      event: 'project_archived',
      detail: JSON.stringify({ entry: 'project', projectPath: row.project_path, projectName: row.custom_project_name ?? null }),
    });
    return;
  }

  const sessions = sessionsDb.getSessionsByProjectPathIncludingArchived(row.project_path);

  // 预检:一条都不动之前先问清楚"有没有正在用的"。
  const busy = sessions.filter((session) => sessionsService.isSessionInUse(session.session_id));
  if (busy.length > 0) {
    const names = busy.slice(0, 5).map((session) => session.custom_name?.trim() || session.session_id);
    throw new AppError(
      `项目下还有 ${busy.length} 条会话正在使用(在跑 / 终端接管 / 有排队消息):${names.join('、')} —— 先停掉它们再删除项目。`,
      { code: 'PROJECT_HAS_ACTIVE_SESSIONS', statusCode: 409 },
    );
  }

  const trashed: string[] = [];
  const failed: string[] = [];
  for (const session of sessions) {
    try {
      await sessionsService.deleteOrArchiveSessionById(session.session_id, {
        force: true,
        deletedFromDisk: true,
        actor,
        via: 'project',
      });
      trashed.push(session.custom_name?.trim() || session.session_id);
    } catch (error) {
      failed.push(session.session_id);
      log.warn('[project-delete] 会话进最近删除失败(继续其余):', { sessionId: session.session_id, error: (error as Error)?.message });
    }
  }

  /**
   * 一条都不许"直接删"。
   *
   * 预检(上面的 `busy`)挡的是"删之前就在用";但循环里每条都 `await`,中途某条完全可能
   * 刚被起一个新回合 → 409 → 落到这里。这时要停下来:已经进回收站的那些都可恢复(项目行
   * 还在,恢复能直接挂回去),用户重试一次即可。不能继续往下、靠 `deleteSessionsByProjectPath`
   * 兜住失败的那几条:那等于连显示日志一起硬删,回收站里没有副本、没有 `session_deleted` 审计,
   * runtime 也没收。
   */
  if (failed.length > 0) {
    const names = failed.slice(0, 5);
    throw new AppError(
      `项目下有 ${failed.length} 条会话没能进入最近删除(多半是刚好开始了新回合):${names.join('、')}`
      + ` —— 项目没有删除;已经进「最近删除」的 ${trashed.length} 条可以恢复,处理完这几条再重试。`,
      { code: 'PROJECT_HAS_ACTIVE_SESSIONS', statusCode: 409 },
    );
  }

  /**
   * 顺序与原子性(原文保留):磁盘那步(删附件目录)没法进事务;库写包起来。
   * 会话行这时已经全部进了回收站,`deleteSessionsByProjectPath` 只是兜底
   * (例如路径挂着一条列表没返回的行),正常情况下删 0 行。
   */
  await purgeProjectAttachments(row.project_path);

  const commitRemoval = getConnection().transaction(() => {
    sessionsDb.deleteSessionsByProjectPath(row.project_path);
    // 定时任务(含运行记录)与项目同事务删除:留着它们,到点就会以任务主人的身份把项目重建出来。
    scheduledTasksDb.deleteByProjectPath(row.project_path);
    projectsDb.deleteProjectById(projectId);
  });
  commitRemoval();

  auditLogDb.record({
    ...auditBase,
    event: 'project_deleted',
    detail: JSON.stringify({
      entry: 'project',
      projectPath: row.project_path,
      projectName: row.custom_project_name ?? null,
      count: trashed.length,
      names: trashed.slice(0, 10),
    }),
  });
  log.info(`[projects] 永久删除项目:${row.project_path} 会话 ${trashed.length} 条进最近删除 操作者=${actor?.username ?? actor?.userId ?? '-'}`);
}

/**
 * force 删项目时清掉它的附件目录 + 台账行。
 *
 * 对话附件落在项目的 `attachments/` 子目录,并记进按用户计配额的 attachments 台账;
 * 不主动清的话,附件行会继续占着用户配额直到 TTL 过期。
 *   1. 先递归删 `<project>/attachments/` 目录里的文件(forgetUnder 只删台账不删文件);
 *   2. 再按前缀 forget 掉台账行,立即把配额还给用户。
 * 顺序不能反:两步之间若中断,先 forget 会留下台账找不到的磁盘孤儿(TTL 清扫器靠台账才
 * 找得到它们),先删文件则只剩几行会被 TTL 收走的台账。
 */
async function purgeProjectAttachments(projectPath: string): Promise<void> {
  if (!projectPath) return;
  const attachmentsDir = path.join(projectPath, ATTACHMENT_DIR_NAME);
  try {
    await fs.rm(attachmentsDir, { recursive: true, force: true });
  } catch (error) {
    // 删目录失败不阻断删项目本身;台账仍会被 forget,配额照样释放。
    log.warn('[project-delete] 清附件目录失败(继续):', (error as Error).message);
  }
  attachmentsDb.forgetUnder(attachmentsDir);
}

/**
 * Restores one archived project row back into the active project list.
 */
export function restoreArchivedProject(projectId: string): void {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  projectsDb.updateProjectIsArchivedById(projectId, false);
}
