import { createTicketStore } from './ticket-store.js';

/**
 * HTTP SSE(EventSource)用的短命票据。
 *
 * EventSource 发起 GET 时**设不了 Authorization 头**,只能把凭据放进查询串 ——
 * 而查询串会进反代 access log 和浏览器历史。所以搜索 SSE 过去直接把 7 天有效的
 * JWT 拼进 `?token=`,泄一次就是一把可用令牌。这里改发短命票据:日志里留下的
 * 那一份,60 秒后就废了。
 *
 * 与 WS 票据的区别:**可在有效期内重复消费**(`singleUse:false`)。EventSource
 * 断线会自动重连、用同一个 URL —— 一次性票会让重连立刻 401。60 秒窗口足够覆盖
 * 一次搜索及其偶发重连,又短到泄漏无实际价值。
 */
export const SSE_TICKET_TTL_MS = 60_000;

const store = createTicketStore({ ttlMs: SSE_TICKET_TTL_MS, singleUse: false });

/** 为指定用户签发一张 SSE 票据。返回 64 位十六进制串。 */
export function issueSseTicket(userId) {
  if (userId === undefined || userId === null || userId === '') {
    throw new Error('issueSseTicket requires a userId');
  }
  return store.issue({ userId });
}

/** 消费一张 SSE 票据。过期/未知返回 null;有效期内可重复消费。 */
export function consumeSseTicket(ticket) {
  const payload = store.consume(ticket);
  return payload ? { userId: payload.userId } : null;
}

/** 仅供测试。 */
export function __resetSseTicketsForTest() {
  store.reset();
}
