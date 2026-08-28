import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  scheduledTasksDb,
  taskRunHistoryLimit,
  userDb,
} from '@/modules/database/index.js';

/**
 * cz:定时任务的运行记录。
 *
 * 之前只有 scheduled_tasks 上的 last_run_* 四个单数列,跑一次覆盖一次 ——
 * 任务连着失败几回,前几次的失败原因根本查不到。这里要盯住三件事:
 *   1. 每跑一次**追加**一行,不是覆盖;
 *   2. 摘要(last_run_*)和明细(最新一条记录)必须一致 —— 两者打架时没人知道该信哪个;
 *   3. 有上限,而且删任务时记录跟着走,不留孤儿。
 */
const previousDatabasePath = process.env.DATABASE_PATH;
const previousLimit = process.env.PRISM_TASK_RUN_HISTORY;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousLimit === undefined) delete process.env.PRISM_TASK_RUN_HISTORY;
  else process.env.PRISM_TASK_RUN_HISTORY = previousLimit;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function freshDb(): Promise<number> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'task-runs-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
  return Number(userDb.createUser('alice', 'h').id);
}

function makeTask(id: string, ownerUserId: number) {
  scheduledTasksDb.insert({
    id,
    name: `任务 ${id}`,
    instructions: '干活',
    project_path: '/tmp/demo',
    session_mode: 'fixed',
    fixed_session_id: null,
    frequency: 'daily',
    run_at_hour: 15,
    run_at_minute: 45,
    run_at_weekday: null,
    run_at_day: null,
    model: null,
    permission_mode: 'bypassPermissions',
    enabled: 1,
    owner_user_id: ownerUserId,
    next_run_at: null,
  });
}

const finish = (id: string, over: Partial<Parameters<typeof scheduledTasksDb.finishRun>[1]> = {}) =>
  scheduledTasksDb.finishRun(id, {
    status: 'completed',
    detail: null,
    durationMs: 8000,
    nextRunAt: null,
    trigger: 'schedule',
    ...over,
  });

describe('定时任务运行记录', () => {
  test('每跑一次追加一行,不是覆盖', async () => {
    const owner = await freshDb();
    makeTask('t1', owner);

    finish('t1');
    finish('t1', { status: 'failed', detail: '上游 502' });
    finish('t1', { durationMs: 1200 });

    const { rows, total } = scheduledTasksDb.listRuns('t1');
    assert.equal(total, 3);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].duration_ms, 1200, '最近的在最前');
    assert.equal(rows[1].status, 'failed');
    assert.equal(rows[1].detail, '上游 502', '失败原因逐条留着,不再被下一次覆盖');
  });

  test('摘要与最新一条明细一致', async () => {
    const owner = await freshDb();
    makeTask('t1', owner);
    finish('t1', { status: 'failed', detail: '连不上', durationMs: 300 });

    const task = scheduledTasksDb.getById('t1')!;
    const latest = scheduledTasksDb.listRuns('t1').rows[0];
    assert.equal(task.last_run_status, latest.status);
    assert.equal(task.last_run_detail, latest.detail);
    assert.equal(task.last_run_duration_ms, latest.duration_ms);
    assert.equal(task.running, 0, '收尾必须把 running 放掉');
  });

  test('记下触发方式和产出会话 —— 新建会话模式下每次会话不同,得点得回去', async () => {
    const owner = await freshDb();
    makeTask('t1', owner);
    finish('t1', { trigger: 'manual', sessionId: 'sess-a' });
    finish('t1', { trigger: 'schedule', sessionId: 'sess-b' });

    const rows = scheduledTasksDb.listRuns('t1').rows;
    assert.equal(rows[0].trigger_kind, 'schedule');
    assert.equal(rows[0].session_id, 'sess-b');
    assert.equal(rows[1].trigger_kind, 'manual');
    assert.equal(rows[1].session_id, 'sess-a');
  });

  test('超过上限就地裁掉最旧的', async () => {
    process.env.PRISM_TASK_RUN_HISTORY = '5';
    const owner = await freshDb();
    makeTask('t1', owner);
    for (let i = 0; i < 12; i += 1) finish('t1', { durationMs: i });

    const { rows, total } = scheduledTasksDb.listRuns('t1', 100);
    assert.equal(total, 5, '每小时跑一次的任务一年 8760 行,必须有上限');
    assert.deepEqual(rows.map((r) => r.duration_ms), [11, 10, 9, 8, 7], '留下的是最近 5 条');
  });

  test('上限配 0 视为不裁剪', async () => {
    process.env.PRISM_TASK_RUN_HISTORY = '0';
    const owner = await freshDb();
    makeTask('t1', owner);
    for (let i = 0; i < 8; i += 1) finish('t1');
    assert.equal(scheduledTasksDb.listRuns('t1', 100).total, 8);
  });

  test('上限默认 50,配了废值也回落到 50', () => {
    assert.equal(taskRunHistoryLimit({} as NodeJS.ProcessEnv), 50);
    assert.equal(taskRunHistoryLimit({ PRISM_TASK_RUN_HISTORY: 'abc' } as NodeJS.ProcessEnv), 50);
    assert.equal(taskRunHistoryLimit({ PRISM_TASK_RUN_HISTORY: '7' } as NodeJS.ProcessEnv), 7);
  });

  test('裁剪只动自己这个任务,不碰别人的记录', async () => {
    process.env.PRISM_TASK_RUN_HISTORY = '2';
    const owner = await freshDb();
    makeTask('t1', owner);
    makeTask('t2', owner);
    for (let i = 0; i < 5; i += 1) finish('t1');
    finish('t2');
    finish('t2');

    assert.equal(scheduledTasksDb.listRuns('t1', 100).total, 2);
    assert.equal(scheduledTasksDb.listRuns('t2', 100).total, 2, 't2 不该被 t1 的裁剪连累');
  });

  test('删任务时记录跟着走,不留孤儿', async () => {
    const owner = await freshDb();
    makeTask('t1', owner);
    makeTask('t2', owner);
    finish('t1');
    finish('t1');
    finish('t2');

    assert.equal(scheduledTasksDb.delete('t1'), true);
    assert.equal(scheduledTasksDb.listRuns('t1', 100).total, 0, '任务没了,它的记录也不该还占着表');
    assert.equal(scheduledTasksDb.listRuns('t2', 100).total, 1, '别人的记录不受影响');
  });

  test('分页取得到更早的记录', async () => {
    const owner = await freshDb();
    makeTask('t1', owner);
    for (let i = 0; i < 10; i += 1) finish('t1', { durationMs: i });

    const page2 = scheduledTasksDb.listRuns('t1', 3, 3);
    assert.equal(page2.total, 10);
    assert.deepEqual(page2.rows.map((r) => r.duration_ms), [6, 5, 4]);
  });

  test('没跑过的任务返回空列表而不是报错', async () => {
    const owner = await freshDb();
    makeTask('t1', owner);
    assert.deepEqual(scheduledTasksDb.listRuns('t1'), { rows: [], total: 0 });
  });
});
