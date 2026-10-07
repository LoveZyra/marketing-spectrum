import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { RequestHandler } from 'express';
import { afterAll, beforeAll, describe, test } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  scheduledTasksDb,
  sessionMessagesDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { deleteOrArchiveProject } from '@/modules/projects/services/project-delete.service.js';
import { createTasksRouter, INSTRUCTIONS_MAX_BYTES } from '@/modules/tasks/tasks.routes.js';
import {
  computeNextRunAt,
  executeTask,
  explainProjectUnavailable,
  readOneShotOutcome,
  serverTimeInfo,
  startTaskScheduler,
  stopTaskScheduler,
} from '@/modules/tasks/services/scheduled-tasks.service.js';

/**
 * 定时任务的回归测试:一次性路径的成败要如实记账;项目被删 / 归档后任务跳过,不能把项目重建出来;
 * 运行中改动任务时收尾不能用旧快照覆盖;用户行与回执要落显示日志;路由校验时分范围、会话归属与指令长度,
 * 响应带服务端时区;下次运行时间按日历日推算(跨夏令时也不跳天)。
 */

type TestUser = { id: number; username: string };
type Ctx = {
  baseUrl: string;
  users: Record<string, TestUser>;
  alicePath: string;
  bobPath: string;
  tempDirectory: string;
};

const HOUR = 3600_000;

async function withTasksEnv(runTest: (ctx: Ctx) => Promise<void>): Promise<void> {
  const prev = {
    db: process.env.DATABASE_PATH,
    root: process.env.PRISM_ROOT_USERS,
    pub: process.env.PRISM_PUBLIC_WORKSPACE,
    ws: process.env.WORKSPACES_ROOT,
  };
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'hl-tasks-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'hl.db');
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
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/tasks', createTasksRouter({ authenticateToken: fakeAuth }));
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no listen address');

    await runTest({ baseUrl: `http://127.0.0.1:${address.port}`, users, alicePath, bobPath, tempDirectory });
  } finally {
    stopTaskScheduler();
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

const call = async (baseUrl: string, asUser: string, method: string, url: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': asUser },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* 非 JSON */ }
  return { status: response.status, body: parsed, text };
};

/**
 * 每日触发的钟点离"现在"至少 2 小时(本地、UTC 两种口径都离开)—— 写死 9 点的话,08:55~09:00 跑测试时
 * 下一次正常触发比"5 分钟后重试"还近,重试就不排了,用例按钟点随机失败。
 */
const FAR_HOUR = (() => {
  const now = new Date();
  const gap = (a: number, b: number) => Math.min((a - b + 24) % 24, (b - a + 24) % 24);
  for (let hour = 0; hour < 24; hour += 1) {
    if (gap(hour, now.getHours()) >= 2 && gap(hour, now.getUTCHours()) >= 2) return hour;
  }
  return (now.getUTCHours() + 12) % 24;
})();

function insertTask(id: string, ownerId: number, projectPath: string, extra: Partial<Parameters<typeof scheduledTasksDb.insert>[0]> = {}) {
  scheduledTasksDb.insert({
    id,
    name: `task ${id}`,
    instructions: '跑个回归',
    project_path: projectPath,
    session_mode: 'fixed',
    fixed_session_id: null,
    frequency: 'daily',
    run_at_hour: FAR_HOUR, run_at_minute: 0, run_at_weekday: null, run_at_day: null,
    model: 'no-such-model-hl-test', permission_mode: 'bypassPermissions',
    enabled: 1, owner_user_id: ownerId,
    next_run_at: '2020-01-01 00:00:00',
    ...extra,
  });
  return scheduledTasksDb.getById(id)!;
}

/* ── 失败要记成失败 ─────────────────────────────────────── */

describe('一次性路径的成败要传到任务记账', () => {
  test('readOneShotOutcome:ok/exitCode/aborted 三态;老的 undefined 当成功', () => {
    assert.deepEqual(readOneShotOutcome(undefined), { ok: true });
    assert.deepEqual(readOneShotOutcome({ ok: true, exitCode: 0 }), { ok: true });
    assert.deepEqual(readOneShotOutcome({ ok: false, exitCode: 1, aborted: false, error: 'model not found' }),
      { ok: false, aborted: false, rejected: false, error: 'model not found' });
    assert.deepEqual(readOneShotOutcome({ ok: false, exitCode: 1, aborted: true, error: null }),
      { ok: false, aborted: true, rejected: false, error: '回合被中止' });
    // 闸口 / 网关拒绝(没有 key、网关停用、模型不许用)带 rejected,调度器据此不重试
    assert.deepEqual(readOneShotOutcome({ ok: false, exitCode: 1, aborted: false, rejected: true, error: '没有 key' }),
      { ok: false, aborted: false, rejected: true, error: '没有 key' });
  });

  test('SDK 报失败 → 运行记录 failed + 原因 + 5 分钟重试 + 失败通知', async () => {
    await withTasksEnv(async ({ users, alicePath }) => {
      const notified: unknown[] = [];
      startTaskScheduler(
        async () => ({ ok: false, exitCode: 1, aborted: false, error: 'API Error: model no-such-model not found', sessionId: null }),
        { notifyTaskFailed: (input) => { notified.push(input); } },
      );
      const task = insertTask('t-fail', users.alice.id, alicePath);
      await executeTask(task, 'schedule');

      const after = scheduledTasksDb.getById('t-fail')!;
      assert.equal(after.running, 0);
      // 失败必须记成 failed 并写明原因,不能落成 completed + 空 detail。
      assert.equal(after.last_run_status, 'failed');
      assert.match(String(after.last_run_detail), /model no-such-model not found/);
      assert.match(String(after.last_run_detail), /5 分钟后自动重试/);
      const runs = scheduledTasksDb.listRuns('t-fail').rows;
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, 'failed');
      // 5 分钟重试:next_run_at 在 4–6 分钟之后
      const nextMs = new Date(`${after.next_run_at!.replace(' ', 'T')}Z`).getTime() - Date.now();
      assert.ok(nextMs > 4 * 60_000 && nextMs < 6 * 60_000, `next_run_at 不是 5 分钟后:${after.next_run_at}`);
      assert.equal(notified.length, 1, 'notifyTaskFailed 没被调');
      // 会话里的回执是 ⚠️ 而不是 ✅
      const log = sessionMessagesDb.listForSession(after.fixed_session_id!);
      const receipts = log.filter((m) => m.kind === 'task_notification');
      assert.ok(receipts.some((m) => String((m as { summary?: string }).summary).includes('⚠️')), '缺失败回执');
      assert.ok(!receipts.some((m) => String((m as { summary?: string }).summary).includes('✅')), '失败却写了成功回执');
    });
  });

  test('连续 3 次失败停手:第 3 次不再拉近到 5 分钟', async () => {
    await withTasksEnv(async ({ users, alicePath }) => {
      startTaskScheduler(async () => ({ ok: false, exitCode: 1, aborted: false, error: 'boom', sessionId: null }));
      const task = insertTask('t-cap', users.alice.id, alicePath);
      for (let i = 0; i < 3; i += 1) await executeTask(scheduledTasksDb.getById('t-cap')!, 'schedule');
      const after = scheduledTasksDb.getById('t-cap')!;
      assert.equal(scheduledTasksDb.listRuns('t-cap').rows.length, 3);
      const nextMs = new Date(`${after.next_run_at!.replace(' ', 'T')}Z`).getTime() - Date.now();
      assert.ok(nextMs > 10 * 60_000, `第 3 次失败仍在 5 分钟重试:${after.next_run_at}`);
      assert.ok(!String(after.last_run_detail).includes('自动重试'));
    });
  });

  test('被中止(aborted)记 failed 但不重试;成功照旧 completed', async () => {
    await withTasksEnv(async ({ users, alicePath }) => {
      let mode: 'aborted' | 'ok' = 'aborted';
      startTaskScheduler(async () => (mode === 'aborted'
        ? { ok: false, exitCode: 1, aborted: true, error: null, sessionId: null }
        : { ok: true, exitCode: 0, aborted: false, error: null, sessionId: null }));
      const task = insertTask('t-abort', users.alice.id, alicePath);
      await executeTask(task, 'schedule');
      let after = scheduledTasksDb.getById('t-abort')!;
      assert.equal(after.last_run_status, 'failed');
      assert.match(String(after.last_run_detail), /中止/);
      assert.ok(!String(after.last_run_detail).includes('自动重试'), '被人停掉的不该 5 分钟后自己再跑');

      mode = 'ok';
      await executeTask(scheduledTasksDb.getById('t-abort')!, 'manual');
      after = scheduledTasksDb.getById('t-abort')!;
      assert.equal(after.last_run_status, 'completed');
      // 夹具的模型名(no-such-model-hl-test)不在模型目录里 → 按默认模型跑,运行记录写明回落
      assert.match(String(after.last_run_detail ?? ''), /^$|耗时|已不在模型目录里/);
    });
  });
});

/* ── 项目没了 / 归档了就跳过,不重建项目 ────────────────── */

describe('删除 / 归档项目后的任务', () => {
  test('项目已删除:记一次 failed 说明原因,不 createAppSession、不重建项目、不重试', async () => {
    await withTasksEnv(async ({ users, tempDirectory }) => {
      const gone = path.join(tempDirectory, 'gone-proj');
      let calls = 0;
      startTaskScheduler(async () => { calls += 1; return { ok: true, exitCode: 0, aborted: false, error: null, sessionId: null }; });
      const task = insertTask('t-gone', users.alice.id, gone);
      assert.match(String(await explainProjectUnavailable(task)), /已删除或不可访问/);
      await executeTask(task, 'schedule');
      assert.equal(calls, 0, 'SDK 不该被调');
      // 不能顺手把项目建回来(projects 表里多出一行 gone-proj、属主 alice)。
      assert.equal(projectsDb.getProjectPath(gone), null, '项目被重建出来了');
      const after = scheduledTasksDb.getById('t-gone')!;
      assert.equal(after.last_run_status, 'failed');
      assert.match(String(after.last_run_detail), /已删除或不可访问/);
      assert.ok(!String(after.last_run_detail).includes('自动重试'));
      assert.equal(after.fixed_session_id, null, '不该建会话');
    });
  });

  test('项目已归档:同样跳过并记 failed', async () => {
    await withTasksEnv(async ({ users, alicePath }) => {
      startTaskScheduler(async () => ({ ok: true, exitCode: 0, aborted: false, error: null, sessionId: null }));
      const task = insertTask('t-arch', users.alice.id, alicePath);
      const project = projectsDb.getProjectPath(alicePath)!;
      projectsDb.updateProjectIsArchivedById(project.project_id, true);
      assert.match(String(await explainProjectUnavailable(task)), /已归档/);
      await executeTask(task, 'schedule');
      assert.equal(scheduledTasksDb.getById('t-arch')!.last_run_status, 'failed');
    });
  });

  test('主人看不见项目了(不再是 owner、未分享):跳过', async () => {
    await withTasksEnv(async ({ users, bobPath }) => {
      const task = insertTask('t-noaccess', users.alice.id, bobPath);
      assert.match(String(await explainProjectUnavailable(task)), /无权访问/);
    });
  });

  test('归档项目 → 任务停用(next_run_at 清空);还原项目不自动恢复', async () => {
    await withTasksEnv(async ({ users, alicePath }) => {
      insertTask('t-onarch', users.alice.id, alicePath);
      const project = projectsDb.getProjectPath(alicePath)!;
      await deleteOrArchiveProject(project.project_id, false, null);
      const after = scheduledTasksDb.getById('t-onarch')!;
      assert.equal(after.enabled, 0);
      assert.equal(after.next_run_at, null);
      // 还原
      projectsDb.updateProjectIsArchivedById(project.project_id, false);
      assert.equal(scheduledTasksDb.getById('t-onarch')!.enabled, 0, '还原不该自动重新启用');
    });
  });

  test('永久删除项目 → 任务与运行记录同事务删除', async () => {
    await withTasksEnv(async ({ users, alicePath }) => {
      insertTask('t-ondel', users.alice.id, alicePath);
      scheduledTasksDb.finishRun('t-ondel', { status: 'completed', detail: null, durationMs: 1, nextRunAt: null });
      assert.equal(scheduledTasksDb.listRuns('t-ondel').total, 1);
      const project = projectsDb.getProjectPath(alicePath)!;
      await deleteOrArchiveProject(project.project_id, true, null);
      assert.equal(scheduledTasksDb.getById('t-ondel'), undefined, '删项目后任务还在');
      assert.equal(scheduledTasksDb.listRuns('t-ondel').total, 0, '运行记录成了孤儿');
    });
  });
});

/* ── 收尾用最新任务 ───────────────────────────────────── */

describe('运行中改任务,收尾不被旧快照覆盖', () => {
  test('运行中改成 manual → 结束后 next_run_at 仍为 null', async () => {
    await withTasksEnv(async ({ users, alicePath }) => {
      startTaskScheduler(async () => {
        // 回合"跑着"的时候用户把任务改成手动
        scheduledTasksDb.update('t-manual', { frequency: 'manual', next_run_at: null });
        return { ok: true, exitCode: 0, aborted: false, error: null, sessionId: null };
      });
      const task = insertTask('t-manual', users.alice.id, alicePath);
      await executeTask(task, 'schedule');
      const after = scheduledTasksDb.getById('t-manual')!;
      assert.equal(after.frequency, 'manual');
      // 收尾若用旧快照,会写回一个 next_run_at,manual 任务下一拍就自动跑。
      assert.equal(after.next_run_at, null);
      assert.equal(after.last_run_status, 'completed');
    });
  });

  test('运行中任务被删 → 不写运行记录也不抛', async () => {
    await withTasksEnv(async ({ users, alicePath }) => {
      startTaskScheduler(async () => {
        scheduledTasksDb.delete('t-del-mid');
        return { ok: true, exitCode: 0, aborted: false, error: null, sessionId: null };
      });
      const task = insertTask('t-del-mid', users.alice.id, alicePath);
      await executeTask(task, 'manual');
      assert.equal(scheduledTasksDb.getById('t-del-mid'), undefined);
    });
  });
});

/* ── 回执之前先 seed ─────────────────────────────────────── */

describe('任务的用户行与回执要落显示日志', () => {
  test('executeTask 在 startRun 之前走 chat.send 同一条 seed 路径(源码钉住)', () => {
    const source = readFileSync(path.join(process.cwd(), 'server/modules/tasks/services/scheduled-tasks.service.ts'), 'utf8');
    const body = source.slice(source.indexOf('export async function executeTask('));
    const seedAt = body.indexOf('await seedDisplayLogFromTranscript(sessionId)');
    const startAt = body.indexOf('chatRunRegistry.startRun(');
    assert.ok(seedAt > 0, '没有调用 seedDisplayLogFromTranscript');
    assert.ok(seedAt < startAt, 'seed 必须在 startRun 之前');
  });

  test('没有 transcript 的新会话:用户行 + ⏰ + ✅ 三行都在', async () => {
    await withTasksEnv(async ({ users, alicePath }) => {
      startTaskScheduler(async () => ({ ok: true, exitCode: 0, aborted: false, error: null, sessionId: null }));
      const task = insertTask('t-log', users.alice.id, alicePath);
      await executeTask(task, 'manual');
      const sid = scheduledTasksDb.getById('t-log')!.fixed_session_id!;
      const log = sessionMessagesDb.listForSession(sid);
      assert.equal(log.filter((m) => m.kind === 'text').length, 1, '缺用户指令行');
      assert.equal(log.filter((m) => m.kind === 'task_notification').length, 2, '缺回执');
    });
  });

  test('指令行带 senderUserId = 任务主人 → 会话发起人认得出来', async () => {
    await withTasksEnv(async ({ users, alicePath }) => {
      startTaskScheduler(async () => ({ ok: true, exitCode: 0, aborted: false, error: null, sessionId: null }));
      const task = insertTask('t-sender', users.alice.id, alicePath);
      await executeTask(task, 'manual');
      const sid = scheduledTasksDb.getById('t-sender')!.fixed_session_id!;
      const userLine = sessionMessagesDb.listForSession(sid).find((m) => m.kind === 'text') as { senderUserId?: number };
      // 缺了 senderUserId,协作者自己的任务建出的会话,他本人就不能归档 / 删除。
      assert.equal(userLine?.senderUserId, users.alice.id);
      assert.equal(sessionsDb.getSessionInitiatorUserId(sid), users.alice.id);
    });
  });
});

/* ── 路由校验 ───────────────────────── */

describe('任务路由的校验', () => {
  const base = (projectPath: string) => ({
    name: '范围', instructions: '干点什么', projectPath, sessionMode: 'new', frequency: 'daily',
  });

  test('时 / 分 / 星期 / 日越界 → 400;边界值放行', async () => {
    await withTasksEnv(async ({ baseUrl, alicePath }) => {
      for (const bad of [
        { runAtHour: 99 }, { runAtHour: -1 }, { runAtMinute: 75 }, { runAtMinute: -5 },
        { runAtWeekday: 7 }, { runAtWeekday: 9 }, { runAtDay: 0 }, { runAtDay: 29 }, { runAtHour: 'abc' },
      ]) {
        const got = await call(baseUrl, 'alice', 'POST', '/api/tasks/', { ...base(alicePath), ...bad });
        // 越界值若放行,卡片会显示「每天 99:00」。
        assert.equal(got.status, 400, `${JSON.stringify(bad)} 没被挡:${got.text}`);
      }
      const ok = await call(baseUrl, 'alice', 'POST', '/api/tasks/', {
        ...base(alicePath), runAtHour: 23, runAtMinute: 59, runAtWeekday: 6, runAtDay: 28,
      });
      assert.equal(ok.status, 201, ok.text);
      const patched = await call(baseUrl, 'alice', 'PATCH', `/api/tasks/${(ok.body.task as { id: string }).id}`, { runAtHour: 24 });
      assert.equal(patched.status, 400);
    });
  });

  test('sessionMode:"new" 同时带 fixedSessionId → 400', async () => {
    await withTasksEnv(async ({ baseUrl, alicePath, users }) => {
      const sid = 'sess-alice-1';
      sessionsDb.createAppSession(sid, 'claude', alicePath, users.alice.id);
      const got = await call(baseUrl, 'alice', 'POST', '/api/tasks/', { ...base(alicePath), fixedSessionId: sid });
      assert.equal(got.status, 400, got.text);
      assert.match(String(got.body.error), /fixedSessionId/);
    });
  });

  test('固定会话不属于任务项目 → 400(建 / 改都拦);同项目放行', async () => {
    await withTasksEnv(async ({ baseUrl, alicePath, bobPath, users }) => {
      // 跨项目引用会话的前提是调用者两边都看得见:用 root(boss)来测,等价于 bob 的项目分享给了调用者
      sessionsDb.createAppSession('sess-bob-1', 'claude', bobPath, users.bob.id);
      sessionsDb.createAppSession('sess-alice-2', 'claude', alicePath, users.alice.id);
      const crossed = await call(baseUrl, 'boss', 'POST', '/api/tasks/', {
        ...base(alicePath), sessionMode: 'fixed', fixedSessionId: 'sess-bob-1',
      });
      // 放行的话,任务每次都会 resume 一段别的项目的对话。
      assert.equal(crossed.status, 400, crossed.text);
      assert.match(String(crossed.body.error), /不属于这个项目/);

      const same = await call(baseUrl, 'alice', 'POST', '/api/tasks/', {
        ...base(alicePath), sessionMode: 'fixed', fixedSessionId: 'sess-alice-2',
      });
      assert.equal(same.status, 201, same.text);
      const id = (same.body.task as { id: string }).id;
      // 只改 projectPath、不换会话:旧会话对不上新项目 → 400
      const moved = await call(baseUrl, 'boss', 'PATCH', `/api/tasks/${id}`, { projectPath: bobPath });
      assert.equal(moved.status, 400, moved.text);
      // 换项目并清掉会话 → 放行
      const movedClean = await call(baseUrl, 'boss', 'PATCH', `/api/tasks/${id}`, { projectPath: bobPath, fixedSessionId: null });
      assert.equal(movedClean.status, 200, movedClean.text);
    });
  });

  test('执行指令超过上限 → 400', async () => {
    await withTasksEnv(async ({ baseUrl, alicePath }) => {
      const got = await call(baseUrl, 'alice', 'POST', '/api/tasks/', {
        ...base(alicePath), instructions: 'x'.repeat(INSTRUCTIONS_MAX_BYTES + 1),
      });
      assert.equal(got.status, 400, got.text);
      assert.match(String(got.body.error), /过长/);
    });
  });

  test('列表 / 单个 / 创建响应都带 serverTime {tz, offsetMin, local, now}', async () => {
    await withTasksEnv(async ({ baseUrl, alicePath }) => {
      const list = await call(baseUrl, 'alice', 'GET', '/api/tasks/');
      const st = list.body.serverTime as Record<string, unknown>;
      assert.equal(typeof st?.tz, 'string');
      assert.equal(typeof st?.offsetMin, 'number');
      assert.match(String(st?.local), /^\d{2}:\d{2}$/);
      const created = await call(baseUrl, 'alice', 'POST', '/api/tasks/', base(alicePath));
      assert.ok((created.body.serverTime as { tz?: string })?.tz);
      const one = await call(baseUrl, 'alice', 'GET', `/api/tasks/${(created.body.task as { id: string }).id}`);
      assert.ok((one.body.serverTime as { tz?: string })?.tz);
    });
  });

  test('serverTimeInfo 的偏移与 Date 自己的一致', () => {
    const now = new Date();
    const info = serverTimeInfo(now);
    assert.equal(info.offsetMin, -now.getTimezoneOffset());
    assert.equal(info.now, now.toISOString());
  });
});

/* ── 夏令时 ───────────────────────────────────────────── */

describe('computeNextRunAt 在 America/New_York 的夏令时切换日', () => {
  const prevTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/New_York'; });
  afterAll(() => { if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz; });

  const daily = (hour: number, minute: number) => ({
    frequency: 'daily' as const, run_at_hour: hour, run_at_minute: minute, run_at_weekday: null, run_at_day: null,
  });

  test('前提:进程时区已切到纽约', () => {
    // 2026-07-01 是 EDT(UTC-4)
    assert.equal(new Date('2026-07-01T12:00:00Z').getHours(), 8);
  });

  test('拨快日(2026-03-08,23 小时):23:30 的每日任务不跳过那一天', () => {
    // 2026-03-07 23:45 EST。按 `+24h` 推会落到 03-09 00:45 EDT,再 setHours(23:30)
    // → 03-09 23:30:整整跳过 03-08 一天。所以要按日历日推。
    const from = new Date(2026, 2, 7, 23, 45, 0, 0);
    const next = computeNextRunAt(daily(23, 30), from)!;
    assert.equal(next.getMonth(), 2);
    assert.equal(next.getDate(), 8, `跳过了拨快日:${next.toString()}`);
    assert.equal(next.getHours(), 23);
    assert.equal(next.getMinutes(), 30);
  });

  test('回拨日(2026-11-01,25 小时):每日任务落在次日同一时刻,不多跑也不少跑', () => {
    const from = new Date(2026, 9, 31, 23, 45, 0, 0); // 10-31 23:45 EDT
    const next = computeNextRunAt(daily(23, 30), from)!;
    assert.equal(next.getMonth(), 10);
    assert.equal(next.getDate(), 1);
    assert.equal(next.getHours(), 23);
    // 回拨日当天再算一次 → 11-02
    const again = computeNextRunAt(daily(23, 30), new Date(next.getTime() + 60_000))!;
    assert.equal(again.getDate(), 2);
    assert.equal(again.getHours(), 23);
  });

  test('工作日 / 每周也按日历日推(跨拨快日)', () => {
    // 2026-03-06 是周五 23:45;工作日 23:30 → 下一个工作日是 03-09 周一
    const weekdays = computeNextRunAt({ frequency: 'weekdays', run_at_hour: 23, run_at_minute: 30, run_at_weekday: null, run_at_day: null }, new Date(2026, 2, 6, 23, 45))!;
    assert.equal(weekdays.getDate(), 9);
    assert.equal(weekdays.getDay(), 1);
    assert.equal(weekdays.getHours(), 23);
    // 每周日 23:30,从 03-07 周六 23:45 起 → 03-08 周日(拨快日)
    const weekly = computeNextRunAt({ frequency: 'weekly', run_at_hour: 23, run_at_minute: 30, run_at_weekday: 0, run_at_day: null }, new Date(2026, 2, 7, 23, 45))!;
    assert.equal(weekly.getDate(), 8, `跳过了拨快日的周日:${weekly.toString()}`);
    assert.equal(weekly.getHours(), 23);
  });

  test('普通日子仍是"明天同一时刻",差 24 小时整', () => {
    const from = new Date(2026, 6, 1, 10, 0);
    const next = computeNextRunAt(daily(9, 0), from)!;
    assert.equal(next.getTime() - new Date(2026, 6, 1, 9, 0).getTime(), 24 * HOUR);
  });
});
