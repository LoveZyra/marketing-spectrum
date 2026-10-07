import { createTicketStore } from './ticket-store.js';

/**
 * WebSocket 升级用的一次性票据。
 *
 * 浏览器发起 WebSocket 时设不了 Authorization 头,只能把凭据放进查询串 —— 而
 * 查询串会进代理日志和浏览器历史。所以这里发的是短命、一次性的票据而不是 JWT:
 * 日志里留下的那一份,拿到手也已经用过了。
 *
 * 存储与清扫逻辑在 `ticket-store.js`,与其他票据共用一份实现。
 */

export const WS_TICKET_TTL_MS = 60_000;

const store = createTicketStore({ ttlMs: WS_TICKET_TTL_MS });

/**
 * 为指定用户签发一张一次性 WebSocket 票据。
 *
 * @param {string|number} userId
 * @param {number|null} [tokenVersion] 签发时的 token_version
 * @returns {string} 32 字节随机数的 64 位十六进制串
 */
export function issueTicket(userId, tokenVersion = null) {
  if (userId === undefined || userId === null || userId === '') {
    throw new Error('issueTicket requires a userId');
  }
  // token_version 随票据保存,升级时与账号当前值比对:「退出所有设备 / 改密码」之后,
  // 已签发出去的票据不能再开新 socket。
  return store.issue({ userId, tokenVersion });
}

/**
 * 消费一张票据。有效期内且只能用一次。
 *
 * @param {unknown} ticket
 * @returns {{ userId: string|number, tokenVersion: number|null } | null} 未知、已用过或已过期都返回 null
 */
export function consumeTicket(ticket) {
  const payload = store.consume(ticket);
  return payload ? { userId: payload.userId, tokenVersion: payload.tokenVersion ?? null } : null;
}

/** 仅供测试。 */
export function __resetTicketsForTest() {
  store.reset();
}
