import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * 活跃 WebSocket 连接的共享注册表与 readyState 常量。
 *
 * ## 为什么住在 shared/ 而不是 websocket 模块里
 *
 * 它本身只依赖一个类型,是个纯叶子。但它原来待在 `websocket/services/` 下,而
 * eslint 的模块边界要求**跨模块必须走 barrel** —— 于是 `sessions-watcher`(providers)
 * 和 `projects-with-sessions-fetch`(projects)想广播一条更新,就得 import
 * `@/modules/websocket/index.js`,而那个 barrel 又把 chat-websocket 拉进来,
 * chat-websocket 再 import `@/modules/providers/index.js`……环就成了。
 *
 * `madge --circular --ts-config server/tsconfig.json server` 实测:搬走
 * generateDisplayName 之后还剩 2 个环,全部以这条边为骨。
 *
 * ## 这是"barrel 强制"与"防环"的正面冲突
 *
 * 边界规则本身是对的(它防的是模块之间乱伸手),但它把**低层原语**也一起推上了
 * barrel。解法不是给规则开后门,而是承认这类东西根本不属于任何一个业务模块:
 * 连接注册表和 readyState 常量既不是 websocket 的业务,也不是 providers 的,
 * 它就是个公共设施 —— 放 shared/ 之后两边都往下引,不互相引。
 *
 * 同一形状的第三例(前两例:prism-internal-transcripts、project-display-name)。
 * 下次再遇到"A 和 B 都要用、放谁那儿都成环"的东西,先想它是不是也该在这儿。
 */

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
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
