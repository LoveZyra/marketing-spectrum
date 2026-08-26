import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { describe, test } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

import { createUsageRouter } from '../usage.routes.js';

/**
 * bu 轮回归:fork-point 与 token-usage 两个端点的可见性闸门。
 *
 * 这两条路由当年从 index.js 迁进 usage.routes.ts 时漏挂了 canViewerSeeSession ——
 * 邻居端点(context-usage / slash-commands / active-model)都有。漏掉的后果:
 * 任何登录用户拿会话 id 就能套出别人会话的 provider_session_id 与项目路径
 * (fork-point),或读别人的 token 用量(token-usage)。
 *
 * 测试策略:起一个真 express 实例(路由工厂 + 假鉴权中间件,身份由请求头指定),
 * 用返回文案区分"被闸门挡下的 404"(Session not found)与"过了闸门后的正常
 * 404"(no provider transcript / Project not found)—— 后者证明闸门对合法访问
 * 者是放行的,防止未来有人把闸门挪成一刀切。
 */

type TestUser = { id: number; username: string };

async function withUsageServer(
  runTest: (context: {
    baseUrl: string;
    users: Record<string, TestUser>;
    projectId: string;
    aliceSessionId: string;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousRootUsers = process.env.PRISM_ROOT_USERS;
  const previousPublicWorkspace = process.env.PRISM_PUBLIC_WORKSPACE;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'usage-visibility-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  delete process.env.PRISM_PUBLIC_WORKSPACE;
  await initializeDatabase();

  let server: Server | null = null;
  try {
    const users: Record<string, TestUser> = {};
    for (const name of ['alice', 'bob', 'boss']) {
      users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name };
    }

    const projectPath = path.join(tempDirectory, 'proj-a');
    const registration = projectsDb.createProjectPath(projectPath, null, users.alice.id);
    const projectId = registration.project!.project_id;

    const aliceSessionId = 'session-alice-0001';
    sessionsDb.createAppSession(aliceSessionId, 'claude', projectPath, users.alice.id);

    // 假鉴权:身份由 x-test-user 头指定,与生产中间件一样把 req.user 挂上。
    const fakeAuth: RequestHandler = (req, _res, next) => {
      const name = String(req.headers['x-test-user'] ?? '');
      (req as unknown as { user?: TestUser }).user = users[name];
      next();
    };

    const app = express();
    app.use(express.json());
    app.use(createUsageRouter({ authenticateToken: fakeAuth }));

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no listen address');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await runTest({ baseUrl, users, projectId, aliceSessionId });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousRootUsers === undefined) delete process.env.PRISM_ROOT_USERS;
    else process.env.PRISM_ROOT_USERS = previousRootUsers;
    if (previousPublicWorkspace === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
    else process.env.PRISM_PUBLIC_WORKSPACE = previousPublicWorkspace;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function postForkPoint(baseUrl: string, asUser: string, sessionId: string) {
  const response = await fetch(`${baseUrl}/api/claude/fork-point`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: JSON.stringify({ sessionId }),
  });
  return { status: response.status, body: (await response.json()) as { error?: string } };
}

describe('usage 路由的会话可见性闸门', () => {
  test('fork-point:他人会话被 404 同形挡下,本人与 root 过闸', async () => {
    await withUsageServer(async ({ baseUrl, aliceSessionId }) => {
      // bob 看 alice 的会话:被闸门挡(与"不存在"同形,不泄漏存在性)。
      const asBob = await postForkPoint(baseUrl, 'bob', aliceSessionId);
      assert.equal(asBob.status, 404);
      assert.equal(asBob.body.error, 'Session not found');

      // alice 自己:过了闸门,落在"还没有 provider transcript"的正常 404 ——
      // 文案不同,证明不是被闸门挡的。
      const asAlice = await postForkPoint(baseUrl, 'alice', aliceSessionId);
      assert.equal(asAlice.status, 404);
      assert.equal(asAlice.body.error, 'Session has no provider transcript yet');

      // root 看谁的都行,同样过闸。
      const asBoss = await postForkPoint(baseUrl, 'boss', aliceSessionId);
      assert.equal(asBoss.status, 404);
      assert.equal(asBoss.body.error, 'Session has no provider transcript yet');
    });
  });

  test('token-usage:他人会话被 404 同形挡下,本人过闸', async () => {
    await withUsageServer(async ({ baseUrl, projectId, aliceSessionId }) => {
      const url = (user: string) =>
        fetch(`${baseUrl}/api/projects/${projectId}/sessions/${aliceSessionId}/token-usage`, {
          headers: { 'x-test-user': user },
        });

      const asBob = await url('bob');
      assert.equal(asBob.status, 404);
      const bobBody = (await asBob.json()) as { error?: string };
      assert.equal(bobBody.error, 'Session not found');

      // alice 过闸后继续往下走(transcript 不存在 → Session file not found),
      // 错误文案不同 = 不是闸门挡的。
      const asAlice = await url('alice');
      assert.equal(asAlice.status, 404);
      const aliceBody = (await asAlice.json()) as { error?: string };
      assert.equal(aliceBody.error, 'Session file not found');
    });
  });
});
