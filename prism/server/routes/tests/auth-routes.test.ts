import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'vitest';

/**
 * G1:注册 / 登录路由的行为矩阵。
 *
 * 这三条路(审批门、失败锁定、令牌旋转)决定了"谁能进来"和"进来之后旧凭据还算不算数",
 * 而它们此前只有间接覆盖。这里用一个真的 express 服务器跑真的 HTTP —— 中间件顺序
 * (限流 → 锁定 → 路由)本身就是被测对象的一部分,拿函数单独调是测不出来的。
 *
 * 端口取 0(内核分配),所以并行跑测试也不会撞端口。
 */
const previousEnv = {
  DATABASE_PATH: process.env.DATABASE_PATH,
  PRISM_ROOT_USERS: process.env.PRISM_ROOT_USERS,
  PRISM_APPROVAL_REQUIRED: process.env.PRISM_APPROVAL_REQUIRED,
  JWT_SECRET: process.env.JWT_SECRET,
  PRISM_LOGIN_MAX_ATTEMPTS: process.env.PRISM_LOGIN_MAX_ATTEMPTS,
  PRISM_TRUST_PROXY: process.env.PRISM_TRUST_PROXY,
};

let tempDir: string | null = null;
let server: Server | null = null;
let baseUrl = '';
let authRoutes: express.Router;
let db: typeof import('@/modules/database/index.js');

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-for-auth-routes';
  process.env.PRISM_ROOT_USERS = 'boss';
  process.env.PRISM_APPROVAL_REQUIRED = '1';
  // 锁定阈值调到 3,免得每条用例都要打五次错密码。
  process.env.PRISM_LOGIN_MAX_ATTEMPTS = '3';
  // 锁定按 (IP, 用户名) 计数,而测试全都来自 127.0.0.1 —— 打开代理信任让每条
  // 用例能用 X-Forwarded-For 挑一个自己的"来源",互不干扰。
  process.env.PRISM_TRUST_PROXY = '1';

  tempDir = await mkdtemp(path.join(tmpdir(), 'auth-routes-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  db = await import('@/modules/database/index.js');
  await db.initializeDatabase();

  authRoutes = (await import('@/routes/auth.js')).default;

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  db?.closeConnection();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 每条用例一张干净的用户表 —— 但**不重建连接**:auth.js 在模块加载时
  // 抓住了一个连接对象(`const db = getConnection()`),换连接会让它拿着一个
  // 已关闭的句柄。
  const connection = db.getConnection();
  connection.prepare('DELETE FROM users').run();
  connection.prepare('DELETE FROM audit_log').run();
});

afterEach(() => { /* 状态在 beforeEach 里清 */ });

type Json = Record<string, unknown>;

const post = async (route: string, body: Json, headers: Record<string, string> = {}) => {
  const response = await fetch(`${baseUrl}/api/auth${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
};

describe('注册', () => {
  test('第一个账号直接可用 —— 全新安装时没有任何人能来批它', async () => {
    const result = await post('/register', { username: 'first', password: 'password123' });
    assert.equal(result.status, 200);
    assert.equal(result.body.pendingApproval, false);
    assert.ok(result.body.token, '第一个账号应该拿到 token');
  });

  test('之后的账号进待审队列,而且**不发 token** —— 登不进去的账号不该拿到会话', async () => {
    await post('/register', { username: 'first', password: 'password123' });
    const result = await post('/register', { username: 'second', password: 'password123' });

    assert.equal(result.status, 200);
    assert.equal(result.body.pendingApproval, true);
    assert.equal(result.body.token, undefined);
  });

  test('PRISM_ROOT_USERS 里的名字免审批 —— 审批逻辑要是错了,root 还进得来把它改回去', async () => {
    await post('/register', { username: 'first', password: 'password123' });
    const result = await post('/register', { username: 'boss', password: 'password123' });

    assert.equal(result.body.pendingApproval, false);
    assert.ok(result.body.token);
  });

  test('太短的用户名/密码被挡下来', async () => {
    assert.equal((await post('/register', { username: 'ab', password: 'password123' })).status, 400);
    assert.equal((await post('/register', { username: 'abc', password: '12345' })).status, 400);
    assert.equal((await post('/register', { username: '', password: '' })).status, 400);
  });

  test('重名注册不成功,而且不会把库写坏(下一次注册照常)', async () => {
    await post('/register', { username: 'first', password: 'password123' });
    const dup = await post('/register', { username: 'first', password: 'password123' });
    assert.ok(dup.status >= 400);

    const other = await post('/register', { username: 'another', password: 'password123' });
    assert.equal(other.status, 200);
  });
});

describe('登录', () => {
  test('待审账号:密码对也进不去,而且给的是 403 + 状态,不是含糊的 401', async () => {
    await post('/register', { username: 'first', password: 'password123' });
    await post('/register', { username: 'pending', password: 'password123' });

    const result = await post('/login', { username: 'pending', password: 'password123' });
    assert.equal(result.status, 403);
    assert.equal(result.body.approvalStatus, 'pending');
  });

  test('审批通过之后就能登录', async () => {
    await post('/register', { username: 'first', password: 'password123' });
    await post('/register', { username: 'pending', password: 'password123' });
    const userId = db.userDb.findIdByUsername('pending')!;
    db.userDb.setApprovalStatus(userId, 'approved', null);

    const result = await post('/login', { username: 'pending', password: 'password123' });
    assert.equal(result.status, 200);
    assert.ok(result.body.token);
  });

  test('不存在的用户和密码错误给**同一句话** —— 否则登录框就成了用户名探测器', async () => {
    await post('/register', { username: 'first', password: 'password123' });

    const unknown = await post('/login', { username: 'nobody', password: 'password123' }, { 'x-forwarded-for': '10.9.0.1' });
    const wrongPassword = await post('/login', { username: 'first', password: 'wrong-password' }, { 'x-forwarded-for': '10.9.0.2' });

    assert.equal(unknown.status, 401);
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknown.body.error, wrongPassword.body.error);
  });

  test('连续失败会锁定,锁定后**连正确密码也进不去**', async () => {
    await post('/register', { username: 'first', password: 'password123' });
    const from = { 'x-forwarded-for': '10.9.9.9' };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await post('/login', { username: 'first', password: 'wrong' }, from);
    }

    const locked = await post('/login', { username: 'first', password: 'password123' }, from);
    assert.equal(locked.status, 429, `锁定后应该是 429,实际 ${locked.status}: ${JSON.stringify(locked.body)}`);

    // 换一个来源不受影响 —— 锁的是(IP, 用户名),不是账号本身
    const elsewhere = await post('/login', { username: 'first', password: 'password123' }, { 'x-forwarded-for': '10.9.9.10' });
    assert.equal(elsewhere.status, 200, '锁定不该把这个账号在别处也锁死');
  });

  test('缺字段 400', async () => {
    assert.equal((await post('/login', { username: 'first' })).status, 400);
    assert.equal((await post('/login', {})).status, 400);
  });
});
