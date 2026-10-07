import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { afterEach, describe, test, vi } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

import { createTasksRouter } from '../tasks.routes.js';

/**
 * 定时任务表单的会话下拉 `GET /api/tasks/options/sessions`。
 *
 * 可见性与项目过滤都下推到 SQL(`getVisibleSessionsPage`)。这里钉三件事:
 * 非 root 看不到别人私有项目里的会话;`projectPath` 只回该项目的;
 * 路由不整表捞会话、也不逐行查可见性(better-sqlite3 是同步的,逐行查会按住事件循环)。
 */

type TestUser = { id: number; username: string };
type Ctx = {
  baseUrl: string;
  users: Record<string, TestUser>;
  alicePath: string;
  aliceOtherPath: string;
  bobPath: string;
};

async function withServer(runTest: (ctx: Ctx) => Promise<void>): Promise<void> {
  const prev = {
    db: process.env.DATABASE_PATH,
    root: process.env.PRISM_ROOT_USERS,
    pub: process.env.PRISM_PUBLIC_WORKSPACE,
    ws: process.env.WORKSPACES_ROOT,
  };
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-session-options-'));
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
    const aliceOtherPath = path.join(tempDirectory, 'alice-other');
    const bobPath = path.join(tempDirectory, 'bob-proj');
    for (const dir of [alicePath, aliceOtherPath, bobPath]) await mkdir(dir, { recursive: true });
    projectsDb.createProjectPath(alicePath, null, users.alice.id);
    projectsDb.createProjectPath(aliceOtherPath, null, users.alice.id);
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

    await runTest({ baseUrl: `http://127.0.0.1:${address.port}`, users, alicePath, aliceOtherPath, bobPath });
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

type OptionRow = { sessionId: string; name: string; projectPath: string | null };

async function listOptions(baseUrl: string, asUser: string, projectPath?: string): Promise<OptionRow[]> {
  const query = projectPath === undefined ? '' : `?projectPath=${encodeURIComponent(projectPath)}`;
  const response = await fetch(`${baseUrl}/api/tasks/options/sessions${query}`, {
    headers: { 'x-test-user': asUser },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json() as { sessions: OptionRow[] };
  return payload.sessions;
}

const ids = (rows: OptionRow[]) => rows.map((row) => row.sessionId);

/** 按给定的最后活动时间落一条会话(createSession 接受显式时间戳)。 */
function seedSession(id: string, projectPath: string, updatedAt: string, name?: string) {
  sessionsDb.createSession(id, 'claude', projectPath, name, updatedAt, updatedAt);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/tasks/options/sessions', () => {
  test('非 root 看不到别人私有项目里的会话(带不带 projectPath 都一样)', async () => {
    await withServer(async ({ baseUrl, alicePath, bobPath }) => {
      seedSession('alice-1', alicePath, '2026-09-01T10:00:00.000Z', 'alice 的会话');
      seedSession('bob-1', bobPath, '2026-09-02T10:00:00.000Z', 'bob 的会话');

      assert.deepEqual(ids(await listOptions(baseUrl, 'bob')), ['bob-1']);
      assert.deepEqual(ids(await listOptions(baseUrl, 'bob', alicePath)), []);
      assert.deepEqual(ids(await listOptions(baseUrl, 'bob', bobPath)), ['bob-1']);
      assert.deepEqual(ids(await listOptions(baseUrl, 'alice', alicePath)), ['alice-1']);
    });
  });

  test('项目分享给 bob 之后,他就看得到这个项目的会话', async () => {
    await withServer(async ({ baseUrl, users, alicePath }) => {
      seedSession('alice-1', alicePath, '2026-09-01T10:00:00.000Z');
      const project = projectsDb.getProjectPath(alicePath)!;
      projectsDb.setProjectShares(project.project_id, [users.bob.id], users.alice.id);

      assert.deepEqual(ids(await listOptions(baseUrl, 'bob', alicePath)), ['alice-1']);
    });
  });

  test('projectPath 只回该项目的会话:按最近活跃排序,归档的不出,名字回落到 id 前 8 位', async () => {
    await withServer(async ({ baseUrl, alicePath, aliceOtherPath }) => {
      seedSession('alice-old', alicePath, '2026-09-01T10:00:00.000Z', '老的');
      seedSession('alice-new', alicePath, '2026-09-03T10:00:00.000Z', '新的');
      seedSession('alice-archived', alicePath, '2026-09-04T10:00:00.000Z', '归档了');
      sessionsDb.updateSessionIsArchived('alice-archived', true);
      seedSession('other-1234567890', aliceOtherPath, '2026-09-05T10:00:00.000Z');

      const rows = await listOptions(baseUrl, 'alice', alicePath);
      assert.deepEqual(ids(rows), ['alice-new', 'alice-old']);
      assert.deepEqual(rows.map((row) => row.name), ['新的', '老的']);
      assert.ok(rows.every((row) => row.projectPath === alicePath));

      // 结尾多一个斜杠也认得是同一个项目
      assert.deepEqual(ids(await listOptions(baseUrl, 'alice', `${alicePath}/`)), ['alice-new', 'alice-old']);

      const other = await listOptions(baseUrl, 'alice', aliceOtherPath);
      assert.deepEqual(other, [{ sessionId: 'other-1234567890', name: 'other-12', projectPath: aliceOtherPath }]);

      // 不带 projectPath:这个人看得见的全部,最近的在前
      assert.deepEqual(ids(await listOptions(baseUrl, 'alice')), ['other-1234567890', 'alice-new', 'alice-old']);
    });
  });

  test('root 全看;带 projectPath 时同样只回该项目', async () => {
    await withServer(async ({ baseUrl, alicePath, bobPath }) => {
      seedSession('alice-1', alicePath, '2026-09-01T10:00:00.000Z');
      seedSession('bob-1', bobPath, '2026-09-02T10:00:00.000Z');

      assert.deepEqual(ids(await listOptions(baseUrl, 'boss')), ['bob-1', 'alice-1']);
      assert.deepEqual(ids(await listOptions(baseUrl, 'boss', alicePath)), ['alice-1']);
    });
  });

  test('最多回 100 条', async () => {
    await withServer(async ({ baseUrl, alicePath }) => {
      for (let index = 0; index < 105; index += 1) {
        const minute = String(index % 60).padStart(2, '0');
        const hour = String(10 + Math.floor(index / 60)).padStart(2, '0');
        seedSession(`s-${String(index).padStart(3, '0')}`, alicePath, `2026-09-01T${hour}:${minute}:00.000Z`);
      }
      const rows = await listOptions(baseUrl, 'alice', alicePath);
      assert.equal(rows.length, 100);
      assert.equal(rows[0].sessionId, 's-104');
    });
  });

  test('不整表捞会话,也不逐行查可见性', async () => {
    await withServer(async ({ baseUrl, alicePath, bobPath }) => {
      // bob 一条都看不见的 50 条:逐行判可见性的写法会为每一条查一次库
      for (let index = 0; index < 50; index += 1) {
        seedSession(`alice-${index}`, alicePath, `2026-09-01T10:${String(index).padStart(2, '0')}:00.000Z`);
      }
      seedSession('bob-1', bobPath, '2026-09-02T10:00:00.000Z');

      const getAll = vi.spyOn(sessionsDb, 'getAllSessions');
      const getById = vi.spyOn(sessionsDb, 'getSessionById');

      assert.deepEqual(ids(await listOptions(baseUrl, 'bob')), ['bob-1']);
      assert.equal(getAll.mock.calls.length, 0, '不该整表捞会话');
      assert.equal(getById.mock.calls.length, 0, `不该逐行查可见性(查了 ${getById.mock.calls.length} 次)`);
    });
  });
});
