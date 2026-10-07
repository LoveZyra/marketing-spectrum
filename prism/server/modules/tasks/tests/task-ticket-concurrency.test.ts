import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { describe, test, vi } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  scheduledTasksDb,
  userDb,
} from '@/modules/database/index.js';

import { createTasksRouter } from '../tasks.routes.js';

/**
 * 「让 Claude 创建」的票据一张只建一个任务,并发请求也一样。
 *
 * 路由在检查票据之后要等一次项目路径校验;未登记的路径要过 `validateWorkspacePath` 的
 * 文件系统检查,这一步会让出事件循环,同一张票的第二个请求就会在第一个落库之前插进来。
 * 这里给路径校验包一层定时器,稳定地造出同样的交错。
 */
vi.mock('@/modules/providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/providers/index.js')>();
  return {
    ...actual,
    assertViewerMayCreateSessionAt: async (...args: Parameters<typeof actual.assertViewerMayCreateSessionAt>) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return actual.assertViewerMayCreateSessionAt(...args);
    },
  };
});

type TestUser = { id: number; username: string };
type Ctx = { baseUrl: string; users: Record<string, TestUser>; alicePath: string; bobPath: string };

async function withServer(runTest: (ctx: Ctx) => Promise<void>): Promise<void> {
  const prev = {
    db: process.env.DATABASE_PATH,
    root: process.env.PRISM_ROOT_USERS,
    pub: process.env.PRISM_PUBLIC_WORKSPACE,
    ws: process.env.WORKSPACES_ROOT,
  };
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-ticket-race-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  process.env.WORKSPACES_ROOT = tempDirectory;
  process.env.PRISM_PUBLIC_WORKSPACE = path.join(tempDirectory, 'public');
  await initializeDatabase();

  let server: Server | null = null;
  try {
    const users: Record<string, TestUser> = {};
    for (const name of ['alice', 'bob', 'boss']) {
      users[name] = { id: Number(userDb.createUser(name, 'hash').id), username: name };
    }
    const alicePath = path.join(tempDirectory, 'alice-proj');
    const bobPath = path.join(tempDirectory, 'bob-proj');
    for (const dir of [alicePath, bobPath]) await mkdir(dir, { recursive: true });
    projectsDb.createProjectPath(alicePath, null, users.alice.id);
    projectsDb.createProjectPath(bobPath, null, users.bob.id);

    const fakeAuth: RequestHandler = (req, _res, next) => {
      const name = String(req.headers['x-test-user'] ?? '');
      const user = users[name];
      (req as unknown as { user?: TestUser & { token_version: number } }).user = user ? { ...user, token_version: 0 } : undefined;
      next();
    };
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', createTasksRouter({ authenticateToken: fakeAuth }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no listen address');

    await runTest({ baseUrl: `http://127.0.0.1:${address.port}`, users, alicePath, bobPath });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    closeConnection();
    for (const [key, value] of [
      ['DATABASE_PATH', prev.db], ['PRISM_ROOT_USERS', prev.root],
      ['PRISM_PUBLIC_WORKSPACE', prev.pub], ['WORKSPACES_ROOT', prev.ws],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function issueTicket(baseUrl: string, asUser: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/tasks/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: '{}',
  });
  const payload = await response.json() as { ticket?: string };
  assert.equal(response.status, 200);
  assert.ok(payload.ticket);
  return payload.ticket!;
}

async function viaTicket(baseUrl: string, ticket: string, method: 'POST' | 'DELETE', url: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-prism-task-ticket': ticket },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: { error?: string; task?: { id: string } } = {};
  try { parsed = JSON.parse(text) as typeof parsed; } catch { /* 非 JSON */ }
  return { status: response.status, body: parsed, text };
}

const taskBody = (projectPath: string, name: string) => ({
  name, instructions: '跑一下回归', projectPath, sessionMode: 'new', frequency: 'manual',
});

describe('任务票据:一张票只建一个任务', () => {
  test('同一张票并发两次:只建出一个,另一个被拒;建出的那个能用票撤销', async () => {
    await withServer(async ({ baseUrl, users, alicePath }) => {
      const ticket = await issueTicket(baseUrl, 'alice');
      const [first, second] = await Promise.all([
        viaTicket(baseUrl, ticket, 'POST', '/api/tasks/via-ticket', taskBody(alicePath, '并发一')),
        viaTicket(baseUrl, ticket, 'POST', '/api/tasks/via-ticket', taskBody(alicePath, '并发二')),
      ]);

      const statuses = [first.status, second.status].sort();
      assert.deepEqual(statuses, [201, 409], `两次请求的结果:${first.text} / ${second.text}`);
      const owned = scheduledTasksDb.listAll().filter((task) => task.owner_user_id === users.alice.id);
      assert.equal(owned.length, 1, `建出了 ${owned.length} 个任务`);

      const loser = first.status === 409 ? first : second;
      assert.match(String(loser.body.error), /正在建任务/);

      const winner = first.status === 201 ? first : second;
      const createdId = winner.body.task!.id;
      assert.equal(owned[0].id, createdId);

      // 建完之后再用这张票:已经用过
      const again = await viaTicket(baseUrl, ticket, 'POST', '/api/tasks/via-ticket', taskBody(alicePath, '第三次'));
      assert.equal(again.status, 401);
      assert.match(String(again.body.error), /已经建过任务/);

      const revoked = await viaTicket(baseUrl, ticket, 'DELETE', `/api/tasks/via-ticket/${createdId}`);
      assert.equal(revoked.status, 200, revoked.text);
      assert.equal(scheduledTasksDb.getById(createdId), undefined);
    });
  });

  test('占位后校验失败(项目不可见、固定会话不存在):票据仍可再用', async () => {
    await withServer(async ({ baseUrl, bobPath, alicePath }) => {
      const ticket = await issueTicket(baseUrl, 'alice');

      const badPath = await viaTicket(baseUrl, ticket, 'POST', '/api/tasks/via-ticket', taskBody(bobPath, '别人的项目'));
      assert.equal(badPath.status, 400, badPath.text);

      const badSession = await viaTicket(baseUrl, ticket, 'POST', '/api/tasks/via-ticket', {
        ...taskBody(alicePath, '不存在的会话'), sessionMode: 'fixed', fixedSessionId: 'no-such-session',
      });
      assert.equal(badSession.status, 400, badSession.text);

      const ok = await viaTicket(baseUrl, ticket, 'POST', '/api/tasks/via-ticket', taskBody(alicePath, '这次对了'));
      assert.equal(ok.status, 201, ok.text);
    });
  });
});
