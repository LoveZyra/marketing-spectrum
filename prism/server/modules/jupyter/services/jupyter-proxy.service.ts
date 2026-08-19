/**
 * /jupyter/* 反向代理:HTTP 转发 + WebSocket 隧道,全部手写零依赖。
 *
 * 鉴权模型(iframe 加不了请求头,所以是"票据换 cookie"):
 *   1. 第一跳带 ?prism_ticket=(POST /api/jupyter/session 铸的一次性票),
 *      这里消费掉、Set-Cookie 一个 12h 滑动会话,然后照常转发。
 *   2. 之后 iframe 的所有请求(含 WebSocket 升级)同源自动带 cookie,验过即转。
 *   3. 两样都没有 → 401。Prism 自己的 JWT 从不流向 jupyter 进程。
 *
 * 转发时注入 `Authorization: token <随机token>`(jupyter 只认这个),浏览器端
 * 拿不到该 token —— 它只存在于 Prism 内存和回环连接上。
 *
 * 转发机制照抄 ma-proxy 的成熟处理:逐跳首部剥离、Connection 点名剥离、
 * settled 竞态防护、上游错误→502。WebSocket 走"握手后原始 TCP 对管":
 * 我们把原样的升级请求(换 host、注入 authorization)写给上游,之后两条
 * socket 互相 pipe,不解析任何帧 —— 最不容易出错的做法。
 */

import http from 'node:http';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  JUPYTER_BASE_PATH,
  JUPYTER_COOKIE_NAME,
  ensureJupyterRunning,
  getJupyterRuntime,
  isJupyterSessionValid,
  readCookieValue,
  redeemJupyterEntryTicket,
} from './jupyter-manager.service.js';

const UPSTREAM_TIMEOUT_MS = 120_000;

// RFC 7230 逐跳首部。upgrade/connection 在 WS 隧道里单独重建。
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// lab 一次冷加载要拉上百个静态资源,复用连接省一大截握手;tornado 的
// keep-alive 实现是可靠的(ma-proxy 不复用是那边上游的坑,这里没有)。
const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

function connectionListed(headers: IncomingMessage['headers']): Set<string> {
  const raw = headers.connection;
  if (typeof raw !== 'string') return new Set();
  return new Set(raw.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean));
}

/** 组装转发首部:剥逐跳、换 host、注入 jupyter token。导出供单测。 */
export function buildForwardHeaders(
  headers: IncomingMessage['headers'],
  options: { hostLabel: string; jupyterToken: string },
): Record<string, string | string[]> {
  const dropped = connectionListed(headers);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'host') continue;
    if (HOP_BY_HOP.has(lower)) continue;
    // Prism 的 JWT 不外流;下面统一换成 jupyter 自己的 token。
    if (lower === 'authorization') continue;
    if (dropped.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = value;
  }
  out.host = options.hostLabel;
  out.authorization = `token ${options.jupyterToken}`;
  return out;
}

/** 去掉查询串里的入口票再转发 —— 票已经消费,别让它进 jupyter 的日志。 */
export function stripEntryTicket(url: string): string {
  const parsed = new URL(url, 'http://localhost');
  parsed.searchParams.delete('prism_ticket');
  const query = parsed.searchParams.toString();
  return `${parsed.pathname}${query ? `?${query}` : ''}`;
}

/**
 * WebSocket 升级请求的原始首部块(写给上游 TCP 的第一段)。
 * 用 rawHeaders 保留重复首部(sec-websocket-extensions 可能多条),
 * host/authorization 替换,其余原样。导出供单测。
 */
export function buildUpgradeRequestHead(
  request: IncomingMessage,
  options: { hostLabel: string; jupyterToken: string },
): string {
  const path = stripEntryTicket(request.url ?? '/');
  const lines = [`GET ${path} HTTP/1.1`];
  const raw = request.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index];
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'authorization') continue;
    lines.push(`${name}: ${raw[index + 1]}`);
  }
  lines.push(`Host: ${options.hostLabel}`);
  lines.push(`Authorization: token ${options.jupyterToken}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

type AuthOutcome = { ok: true; setCookie: string | null } | { ok: false };

/** 票据/cookie 二选一的入场检查。票据有效时给出要下发的 Set-Cookie。 */
export function authorizeJupyterRequest(request: IncomingMessage): AuthOutcome {
  const cookie = readCookieValue(request.headers.cookie, JUPYTER_COOKIE_NAME);
  if (isJupyterSessionValid(cookie)) {
    return { ok: true, setCookie: null };
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  const ticket = url.searchParams.get('prism_ticket');
  if (ticket) {
    const sessionId = redeemJupyterEntryTicket(ticket);
    if (sessionId) {
      return {
        ok: true,
        setCookie: `${JUPYTER_COOKIE_NAME}=${sessionId}; Path=${JUPYTER_BASE_PATH}; HttpOnly; SameSite=Lax`,
      };
    }
  }
  return { ok: false };
}

/**
 * HTTP 转发处理器。挂载:app.use('/jupyter', handler) —— 内部读 originalUrl,
 * 所以挂载点剥掉前缀也不影响(jupyter 的 base_url 就是 /jupyter,要全路径)。
 */
export function createJupyterProxyHandler() {
  return async function jupyterProxyHandler(
    req: IncomingMessage & { originalUrl?: string },
    res: ServerResponse,
  ): Promise<void> {
    const auth = authorizeJupyterRequest(req);
    if (!auth.ok) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'jupyter 会话无效或已过期,请回 Prism 重新打开 notebook 标签页' }));
      return;
    }

    // 正常路径下 POST /api/jupyter/session 已经把 lab 拉起来了;这里的 ensure
    // 是崩溃后的兜底 —— 共享同一个启动 promise,不会并发拉多份。
    let runtime = getJupyterRuntime();
    if (!runtime) {
      const ensured = await ensureJupyterRunning();
      if (!ensured.ok) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `JupyterLab 未就绪:${ensured.detail}` }));
        return;
      }
      runtime = ensured.runtime;
    }

    const hostLabel = `127.0.0.1:${runtime.port}`;
    const forwardPath = stripEntryTicket(req.originalUrl ?? req.url ?? '/');

    let settled = false;
    const fail = (status: number, message: string) => {
      if (settled) return;
      settled = true;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
    };

    const upstreamReq = http.request(
      {
        host: '127.0.0.1',
        port: runtime.port,
        method: req.method,
        path: forwardPath,
        headers: buildForwardHeaders(req.headers, { hostLabel, jupyterToken: runtime.token }),
        agent: upstreamAgent,
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
        // 全局中间件对所有响应打 X-Frame-Options: DENY;lab 恰恰要被自家
        // iframe 装进来 —— 同源放行,其余仍然拒绝。
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        if (auth.setCookie) {
          const existing = res.getHeader('set-cookie');
          const merged = Array.isArray(existing)
            ? [...existing, auth.setCookie]
            : existing
              ? [String(existing), auth.setCookie]
              : [auth.setCookie];
          res.setHeader('set-cookie', merged);
        }
        res.writeHead(upstreamRes.statusCode ?? 502);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => res.destroy());
      },
    );

    upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstreamReq.destroy(new Error('upstream_timeout'));
      fail(504, `JupyterLab ${UPSTREAM_TIMEOUT_MS / 1000}s 未响应`);
    });
    upstreamReq.on('error', (error: NodeJS.ErrnoException) => {
      fail(502, error.code === 'ECONNREFUSED' ? 'JupyterLab 进程未在监听(可能刚崩溃,稍后重试)' : '转发到 JupyterLab 失败');
    });
    res.on('close', () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    });
    req.on('error', () => {
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    });

    req.pipe(upstreamReq);
  };
}

/**
 * WebSocket 升级:kernel channels / terminals / events 全走这里。
 * cookie 鉴权(浏览器同源 WS 自动带),然后 TCP 对管。
 */
export function handleJupyterUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const cookie = readCookieValue(request.headers.cookie, JUPYTER_COOKIE_NAME);
  if (!isJupyterSessionValid(cookie)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const runtime = getJupyterRuntime();
  if (!runtime) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstream = net.connect(runtime.port, '127.0.0.1', () => {
    upstream.write(
      buildUpgradeRequestHead(request, {
        hostLabel: `127.0.0.1:${runtime.port}`,
        jupyterToken: runtime.token,
      }),
    );
    if (head && head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const teardown = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on('error', teardown);
  socket.on('error', teardown);
  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}
