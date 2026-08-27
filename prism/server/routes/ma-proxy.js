/**
 * 营销诊断 API 反向代理:把 Prism 8080 上的 /api/ma/* 转到本机回环的诊断服务。
 *
 * 为什么要这层:
 *   公司那台 ma_server 的网关只转发 8080(方案文档 §1.3),诊断服务另起端口
 *   从外面根本打不通。与其去申请网关规则,不如借 Prism 已经暴露的 8080 走一
 *   条路径前缀进去 —— 诊断服务因此可以一直绑回环,不用对外开口子。
 *
 * 三条硬约束:
 *   1. 只允许回环目标。这层如果能转发到任意主机,Prism 就成了一台现成的 SSRF
 *      跳板 —— 谁能访问 8080,谁就能拿它去打内网。parseUpstream() 拒绝一切非
 *      回环地址,配错了就是启动时不挂载,而不是默默转发。
 *   2. 路径白名单。诊断服务的接口就那五个,按精确正则放行;不做通配转发,免得
 *      以后那边多出一个调试接口就跟着一起暴露了。
 *   3. 不外带 Prism 自己的凭据。Authorization / Cookie / x-prism-api-key 一律
 *      剥掉:诊断服务用的是它自己的 x-ma-api-key,把 Prism 的 JWT 顺手灌进另一
 *      个进程的日志里没有任何好处。
 *
 * 鉴权分工:这层不校验,由下游诊断服务用 x-ma-api-key 校验(它自己会拒 401)。
 * 所以挂载点必须在 Prism 的 validateApiKey 之前 —— 外部调用方拿的是诊断服务的
 * key,不是 Prism 的 key。限流则要在前面,见 index.js 的挂载顺序。
 *
 * 环境变量(都不配 = 整层不挂载,Prism 行为与之前完全一致):
 *   PRISM_MA_API_TARGET      形如 127.0.0.1:8092 或 http://127.0.0.1:8092
 *   PRISM_MA_API_TIMEOUT_MS  上游超时,默认 120000
 *   PRISM_MA_API_MAX_BODY    请求体上限字节,默认 262144(下游自己是 64KB)
 */

import http from 'http';

import express from 'express';

import {
  HOP_BY_HOP,
  buildUpstreamHeaders,
  connectionListed,
  parseUpstream,
} from './proxy-kit.js';

// parseUpstream / buildUpstreamHeaders 搬进了 proxy-kit(recsys-proxy 要用同一份),
// 这里原样再导出一次:它们是本文件公开过的接口,不该因为内部搬家就让调用方改 import。
export { buildUpstreamHeaders, parseUpstream };

/** 挂载前缀。index.js 和测试共用这一个常量,别两头各写一遍。 */
export const MA_PROXY_PREFIX = '/api/ma';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BODY = 256 * 1024;

// 只放行诊断服务真实存在的接口。job_id 用 [A-Za-z0-9_-] 是照着
// job_20260729_114613_cf123e 这种实际形态收的;顺带把 %2e%2e 这类编码穿越
// 挡在外面 —— 这里比对的是未解码的原始路径,`%` 本身就不在字符集里。
const JOB_ID = '[A-Za-z0-9_-]{1,64}';
const ROUTES = [
  { method: 'GET', pattern: new RegExp('^/healthz$'), to: () => '/healthz' },
  { method: 'POST', pattern: new RegExp('^/diagnose$'), to: () => '/api/ma/diagnose' },
  { method: 'GET', pattern: new RegExp('^/jobs$'), to: () => '/api/ma/jobs' },
  { method: 'GET', pattern: new RegExp(`^/jobs/${JOB_ID}$`), to: (p) => `/api/ma${p}` },
  { method: 'GET', pattern: new RegExp(`^/jobs/${JOB_ID}/result$`), to: (p) => `/api/ma${p}` },
];

// 查询串放行的字符。诊断服务目前不读 query,这里只是别把奇怪的东西透下去。
const SAFE_QUERY = /^[A-Za-z0-9_\-=&%.,:+]{0,512}$/;

/**
 * 把挂载点之后的剩余路径映射成上游路径。
 * @returns {{ok: true, path: string} | {ok: false, status: 404|405}}
 */
export function resolveUpstreamPath(method, pathname) {
  let pathMatched = false;
  for (const route of ROUTES) {
    if (!route.pattern.test(pathname)) continue;
    pathMatched = true;
    if (route.method === method) return { ok: true, path: route.to(pathname) };
  }
  // 路径认识但方法不对 → 405,让调用方一眼看出是自己发错了动词。
  return { ok: false, status: pathMatched ? 405 : 404 };
}

/**
 * 建代理路由。target 解析不通就返回 null —— 调用方据此决定不挂载,
 * 宁可这条路径 404,也不要挂一个指向不明的转发器上去。
 */
export function createMaProxyRouter({
  target,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_MAX_BODY,
  logger = console,
} = {}) {
  const upstream = parseUpstream(target);
  if (!upstream.ok) {
    if (upstream.reason !== 'empty') {
      logger.warn?.(
        `[ma-proxy] PRISM_MA_API_TARGET=${JSON.stringify(target)} 不可用(${upstream.reason}),` +
          `${MA_PROXY_PREFIX} 未挂载。只接受回环地址,例如 127.0.0.1:8092。`
      );
    }
    return null;
  }

  const router = express.Router();

  router.use((req, res) => {
    const rawUrl = req.url || '/';
    const queryAt = rawUrl.indexOf('?');
    const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
    const query = queryAt === -1 ? '' : rawUrl.slice(queryAt + 1);

    const resolved = resolveUpstreamPath(req.method, pathname);
    if (!resolved.ok) {
      res.status(resolved.status).json({
        error: resolved.status === 405 ? 'E_METHOD_NOT_ALLOWED' : 'E_NOT_FOUND',
        message:
          resolved.status === 405
            ? `${req.method} 不适用于 ${MA_PROXY_PREFIX}${pathname}`
            : `${MA_PROXY_PREFIX} 只转发 /healthz、/diagnose、/jobs、/jobs/{id}、/jobs/{id}/result`,
      });
      return;
    }
    if (query && !SAFE_QUERY.test(query)) {
      res.status(400).json({ error: 'E_BAD_QUERY', message: '查询串含不允许的字符' });
      return;
    }

    const declaredLength = Number.parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      res.status(413).json({ error: 'E_BODY_TOO_LARGE', limit: maxBodyBytes });
      return;
    }

    let settled = false;
    const fail = (status, payload) => {
      if (settled) return;
      settled = true;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(status).json(payload);
    };

    const upstreamReq = http.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: query ? `${resolved.path}?${query}` : resolved.path,
        headers: buildUpstreamHeaders(req, upstream.label),
        // 每次都开新连接,绝不复用。Node 19 起全局 agent 默认 keepAlive:true,
        // 而上游是 Python 标准库的 http.server —— 它在 401/413 这类提前返回的分支上
        // 曾经不读请求体就回话,残留字节会被下一个复用该连接的请求当成请求行解析
        // (症状:莫名其妙的 501 `Unsupported method ('{"activity_id":...}POST')`,
        // 而且报在下一个请求头上,跟肇事者隔了一整个请求)。
        // 上游那边已经修了(ma_core.py 的 _drain_body),这里再断一次是故意的:
        // 反代不该指望上游的 HTTP 实现没毛病。回环连接的握手成本可以忽略。
        agent: false,
      },
      (upstreamRes) => {
        if (settled) {
          upstreamRes.resume();
          return;
        }
        settled = true;
        const dropped = connectionListed(upstreamRes.headers);
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          const lower = name.toLowerCase();
          if (HOP_BY_HOP.has(lower) || dropped.has(lower)) continue;
          if (value !== undefined) res.setHeader(name, value);
        }
        res.status(upstreamRes.statusCode || 502);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => res.destroy());
      }
    );

    upstreamReq.setTimeout(timeoutMs, () => {
      upstreamReq.destroy(new Error('upstream_timeout'));
      fail(504, {
        error: 'E_MA_TIMEOUT',
        message: `诊断服务 ${upstream.label} ${timeoutMs}ms 内没有响应`,
      });
    });

    upstreamReq.on('error', (error) => {
      const refused = error && (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND');
      if (refused) {
        logger.warn?.(`[ma-proxy] 连不上 ${upstream.label}:${error.code}(服务没起?)`);
      }
      fail(502, {
        error: 'E_MA_UNREACHABLE',
        message: refused
          ? `诊断服务 ${upstream.label} 没在监听 —— 先把 ma_api_c.py 起起来`
          : `转发到 ${upstream.label} 失败`,
        code: error?.code || null,
      });
    });

    // 客户端先走了就别再占着上游的连接。
    res.on('close', () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    });

    // 请求体边转边数。声明的 content-length 可以撒谎,这里才是真正的闸。
    let forwarded = 0;
    req.on('data', (chunk) => {
      forwarded += chunk.length;
      if (forwarded > maxBodyBytes) {
        upstreamReq.destroy(new Error('body_too_large'));
        fail(413, { error: 'E_BODY_TOO_LARGE', limit: maxBodyBytes });
      }
    });
    req.on('error', () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  });

  router.maProxyTarget = upstream.label;
  return router;
}

/** 从环境变量装配。返回 null 表示没配置,调用方不挂载。 */
export function createMaProxyRouterFromEnv(env = process.env, logger = console) {
  const target = env.PRISM_MA_API_TARGET;
  if (!target) return null;
  const timeoutMs = Number.parseInt(env.PRISM_MA_API_TIMEOUT_MS ?? '', 10);
  const maxBody = Number.parseInt(env.PRISM_MA_API_MAX_BODY ?? '', 10);
  return createMaProxyRouter({
    target,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    maxBodyBytes: Number.isFinite(maxBody) && maxBody > 0 ? maxBody : DEFAULT_MAX_BODY,
    logger,
  });
}
