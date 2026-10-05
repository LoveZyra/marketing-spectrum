import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { afterEach, describe, test } from 'vitest';

import { closeConnection, getConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { invalidateCatalogCache } from '@/modules/providers/list/claude/claude-model-catalog.service.js';
import { resetEncryptionKey } from '@/shared/crypto-box.js';

import providerRouter from '../provider.routes.js';

/**
 * hq:网关 / key 路由 —— 在**路由层**钉:
 * - root 接口普通用户 403;别人的私有网关 / 私有模型一律 404(改不了、读不到);
 * - **key 只进不出**:每个碰 key 的接口,响应 JSON 里都找不到 key 明文(最多末四位);审计里也没有;
 * - 目录条目挂网关 / 可用人员的引用校验、删网关 409、私有网关总开关。
 */

type TestUser = { id: number; username: string; isRoot?: boolean };

const ENV_KEYS = [
  'DATABASE_PATH', 'HOME', 'PRISM_ROOT_USERS', 'PRISM_ENCRYPTION_KEY',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const servers: Server[] = [];
let dir: string | null = null;

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  invalidateCatalogCache();
  resetEncryptionKey();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (dir) { await fs.rm(dir, { recursive: true, force: true }); dir = null; }
});

const listen = async (server: Server): Promise<string> => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('no listen address');
  return `http://127.0.0.1:${address.port}`;
};

/** 假的上游网关:401,并把收到的 key 回显在错误体里 —— Prism 不能把它带回给浏览器。 */
const startUpstream = () => listen(createServer((req, res) => {
  const echo = String(req.headers.authorization ?? req.headers['x-api-key'] ?? '');
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `bad key: ${echo}` } }));
}));

const SETTINGS_TOKEN = 'sk-settings-token-SETT';

async function setup() {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-gw-routes-'));
  closeConnection();
  resetEncryptionKey();
  const upstream = await startUpstream();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.HOME = dir;
  process.env.PRISM_ROOT_USERS = 'boss';
  delete process.env.PRISM_ENCRYPTION_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: `${upstream}/tenant-zero`, ANTHROPIC_AUTH_TOKEN: SETTINGS_TOKEN },
  }));
  await initializeDatabase();
  invalidateCatalogCache();
  const users: Record<string, TestUser> = {};
  for (const name of ['alice', 'bob', 'boss']) {
    users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name, isRoot: name === 'boss' };
  }
  const fakeAuth: RequestHandler = (req, res, next) => {
    const name = String(req.headers['x-test-user'] ?? '');
    if (!users[name]) { res.status(401).json({ error: 'nope' }); return; }
    (req as unknown as { user?: TestUser }).user = users[name];
    next();
  };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', fakeAuth, providerRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    void _next;
    const status = (error as { statusCode?: number })?.statusCode ?? 500;
    res.status(status).json({ error: (error as Error)?.message ?? 'error', code: (error as { code?: string })?.code });
  });
  const baseUrl = await listen(createServer(app));
  return { baseUrl, upstream, users };
}

type Reply = { status: number; text: string; body: { error?: string; code?: string; data?: Record<string, unknown> } };

const call = async (baseUrl: string, asUser: string, method: string, url: string, body?: unknown): Promise<Reply> => {
  const response = await fetch(`${baseUrl}/api/providers/claude${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Reply['body'] = {};
  try { parsed = JSON.parse(text) as Reply['body']; } catch { /* 非 JSON */ }
  return { status: response.status, text, body: parsed };
};

/** 响应里不许出现任何一把 key 的明文。 */
const assertNoSecrets = (reply: Reply, secrets: string[], label: string) => {
  for (const secret of secrets) {
    assert.equal(reply.text.includes(secret), false, `${label}: 响应里出现了 key 明文 ${secret}`);
  }
};

const data = (reply: Reply) => reply.body.data as Record<string, any>;

/* ================================================================== */

describe('hq 路由:root 接口', () => {
  test('普通用户访问 root 接口一律 403,且什么都没改', async () => {
    const { baseUrl, users } = await setup();
    const created = await call(baseUrl, 'boss', 'POST', '/gateways', { name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer' });
    assert.equal(created.status, 201);
    const gid = data(created).gateway.id as number;

    const attempts: Array<[string, string, unknown?]> = [
      ['GET', '/gateways'],
      ['POST', '/gateways', { name: 'X', baseUrl: 'https://x.example.com' }],
      ['PATCH', `/gateways/${gid}`, { name: 'pwned' }],
      ['DELETE', `/gateways/${gid}`],
      ['PUT', `/gateways/${gid}/default-key`, { key: 'sk-evil' }],
      ['DELETE', `/gateways/${gid}/default-key`],
      ['POST', `/gateways/${gid}/test`, {}],
      ['POST', '/gateways/0/test', {}],
      ['GET', `/gateways/${gid}/keys`],
      ['GET', '/gateways/0/keys'],
      ['PUT', `/gateways/${gid}/keys/${users.bob.id}`, { key: 'sk-evil' }],
      ['PUT', `/gateways/0/keys/${users.bob.id}`, { key: 'sk-evil' }],
      ['DELETE', `/gateways/0/keys/${users.bob.id}`],
      ['PUT', '/gateways-settings', { allowPrivate: false }],
      ['POST', '/model-catalog', { modelId: 'm', gatewayId: gid }],
    ];
    for (const [method, url, body] of attempts) {
      const reply = await call(baseUrl, 'alice', method, url, body);
      assert.equal(reply.status, 403, `${method} ${url} → ${reply.status} ${reply.text}`);
    }
    const after = await call(baseUrl, 'boss', 'GET', '/gateways');
    assert.equal(data(after).gateways[0].name, 'G');
    assert.equal(data(after).gateways[0].hasDefaultKey, false);
    assert.equal(data(after).allowPrivate, true);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS c FROM gateway_user_keys').get() as { c: number }).c, 0);
  });

  test('provider 不是 claude → 400', async () => {
    const { baseUrl } = await setup();
    const response = await fetch(`${baseUrl}/api/providers/codex/my-gateways`, { headers: { 'x-test-user': 'alice' } });
    assert.equal(response.status, 400);
  });

  test('key 只进不出:每个碰 key 的接口,响应与审计里都没有明文', async () => {
    const { baseUrl, upstream, users } = await setup();
    const K = {
      sharedDefault: 'sk-shared-default-AAAA',
      sharedDefault2: 'sk-shared-default-BBBB',
      rootForAlice: 'sk-root-for-alice-CCCC',
      rootForBobZero: 'sk-root-for-bob-zero-DDDD',
      aliceZero: 'sk-alice-zero-EEEE',
      aliceShared: 'sk-alice-shared-FFFF',
      alicePrivate: 'sk-alice-private-GGGG',
      alicePrivate2: 'sk-alice-private-HHHH',
      probe: 'sk-probe-candidate-IIII',
    };
    const secrets = [...Object.values(K), SETTINGS_TOKEN];
    const replies: Array<[string, Reply]> = [];
    const track = async (label: string, promise: Promise<Reply>) => {
      const reply = await promise;
      replies.push([label, reply]);
      return reply;
    };

    // ---- root ----
    const created = await track('POST /gateways', call(baseUrl, 'boss', 'POST', '/gateways', {
      name: 'G', baseUrl: `${upstream}/tenant-g/v1`, authType: 'x-api-key', defaultKey: K.sharedDefault,
    }));
    assert.equal(created.status, 201, created.text);
    const gateway = data(created).gateway;
    assert.equal(gateway.baseUrl, `${upstream}/tenant-g`);
    assert.equal(gateway.hasDefaultKey, true);
    assert.equal(gateway.defaultKeyLast4, 'AAAA');
    const gid = gateway.id as number;

    const putDefault = await track('PUT default-key', call(baseUrl, 'boss', 'PUT', `/gateways/${gid}/default-key`, { key: K.sharedDefault2 }));
    assert.equal(putDefault.status, 200);
    assert.equal(data(putDefault).gateway.defaultKeyLast4, 'BBBB');

    const forAlice = await track('PUT keys/:alice', call(baseUrl, 'boss', 'PUT', `/gateways/${gid}/keys/${users.alice.id}`, { key: K.rootForAlice }));
    assert.equal(forAlice.status, 200);
    assert.deepEqual(data(forAlice).keys.map((row: Record<string, unknown>) => [row.username, row.keyLast4, row.setBy]), [['alice', 'CCCC', 'boss']]);
    const forBobZero = await track('PUT 0/keys/:bob', call(baseUrl, 'boss', 'PUT', `/gateways/0/keys/${users.bob.id}`, { key: K.rootForBobZero }));
    assert.equal(forBobZero.status, 200);
    await track('GET keys', call(baseUrl, 'boss', 'GET', `/gateways/${gid}/keys`));
    const zeroKeys = await track('GET 0/keys', call(baseUrl, 'boss', 'GET', '/gateways/0/keys'));
    assert.deepEqual(data(zeroKeys).keys.map((row: Record<string, unknown>) => row.keyLast4), ['DDDD']);

    // 测试连接:上游把 key 回显在 401 的错误体里 —— 不能被带回来
    const rootTest = await track('POST gateways/:id/test', call(baseUrl, 'boss', 'POST', `/gateways/${gid}/test`, {}));
    assert.equal(rootTest.status, 200);
    assert.equal(data(rootTest).result.ok, false);
    assert.equal(data(rootTest).result.status, 401);
    await track('POST gateways/0/test', call(baseUrl, 'boss', 'POST', '/gateways/0/test', {}));
    await track('POST gateways/:id/test with key', call(baseUrl, 'boss', 'POST', `/gateways/${gid}/test`, { key: K.probe }));
    await track('POST gateways-test', call(baseUrl, 'boss', 'POST', '/gateways-test', { baseUrl: upstream, authType: 'bearer', key: K.probe }));

    // ---- alice ----
    const putZero = await track('PUT my-gateways/0/key', call(baseUrl, 'alice', 'PUT', '/my-gateways/0/key', { key: K.aliceZero }));
    assert.equal(putZero.status, 200);
    const zeroView = data(putZero).gateways.find((row: Record<string, unknown>) => row.id === 0);
    assert.equal(zeroView.source, 'personal');
    assert.equal(zeroView.personalLast4, 'EEEE');
    assert.equal(zeroView.personalSetBy, 'alice');
    assert.equal(zeroView.baseUrl, null, '普通用户看不到默认网关的完整地址');
    const putShared = await track('PUT my-gateways/:id/key', call(baseUrl, 'alice', 'PUT', `/my-gateways/${gid}/key`, { key: K.aliceShared }));
    assert.equal(putShared.status, 200);

    const createdPrivate = await track('POST my-gateways', call(baseUrl, 'alice', 'POST', '/my-gateways', {
      name: 'mine', baseUrl: `${upstream}/alice`, authType: 'bearer', key: K.alicePrivate,
    }));
    assert.equal(createdPrivate.status, 201, createdPrivate.text);
    const pid = data(createdPrivate).gateway.id as number;
    assert.equal(data(createdPrivate).gateway.scope, 'private');
    assert.equal(data(createdPrivate).gateway.defaultKeyLast4, 'GGGG');
    const putPrivate = await track('PUT private-key', call(baseUrl, 'alice', 'PUT', `/my-gateways/${pid}/private-key`, { key: K.alicePrivate2 }));
    assert.equal(putPrivate.status, 200);
    assert.equal(data(putPrivate).gateway.defaultKeyLast4, 'HHHH');
    await track('PATCH my-gateways/:id', call(baseUrl, 'alice', 'PATCH', `/my-gateways/${pid}`, { name: 'mine2' }));
    const myTest = await track('POST my-gateways/:id/test', call(baseUrl, 'alice', 'POST', `/my-gateways/${pid}/test`, {}));
    assert.equal(data(myTest).result.status, 401);
    await track('POST my-gateways/0/test', call(baseUrl, 'alice', 'POST', '/my-gateways/0/test', {}));
    await track('POST my-gateways/:shared/test', call(baseUrl, 'alice', 'POST', `/my-gateways/${gid}/test`, {}));
    await track('POST gateways-test (alice)', call(baseUrl, 'alice', 'POST', '/gateways-test', { baseUrl: upstream, authType: 'x-api-key', key: K.probe }));
    // (不在这里打 /my-models/:id/probe:有 key 时它会真的起 CLI 子进程)
    const createdModel = await track('POST my-models', call(baseUrl, 'alice', 'POST', '/my-models', { gatewayId: pid, modelId: 'alice-model' }));
    assert.equal(createdModel.status, 201, createdModel.text);
    await track('PATCH my-models/:id', call(baseUrl, 'alice', 'PATCH', `/my-models/${data(createdModel).model.id}`, { label: 'Alice' }));

    const mine = await track('GET my-gateways', call(baseUrl, 'alice', 'GET', '/my-gateways'));
    const sharedView = data(mine).gateways.find((row: Record<string, unknown>) => row.id === gid);
    assert.equal(sharedView.source, 'personal');
    assert.equal(sharedView.personalLast4, 'FFFF');
    assert.equal(sharedView.baseUrl, null, '普通用户看共享网关只看 host');
    assert.ok(sharedView.host);
    assert.equal(sharedView.defaultKeyLast4, null, '普通用户看不到网关默认 key 的末四位');
    const privateView = data(mine).gateways.find((row: Record<string, unknown>) => row.id === pid);
    assert.equal(privateView.canSetPersonalKey, false);
    assert.equal(privateView.personalLast4, 'HHHH');
    await track('GET my-gateways (bob)', call(baseUrl, 'bob', 'GET', '/my-gateways'));

    const rootList = await track('GET gateways', call(baseUrl, 'boss', 'GET', '/gateways'));
    assert.equal(data(rootList).defaultGateway.baseUrl, `${upstream}/tenant-zero`);
    assert.equal(data(rootList).defaultGateway.hasDefaultKey, true);
    const privateForRoot = data(rootList).privateGateways.find((row: Record<string, unknown>) => row.id === pid);
    assert.equal(privateForRoot.ownerUsername, 'alice');
    assert.equal(privateForRoot.baseUrl, null, 'root 看别人的私有网关只看 host');
    assert.equal(privateForRoot.defaultKeyLast4, null, 'root 也看不到别人私有网关 key 的末四位');

    // 清 key 的几条也过一遍
    await track('DELETE my-gateways/0/key', call(baseUrl, 'alice', 'DELETE', '/my-gateways/0/key'));
    await track('DELETE 0/keys/:bob', call(baseUrl, 'boss', 'DELETE', `/gateways/0/keys/${users.bob.id}`));
    await track('DELETE default-key', call(baseUrl, 'boss', 'DELETE', `/gateways/${gid}/default-key`));

    for (const [label, reply] of replies) {
      assert.ok(reply.status < 500, `${label}: ${reply.status} ${reply.text}`);
      assertNoSecrets(reply, secrets, label);
    }

    // 审计:记了谁对哪个网关做了什么,但不记 key
    const audit = getConnection().prepare('SELECT event, detail FROM audit_log').all() as Array<{ event: string; detail: string | null }>;
    const events = new Set(audit.map((row) => row.event));
    for (const event of [
      'model_gateway_created', 'gateway_default_key_set', 'gateway_key_set_by_root', 'gateway_key_set', 'private_gateway_created',
      'private_gateway_key_set', 'private_gateway_updated', 'user_model_created', 'gateway_key_cleared', 'gateway_key_cleared_by_root',
      'gateway_default_key_cleared',
    ]) {
      assert.ok(events.has(event as never), `缺审计事件 ${event}`);
    }
    const auditText = JSON.stringify(audit);
    for (const secret of secrets) assert.equal(auditText.includes(secret), false, `审计里出现了 ${secret}`);
    for (const last4 of ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF', 'GGGG', 'HHHH']) {
      assert.equal(auditText.includes(last4), false, `审计里出现了末四位 ${last4}`);
    }
  });

  // BUG(低):root 替别人设 / 清个人 key 的审计行没有 target_user_id(只在 detail 里记了 forUserId),
  // 被操作的人在「与我有关的操作记录」里看不到 —— 与 admin.routes.ts 的 adminAuditBase(hl 动态 P2-9)约定不一致。
  // 修法:claude-gateways.routes.ts 的 audit() 增加 targetUserId 参数,gateway_key_set_by_root / gateway_key_cleared_by_root 传 userId。
  test('root 替别人设 / 清 key:审计行带 target_user_id = 被操作的人', async () => {
    const { baseUrl, users } = await setup();
    assert.equal((await call(baseUrl, 'boss', 'PUT', `/gateways/0/keys/${users.bob.id}`, { key: 'sk-for-bob' })).status, 200);
    assert.equal((await call(baseUrl, 'boss', 'DELETE', `/gateways/0/keys/${users.bob.id}`)).status, 200);
    const rows = getConnection()
      .prepare("SELECT event, target_user_id FROM audit_log WHERE event IN ('gateway_key_set_by_root', 'gateway_key_cleared_by_root') ORDER BY id")
      .all() as Array<{ event: string; target_user_id: number | null }>;
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.target_user_id, users.bob.id, row.event);
  });

  test('目录条目:gatewayId 只能是共享网关、allowedUsers 只能是存在的用户;挂着模型的共享网关删不了(409)', async () => {
    const { baseUrl, users } = await setup();
    const g = data(await call(baseUrl, 'boss', 'POST', '/gateways', { name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer' })).gateway;
    const p = data(await call(baseUrl, 'alice', 'POST', '/my-gateways', { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer' })).gateway;

    const onPrivate = await call(baseUrl, 'boss', 'POST', '/model-catalog', { modelId: 'm1', gatewayId: p.id });
    assert.equal(onPrivate.status, 400);
    assert.equal(onPrivate.body.code, 'BAD_GATEWAY');
    const missingGateway = await call(baseUrl, 'boss', 'POST', '/model-catalog', { modelId: 'm1', gatewayId: 4242 });
    assert.equal(missingGateway.body.code, 'BAD_GATEWAY');
    const ghostUser = await call(baseUrl, 'boss', 'POST', '/model-catalog', { modelId: 'm1', allowedUsers: [users.alice.id, 4242] });
    assert.equal(ghostUser.status, 400);
    assert.equal(ghostUser.body.code, 'BAD_ALLOWED_USERS');

    const ok = await call(baseUrl, 'boss', 'POST', '/model-catalog', { modelId: 'm1', gatewayId: g.id, allowedUsers: [users.alice.id] });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(data(ok).entry.gatewayId, g.id);
    assert.deepEqual(data(ok).entry.allowedUsers, [users.alice.id]);
    const listed = await call(baseUrl, 'boss', 'GET', '/model-catalog');
    assert.equal(data(listed).entries[0].gatewayId, g.id);

    const blocked = await call(baseUrl, 'boss', 'DELETE', `/gateways/${g.id}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'GATEWAY_IN_USE');
    const moved = await call(baseUrl, 'boss', 'PATCH', `/model-catalog/${data(ok).entry.id}`, { gatewayId: 0 });
    assert.equal(moved.status, 200);
    assert.equal(data(moved).entry.gatewayId, 0);
    const removed = await call(baseUrl, 'boss', 'DELETE', `/gateways/${g.id}`);
    assert.equal(removed.status, 200);
    // 删共享网关的入口删不了私有网关
    assert.equal((await call(baseUrl, 'boss', 'DELETE', `/gateways/${p.id}`)).status, 404);
    assert.equal((await call(baseUrl, 'boss', 'PATCH', `/gateways/${p.id}`, { name: 'x' })).status, 404);
    assert.equal((await call(baseUrl, 'boss', 'PUT', `/gateways/${p.id}/default-key`, { key: 'sk-x' })).status, 404);
  });

  test('/models 按人:可用人员与私有模型只对该看的人出现;不可用的带 available:false', async () => {
    const { baseUrl, users } = await setup();
    const g = data(await call(baseUrl, 'boss', 'POST', '/gateways', { name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer' })).gateway;
    await call(baseUrl, 'boss', 'POST', '/model-catalog', { modelId: 'team-model', allowedUsers: [users.alice.id] });
    await call(baseUrl, 'boss', 'POST', '/model-catalog', { modelId: 'g-model', gatewayId: g.id });
    const p = data(await call(baseUrl, 'alice', 'POST', '/my-gateways', { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer', key: 'sk-alice-p' })).gateway;
    await call(baseUrl, 'alice', 'POST', '/my-models', { gatewayId: p.id, modelId: 'alice-model' });

    const values = async (who: string) => {
      const reply = await call(baseUrl, who, 'GET', '/models');
      assert.equal(reply.status, 200, reply.text);
      return data(reply).models.OPTIONS as Array<Record<string, unknown>>;
    };
    const alice = await values('alice');
    assert.deepEqual(alice.filter((row) => row.group === 'catalog').map((row) => row.value), ['alice-model', 'team-model', 'g-model']);
    assert.equal(alice.find((row) => row.value === 'g-model')?.available, false);
    assert.equal(alice.find((row) => row.value === 'alice-model')?.available, true);
    const bob = await values('bob');
    assert.deepEqual(bob.filter((row) => row.group === 'catalog').map((row) => row.value), ['g-model']);
  });
});

/* ================================================================== */

describe('hq 路由:本人的私有网关 / 私有模型', () => {
  test('别人的私有网关 / 私有模型:读不到、改不了、删不了、测不了(404),数据原样', async () => {
    const { baseUrl } = await setup();
    const p = data(await call(baseUrl, 'alice', 'POST', '/my-gateways', { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer', key: 'sk-alice-p' })).gateway;
    const model = data(await call(baseUrl, 'alice', 'POST', '/my-models', { gatewayId: p.id, modelId: 'alice-model', label: 'A' })).model;

    const attempts: Array<[string, string, unknown?]> = [
      ['PATCH', `/my-gateways/${p.id}`, { name: 'pwned', baseUrl: 'https://evil.example.com' }],
      ['PUT', `/my-gateways/${p.id}/private-key`, { key: 'sk-evil' }],
      ['PUT', `/my-gateways/${p.id}/private-key`, { key: '' }],
      ['DELETE', `/my-gateways/${p.id}`],
      ['POST', `/my-gateways/${p.id}/test`, {}],
      ['POST', '/my-models', { gatewayId: p.id, modelId: 'squatter' }],
      ['PATCH', `/my-models/${model.id}`, { label: 'pwned' }],
      ['DELETE', `/my-models/${model.id}`],
      ['POST', `/my-models/${model.id}/probe`, {}],
    ];
    for (const who of ['bob', 'boss']) {
      for (const [method, url, body] of attempts) {
        const reply = await call(baseUrl, who, method, url, body);
        assert.equal(reply.status, 404, `${who} ${method} ${url} → ${reply.status} ${reply.text}`);
      }
    }
    // 别人的私有网关上不能填"个人 key"(不管返回什么,都不能写进去)
    const keyAttempt = await call(baseUrl, 'bob', 'PUT', `/my-gateways/${p.id}/key`, { key: 'sk-evil' });
    assert.ok(keyAttempt.status >= 400 && keyAttempt.status < 500, keyAttempt.text);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS c FROM gateway_user_keys').get() as { c: number }).c, 0);

    const bobView = await call(baseUrl, 'bob', 'GET', '/my-gateways');
    assert.equal(data(bobView).gateways.some((row: Record<string, unknown>) => row.id === p.id), false);
    assert.deepEqual(data(bobView).models, []);
    assert.equal(bobView.text.includes('alice.example.com'), false);

    const aliceView = await call(baseUrl, 'alice', 'GET', '/my-gateways');
    const mine = data(aliceView).gateways.find((row: Record<string, unknown>) => row.id === p.id);
    assert.equal(mine.name, 'mine');
    assert.equal(mine.baseUrl, 'https://alice.example.com');
    assert.equal(mine.hasDefaultKey, true);
    assert.deepEqual(data(aliceView).models.map((row: Record<string, unknown>) => [row.modelId, row.label]), [['alice-model', 'A']]);
  });

  // BUG(低):别人的私有网关在 `PUT /my-gateways/:id/key` 上回 400 PRIVATE_GATEWAY(不存在的 id 回 404)——
  // 能据此探出某个 id 是不是别人的私有网关。修法:claude-gateways.service.ts requireKeyableGateway 在
  // 私有网关且 owner ≠ 调用者时也抛 NOT_FOUND 404(需要把 userId 传进去),或路由层先查归属。
  test('别人的私有网关上填个人 key → 404(与其它入口一致,不泄露存在性)', async () => {
    const { baseUrl } = await setup();
    const p = data(await call(baseUrl, 'alice', 'POST', '/my-gateways', { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer' })).gateway;
    assert.equal((await call(baseUrl, 'bob', 'PUT', `/my-gateways/${p.id}/key`, { key: 'sk-evil' })).status, 404);
  });

  test('私有网关总开关:关掉后不能新建 / 改 / 填 key / 加模型 / 测未保存的网关;本人仍能删;root 不受影响', async () => {
    const { baseUrl } = await setup();
    const p = data(await call(baseUrl, 'alice', 'POST', '/my-gateways', { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer' })).gateway;
    const model = data(await call(baseUrl, 'alice', 'POST', '/my-models', { gatewayId: p.id, modelId: 'alice-model' })).model;
    const off = await call(baseUrl, 'boss', 'PUT', '/gateways-settings', { allowPrivate: false });
    assert.equal(off.status, 200);
    assert.equal(data(off).allowPrivate, false);
    assert.equal((await call(baseUrl, 'boss', 'PUT', '/gateways-settings', { allowPrivate: 'no' })).status, 400);

    for (const [method, url, body] of [
      ['POST', '/my-gateways', { name: 'two', baseUrl: 'https://two.example.com' }],
      ['PATCH', `/my-gateways/${p.id}`, { name: 'renamed' }],
      ['PUT', `/my-gateways/${p.id}/private-key`, { key: 'sk-x' }],
      ['POST', '/my-models', { gatewayId: p.id, modelId: 'another' }],
      ['PATCH', `/my-models/${model.id}`, { label: 'x' }],
      ['POST', `/my-models/${model.id}/probe`, {}],
      ['POST', '/gateways-test', { baseUrl: 'https://x.example.com', authType: 'bearer', key: 'k' }],
    ] as Array<[string, string, unknown]>) {
      const reply = await call(baseUrl, 'alice', method, url, body);
      assert.equal(reply.status, 403, `${method} ${url} → ${reply.status} ${reply.text}`);
      assert.equal(reply.body.code, 'PRIVATE_GATEWAYS_DISABLED');
    }
    const view = await call(baseUrl, 'alice', 'GET', '/my-gateways');
    assert.equal(data(view).allowPrivate, false);
    const models = await call(baseUrl, 'alice', 'GET', '/models');
    assert.equal((data(models).models.OPTIONS as Array<Record<string, unknown>>).some((row) => row.private), false);

    const delModel = await call(baseUrl, 'alice', 'DELETE', `/my-models/${model.id}`);
    assert.equal(delModel.status, 200);
    const delGateway = await call(baseUrl, 'alice', 'DELETE', `/my-gateways/${p.id}`);
    assert.equal(delGateway.status, 200);
    assert.deepEqual(data(delGateway).models, []);
  });

  test('删私有网关连带删掉上面的私有模型;删除响应里带最新列表', async () => {
    const { baseUrl } = await setup();
    const p = data(await call(baseUrl, 'alice', 'POST', '/my-gateways', { name: 'mine', baseUrl: 'https://alice.example.com', authType: 'bearer' })).gateway;
    await call(baseUrl, 'alice', 'POST', '/my-models', { gatewayId: p.id, modelId: 'a-1' });
    await call(baseUrl, 'alice', 'POST', '/my-models', { gatewayId: p.id, modelId: 'a-2' });
    const removed = await call(baseUrl, 'alice', 'DELETE', `/my-gateways/${p.id}`);
    assert.equal(removed.status, 200);
    assert.equal(data(removed).removed, p.id);
    assert.deepEqual(data(removed).models, []);
    assert.equal(data(removed).gateways.some((row: Record<string, unknown>) => row.id === p.id), false);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS c FROM user_models').get() as { c: number }).c, 0);
  });

  test('个人 key:只能填在网关 0 与共享网关上;key 校验失败 → 400 BAD_KEY;不存在的网关 → 404', async () => {
    const { baseUrl } = await setup();
    const g = data(await call(baseUrl, 'boss', 'POST', '/gateways', { name: 'G', baseUrl: 'https://g.example.com', authType: 'bearer' })).gateway;
    assert.equal((await call(baseUrl, 'alice', 'PUT', `/my-gateways/${g.id}/key`, { key: 'sk a' })).body.code, 'BAD_KEY');
    assert.equal((await call(baseUrl, 'alice', 'PUT', '/my-gateways/0/key', {})).body.code, 'BAD_KEY');
    assert.equal((await call(baseUrl, 'alice', 'PUT', '/my-gateways/4242/key', { key: 'sk-x' })).status, 404);
    assert.equal((await call(baseUrl, 'alice', 'PUT', '/my-gateways/-1/key', { key: 'sk-x' })).status, 400);
    assert.equal((await call(baseUrl, 'boss', 'PUT', `/gateways/${g.id}/keys/4242`, { key: 'sk-x' })).status, 404);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS c FROM gateway_user_keys').get() as { c: number }).c, 0);
  });
});
