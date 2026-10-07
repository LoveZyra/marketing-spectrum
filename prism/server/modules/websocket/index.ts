export { WS_OPEN_STATE, connectedClients } from '@/shared/websocket-state.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
export { chatRunRegistry } from './services/chat-run-registry.service.js';
export { forgetObservedRun, observeOrphanFrames, observedRunStats } from './services/observed-run.service.js';
export { getPtyPoolStats } from './services/shell-websocket.service.js';
export {
  backgroundApprovalWriter, broadcastBackgroundTasks, broadcastRuntimeEvicted, broadcastSessionRestored, drainPendingSendForSession,
  handleMergedMessageEvent, hasPendingSendForSession, prepareSessionRemovedBroadcast, withdrawUnstartedUserTurn,
} from './services/chat-websocket.service.js';
// 删除会话前要判断终端是否正接管着它(见 sessions.service 的 deleteOrArchiveSessionById / isSessionInUse)。
export { currentHolder as currentConversationHolder } from './services/conversation-ownership.service.js';
export { broadcastPendingApprovalCount } from './services/admin-broadcast.service.js';
// 项目级实时推送(新建 / 改名 / 权限 / 归档 / 还原 / 转移属主 / 删除)。
export { broadcastProjectChange, prepareProjectChangeBroadcast } from './services/project-broadcast.service.js';
