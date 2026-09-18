import { projectVisibilityInput } from '@/modules/database/project-access.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { canViewerSeeProject } from '@/shared/project-visibility.js';
import { isRootUser } from '@/shared/root-users.js';
import type { Viewer } from '@/shared/types.js';

/**
 * Whether a viewer may touch a session.
 *
 * A session carries no owner of its own — it hangs off a project, and the
 * project is what has one. So the resolution is session → project path →
 * project owner → the same `canViewerSeeProject` rule the sidebar list and the
 * realtime broadcast use. One rule, three call paths, no drift.
 *
 * This lives in the database module rather than next to either caller because
 * both the providers module (REST) and the websocket module (chat.subscribe,
 * abort, permission responses) need it, and providers already imports
 * websocket — putting it on either side would close a dependency cycle.
 *
 * A session that does not exist resolves to `false`, not `true`. Callers turn
 * that into a 404, which makes "no such id" and "not yours" indistinguishable
 * from outside; a 403 would confirm the id exists and hand an attacker a free
 * existence oracle over a guessable id space.
 */
export function canViewerSeeSession(sessionId: string, viewer: Viewer): boolean {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    return false;
  }

  const projectPath = session.project_path?.trim() ? session.project_path : null;
  if (!projectPath) {
    // A session indexed before its project row exists: root only. `-1` is an
    // owner id nobody has, which reuses the one rule instead of hand-rolling a
    // second root check here.
    return canViewerSeeProject({
      ownerUserId: -1,
      viewerUserId: viewer.userId,
      viewerUsername: viewer.username,
    });
  }

  const project = projectsDb.getProjectPath(projectPath);
  return canViewerSeeProject({
    ...projectVisibilityInput(project, projectPath),
    viewerUserId: viewer.userId,
    viewerUsername: viewer.username,
  });
}

/**
 * gk:谁能**永久删除**一条会话 —— root,或它所属项目的 owner。
 *
 * 与 `canViewerSeeSession` 分开是这次事故的直接教训:此前"看得见 = 能永久删",
 * 共享项目里任何一位协作者都能把别人跑了一天的对话连 transcript 一起删掉。
 * 归档仍然是"看得见就能做"(可逆);只有不可逆的那一档收紧到 owner / root。
 *
 * 会话自己没有 owner(它挂在项目上),所以"创建者"这个维度这里给不出来。
 *
 * ## 无主项目(`owner_user_id IS NULL`)回到旧口径:看得见就能永久删
 *
 * 无主项目没有"负责人"这一档可以收紧到,所以这里直接回落到可见性。
 * 无主的可见性本身是收着的(2026-08-14 起:只有落在 `PRISM_PUBLIC_WORKSPACE`
 * 之下才对所有人可见,否则仅 root),所以这条回落**不会放开任何原本看不见的东西**:
 *   - 无主 + 不在公共目录 → 非 root 连看都看不见,这里返回 false,调用方本来也已 404;
 *   - 无主 + 在公共目录 → 对所有人可见,于是也对所有人可删 —— 与 gj 一致。
 *
 * 之所以要专门回落:监视器在磁盘上扫到新路径时就是 `createProjectPath(path)`,
 * 不带 owner(有人在终端里直接跑 `claude` 就会这样)。公共目录部署下若把无主也判成
 * "只有 root 能永久删",后果是普通用户删自己刚开的会话拿 403,而「清空归档」
 * 逐条跳过、返回 `{deleted: 0, skipped: N}` —— 界面上看着像点了没反应。
 *
 * 没有项目路径的会话仍然只有 root 能动 —— 与 `canViewerSeeSession` 同一条口径。
 *
 * 不存在的会话返回 false —— 调用方与可见性判定一样统一回 404。
 */
export function canViewerManageSession(sessionId: string, viewer: Viewer): boolean {
  if (isRootUser(viewer.username ?? undefined)) {
    return sessionsDb.getSessionById(sessionId) !== null;
  }
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) return false;
  const projectPath = session.project_path?.trim() ? session.project_path : null;
  if (!projectPath) return false;
  const project = projectsDb.getProjectPath(projectPath);
  const owner = project?.owner_user_id;
  if (owner === null || owner === undefined) return canViewerSeeSession(sessionId, viewer);
  if (viewer.userId === null || viewer.userId === undefined) return false;
  return String(owner) === String(viewer.userId);
}
