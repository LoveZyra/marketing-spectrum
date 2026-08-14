import type { RealtimeClientConnection } from '@/shared/types.js';

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
