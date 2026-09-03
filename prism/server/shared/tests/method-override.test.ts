import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { methodOverrideMiddleware, resolveOverriddenMethod } from '@/shared/method-override.js';

/**
 * ea:方法隧道。
 *
 * 用户实测:定时任务「启用/暂停」开关(PATCH)在公司 Windows 机器上点了没反应,
 * Mac 正常 —— 只放行 GET/POST 的企业代理把 PATCH 拦了。前端改发
 * POST + X-HTTP-Method-Override,服务端在路由之前改回真实方法。
 *
 * 纯函数那几条钉判定规则;真 HTTP 那几条钉"改写发生在路由之前"——
 * 这一点拿函数单独调是测不出来的,必须让 express 真的按 req.method 去路由。
 */
describe('resolveOverriddenMethod', () => {
  it('POST + 合法头 → 改写', () => {
    expect(resolveOverriddenMethod('POST', 'PATCH')).toBe('PATCH');
    expect(resolveOverriddenMethod('POST', 'put')).toBe('PUT');
    expect(resolveOverriddenMethod('POST', ' delete ')).toBe('DELETE');
  });

  it('只从 POST 发起才认 —— GET 带头是绕过,不是隧道', () => {
    expect(resolveOverriddenMethod('GET', 'DELETE')).toBeNull();
    expect(resolveOverriddenMethod('PATCH', 'DELETE')).toBeNull();
  });

  it('只认三个方法;GET/HEAD/OPTIONS/乱写一律不改', () => {
    expect(resolveOverriddenMethod('POST', 'GET')).toBeNull();
    expect(resolveOverriddenMethod('POST', 'OPTIONS')).toBeNull();
    expect(resolveOverriddenMethod('POST', 'FOO')).toBeNull();
    expect(resolveOverriddenMethod('POST', undefined)).toBeNull();
    expect(resolveOverriddenMethod('POST', ['PATCH'])).toBeNull();
  });

  it('头被代理剥掉时,查询串 ?_method 也认;两个都在以头为准', () => {
    expect(resolveOverriddenMethod('POST', undefined, 'PATCH')).toBe('PATCH');
    expect(resolveOverriddenMethod('POST', undefined, 'delete')).toBe('DELETE');
    expect(resolveOverriddenMethod('POST', 'PUT', 'DELETE')).toBe('PUT');
    expect(resolveOverriddenMethod('POST', undefined, 'GET')).toBeNull();
    expect(resolveOverriddenMethod('GET', undefined, 'DELETE')).toBeNull();
  });
});

describe('methodOverrideMiddleware(真 HTTP)', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    const app = express();
    app.use('/api', methodOverrideMiddleware());
    // 同一路径同时有 POST 与 PATCH/DELETE 处理器 —— 隧道必须落到 PATCH/DELETE 那个。
    app.post('/api/things/:id', (_req, res) => { res.json({ hit: 'post' }); });
    app.patch('/api/things/:id', (req, res) => {
      res.json({
        hit: 'patch',
        original: (req as express.Request & { originalMethod?: string }).originalMethod ?? null,
        // _method 必须已被消费掉,不能漏进路由的 req.query
        leakedQuery: Object.prototype.hasOwnProperty.call(req.query, '_method'),
      });
    });
    app.delete('/api/things/:id', (_req, res) => { res.json({ hit: 'delete' }); });
    // /api 之外不改写
    app.post('/other', (req, res) => { res.json({ method: req.method }); });

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('POST + X-HTTP-Method-Override: PATCH 落到 PATCH 路由,并留下 originalMethod', async () => {
    const response = await fetch(`${baseUrl}/api/things/1`, {
      method: 'POST',
      headers: { 'X-HTTP-Method-Override': 'PATCH' },
    });
    expect(await response.json()).toEqual({ hit: 'patch', original: 'POST', leakedQuery: false });
  });

  it('头被剥掉、只剩 ?_method=PATCH 也能落到 PATCH 路由,且 _method 不漏进 req.query', async () => {
    const response = await fetch(`${baseUrl}/api/things/1?_method=PATCH`, { method: 'POST' });
    expect(await response.json()).toEqual({ hit: 'patch', original: 'POST', leakedQuery: false });
  });

  it('DELETE 同理', async () => {
    const response = await fetch(`${baseUrl}/api/things/1`, {
      method: 'POST',
      headers: { 'x-http-method-override': 'delete' },
    });
    expect(await response.json()).toEqual({ hit: 'delete' });
  });

  it('没带头的 POST 照旧走 POST', async () => {
    const response = await fetch(`${baseUrl}/api/things/1`, { method: 'POST' });
    expect(await response.json()).toEqual({ hit: 'post' });
  });

  it('真实的 PATCH 不受影响(老客户端 / 外部 API)', async () => {
    const response = await fetch(`${baseUrl}/api/things/1`, { method: 'PATCH' });
    expect(await response.json()).toEqual({ hit: 'patch', original: null, leakedQuery: false });
  });

  it('/api 之外的路径不改写', async () => {
    const response = await fetch(`${baseUrl}/other`, {
      method: 'POST',
      headers: { 'X-HTTP-Method-Override': 'DELETE' },
    });
    expect(await response.json()).toEqual({ method: 'POST' });
  });
});
