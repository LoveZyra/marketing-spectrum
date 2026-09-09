import { promises as fs } from 'node:fs';
import path from 'node:path';

import { attachmentsDb, projectsDb, sessionsDb, getConnection } from '@/modules/database/index.js';
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
 * - **Force** (`force` true): for each session row for that `project_path`, delete the file at `jsonl_path`
 *   (when set), then remove session rows and the `projects` row.
 */
export async function deleteOrArchiveProject(projectId: string, force: boolean): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (!force) {
    projectsDb.updateProjectIsArchivedById(projectId, true);
    return;
  }

  /**
   * 顺序与原子性。
   *
   * 磁盘那两步(删 transcript、删附件目录)**没法**放进事务里 —— 文件系统不回滚。
   * 所以只把两次库写包起来:它们要么一起生效,要么一起不生效。
   *
   * ## 为什么这一层包起来就够
   *
   * 之前四步全裸奔,中途崩会留下"会话行删了、项目行还在"这种谁也没描述过的中间态:
   * 项目仍列在侧栏,点进去空空如也,而且**再删一次也删不掉那些已经没了的会话**。
   * 现在最坏的情况是"文件删了、库还在" —— 那是**可自愈**的:重新点一次删除,
   * 磁盘那两步是幂等的(`fs.rm` 带 force、`forgetUnder` 按前缀),库那步照常跑完。
   *
   * 反过来包(先删库再删盘)不行:库删了就再也找不到 project_path,磁盘上的
   * transcript 和附件成为永久孤儿。所以磁盘在前、库在后,是有意的。
   */
  await deleteSessionJsonlFilesForProjectPath(row.project_path);
  await purgeProjectAttachments(row.project_path);

  const commitRemoval = getConnection().transaction(() => {
    sessionsDb.deleteSessionsByProjectPath(row.project_path);
    projectsDb.deleteProjectById(projectId);
  });
  commitRemoval();
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
