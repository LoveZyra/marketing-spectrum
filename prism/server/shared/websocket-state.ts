import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * 活跃 WebSocket 连接的共享注册表与 readyState 常量。
 *
 * 放在 shared/ 而不是 websocket 模块里:eslint 的模块边界要求跨模块必须走 barrel,
 * 而 `@/modules/websocket/index.js` 会拉进 chat-websocket,后者又 import providers 的 barrel。
 * providers(sessions-watcher)和 projects(projects-with-sessions-fetch)若经由这个 barrel
 * 广播更新就会成环。连接注册表和 readyState 常量不属于任何业务模块,放在 shared/ 之后
 * 各模块都只向下引用。
 *
 * prism-internal-transcripts、project-display-name 放在 shared/ 也是同样的原因:
 * 「A 和 B 都要用、放谁那儿都成环」的低层原语属于这里。
 */

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * Exported here so services that broadcast updates do not need to import `ws`
 * directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Numeric readyState for a connection still completing its handshake.
 *
 * Distinguished from CLOSED/CLOSING because a CONNECTING socket is still going
 * to become usable — anything pruning dead connections must not drop it.
 */
export const WS_CONNECTING_STATE = 0;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();
