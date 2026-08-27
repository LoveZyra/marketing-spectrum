import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'vitest';

/**
 * G1:鉴权中间件的行为矩阵。
 *
 * 这个文件此前**一个测试都没有**,而它是整个服务里唯一决定"你是谁、你能不能进"
 * 的地方:JWT 校验、令牌吊销(token_version)、半衰期续签、root 判定、API key 闸、
 * WebSocket 升级鉴权。任何一条错掉都是越权,而越权是这类系统里最贵的错。
 *
 * 每条用例钉的都是**行为**(响应码 / req.user / 返回值),不是实现 —— 中间件重写
 * 一遍也该照样通过。
 */
type FakeResponse = {
  statusCode: number | null;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeResponse;
  json(payload: unknown): FakeResponse;
  setHeader(name: string, value: string): void;
};

function createResponse(): FakeResponse {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
  };
}

const previousEnv = {
  DATABASE_PATH: process.env.DATABASE_PATH,
  PRISM_ROOT_USERS: process.env.PRISM_ROOT_USERS,
  PRISM_API_KEY: process.env.PRISM_API_KEY,
  JWT_SECRET: process.env.JWT_SECRET,
  PRISM_ALLOW_QUERY_TOKEN: process.env.PRISM_ALLOW_QUERY_TOKEN,
};

let tempDir: string | null = null;
let auth: typeof import('@/middleware/auth.js');
let userDb: typeof import('@/modules/database/index.js')['userDb'];

/**
 * auth.js 在**模块加载时**读 JWT_SECRET,所以密钥必须在 import 之前就位 ——
 * 于是整个文件共用一次导入(beforeAll),而不是每个用例重载。
 *
 * 这样做是安全的:PRISM_API_KEY 与 PRISM_ALLOW_QUERY_TOKEN 都是**每次请求**现读的,
 * 需要它们变化的用例直接改 env 即可,不需要新的模块实例。
 */
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-for-auth-matrix';
  process.env.PRISM_ROOT_USERS = 'boss';
  auth = await import('@/middleware/auth.js');
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'auth-mw-'));
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  delete process.env.PRISM_API_KEY;
  delete process.env.PRISM_ALLOW_QUERY_TOKEN;

  const db = await import('@/modules/database/index.js');
  db.closeConnection();
  await db.initializeDatabase();
  userDb = db.userDb;
});

afterEach(async () => {
  const db = await import('@/modules/database/index.js');
  db.closeConnection();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const createUser = (username: string) => {
  const created = userDb.createUser(username, 'hash');
  return userDb.getUserById(Number(created.id))!;
};

const runMiddleware = async (
  middleware: (req: unknown, res: unknown, next: () => void) => unknown,
  req: Record<string, unknown>,
): Promise<{ res: FakeResponse; nexted: boolean; req: Record<string, unknown> }> => {
  const res = createResponse();
  let nexted = false;
  await middleware(req, res, () => { nexted = true; });
  return { res, nexted, req };
};

describe('authenticateToken', () => {
  test('没有 token 一律 401,而且不泄漏"哪个环节失败"', async () => {
    const { res, nexted } = await runMiddleware(auth.authenticateToken, { headers: {}, query: {} });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });

  test('合法 token 放行,并把 user 挂上(含 isRoot)', async () => {
    const alice = createUser('alice');
    const token = auth.generateToken(alice);
    const { res, nexted, req } = await runMiddleware(auth.authenticateToken, {
      headers: { authorization: `Bearer ${token}` },
      query: {},
    });

    assert.equal(nexted, true, `期望放行,实际 ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal((req.user as { username: string }).username, 'alice');
    assert.equal((req.user as { isRoot: boolean }).isRoot, false);
  });

  test('root 身份来自 PRISM_ROOT_USERS,不是数据库里的列', async () => {
    const boss = createUser('boss');
    const { req } = await runMiddleware(auth.authenticateToken, {
      headers: { authorization: `Bearer ${auth.generateToken(boss)}` },
      query: {},
    });
    assert.equal((req.user as { isRoot: boolean }).isRoot, true);
  });

  test('伪造签名 → 403(与"没带 token"的 401 区分开)', async () => {
    const { res, nexted } = await runMiddleware(auth.authenticateToken, {
      headers: { authorization: 'Bearer not.a.real.token' },
      query: {},
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
  });

  test('token 指向的用户不存在时 401(而不是当成匿名放行)', async () => {
    const alice = createUser('alice');
    // 用一个库里没有的 id 签一个**签名合法**的 token —— 这正是"删号后旧 token"
    // 和"跨库复用 token"两种情况的形状。
    const orphan = auth.generateToken({ id: alice.id + 9999, username: 'ghost', token_version: 0 });

    const { res, nexted } = await runMiddleware(auth.authenticateToken, {
      headers: { authorization: `Bearer ${orphan}` },
      query: {},
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });

  test('token_version 一变,旧 token 全部作废(改密码 / 全端登出的实现)', async () => {
    const alice = createUser('alice');
    const token = auth.generateToken(alice);

    // 先确认它本来是好的
    assert.equal((await runMiddleware(auth.authenticateToken, {
      headers: { authorization: `Bearer ${token}` }, query: {},
    })).nexted, true);

    userDb.bumpTokenVersion(alice.id);

    const { res, nexted } = await runMiddleware(auth.authenticateToken, {
      headers: { authorization: `Bearer ${token}` },
      query: {},
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
    assert.match(String((res.body as { error: string }).error), /revoked/i);
  });

  test('停用的账号进不来 —— getUserById 只返回活跃用户', async () => {
    const alice = createUser('alice');
    const token = auth.generateToken(alice);
    userDb.setActive(alice.id, false);

    const { res, nexted } = await runMiddleware(auth.authenticateToken, {
      headers: { authorization: `Bearer ${token}` },
      query: {},
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });

  test('默认**不接受** ?token= —— 那正是要消灭的泄漏面(URL 会进日志和浏览器历史)', async () => {
    const alice = createUser('alice');
    const token = auth.generateToken(alice);

    const { res, nexted } = await runMiddleware(auth.authenticateToken, {
      headers: {},
      query: { token },
    });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });

  test('显式开了 PRISM_ALLOW_QUERY_TOKEN=1 的老部署才放行', async () => {
    // 这个开关是每次请求现读的,所以改 env 就够,不需要重新加载模块。
    process.env.PRISM_ALLOW_QUERY_TOKEN = '1';
    const alice = createUser('alice');

    const { nexted } = await runMiddleware(auth.authenticateToken, {
      headers: {},
      query: { token: auth.generateToken(alice) },
    });
    assert.equal(nexted, true);
  });
});

describe('requireRoot', () => {
  test('只有 isRoot 放行,其余一律 403', async () => {
    assert.equal((await runMiddleware(auth.requireRoot, { user: { isRoot: true } })).nexted, true);

    const denied = await runMiddleware(auth.requireRoot, { user: { isRoot: false } });
    assert.equal(denied.nexted, false);
    assert.equal(denied.res.statusCode, 403);

    // 没跑过 authenticateToken(req.user 缺失)也必须是拒绝,不能当成"内部调用"放行
    const anonymous = await runMiddleware(auth.requireRoot, {});
    assert.equal(anonymous.nexted, false);
    assert.equal(anonymous.res.statusCode, 403);
  });
});

describe('validateApiKey', () => {
  test('没配 PRISM_API_KEY 时直接放行(这道闸默认关)', async () => {
    const { nexted } = await runMiddleware(auth.validateApiKey, { headers: {} });
    assert.equal(nexted, true);
  });

  test('配了就必须带对的头;错的、缺的一律 401', async () => {
    process.env.PRISM_API_KEY = 'super-secret';
    const gated = auth;

    assert.equal((await runMiddleware(gated.validateApiKey, {
      headers: { 'x-prism-api-key': 'super-secret' },
    })).nexted, true);

    const wrong = await runMiddleware(gated.validateApiKey, { headers: { 'x-prism-api-key': 'nope' } });
    assert.equal(wrong.nexted, false);
    assert.equal(wrong.res.statusCode, 401);

    const missing = await runMiddleware(gated.validateApiKey, { headers: {} });
    assert.equal(missing.nexted, false);
    assert.equal(missing.res.statusCode, 401);
  });

  test('长度不同的 key 不会让 timingSafeEqual 抛出来(它对不等长会抛)', async () => {
    process.env.PRISM_API_KEY = 'super-secret';
    const gated = auth;
    const short = await runMiddleware(gated.validateApiKey, { headers: { 'x-prism-api-key': 'x' } });
    assert.equal(short.res.statusCode, 401);
  });
});

describe('authenticateWebSocket', () => {
  test('合法 token 返回身份;无 token / 伪造 / 已吊销一律 null', async () => {
    const alice = createUser('alice');
    const token = auth.generateToken(alice);

    assert.deepEqual(auth.authenticateWebSocket(token), { userId: alice.id, username: 'alice' });
    assert.equal(auth.authenticateWebSocket(''), null);
    assert.equal(auth.authenticateWebSocket('garbage'), null);

    userDb.bumpTokenVersion(alice.id);
    assert.equal(auth.authenticateWebSocket(token), null, '吊销过的 token 也不能开 socket');
  });
});

describe('generateToken', () => {
  test('把当前 token_version 钉进 token —— 没有它就没法吊销', async () => {
    const alice = createUser('alice');
    userDb.bumpTokenVersion(alice.id);
    const fresh = userDb.getUserById(alice.id)!;

    // 用**旧行**(version 0)签出来的 token 应该已经不被接受
    const stale = auth.generateToken({ ...alice, token_version: 0 });
    assert.equal(auth.authenticateWebSocket(stale), null);

    // 用新行签的可以
    assert.ok(auth.authenticateWebSocket(auth.generateToken(fresh)));
  });
});
