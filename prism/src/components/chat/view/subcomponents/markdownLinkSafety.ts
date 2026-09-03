/**
 * dv:能真正渲染成可点链接的协议白名单。
 *
 * 正文里的链接来自**模型输出**,而模型输出里可以夹带任何东西(工具结果回显
 * 的外部内容尤其如此)。此前 `<a href={href}>` 是原样透传的:`javascript:` /
 * `vbscript:` 一点就在应用同源里执行脚本,`data:text/html` 同理,`file:` 则
 * 拿去探本机路径。这些一律降级为纯文本(保留字面量,让人看得见它写了什么),
 * 只有 http/https/mailto/tel 与页内锚点才真的挂 href。
 */
const SAFE_LINK_PROTOCOL = /^(https?:|mailto:|tel:)/i;

export function safeLinkHref(href?: string): string | null {
  const raw = (href || '').trim();
  if (!raw) return null;
  if (raw.startsWith('#')) return raw;
  // 去掉可能用来绕过前缀匹配的控制字符与零宽字符(浏览器解析 URL 时会忽略它们)。
  const normalized = raw.replace(/[\u0000-\u0020\u00a0\u180e\u200b-\u200d\ufeff]/g, '');
  if (SAFE_LINK_PROTOCOL.test(normalized)) return raw;
  // 没有协议的相对链接(`./doc.md`、`/docs/x`)交给下面的文件路径分支处理;
  // 到这里还带冒号的一律当危险协议拒掉。
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return null;
  return raw;
}
