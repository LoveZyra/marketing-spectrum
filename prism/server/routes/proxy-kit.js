/**
 * 反代公共骨架。ma-proxy 和 recsys-proxy 共用这一份。
 *
 * 为什么要单独抽一个文件:反代文档把"只转回环""剥 Prism 凭据"写成了**不可绕过**
 * 的硬约束,而当时的做法是让每个新反代去 `cp` 一份现成的再改名字。复制粘贴的
 * 问题不在写的时候,在改的时候 —— 哪天回环判断要补一条(比如某种新的 IPv6
 * 写法),复制出去的那几份不会跟着变,而且没有任何东西会提醒你它们存在。
 * 所以约束放这里一份,谁挂反代都必须从这里拿。
 *
 * 这里只放**判断和拼装**,不放转发循环:ma-proxy 那圈 pipe 带着一段和 Python
 * 上游有关的 `agent:false` 的来龙去脉,recsys 要做的又是改 Location、不做白名单,
 * 两边的循环本来就不一样,硬合成一个反而要靠参数去区分,那就白抽了。
 */

// RFC 7230 逐跳首部:代理必须就地消费,不能转发。
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Prism 自己的凭据,不带去下游。上游的日志不该出现 Prism 的 JWT。
export const PRISM_CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'x-prism-api-key']);

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 解析上游地址。只认回环。
 *
 * 这层如果能转发到任意主机,Prism 就成了一台现成的 SSRF 跳板 —— 谁能访问 8080,
 * 谁就能拿它去打内网。配错了的结果是**启动时不挂载**,而不是默默转发出去。
 *
 * @returns {{ok: true, host: string, port: number, label: string} | {ok: false, reason: string}}
 */
export function parseUpstream(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'unparsable' };
  }
  if (url.protocol !== 'http:') {
    return { ok: false, reason: 'protocol_not_http' };
  }
  const hostname = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    // 故意不给"改成回环就行"之外的出路:非回环目标一律拒绝。
    return { ok: false, reason: 'not_loopback' };
  }
  const port = Number.parseInt(url.port || '80', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: 'bad_port' };
  }
  // hostname 对 IPv6 会带方括号,http.request 要的是不带的。
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  return { ok: true, host, port, label: `${hostname}:${port}` };
}

/** 按 RFC,Connection 里点名的首部也算逐跳,一并剥掉。 */
export function connectionListed(headers) {
  const raw = headers.connection;
  if (typeof raw !== 'string') return new Set();
  return new Set(
    raw
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * 组装转发给上游的首部:剥逐跳、剥 Prism 凭据、补 X-Forwarded-*。
 * 导出是为了让测试能直接盯住"到底带了什么下去"。
 */
export function buildUpstreamHeaders(req, upstreamLabel) {
  const dropped = connectionListed(req.headers);
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'host') continue;
    if (HOP_BY_HOP.has(lower)) continue;
    if (PRISM_CREDENTIAL_HEADERS.has(lower)) continue;
    if (dropped.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = value;
  }
  out.host = upstreamLabel;

  const clientAddress = req.ip || req.socket?.remoteAddress || '';
  const priorForwarded = req.headers['x-forwarded-for'];
  const chain = [
    typeof priorForwarded === 'string' && priorForwarded ? priorForwarded : null,
    clientAddress || null,
  ].filter(Boolean);
  if (chain.length > 0) out['x-forwarded-for'] = chain.join(', ');
  out['x-forwarded-proto'] = req.protocol || 'http';
  if (typeof req.headers.host === 'string') out['x-forwarded-host'] = req.headers.host;

  return out;
}
