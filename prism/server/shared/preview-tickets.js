// 编辑器沙箱预览用的短命票据。
//
// 为什么不复用发布 token:发布是一次深思熟虑的长期分享,撤销之前一直可达;
// 预览是"我看一眼长什么样",不该留下一个一直能用的 URL。两者互相顶替的结果,
// 要么是不小心铸出永久链接,要么是分享出去的链接五分钟就死。
//
// 为什么不用会话 JWT:预览跑在带 `sandbox` 且没有 `allow-same-origin` 的 iframe
// 里,它请求相对资源(./style.css、./chart.png)时既没有 Authorization 头也没有
// cookie —— 凭据只能放在 URL 里。一张 5 分钟、限定到项目+目录的票据,比一个
// 7 天有效的 JWT 小得多。
//
// 契约(其它模块按这两个名字导入,不要改名):
//   issuePreviewTicket({ projectId, relDir }) -> 64 位十六进制串
//   readPreviewTicket(ticket) -> { projectId, relDir } | null
//
// **和 WS 票据不同,这些不是一次性的**:一次预览要加载文档本身,外加它引用的
// 每一个资源。取出即删会让第一张图之后的所有请求全部失败。

import { createTicketStore } from './ticket-store.js';

export const PREVIEW_TICKET_TTL_MS = 5 * 60_000;

const store = createTicketStore({
  ttlMs: PREVIEW_TICKET_TTL_MS,
  singleUse: false,
});

/**
 * 签发一张限定到某项目某目录的预览票据。
 *
 * @param {{ projectId: string, relDir: string }} scope
 *   `relDir` 是被预览文档所在的项目内相对目录,项目根用 ''。预览能读到的一切
 *   都在它之下。
 * @returns {string} 32 字节随机数的 64 位十六进制串
 */
export function issuePreviewTicket({ projectId, relDir }) {
  return store.issue({
    projectId: String(projectId),
    relDir: String(relDir ?? ''),
  });
}

/**
 * 解析一张票据。未知或已过期返回 null。
 *
 * @param {string} ticket
 * @returns {{ projectId: string, relDir: string } | null}
 */
export function readPreviewTicket(ticket) {
  const payload = store.consume(ticket);
  return payload ? { projectId: payload.projectId, relDir: payload.relDir } : null;
}

/** 测试钩子:丢弃所有未过期票据。 */
export function resetPreviewTickets() {
  store.reset();
}
