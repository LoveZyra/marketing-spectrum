export { WS_OPEN_STATE, connectedClients } from '@/shared/websocket-state.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
export { chatRunRegistry } from './services/chat-run-registry.service.js';
export { noteMergedSend, observeOrphanFrames, observedRunStats } from './services/observed-run.service.js';
export { getPtyPoolStats } from './services/shell-websocket.service.js';
export { broadcastRuntimeEvicted, drainPendingSendForSession, hasPendingSendForSession } from './services/chat-websocket.service.js';
// fl:会话删除前要判"终端有没有接管着它"(见 sessions.service 的 deleteOrArchive)。
export { currentHolder as currentConversationHolder } from './services/conversation-ownership.service.js';
export { broadcastPendingApprovalCount } from './services/admin-broadcast.service.js';
