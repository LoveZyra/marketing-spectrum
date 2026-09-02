import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { canViewerSeeProject } from '@/shared/project-visibility.js';
import type { ProjectRepositoryRow, Viewer } from '@/shared/types.js';

/**
 * 把一行项目记录补全成 `canViewerSeeProject` 的完整输入(含显式可见性与
 * 指定用户授权)。所有"手里有项目行"的判定点都应经这里,免得漏掉
 * visibility / project_shares 任意一个维度 —— 漏掉的那个点就是权限洞。
 */
export function projectVisibilityInput(
  project: ProjectRepositoryRow | null,
  fallbackProjectPath: string | null = null,
): {
  ownerUserId: number | null;
  projectPath: string | null;
  visibility: string | null;
  sharedUserIds: number[];
} {
  return {
    ownerUserId: project?.owner_user_id ?? null,
    projectPath: project?.project_path ?? fallbackProjectPath,
    visibility: project?.visibility ?? null,
    sharedUserIds: project ? projectsDb.getProjectSharedUserIds(project.project_id) : [],
  };
}

/**
 * 归属校验 + 路径解析,一步完成 —— 给所有按 projectId 寻址的路由用。
 *
 * 背景:一次全局复审发现文件模块、项目增删改、预览票据等一批路由都只做了
 * `getProjectPathById(projectId)`(存在即放行),从不问"你能看这个项目吗"。
 * 而 `getProjectPathById` 不做任何 owner 过滤,`validatePathInProject` 只保证
 * 不越出**目标项目**——那个项目恰恰是受害者的。于是拿到别人的 projectId(归档
 * 反查、URL、日志都可能泄露)就能读写删别人的文件。
 *
 * 这个 helper 把两件事收成一件:解析出项目根路径,并用 path-aware 的
 * `canViewerSeeProject` 判定可见性(无主项目现在只有落在公共目录下才对非 root
 * 可见)。**看不见时返回 null,路由一律回 404** —— 与"项目不存在"同形,不给
 * 攻击者一个"这个 id 存不存在"的探针。
 *
 * @returns 可见时返回项目根的绝对路径;不存在或不可见都返回 null。
 */
export function resolveVisibleProjectRoot(viewer: Viewer, projectId: string): string | null {
  if (!projectId) return null;

  const projectRoot = projectsDb.getProjectPathById(projectId);
  if (!projectRoot) return null;

  const project = projectsDb.getProjectPath(projectRoot);
  const visible = canViewerSeeProject({
    ...projectVisibilityInput(project, projectRoot),
    viewerUserId: viewer.userId,
    viewerUsername: viewer.username,
  });

  return visible ? projectRoot : null;
}

/**
 * 按**项目路径**判可见性 —— `resolveVisibleProjectRoot` 的路径寻址版。
 *
 * 定时任务是按 `project_path` 存的(不是 projectId),而它的权限面整个挂在
 * 项目可见性上:能看见这个项目 = 能看/改/删/立即运行跑在它上面的任务。
 * 判定必须和项目、会话走**同一个** `canViewerSeeProject`,否则三套语义之间
 * 一定会漂,而漂出来的那条缝就是权限洞。
 *
 * 路径在 DB 里还没有对应项目行时,按"无主项目"判 —— 落在公共目录下才对
 * 非 root 可见,否则仅 root。方向上宁可多挡。
 */
export function canViewerSeeProjectPath(viewer: Viewer, projectPath: string | null | undefined): boolean {
  const normalized = typeof projectPath === 'string' && projectPath.trim() ? projectPath.trim() : null;
  if (!normalized) return false;
  const project = projectsDb.getProjectPath(normalized);
  return canViewerSeeProject({
    ...projectVisibilityInput(project, normalized),
    viewerUserId: viewer.userId,
    viewerUsername: viewer.username,
  });
}
