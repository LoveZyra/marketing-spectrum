/**
 * Coverage for server/routes/ma-proxy.js.
 *
 * 这层代理是唯一让外部流量进到诊断服务的通道,它一旦放松就等于把 Prism 变成
 * 内网跳板,所以三条硬约束(只转回环、只转白名单路径、不外带 Prism 凭据)每条
 * 都得有断言盯着,不能靠"当时是这么写的"。
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import express from 'express';
import { afterEach, describe, test } from 'vitest';

import {
  MA_PROXY_PREFIX,
  buildUpstreamHeaders,
  createMaProxyRouter,
  createMaProxyRouterFromEnv,
  parseUpstream,
  resolveUpstreamPath,
} from '../ma-proxy.js';

// ---------------------------------------------------------------------------
// 1. 上游地址解析:非回环一律拒
// ---------------------------------------------------------------------------

describe('parseUpstream', () => {
  test('接受回环的几种写法', () => {
    for (const raw of [
      '127.0.0.1:8092',
      'http://127.0.0.1:8092',
      'localhost:8093',
      'http://localhost:8093/',
      '[::1]:8092',
    ]) {
      const parsed = parseUpstream(raw);
      assert.equal(parsed.ok, true, `${raw} 应该被接受`);
      assert.ok(parsed.port > 0);
    }
  });

  test('IPv6 去掉方括号给 http.request,Host 首部保留方括号', () => {
    const parsed = parseUpstream('[::1]:8092');
    assert.equal(parsed.host, '::1');
    assert.equal(parsed.label, '[::1]:8092');
  });

  test('非回环目标拒绝 —— 这是 SSRF 的闸', () => {
    for (const raw of [
      '10.195.43.111:8092',
      'http://169.254.169.254/',
      'example.com:80',
      'http://0.0.0.0:8092',
      '43.167.214.72:8000',
    ]) {
      const parsed = parseUpstream(raw);
      assert.equal(parsed.ok, false, `${raw} 必须被拒`);
      assert.equal(parsed.reason, 'not_loopback');
    }
  });

  test('空值、非 http、乱码分别给出理由', () => {
    assert.equal(parseUpstream('').reason, 'empty');
    assert.equal(parseUpstream(undefined).reason, 'empty');
    assert.equal(parseUpstream('https://127.0.0.1:8092').reason, 'protocol_not_http');
    assert.equal(parseUpstream('http://[::1').reason, 'unparsable');
    // 长得像 scheme 但不是的,会被当成主机名去解析,照样落在非回环上被拒
    assert.equal(parseUpstream('ht!tp://%%%').ok, false);
  });

  test('target 配错时不挂载,而不是挂一个指向不明的转发器', () => {
    const noise = [];
    const logger = { warn: (m) => noise.push(m) };
    assert.equal(createMaProxyRouter({ target: '10.195.43.111:8092', logger }), null);
    assert.equal(noise.length, 1);
    assert.match(noise[0], /not_loopback/);
    // 没配置是正常状态,不该刷警告
    assert.equal(createMaProxyRouterFromEnv({}, logger), null);
    assert.equal(noise.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 2. 路径白名单
// ---------------------------------------------------------------------------

describe('resolveUpstreamPath', () => {
  test('五个真实接口都能映射到上游路径', () => {
    assert.deepEqual(resolveUpstreamPath('GET', '/healthz'), { ok: true, path: '/healthz' });
    assert.deepEqual(resolveUpstreamPath('POST', '/diagnose'), {
      ok: true,
      path: '/api/ma/diagnose',
    });
    assert.deepEqual(resolveUpstreamPath('GET', '/jobs'), { ok: true, path: '/api/ma/jobs' });
    assert.deepEqual(resolveUpstreamPath('GET', '/jobs/job_20260729_114613_cf123e'), {
      ok: true,
      path: '/api/ma/jobs/job_20260729_114613_cf123e',
    });
    assert.deepEqual(resolveUpstreamPath('GET', '/jobs/job_1/result'), {
      ok: true,
      path: '/api/ma/jobs/job_1/result',
    });
  });

  test('路径对、方法错 -> 405;路径不认识 -> 404', () => {
    assert.deepEqual(resolveUpstreamPath('POST', '/jobs'), { ok: false, status: 405 });
    assert.deepEqual(resolveUpstreamPath('DELETE', '/jobs/job_1'), { ok: false, status: 405 });
    assert.deepEqual(resolveUpstreamPath('GET', '/diagnose'), { ok: false, status: 405 });
    assert.deepEqual(resolveUpstreamPath('GET', '/admin'), { ok: false, status: 404 });
  });

  test('路径穿越 / 编码穿越都进不来', () => {
    for (const pathname of [
      '/jobs/../../etc/passwd',
      '/jobs/..%2f..%2fetc%2fpasswd',
      '/jobs/job_1/../../../healthz',
      '/../api/projects',
      '/jobs/job_1/result/extra',
      '/healthz/../diagnose',
    ]) {
      const resolved = resolveUpstreamPath('GET', pathname);
      assert.equal(resolved.ok, false, `${pathname} 必须被拒`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 首部组装:不外带 Prism 凭据
// ---------------------------------------------------------------------------

describe('buildUpstreamHeaders', () => {
  const makeReq = (headers) => ({
    headers,
    ip: '10.0.0.7',
    protocol: 'http',
    socket: { remoteAddress: '10.0.0.7' },
  });

  test('剥掉 Prism 自己的凭据,保留诊断服务的 key', () => {
    const out = buildUpstreamHeaders(
      makeReq({
        host: 'prism.internal:8080',
        authorization: 'Bearer prism-jwt',
        cookie: 'session=abc',
        'x-prism-api-key': 'prism-key',
        'x-ma-api-key': 'ma-key',
        'content-type': 'application/json',
      }),
      '127.0.0.1:8092'
    );
    assert.equal(out.authorization, undefined);
    assert.equal(out.cookie, undefined);
    assert.equal(out['x-prism-api-key'], undefined);
    assert.equal(out['x-ma-api-key'], 'ma-key');
    assert.equal(out['content-type'], 'application/json');
  });

  test('Host 改写成上游,X-Forwarded-* 补齐', () => {
    const out = buildUpstreamHeaders(makeReq({ host: 'prism.internal:8080' }), '127.0.0.1:8092');
    assert.equal(out.host, '127.0.0.1:8092');
    assert.equal(out['x-forwarded-host'], 'prism.internal:8080');
    assert.equal(out['x-forwarded-proto'], 'http');
    assert.equal(out['x-forwarded-for'], '10.0.0.7');
  });

  test('已有的 X-Forwarded-For 接在链上,不覆盖', () => {
    const out = buildUpstreamHeaders(
      makeReq({ host: 'h', 'x-forwarded-for': '203.0.113.9' }),
      '127.0.0.1:8092'
    );
    assert.equal(out['x-forwarded-for'], '203.0.113.9, 10.0.0.7');
  });

  test('逐跳首部以及 Connection 点名的首部都不转发', () => {
    const out = buildUpstreamHeaders(
      makeReq({
        host: 'h',
        connection: 'keep-alive, x-custom-hop',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        'x-custom-hop': '1',
        'x-kept': 'yes',
      }),
      '127.0.0.1:8092'
    );
    for (const gone of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'x-custom-hop']) {
      assert.equal(out[gone], undefined, `${gone} 不该转发`);
    }
    assert.equal(out['x-kept'], 'yes');
  });
});

// ---------------------------------------------------------------------------
// 4. 端到端:真起两个 server,验证转发行为
// ---------------------------------------------------------------------------

const listening = [];

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      listening.push(server);
      resolve(server.address().port);
    });
  });

const closeAll = () =>
  Promise.all(
    listening.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(resolve);
        })
    )
  );

afterEach(closeAll);

/** 起一个假的诊断服务 + 一个挂了代理的 Prism,返回代理侧的 base URL。 */
async function startStack(upstreamHandler, options = {}) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);

  const app = express();
  const router = createMaProxyRouter({
    target: `127.0.0.1:${upstreamPort}`,
    logger: { warn() {} },
    ...options,
  });
  assert.ok(router, '代理应该挂得起来');
  app.use(MA_PROXY_PREFIX, router);

  const proxy = http.createServer(app);
  const proxyPort = await listen(proxy);
  return { base: `http://127.0.0.1:${proxyPort}`, upstreamPort };
}

describe('端到端转发', () => {
  test('GET /api/ma/healthz 落到上游的 /healthz(不带 /api/ma 前缀)', async () => {
    const seen = [];
    const { base } = await startStack((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, runtime: 'real' }));
    });

    const response = await fetch(`${base}${MA_PROXY_PREFIX}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, runtime: 'real' });
    assert.deepEqual(seen, ['/healthz']);
  });

  test('POST /api/ma/diagnose 原样带上请求体和 x-ma-api-key,202 透传', async () => {
    let received = null;
    let receivedKey = null;
    const { base } = await startStack((req, res) => {
      receivedKey = req.headers['x-ma-api-key'];
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received = { url: req.url, method: req.method, body };
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ job_id: 'job_x', state: 'queued' }));
      });
    });

    const payload = JSON.stringify({ activity_id: 'real_c_001', push_source: 'both' });
    const response = await fetch(`${base}${MA_PROXY_PREFIX}/diagnose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ma-api-key': 'ma-key' },
      body: payload,
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { job_id: 'job_x', state: 'queued' });
    assert.equal(received.url, '/api/ma/diagnose');
    assert.equal(received.method, 'POST');
    // 字节级一致 —— 中间没有解析再重新序列化过
    assert.equal(received.body, payload);
    assert.equal(receivedKey, 'ma-key');
  });

  test('上游的 4xx 连同错误体一起透传(比如同活动在跑的 409)', async () => {
    const { base } = await startStack((req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'E_ACTIVITY_BUSY' }));
    });
    const response = await fetch(`${base}${MA_PROXY_PREFIX}/jobs/job_1/result`);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'E_ACTIVITY_BUSY' });
  });

  test('查询串跟着走', async () => {
    const seen = [];
    const { base } = await startStack((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const response = await fetch(`${base}${MA_PROXY_PREFIX}/jobs?limit=20`);
    assert.equal(response.status, 200);
    assert.deepEqual(seen, ['/api/ma/jobs?limit=20']);
  });

  test('诊断服务没起 -> 502,并且说清是没在监听', async () => {
    const dead = http.createServer(() => {});
    const deadPort = await listen(dead);
    await new Promise((resolve) => dead.close(resolve));
    listening.splice(listening.indexOf(dead), 1);

    const app = express();
    const router = createMaProxyRouter({
      target: `127.0.0.1:${deadPort}`,
      logger: { warn() {} },
    });
    app.use(MA_PROXY_PREFIX, router);
    const proxy = http.createServer(app);
    const proxyPort = await listen(proxy);

    const response = await fetch(`http://127.0.0.1:${proxyPort}${MA_PROXY_PREFIX}/healthz`);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'E_MA_UNREACHABLE');
    assert.match(body.message, /没在监听/);
  });

  test('上游迟迟不响应 -> 504,不会把 Prism 的连接吊死', async () => {
    const { base } = await startStack(
      () => {
        /* 故意不回 */
      },
      { timeoutMs: 150 }
    );
    const response = await fetch(`${base}${MA_PROXY_PREFIX}/healthz`);
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error, 'E_MA_TIMEOUT');
  });

  test('超体积的请求体被就地掐掉,不会灌到下游', async () => {
    let upstreamSawBytes = 0;
    const { base } = await startStack(
      (req, res) => {
        req.on('data', (chunk) => {
          upstreamSawBytes += chunk.length;
        });
        req.on('end', () => {
          res.writeHead(202).end('{}');
        });
      },
      { maxBodyBytes: 1024 }
    );

    const response = await fetch(`${base}${MA_PROXY_PREFIX}/diagnose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(4096),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'E_BODY_TOO_LARGE');
    assert.ok(upstreamSawBytes <= 1024 + 64, `下游最多只应看到闸值附近的字节,实际 ${upstreamSawBytes}`);
  });

  test('白名单之外的路径根本不发给上游', async () => {
    const seen = [];
    const { base } = await startStack((req, res) => {
      seen.push(req.url);
      res.writeHead(200).end('{}');
    });

    const notFound = await fetch(`${base}${MA_PROXY_PREFIX}/../api/projects`);
    assert.ok(notFound.status >= 400);
    const methodWrong = await fetch(`${base}${MA_PROXY_PREFIX}/jobs`, { method: 'DELETE' });
    assert.equal(methodWrong.status, 405);
    assert.equal((await methodWrong.json()).error, 'E_METHOD_NOT_ALLOWED');
    assert.deepEqual(seen, [], '一个都不该到上游');
  });

  test('Prism 的 JWT / Cookie 不会漏到诊断服务', async () => {
    let headers = null;
    const { base } = await startStack((req, res) => {
      headers = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });

    await fetch(`${base}${MA_PROXY_PREFIX}/healthz`, {
      headers: {
        authorization: 'Bearer prism-jwt',
        cookie: 'prism_session=secret',
        'x-prism-api-key': 'prism-key',
      },
    });
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers['x-prism-api-key'], undefined);
  });
});
