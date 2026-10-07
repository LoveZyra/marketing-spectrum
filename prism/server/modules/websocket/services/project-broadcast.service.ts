import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { canViewerSeeProject, isPublicWorkspacePath, readSocketViewer } from '@/shared/project-visibility.js';
import type { ProjectRepositoryRow, RealtimeClientConnection } from '@/shared/types.js';
import { connectedClients, WS_OPEN_STATE } from '@/shared/websocket-state.js';

/**
 * 项目级的实时推送 —— `project_upserted` / `project_removed`。
 *
 * `session_upserted` 只在 jsonl 变化时由 `sessions-watcher` 发;项目本身的变化(新建共享项目、
 * 改名、权限改公开、归档、转移属主、删除)靠这里推给其他标签页,否则要手动刷新才看得到。
 *
 * 名单与 `session_upserted` 用同一条可见性判定(`canViewerSeeProject`),逐 socket 判:
 * 一次权限变更之后,能看见的人收 `project_upserted`(带按他视角算的
 * `isStarred / sharedWithViewer`),原来能看、现在看不见的人收 `project_removed` ——
 * 所以要在改行之前先把"现在谁看得见"这份名单收下来(`prepareProjectChangeBroadcast`),
 * 行改完再发。删除同理:行没了就判不出可见性,只能靠事先收的名单。
 *
 * 帧里不带会话列表:前端对已知项目只合并这几个字段(会话列表由 `session_upserted`
 * 各自维护),对陌生的新项目则静默重拉一次列表 —— 一个陌生项目可能已经有几十条
 * 会话,塞进一帧里既大又和分页语义打架。
 */

export type ProjectChangeReason =
  | 'created'
  | 'renamed'
  | 'permissions'
  | 'owner'
  | 'archived'
  | 'restored'
  | 'deleted'
  | 'revived';

type ProjectFrameView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  customName: string | null;
  isArchived: boolean;
  isStarred: boolean;
  ownerUserId: number | null;
  isPublic: boolean;
  sharedWithViewer: boolean;
  sharedUserCount: number;
};

const openSockets = (): RealtimeClientConnection[] => {
  const out: RealtimeClientConnection[] = [];
  for (const client of connectedClients) {
    try {
      if (client.readyState === WS_OPEN_STATE) out.push(client);
    } catch {
      // 单个 socket 出错不影响其余
    }
  }
  return out;
};

const socketCanSee = (socket: RealtimeClientConnection, project: ProjectRepositoryRow, sharedUserIds: number[]): boolean => {
  const viewer = readSocketViewer(socket);
  return canViewerSeeProject({
    ownerUserId: project.owner_user_id ?? null,
    projectPath: project.project_path,
    visibility: project.visibility ?? null,
    sharedUserIds,
    viewerUserId: viewer.userId,
    viewerUsername: viewer.username,
  });
};

const buildView = (project: ProjectRepositoryRow, sharedUserIds: number[], viewerUserId: number | string | null): ProjectFrameView => {
  const ownerUserId = project.owner_user_id ?? null;
  const numericViewer = typeof viewerUserId === 'number' ? viewerUserId : Number(viewerUserId);
  const viewerKnown = Number.isFinite(numericViewer);
  const customName = project.custom_project_name?.trim() ? project.custom_project_name.trim() : null;
  return {
    projectId: project.project_id,
    path: project.project_path,
    fullPath: project.project_path,
    displayName: customName ?? (path.basename(project.project_path) || project.project_path),
    customName,
    isArchived: Boolean(project.isArchived),
    isStarred: viewerKnown ? projectsDb.isProjectStarredByUser(project.project_id, numericViewer) : false,
    ownerUserId,
    isPublic: project.visibility === 'public' || (ownerUserId === null && isPublicWorkspacePath(project.project_path)),
    sharedWithViewer: viewerKnown && ownerUserId !== numericViewer && sharedUserIds.includes(numericViewer),
    sharedUserCount: sharedUserIds.length,
  };
};

const sendSafely = (socket: RealtimeClientConnection, frame: string): boolean => {
  try {
    if (socket.readyState !== WS_OPEN_STATE) return false;
    socket.send(frame);
    return true;
  } catch {
    return false;
  }
};

/**
 * 改行之前收一份"现在谁看得见这个项目"的名单。返回的函数在改完之后调用,
 * 负责把 `project_upserted` / `project_removed` 分发出去。
 *
 * 项目不存在时(id 打错)返回的函数什么都不发。
 */
export function prepareProjectChangeBroadcast(projectId: string): (reason: ProjectChangeReason) => number {
  const before = new Set<RealtimeClientConnection>();
  try {
    const row = projectsDb.getProjectById(projectId);
    if (row) {
      const shares = projectsDb.getProjectSharedUserIds(projectId);
      for (const socket of openSockets()) {
        if (socketCanSee(socket, row, shares)) before.add(socket);
      }
    }
  } catch {
    // 名单收不齐只会少发几帧,不影响操作本身
  }
  return (reason) => broadcastProjectChange(projectId, reason, before);
}

/**
 * 按当前状态分发。`before` 是改行之前能看见的 socket 名单(没有就当空集,
 * 只发 upserted —— 新建项目走这条)。
 *
 * 归档 / 删除:给 before 里的每个人发 `project_removed`(归档的项目从活跃列表消失,
 * 语义上就是"从你的侧栏拿掉");还原 / 其它:能看见的发 upserted,看不见但原来能看的发 removed。
 */
export function broadcastProjectChange(
  projectId: string,
  reason: ProjectChangeReason,
  before: Set<RealtimeClientConnection> = new Set(),
): number {
  let sent = 0;
  const timestamp = new Date().toISOString();
  const removedFrame = JSON.stringify({ kind: 'project_removed', projectId, reason, timestamp });

  let row: ProjectRepositoryRow | null = null;
  let shares: number[] = [];
  try {
    row = projectsDb.getProjectById(projectId);
    shares = row ? projectsDb.getProjectSharedUserIds(projectId) : [];
  } catch {
    row = null;
  }

  if (!row || row.isArchived) {
    for (const socket of before) {
      if (sendSafely(socket, removedFrame)) sent += 1;
    }
    return sent;
  }

  for (const socket of openSockets()) {
    if (socketCanSee(socket, row, shares)) {
      const viewer = readSocketViewer(socket);
      const frame = JSON.stringify({
        kind: 'project_upserted',
        projectId,
        reason,
        project: buildView(row, shares, viewer.userId),
        timestamp,
      });
      if (sendSafely(socket, frame)) sent += 1;
    } else if (before.has(socket)) {
      if (sendSafely(socket, removedFrame)) sent += 1;
    }
  }
  return sent;
}
