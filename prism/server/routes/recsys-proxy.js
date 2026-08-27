/**
 * recsys 服务反代:把 Prism 8080 上的 /recsys/* 转到本机回环的推荐算法点位监控。
 *
 * 与 ma-proxy 的区别只有两点,其余安全骨架完全共用(见 proxy-kit.js):
 *
 *   1. **不做路径白名单**。ma-proxy 的下游是五个已知接口,能精确列举;recsys
 *      是一整个前端页面 —— HTML、JS、CSS、data/*.json,路径是上游自己长出来的,
 *      列不完。代价是上游多出什么接口,这里就跟着暴露什么,所以只放这种"整站
 *      公开只读"的服务;上游哪天要加调试端点或写接口,得回来补白名单。
 *   2. **改写 Location**。上游在回环上是挂在根路径 `/` 的,它发的 302 会指向
 *      `/foo`;浏览器拿到手会跳到 Prism 的 `/foo`,而不是 `/recsys/foo` —— 直接
 *      跳出反代,落到 Prism 自己的前端路由上,表现为莫名其妙的 404 或白页。
 *      所以往回走的 Location 要补上前缀。
 *
 * **这层不鉴权**,和 ma-proxy 一样挂在 validateApiKey 之前 —— 监控页是公开只读的,
 * 这是有意的选择,不是漏配。换句话说:**能打到 Prism 8080 的人都能看这个页面**。
 * 如果哪天上游不再是只读的,要么给它自己加鉴权,要么把挂载点挪到鉴权之后。
 *
 * 路径映射:express 的 Router 挂在前缀上时,req.url 已经是去掉前缀的部分,
 * 所以 `/recsys/data/a.json` 到上游就是 `/data/a.json` —— 上游按自己的根路径服务,
 * 不需要知道自己被挂在哪。它要生成对外链接的话,用自己的 PUBLIC_BASE_URL,
 * 或者读这层带下去的 X-Forwarded-Prefix。
 *
 * 环境变量(都不配 = 整层不挂载,Prism 行为与之前完全一致):
 *   PRISM_RECSYS_TARGET      形如 127.0.0.1:3010 或 http://127.0.0.1:3010
 *   PRISM_RECSYS_TIMEOUT_MS  上游超时,默认 30000
 *   PRISM_RECSYS_MAX_BODY    请求体上限字节,默认 1048576
 */

import http from 'http';

import express from 'express';

import {
  HOP_BY_HOP,
  buildUpstreamHeaders,
  connectionListed,
  parseUpstream,
} from './proxy-kit.js';

/** 挂载前缀。index.js 和测试共用这一个常量,别两头各写一遍。 */
export const RECSYS_PROXY_PREFIX = '/recsys';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY = 1024 * 1024;

/**
 * 挡路径穿越。没有白名单兜着的时候,这是唯一一道路径检查。
 *
 * 比对的是**未解码**的原始路径:`%2e%2e%2f` 这种编码穿越如果先解码再看就已经
 * 变成了 `../`,而 Node 会把原样字节发给上游,上游解不解码不归我们管 —— 所以
 * 干脆连 `%2e` 都不放行。正常的静态资源路径里不会出现编码过的点。
 */
export function hasTraversal(pathname) {
  const lower = String(pathname ?? '').toLowerCase();
  if (lower.includes('%2e')) return true;
  return lower.split('/').some((segment) => segment === '..');
}

/**
 * 把上游发回来的 Location 补上挂载前缀。
 *
 * 只动**根相对**的路径(`/foo`)。绝对 URL(`http://…`)不动 —— 上游如果按
 * PUBLIC_BASE_URL 生成了完整地址,那它已经知道自己对外是什么样子了,再套一层
 * 前缀反而错。相对路径(`foo`、`./foo`)也不动,浏览器会按当前 URL 解析,
 * 而当前 URL 本来就在前缀底下,天然是对的。
 */
export function rewriteLocation(location, prefix = RECSYS_PROXY_PREFIX) {
  if (typeof location !== 'string' || location === '') return location;
  // `//host/path` 是协议相对的绝对地址,不是根相对路径。
  if (!location.startsWith('/') || location.startsWith('//')) return location;
  if (location === prefix || location.startsWith(`${prefix}/`)) return location;
  return `${prefix}${location}`;
}

/**
 * 建代理路由。target 解析不通就返回 null —— 调用方据此决定不挂载,
 * 宁可这条路径 404,也不要挂一个指向不明的转发器上去。
 */
export function createRecsysProxyRouter({
  target,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBodyBytes = DEFAULT_MAX_BODY,
  logger = console,
} = {}) {
  const upstream = parseUpstream(target);
  if (!upstream.ok) {
    if (upstream.reason !== 'empty') {
      logger.warn?.(
        `[recsys-proxy] PRISM_RECSYS_TARGET=${JSON.stringify(target)} 不可用(${upstream.reason}),` +
          `${RECSYS_PROXY_PREFIX} 未挂载。只接受回环地址,例如 127.0.0.1:3010。`
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

    if (hasTraversal(pathname)) {
      res.status(400).json({ error: 'E_BAD_PATH', message: '路径不允许包含 .. 或编码后的点' });
      return;
    }

    const declaredLength = Number.parseInt(req.headers['content-length'] ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      res.status(413).json({ error: 'E_BODY_TOO_LARGE', limit: maxBodyBytes });
      return;
    }

    const headers = buildUpstreamHeaders(req, upstream.label);
    // 让上游有机会自推导对外前缀,而不是把 /recsys 硬编码进它的模板里。
    headers['x-forwarded-prefix'] = RECSYS_PROXY_PREFIX;

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
        path: query ? `${pathname}?${query}` : pathname,
        headers,
        // 和 ma-proxy 同一个理由:不复用连接。Node 19 起全局 agent 默认
        // keepAlive:true,而复用连接对反代只省下回环握手那点成本,却要赌上游
        // 在每一条提前返回的分支上都把请求体读干净。不值当。
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
          if (value === undefined) continue;
          if (lower === 'location') {
            res.setHeader(
              name,
              Array.isArray(value) ? value.map((item) => rewriteLocation(item)) : rewriteLocation(value)
            );
            continue;
          }
          res.setHeader(name, value);
        }
        res.status(upstreamRes.statusCode || 502);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => res.destroy());
      }
    );

    upstreamReq.setTimeout(timeoutMs, () => {
      upstreamReq.destroy(new Error('upstream_timeout'));
      fail(504, {
        error: 'E_RECSYS_TIMEOUT',
        message: `recsys 服务 ${upstream.label} ${timeoutMs}ms 内没有响应`,
      });
    });

    upstreamReq.on('error', (error) => {
      const refused = error && (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND');
      if (refused) {
        logger.warn?.(`[recsys-proxy] 连不上 ${upstream.label}:${error.code}(服务没起?)`);
      }
      fail(502, {
        error: 'E_RECSYS_UNREACHABLE',
        message: refused
          ? `recsys 服务 ${upstream.label} 没在监听 —— 先把 recsys 起起来`
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

  router.recsysTarget = upstream.label;
  return router;
}

/** 从环境变量装配。返回 null 表示没配置,调用方不挂载。 */
export function createRecsysProxyRouterFromEnv(env = process.env, logger = console) {
  const target = env.PRISM_RECSYS_TARGET;
  if (!target) return null;
  const timeoutMs = Number.parseInt(env.PRISM_RECSYS_TIMEOUT_MS ?? '', 10);
  const maxBody = Number.parseInt(env.PRISM_RECSYS_MAX_BODY ?? '', 10);
  return createRecsysProxyRouter({
    target,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    maxBodyBytes: Number.isFinite(maxBody) && maxBody > 0 ? maxBody : DEFAULT_MAX_BODY,
    logger,
  });
}
