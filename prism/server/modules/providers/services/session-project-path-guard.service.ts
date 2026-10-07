import { canViewerSeeProjectPath, projectsDb } from '@/modules/database/index.js';
import type { Viewer } from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';

/**
 * projectPath 必须过的两道门:建会话(`POST /api/providers/sessions`)、建/改定时任务、
 * 写 .mcp.json、列项目技能共用这一份判据。
 *
 * 不拦的话,非 root 用户 POST `{projectPath:"/"}` 就能建出一行 `project_path='/'`、
 * owner 是自己的项目,随后 `GET /api/projects/<id>/files` 列出服务器根目录,
 * `chat.send` 也会以 cwd=/ 跑 agent。
 *
 * 两道门:
 *  1. 已登记的项目:只看可见性(owner / 公共 / 指定共享 / root)。它
 *     登记时已经过了工作区校验,这里不再重验 —— 免得 WORKSPACES_ROOT 改过之后
 *     把 root 自己的老项目也拦住。
 *  2. 没登记的路径:必须同时满足"在工作区根内、不是系统目录"
 *     (validateWorkspacePath)和"对这个人可见"(公共目录下全员可见,其它仅
 *     root)。两条都过才允许落项目行 —— 因为 createAppSession 会顺手把这个
 *     路径登记成调用者名下的项目,那一步才是权限真正易手的地方。
 *
 * 拒绝时一律 404 且文案与"项目不存在"同形:不给"这个路径存不存在"的探针。
 */
export async function assertViewerMayCreateSessionAt(viewer: Viewer, projectPath: string): Promise<void> {
  const normalized = normalizeProjectPath(projectPath.trim());
  if (!normalized) {
    throw new AppError('projectPath is required.', { code: 'PROJECT_PATH_REQUIRED', statusCode: 400 });
  }

  const notFound = () => new AppError('项目不存在或你没有权限', {
    code: 'PROJECT_NOT_FOUND',
    statusCode: 404,
  });

  const registered = projectsDb.getProjectPath(normalized);
  if (!registered) {
    const workspace = await validateWorkspacePath(normalized);
    if (!workspace.valid) throw notFound();
  }

  if (!canViewerSeeProjectPath(viewer, normalized)) {
    throw notFound();
  }
}
