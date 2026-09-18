/**
 * gk:客户端 IP 的唯一判定,搬到叶子上。
 *
 * 原来住在 `middleware/rate-limit.js` 里,只有 `routes/` 那层能 import 它;
 * modules 层(providers / projects 的删除路由要给审计记 ip)按边界规则碰不到
 * middleware。判据一个字都没改:X-Forwarded-For 只在 PRISM_TRUST_PROXY 打开时
 * 才信 —— 能直连 socket 的攻击者否则每个请求都能伪造一个新 IP,把所有限流全部绕过。
 *
 * `PRISM_TRUST_PROXY` 在这里**每次现读**(不在模块顶层缓存):这个文件可能在
 * load-env 之前被 import(测试、CLI),缓存会把"还没读到 .env"的那一刻定死。
 * rate-limit.js 自己那份 TRUST_PROXY 常量保留给限流器,两处口径相同。
 */

const trustProxy = () => {
  const raw = process.env.PRISM_TRUST_PROXY;
  if (raw === undefined || raw === '') return false;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};

/**
 * Best-effort client IP.
 * @param {{ headers?: Record<string, unknown>, ip?: string, socket?: { remoteAddress?: string } }} req
 * @returns {string}
 */
export function clientIp(req) {
  if (trustProxy()) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
