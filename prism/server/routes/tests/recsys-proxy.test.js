/**
 * Coverage for server/routes/recsys-proxy.js.
 *
 * 这层比 ma-proxy 松:没有路径白名单。松掉白名单之后,剩下能挡住事故的就只有
 * "只转回环""剥 Prism 凭据""挡路径穿越"这三条,外加一条不属于安全但会直接
 * 让页面用不了的 Location 改写。每条都得有断言盯着。
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import express from 'express';
import { afterEach, describe, test } from 'vitest';

import {
  RECSYS_PROXY_PREFIX,
  createRecsysProxyRouter,
  createRecsysProxyRouterFromEnv,
  hasTraversal,
  rewriteLocation,
} from '../recsys-proxy.js';

// ---------------------------------------------------------------------------
// 1. 装配:没配就不挂,配错也不挂
// ---------------------------------------------------------------------------

describe('装配', () => {
  test('不配 PRISM_RECSYS_TARGET = 整层不挂载', () => {
    assert.equal(createRecsysProxyRouterFromEnv({}, { warn() {} }), null);
  });

  test('非回环目标不挂载 —— 与 ma-proxy 共用同一道 SSRF 闸', () => {
    const noise = [];
    const logger = { warn: (m) => noise.push(m) };
    for (const bad of ['10.195.43.111:3010', 'http://169.254.169.254/', 'example.com:80']) {
      assert.equal(createRecsysProxyRouterFromEnv({ PRISM_RECSYS_TARGET: bad }, logger), null, bad);
    }
    assert.equal(noise.length, 3, '每次拒绝都要留一句话说清为什么没挂上');
  });

  test('回环目标挂得起来,并记住 target 供启动日志打印', () => {
    const router = createRecsysProxyRouterFromEnv(
      { PRISM_RECSYS_TARGET: '127.0.0.1:3010' },
      { warn() {} }
    );
    assert.ok(router);
    assert.equal(router.recsysTarget, '127.0.0.1:3010');
  });

  test('超时和体积上限可以从环境变量覆盖,给了废值就回落默认', () => {
    const mk = (env) => createRecsysProxyRouterFromEnv({ PRISM_RECSYS_TARGET: '127.0.0.1:3010', ...env }, { warn() {} });
    assert.ok(mk({ PRISM_RECSYS_TIMEOUT_MS: '5000' }));
    assert.ok(mk({ PRISM_RECSYS_TIMEOUT_MS: 'abc' }));
    assert.ok(mk({ PRISM_RECSYS_MAX_BODY: '-1' }));
  });
});

// ---------------------------------------------------------------------------
// 2. 路径穿越:没有白名单兜底时唯一的路径检查
// ---------------------------------------------------------------------------

describe('hasTraversal', () => {
  test('明文 .. 段拦下', () => {
    for (const p of ['/../etc/passwd', '/a/../../b', '/..', '/a/..']) {
      assert.equal(hasTraversal(p), true, p);
    }
  });

  test('编码过的点也拦下 —— 比对的是未解码的原始路径', () => {
    for (const p of ['/%2e%2e/b', '/%2E%2E%2Fb', '/a/%2e%2e']) {
      assert.equal(hasTraversal(p), true, p);
    }
  });

  test('正常路径和只是长得像的都放行', () => {
    for (const p of ['/', '/data/a.json', '/assets/app..css', '/..b/c', '/a.b/c']) {
      assert.equal(hasTraversal(p), false, p);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Location 改写:只动根相对路径
// ---------------------------------------------------------------------------

describe('rewriteLocation', () => {
  test('根相对路径补上前缀', () => {
    assert.equal(rewriteLocation('/'), '/recsys/');
    assert.equal(rewriteLocation('/foo'), '/recsys/foo');
    assert.equal(rewriteLocation('/foo?a=1'), '/recsys/foo?a=1');
  });

  test('已经带前缀的不重复套', () => {
    assert.equal(rewriteLocation('/recsys'), '/recsys');
    assert.equal(rewriteLocation('/recsys/foo'), '/recsys/foo');
  });

  test('绝对地址、协议相对、相对路径都不动', () => {
    assert.equal(rewriteLocation('http://example.com/foo'), 'http://example.com/foo');
    assert.equal(rewriteLocation('//example.com/foo'), '//example.com/foo');
    assert.equal(rewriteLocation('foo'), 'foo');
    assert.equal(rewriteLocation('./foo'), './foo');
  });

  test('空值原样返回,不要变成 "/recsys"', () => {
    assert.equal(rewriteLocation(''), '');
    assert.equal(rewriteLocation(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// 4. 端到端:真起两个 server
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

async function startStack(upstreamHandler, options = {}) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);

  const app = express();
  const router = createRecsysProxyRouter({
    target: `127.0.0.1:${upstreamPort}`,
    logger: { warn() {} },
    ...options,
  });
  assert.ok(router, '代理应该挂得起来');
  app.use(RECSYS_PROXY_PREFIX, router);

  const proxy = http.createServer(app);
  const proxyPort = await listen(proxy);
  return { base: `http://127.0.0.1:${proxyPort}`, upstreamPort };
}

/** 原样发路径,不经 URL 归一化 —— 用来模拟 curl --path-as-is 这类客户端。 */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: rawPath }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('端到端转发', () => {
  test('前缀被剥掉:/recsys/data/a.json 落到上游的 /data/a.json', async () => {
    const seen = [];
    const { base } = await startStack((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const res = await fetch(`${base}/recsys/data/a.json?v=2`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"ok":true}');
    assert.deepEqual(seen, ['/data/a.json?v=2']);
  });

  test('根路径 /recsys 落到上游的 /', async () => {
    const seen = [];
    const { base } = await startStack((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });
    await fetch(`${base}/recsys`);
    assert.deepEqual(seen, ['/']);
  });

  test('Prism 凭据不外带,X-Forwarded-Prefix 带下去', async () => {
    let got = null;
    const { base } = await startStack((req, res) => {
      got = req.headers;
      res.writeHead(200);
      res.end('ok');
    });
    await fetch(`${base}/recsys/`, {
      headers: {
        authorization: 'Bearer prism-jwt',
        cookie: 'token=prism-session',
        'x-prism-api-key': 'prism-key',
        'x-keep': 'yes',
      },
    });
    assert.equal(got.authorization, undefined, 'Prism 的 JWT 不该进上游日志');
    assert.equal(got.cookie, undefined);
    assert.equal(got['x-prism-api-key'], undefined);
    assert.equal(got['x-keep'], 'yes', '其他首部照常转发');
    assert.equal(got['x-forwarded-prefix'], '/recsys');
  });

  test('302 的 Location 补上前缀,不会把浏览器甩出反代', async () => {
    const { base } = await startStack((req, res) => {
      res.writeHead(302, { location: '/login' });
      res.end();
    });
    const res = await fetch(`${base}/recsys/x`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/recsys/login');
  });

  test('路径穿越 400,请求根本不落到上游', async () => {
    let hits = 0;
    const { base } = await startStack((req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end('ok');
    });
    const port = Number(new URL(base).port);
    // 注意这里不能用 fetch:WHATWG 的 URL 解析会先把 %2e%2e 解成 `..` 再归一化掉,
    // 请求还没出门就变成了 /etc/passwd,压根到不了这层。浏览器同样会归一化 ——
    // 也就是说这道闸防的不是浏览器,是 curl --path-as-is 那类原样发包的客户端。
    for (const rawPath of ['/recsys/%2e%2e/etc/passwd', '/recsys/a/../../etc/passwd']) {
      const status = await rawGet(port, rawPath);
      assert.equal(status, 400, rawPath);
    }
    assert.equal(hits, 0, '穿越请求不该被转发出去');
  });

  test('上游没起来给 502,并说清是没在监听', async () => {
    const app = express();
    const dead = http.createServer(() => {});
    const deadPort = await listen(dead);
    await new Promise((r) => dead.close(r));
    listening.splice(listening.indexOf(dead), 1);

    const router = createRecsysProxyRouter({ target: `127.0.0.1:${deadPort}`, logger: { warn() {} } });
    app.use(RECSYS_PROXY_PREFIX, router);
    const proxy = http.createServer(app);
    const proxyPort = await listen(proxy);

    const res = await fetch(`http://127.0.0.1:${proxyPort}/recsys/`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'E_RECSYS_UNREACHABLE');
    assert.match(body.message, /没在监听/);
  });

  test('请求体超上限 413', async () => {
    const { base } = await startStack(
      (req, res) => {
        req.resume();
        res.writeHead(200);
        res.end('ok');
      },
      { maxBodyBytes: 16 }
    );
    const res = await fetch(`${base}/recsys/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'x'.repeat(64),
    });
    assert.equal(res.status, 413);
  });
});
