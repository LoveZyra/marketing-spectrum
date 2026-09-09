import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { describe, test } from 'vitest';

import { closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { isRootUser } from '@/shared/root-users.js';

import { createAdminRouter } from '../admin.routes.js';

/**
 * 管理接口:**每一条**都必须过 root 闸门。
 *
 * ## 为什么值得为一句 `router.use` 写测试
 *
 * 这个路由的 8 条端点里有"重置任意账号密码""停用账号""读全站账号列表" ——
 * 全站权限最高的一组。它们靠**一句** `router.use(authenticateToken, requireRoot)` 罩住。
 *
 * 一句罩住是好设计(比逐条挂不容易漏),但它也意味着:**任何人往这个文件里加一条
 * 路由,是否受保护完全取决于加在那一句的上面还是下面**,而这件事在 diff 里几乎看不出来。
 * 覆盖率报告里这个文件是 0.0%,也就是说这一句从来没有被验证过真的生效。
 *
 * 所以这里不逐条列端点,而是**从源码里把端点扫出来**逐个打 —— 以后新增的端点
 * 自动被纳入,不需要有人记得回来补测试。这和 `.gitignore`、`INIT_SCHEMA_SQL`
 * 那两条守卫是同一个思路:让"漏一个"这件事不可表示。
 *
 * ## 顺带钉住 root 判定的口径
 *
 * `isRootUser` 是大小写不敏感的(ez 轮把 `users.username` 也改成了 `COLLATE NOCASE`,
 * 修的正是"注册一个大小写变体就是 root"那个提权)。这里验一下大小写变体的用户名
 * 确实仍被认成 root —— 免得哪天有人"顺手"把 `isRootUser` 改成精确匹配,
 * 让配置里写 `Boss` 的部署一夜之间没有管理员。
 */

type TestUser = { id: number; username: string };

/** 从路由源码里扫出所有端点 —— 新增的会自动被这条测试覆盖到。 */
function readAdminEndpoints(): Array<{ method: string; url: string }> {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const source = require('node:fs').readFileSync(path.join(here, '..', 'admin.routes.ts'), 'utf8') as string;
  const out: Array<{ method: string; url: string }> = [];
  for (const match of source.matchAll(/router\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
    out.push({ method: match[1].toUpperCase(), url: match[2].replace(':id', '1') });
  }
  return out;
}

async function withAdminServer(
  runTest: (ctx: { baseUrl: string; endpoints: Array<{ method: string; url: string }> }) => Promise<void>,
): Promise<void> {
  const prevDb = process.env.DATABASE_PATH;
  const prevRoot = process.env.PRISM_ROOT_USERS;
  const dir = await mkdtemp(path.join(tmpdir(), 'admin-authz-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  await initializeDatabase();

  let server: Server | null = null;
  try {
    const users: Record<string, TestUser> = {};
    for (const name of ['alice', 'boss', 'BOSS']) {
      // BOSS 与 boss 在 NOCASE 下是同一行,第二次会抛 —— 复用第一行即可
      if (users[name.toLowerCase()]) { users[name] = users[name.toLowerCase()]; continue; }
      users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name };
      users[name.toLowerCase()] = users[name];
    }
    // 大小写变体的"身份"(库里是同一行,但请求头里带的是大写写法)
    users.BOSS = { id: users.boss.id, username: 'BOSS' };

    const fakeAuth: RequestHandler = (req, _res, next) => {
      const name = String(req.headers['x-test-user'] ?? '');
      (req as unknown as { user?: TestUser }).user = users[name];
      next();
    };
    // 生产同款:rootness 每请求从 PRISM_ROOT_USERS 现算,不读列
    const requireRoot: RequestHandler = (req, res, next) => {
      const user = (req as unknown as { user?: TestUser }).user;
      if (user && isRootUser(user.username)) return next();
      return res.status(403).json({ error: 'Administrator access required' });
    };

    const app = express();
    app.use(express.json());
    app.use('/api/admin', createAdminRouter({ authenticateToken: fakeAuth, requireRoot }));

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no listen address');

    await runTest({
      baseUrl: `http://127.0.0.1:${address.port}`,
      endpoints: readAdminEndpoints(),
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    closeConnection();
    if (prevDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prevDb;
    if (prevRoot === undefined) delete process.env.PRISM_ROOT_USERS; else process.env.PRISM_ROOT_USERS = prevRoot;
    await rm(dir, { recursive: true, force: true });
  }
}

const hit = (baseUrl: string, asUser: string, method: string, url: string) =>
  fetch(`${baseUrl}/api/admin${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: method === 'GET' ? undefined : '{}',
  });

describe('管理接口的 root 闸门', () => {
  test('扫出来的每一条端点,非 root 一律 403', async () => {
    await withAdminServer(async ({ baseUrl, endpoints }) => {
      // 扫不到端点说明正则失效了 —— 那比不通过更危险(它会一直绿着什么都没守)
      assert.ok(endpoints.length >= 8, `只扫到 ${endpoints.length} 条端点,判据可能已失效`);

      for (const { method, url } of endpoints) {
        const response = await hit(baseUrl, 'alice', method, url);
        assert.equal(response.status, 403, `${method} ${url} 没有挡住非 root`);
        const body = (await response.json()) as { error?: string };
        assert.equal(body.error, 'Administrator access required', `${method} ${url} 文案不对`);
      }
    });
  });

  test('未认证(没有 req.user)同样 403', async () => {
    await withAdminServer(async ({ baseUrl, endpoints }) => {
      for (const { method, url } of endpoints) {
        const response = await hit(baseUrl, 'nobody', method, url);
        assert.equal(response.status, 403, `${method} ${url} 对未认证放行了`);
      }
    });
  });

  test('root 过闸(证明不是一刀切全挡)', async () => {
    await withAdminServer(async ({ baseUrl }) => {
      const response = await hit(baseUrl, 'boss', 'GET', '/users');
      assert.equal(response.status, 200);
      const body = (await response.json()) as { success?: boolean; users?: unknown[] };
      assert.equal(body.success, true);
      assert.ok(Array.isArray(body.users));
    });
  });

  test('root 判定大小写不敏感 —— 配置写 boss,用 BOSS 登录也是 root', async () => {
    await withAdminServer(async ({ baseUrl }) => {
      // ez 轮把 users.username 改成 COLLATE NOCASE(修"注册大小写变体即 root"的提权),
      // 而 isRootUser 本来就是不敏感的。两边必须保持同一口径:哪天有人把 isRootUser
      // 改成精确匹配,配置里写 `Boss` 的部署会一夜之间没有管理员。
      const response = await hit(baseUrl, 'BOSS', 'GET', '/users');
      assert.equal(response.status, 200, 'root 判定变成大小写敏感了');
    });
  });
});
