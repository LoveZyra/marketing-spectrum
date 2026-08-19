import { projectVisibilityInput } from '@/modules/database/project-access.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { canViewerSeeProject } from '@/shared/project-visibility.js';
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
