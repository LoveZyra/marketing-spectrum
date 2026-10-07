/**
 * 客户端 IP 的唯一判定。
 *
 * 放在 shared/ 叶子上,是因为 modules 层(providers / projects 的删除路由要给审计记 ip)
 * 按边界规则不能 import middleware。X-Forwarded-For 只在 PRISM_TRUST_PROXY 打开时才信:
 * 否则能直连 socket 的攻击者每个请求都能伪造一个新 IP,绕过所有限流。
 *
 * `PRISM_TRUST_PROXY` 在这里每次现读(不在模块顶层缓存):这个文件可能在 load-env 之前
 * 被 import(测试、CLI),缓存会把"还没读到 .env"的那一刻定死。rate-limit.js 另有一个
 * 启动时读取的 TRUST_PROXY 布尔常量,两处判据相同。
 */

/**
 * 信任几层反代。`PRISM_TRUST_PROXY` 不设 / `0` / `false` → 0(不信 XFF);
 * `1` / `true` → 1(前面一层 nginx,最常见);填数字 N → N 层(最多 10)。
 */
export function trustProxyHops() {
  const raw = String(process.env.PRISM_TRUST_PROXY ?? '').trim();
  if (raw === '' || raw === '0' || raw.toLowerCase() === 'false') return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 1;
}

/**
 * Best-effort client IP.
 *
 * 取 X-Forwarded-For 从右数第 N 项,不取最左项:nginx 的 `$proxy_add_x_forwarded_for`
 * 把它看到的对端地址追加在客户端自带的 XFF 后面,最左项由客户端随意填写,信它就能每个请求
 * 换一个假 IP,绕过限流与登录锁定、伪造审计来源。信任 N 层反代时真实客户端是从右数第 N 项;
 * 条目不够 N 个(反代少于配置)就取最左那个,与 Express 的 `trust proxy = N` 同口径。
 *
 * @param {{ headers?: Record<string, unknown>, ip?: string, socket?: { remoteAddress?: string } }} req
 * @returns {string}
 */
export function clientIp(req) {
  const hops = trustProxyHops();
  if (hops > 0) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      const entries = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
      if (entries.length > 0) {
        return entries[Math.max(0, entries.length - hops)];
      }
    }
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
