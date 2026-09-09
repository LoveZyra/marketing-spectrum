import type { VerifyClientCallbackSync } from 'ws';

import { userDb } from '@/modules/database/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('ws-auth');

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  authenticateWebSocket: (token: string | null) => {
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null;
  /**
   * Single-use WebSocket ticket consumption (server/shared/ws-tickets.js —
   * `consumeTicket`). Injected by the composition root because the eslint
   * boundaries config keeps modules off ad-hoc shared files. When absent,
   * `?ticket=` values are ignored and the remaining mechanisms apply.
   */
  consumeTicket?: (ticket: string) => { userId: string | number } | null;
};

/** Query parameters that carry secrets and must never reach the logs. */
const REDACTED_QUERY_PARAMS = ['token', 'ticket'] as const;

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 *
 * OSS-mode acceptance order:
 * 1. `?ticket=` — single-use short-TTL ticket (primary query mechanism).
 * 2. `?token=`  — legacy JWT-in-query, honored ONLY when
 *    PRISM_ALLOW_QUERY_TOKEN === '1' (query strings leak into proxy logs).
 * 3. `Authorization: Bearer <jwt>` header — unchanged.
 */
export function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): boolean {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradeUrl = new URL(request.url ?? '/', 'http://localhost');
  const loggedUrl = new URL(upgradeUrl);
  for (const secretParam of REDACTED_QUERY_PARAMS) {
    if (loggedUrl.searchParams.has(secretParam)) {
      loggedUrl.searchParams.set(secretParam, 'REDACTED');
    }
  }

  // 每次连接都打;真正要紧的是**失败**那三条(下面都是 warn),成功的进 debug。
  log.debug('WebSocket 连接请求:', `${loggedUrl.pathname}${loggedUrl.search}`);

  // Platform mode: use the first DB user and skip token checks.
  if (dependencies.isPlatform) {
    const user = dependencies.authenticateWebSocket(null);
    if (!user) {
      log.warn('Platform mode: No user found in database');
      return false;
    }

    request.user = user;
    log.debug('平台模式 WebSocket 认证通过:', user.username);
    return true;
  }

  // OSS mode, mechanism 1: single-use ticket in the query string (primary).
  const ticket = upgradeUrl.searchParams.get('ticket');
  if (ticket && dependencies.consumeTicket) {
    const consumed = dependencies.consumeTicket(ticket);
    const numericUserId =
      consumed === null
        ? Number.NaN
        : typeof consumed.userId === 'number'
          ? consumed.userId
          : Number.parseInt(String(consumed.userId), 10);
    const user = Number.isFinite(numericUserId) ? userDb.getUserById(numericUserId) : undefined;

    /**
     * fj:票据也要校 `token_version` —— REST 与 JWT-WS 两条路都校,唯独这里没校。
     * 不校的后果:用户「退出所有设备」之后,已签发的那张 60 秒票据仍能开新连接。
     */
    const ticketTokenVersion = (consumed as { tokenVersion?: unknown } | null)?.tokenVersion;
    const tokenVersionMatches = ticketTokenVersion === null
      || ticketTokenVersion === undefined
      || Number(ticketTokenVersion) === Number((user as { token_version?: number })?.token_version ?? 0);

    if (user && tokenVersionMatches) {
      // Same user shape authenticateWebSocket produces in OSS mode.
      request.user = { userId: user.id, username: user.username };
      log.debug('WebSocket 票据认证通过:', user.username);
      return true;
    }
    if (user && !tokenVersionMatches) {
      log.warn('WebSocket ticket rejected (token_version 已失效 —— 用户登出过所有设备)');
    }

    // Invalid/expired/replayed ticket: fall through to the header (and, when
    // explicitly enabled, legacy query token) mechanisms below.
    log.warn('WebSocket ticket rejected (invalid, expired, or already used)');
  }

  // OSS mode, mechanisms 2+3: legacy JWT from the query string is accepted
  // only behind an explicit opt-in; the Authorization header path is the
  // long-standing default and is unchanged.
  const queryToken =
    process.env.PRISM_ALLOW_QUERY_TOKEN === '1'
      ? upgradeUrl.searchParams.get('token')
      : null;
  const token =
    queryToken ??
    request.headers.authorization?.split(' ')[1] ??
    null;

  const user = dependencies.authenticateWebSocket(token);
  if (!user) {
    log.warn('WebSocket authentication failed');
    return false;
  }

  request.user = user;
  log.debug('WebSocket 认证通过:', user.username);
  return true;
}
