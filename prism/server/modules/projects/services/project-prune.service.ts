import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { isPrismInternalProjectPath } from '@/shared/prism-internal-transcripts.js';

/**
 * 清掉 Prism 自己跑出来的「幽灵项目」。
 *
 * ## 为什么忽略判据不够,还要这一步
 *
 * `isPrismInternalTranscript` 挡的是 transcript **进不进列表**。但项目一旦在
 * `projects` 表里落了行,侧栏就直接从库里读 —— 挡不挡它都在。所以要有一次
 * **按真实路径**的清账:项目路径是 Prism 自己的临时工作目录(目前只剩模型探测
 * 那一种),就不是用户的项目,连同它的会话行一起删掉。
 *
 * ## 只删库里的行,不碰磁盘
 *
 * 那些目录本来就是 Prism 自己写的,各自的清理归各自管。这里越少碰文件越安全 ——
 * 判据万一有偏差,删错一行数据库还能重扫回来,删错文件就回不来了。
 */
export function pruneInternalProjects(): { removed: string[] } {
  const removed: string[] = [];
  let rows: Array<{ project_id: string; project_path: string }>;
  try {
    rows = projectsDb.listAllProjectPaths();
  } catch {
    return { removed };
  }

  for (const row of rows) {
    if (!isPrismInternalProjectPath(row.project_path)) continue;
    try {
      sessionsDb.deleteSessionsByProjectPath(row.project_path);
      projectsDb.deleteProjectById(row.project_id);
      removed.push(row.project_path);
    } catch (error) {
      console.warn(`[project-prune] 删不掉 ${row.project_path}:`, (error as Error).message);
    }
  }
  return { removed };
}
