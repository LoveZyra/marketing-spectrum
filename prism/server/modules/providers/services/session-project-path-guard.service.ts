import { canViewerSeeProjectPath, projectsDb } from '@/modules/database/index.js';
import type { Viewer } from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';

/**
 * dz:`POST /api/providers/sessions` 的 projectPath 必须过的两道门。
 *
 * 症状(实测,非 root 用户 mallory):
 *   POST /api/providers/sessions {projectPath:"/"}  → 201
 * 然后 `projects` 表里多了一行 `project_path='/'`、**owner = mallory**;
 * 接着 `GET /api/projects/<id>/files` 直接列出服务器根目录,`chat.send` 也会以
 * cwd=/ 跑 agent。任务路由(tasks.routes.ts)在上一轮已经为完全相同的洞补了
 * `validateWorkspacePath + canViewerSeeProjectPath`,注释里还写着
 * "任何登录用户都能建一个 projectPath:'/' 的任务" —— 会话这条路当时漏了,
 * 而它比定时任务更直接:建完立刻就能聊。
 *
 * 两道门:
 *  1. **已登记的项目**:只看可见性(owner / 公共 / 指定共享 / root)。它当初
 *     登记时已经过了工作区校验,这里不再重验 —— 免得 WORKSPACES_ROOT 后来改过
 *     时把 root 自己的老项目也拦住。
 *  2. **没登记的路径**:必须**同时**满足"在工作区根内、不是系统目录"
 *     (validateWorkspacePath)和"对这个人可见"(公共目录下全员可见,其它仅
 *     root)。两条都过才允许落项目行 —— 因为 createAppSession 会顺手把这个
 *     路径登记成**调用者名下**的项目,那一步才是权限真正易手的地方。
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
