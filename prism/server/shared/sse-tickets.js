import { createTicketStore } from './ticket-store.js';

/**
 * HTTP SSE(EventSource)用的短命票据。
 *
 * EventSource 发起 GET 时设不了 Authorization 头,只能把凭据放进查询串,而查询串会进
 * 反代 access log 和浏览器历史。所以这里发短命票据而不是 JWT:日志里留下的那一份,
 * 60 秒后就废了。
 *
 * 与 WS 票据的区别:可在有效期内重复消费(`singleUse:false`)。EventSource 断线会用
 * 同一个 URL 自动重连,一次性票会让重连立刻 401。60 秒窗口足够覆盖一次搜索及其偶发
 * 重连,又短到泄漏无实际价值。
 */
export const SSE_TICKET_TTL_MS = 60_000;

const store = createTicketStore({ ttlMs: SSE_TICKET_TTL_MS, singleUse: false });

/**
 * 为指定用户签发一张 SSE 票据。返回 64 位十六进制串。
 *
 * 签发时的 `token_version` 随票据保存,消费方比对:「退出所有设备」之后这张票立即作废,
 * 而不是还能用满 60 秒。
 *
 * @param {number|string} userId
 * @param {number|null} [tokenVersion]
 */
export function issueSseTicket(userId, tokenVersion = null) {
  if (userId === undefined || userId === null || userId === '') {
    throw new Error('issueSseTicket requires a userId');
  }
  return store.issue({ userId, tokenVersion: typeof tokenVersion === 'number' ? tokenVersion : null });
}

/** 消费一张 SSE 票据。过期/未知返回 null;有效期内可重复消费。 */
export function consumeSseTicket(ticket) {
  const payload = store.consume(ticket);
  return payload ? { userId: payload.userId, tokenVersion: payload.tokenVersion ?? null } : null;
}

/**
 * SSE 票据只在这些路径上有效。票据只该打开它被签发的那一扇门:若任何路由都认 `?ticket=`,
 * 一张签给搜索的 60 秒票就能拿去换 WS 票开 shell、建一把永久 API key。
 * 路径是挂载点 + 路由(`req.baseUrl + req.path`),与 index.js 的装配一一对应。
 */
export const SSE_TICKET_PATHS = new Set([
  '/api/providers/search/sessions',
]);

/** 仅供测试。 */
export function __resetSseTicketsForTest() {
  store.reset();
}
