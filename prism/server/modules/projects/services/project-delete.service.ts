import { promises as fs } from 'node:fs';
import path from 'node:path';

import { attachmentsDb, auditLogDb, projectsDb, sessionsDb, getConnection } from '@/modules/database/index.js';
import { sessionsService, type SessionActor } from '@/modules/providers/index.js';
import { ATTACHMENT_DIR_NAME } from '@/shared/attachment-storage.js';
import { AppError } from '@/shared/utils.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('projects');

function uniqueJsonlPathsFromSessions(
  sessions: Array<{ jsonl_path: string | null }>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const row of sessions) {
    const raw = row.jsonl_path?.trim();
    if (!raw) {
      continue;
    }
    const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw);
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    result.push(absolute);
  }

  return result;
}

async function unlinkJsonlIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    log.warn(`[project-delete] Failed to remove ${filePath}:`, (error as Error).message);
  }
}

/**
 * Loads all session rows for the project path and removes each distinct `jsonl_path` file on disk.
 */
export async function deleteSessionJsonlFilesForProjectPath(projectPath: string): Promise<void> {
  const sessions = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath);
  const paths = uniqueJsonlPathsFromSessions(sessions);

  for (const filePath of paths) {
    await unlinkJsonlIfExists(filePath);
  }
}

/**
 * - **Soft delete** (`force` false): set `isArchived` on the `projects` row (hide from the active list; DB only).
 * - **Force** (`force` true): every session under that `project_path` goes to the trash (row + display
 *   log + transcript, see sessions.service), attachments are purged, then the `projects` row is removed.
 *
 * gk:此前 force 删项目是**直接 unlink 全部 transcript + DELETE 全部会话行**,而且
 * 完全不看这些会话有没有在跑。现在逐条走与单条永久删除同一条路(进最近删除、
 * 收 runtime、审计、推 `session_removed`),并且**先整体预检**:任何一条在跑 / 被终端
 * 接管 / 有排队消息,整个删除拒绝,一条都不动 —— 删一半再抛,比不删更难解释。
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
    projectsDb.updateProjectIsArchivedById(projectId, true);
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
   * **一条都不许"直接删"。**
   *
   * 上一版在这里继续往下走,靠后面的 `deleteSessionsByProjectPath` 兜住失败的那几条 ——
   * 那等于把它们连显示日志一起硬删:回收站里没有副本、没有 `session_deleted` 审计、
   * runtime 也没收,而这正是整个 gk 要消灭的那种"东西凭空没了"。
   *
   * 预检(上面的 `busy`)挡的是"删之前就在用";但循环里每条都 `await`,第五条删到
   * 一半时第三条完全可能刚被起一个新回合 → 409 → 落到这里。这时正确的收场是
   * **停下来**:已经进回收站的那些都可恢复(项目行还在,恢复能直接挂回去),
   * 用户重试一次即可。删一半再硬删剩下的,才是不可解释的那种状态。
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
 * bl 轮起,对话附件落在项目的 `attachments/` 子目录、并记进 attachments 台账
 * (台账按用户计配额)。删项目原先只删了 sessions/transcripts/项目行,附件行
 * 继续占着用户配额,只能等 30 天 TTL 才消 —— 而那时目录可能已随项目被外部删掉,
 * 徒留一堆按用户计费的僵尸行。这里主动收口:
 *   1. 先递归删 `<project>/attachments/` 目录里的文件(forgetUnder 只删台账不删文件);
 *   2. 再按前缀 forget 掉台账行,立即把配额还给用户。
 * 顺序不能反 —— 先 forget 再删文件会留下磁盘孤儿(TTL 清扫器靠台账才找得到它们)。
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
