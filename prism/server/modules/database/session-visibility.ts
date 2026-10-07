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
 * 谁能改变一条会话的去留(归档 / 还原 / 永久删除):root、所属项目的 owner、
 * 会话发起人(显示日志第一条用户消息的发送者)。其余可见者 403。
 *
 * 不能用"看得见就能做":`sessions.isArchived` 是单列全局的,共享项目里任何协作者
 * 归档别人的会话,所有人当场都看不见;永久删除更会把别人跑了一天的对话连 transcript
 * 一起删掉。而协作者在他人项目里自己开的会话,要允许他自己处置,所以多一维"会话发起人"
 * (前提是他现在还看得见这个项目)。
 *
 * 无主项目(`owner_user_id IS NULL`)没有"负责人"这一档可以收紧到,直接回落到可见性。
 * 无主的可见性本身是收着的(只有落在 `PRISM_PUBLIC_WORKSPACE` 之下才对所有人可见,
 * 否则仅 root),所以这条回落不会放开任何原本看不见的东西:
 *   - 无主 + 不在公共目录 → 非 root 连看都看不见,这里返回 false,调用方本来也已 404;
 *   - 无主 + 在公共目录 → 对所有人可见,于是也对所有人可动。
 * 必须回落:监视器在磁盘上扫到新路径时 `createProjectPath(path)` 不带 owner(有人在终端里
 * 直接跑 `claude` 就会这样),这类会话也没有显示日志、查不出发起人。若判成"只有 root 能动",
 * 公共目录部署下普通用户删自己刚开的会话会拿 403,「清空归档」也会逐条跳过。
 * (项目级的归档 / 永久删除对无主项目只给 root —— 那是整棵项目,不是一条会话。)
 *
 * 没有项目路径的会话只有 root 能动 —— 与 `canViewerSeeSession` 同一条口径。
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
  if (String(owner) === String(viewer.userId)) return true;
  // 会话发起人 —— 前提是他现在还看得见这个项目(被移出共享名单的人不算)。
  const initiator = sessionsDb.getSessionInitiatorUserId(sessionId);
  return initiator !== null
    && String(initiator) === String(viewer.userId)
    && canViewerSeeSession(sessionId, viewer);
}
