import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
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
  scheduledTasksDb,
  sessionsDb,
  userDb,
  type TaskSessionMode,
} from '@/modules/database/index.js';

import { createTasksRouter } from '../tasks.routes.js';

/**
 * PATCH 同时改项目与会话模式时,固定会话的项目归属校验。
 *
 * 库里的固定会话只在任务改完后仍是「固定会话」模式时才要对得上新项目;改成「每次新建」时
 * 它用不上(调度器在 new 模式下不读它),拿它去校验会误报「固定会话不属于这个项目」。
 * 跨项目搬任务要两边都看得见,所以用 root(boss)来调。
 */

type TestUser = { id: number; username: string };
type Ctx = { baseUrl: string; users: Record<string, TestUser>; alicePath: string; bobPath: string };

async function withServer(runTest: (ctx: Ctx) => Promise<void>): Promise<void> {
  const prev = {
    db: process.env.DATABASE_PATH,
    root: process.env.PRISM_ROOT_USERS,
    pub: process.env.PRISM_PUBLIC_WORKSPACE,
    ws: process.env.WORKSPACES_ROOT,
  };
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-patch-mode-'));
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
      (req as unknown as { user?: TestUser }).user = users[name];
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

async function patch(baseUrl: string, asUser: string, id: string, body: unknown) {
  const response = await fetch(`${baseUrl}/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: { error?: string } = {};
  try { parsed = JSON.parse(text) as typeof parsed; } catch { /* 非 JSON */ }
  return { status: response.status, body: parsed, text };
}

function insertTask(id: string, ownerId: number, projectPath: string, sessionMode: TaskSessionMode, fixedSessionId: string | null) {
  scheduledTasksDb.insert({
    id,
    name: `task ${id}`,
    instructions: '跑个回归',
    project_path: projectPath,
    session_mode: sessionMode,
    fixed_session_id: fixedSessionId,
    frequency: 'manual',
    run_at_hour: null, run_at_minute: null, run_at_weekday: null, run_at_day: null,
    model: null, permission_mode: 'bypassPermissions',
    enabled: 1, owner_user_id: ownerId, next_run_at: null,
  });
}

describe('PATCH 改项目时固定会话的归属校验', () => {
  test('同时改成「每次新建」并换项目:不拿旧的固定会话去校验,旧 id 被清掉', async () => {
    await withServer(async ({ baseUrl, users, alicePath, bobPath }) => {
      sessionsDb.createAppSession('sess-alice', 'claude', alicePath, users.alice.id);
      insertTask('t-fixed', users.alice.id, alicePath, 'fixed', 'sess-alice');

      const got = await patch(baseUrl, 'boss', 't-fixed', { sessionMode: 'new', projectPath: bobPath });
      assert.equal(got.status, 200, got.text);
      const after = scheduledTasksDb.getById('t-fixed')!;
      assert.equal(after.session_mode, 'new');
      assert.equal(after.fixed_session_id, null);
      assert.equal(after.project_path, bobPath);
    });
  });

  test('库里已是「每次新建」、只换项目:留着的旧会话 id 用不上,不校验', async () => {
    await withServer(async ({ baseUrl, users, alicePath, bobPath }) => {
      sessionsDb.createAppSession('sess-alice', 'claude', alicePath, users.alice.id);
      insertTask('t-new', users.alice.id, alicePath, 'new', 'sess-alice');

      const got = await patch(baseUrl, 'boss', 't-new', { projectPath: bobPath });
      assert.equal(got.status, 200, got.text);
      assert.equal(scheduledTasksDb.getById('t-new')!.project_path, bobPath);
    });
  });

  test('仍是固定会话模式时照旧校验:旧会话对不上新项目 → 400', async () => {
    await withServer(async ({ baseUrl, users, alicePath, bobPath }) => {
      sessionsDb.createAppSession('sess-alice', 'claude', alicePath, users.alice.id);
      insertTask('t-keep', users.alice.id, alicePath, 'fixed', 'sess-alice');

      for (const body of [{ projectPath: bobPath }, { sessionMode: 'fixed', projectPath: bobPath }]) {
        const got = await patch(baseUrl, 'boss', 't-keep', body);
        assert.equal(got.status, 400, `${JSON.stringify(body)}:${got.text}`);
        assert.match(String(got.body.error), /不属于这个项目/);
      }
      assert.equal(scheduledTasksDb.getById('t-keep')!.project_path, alicePath);

      // 库里是 new、这次改回 fixed 并换项目:留着的旧会话会被用上,同样要校验
      insertTask('t-back', users.alice.id, alicePath, 'new', 'sess-alice');
      const back = await patch(baseUrl, 'boss', 't-back', { sessionMode: 'fixed', projectPath: bobPath });
      assert.equal(back.status, 400, back.text);
    });
  });
});
