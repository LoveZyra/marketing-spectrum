import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  scheduledTasksDb,
  userDb,
  type ApprovalStatus,
} from '@/modules/database/index.js';
import {
  computeNextRunAt,
  executeTask,
  startTaskScheduler,
  stopTaskScheduler,
  toDbUtc,
} from '@/modules/tasks/services/scheduled-tasks.service.js';

/**
 * 调度器判「任务主人账号能不能用」与登录同一口径(`isAccountUsable`):
 * root 与 `PRISM_APPROVAL_REQUIRED=0` 时不看审批状态;否则待审批 / 已驳回的主人不跑,
 * 记一条跳过的运行记录,`next_run_at` 推到下一个正常周期(不进 5 分钟重试)。
 */

/** 每日触发的钟点离"现在"至少 2 小时,下一周期与 5 分钟重试分得开。 */
const FAR_HOUR = (() => {
  const now = new Date();
  const gap = (a: number, b: number) => Math.min((a - b + 24) % 24, (b - a + 24) % 24);
  for (let hour = 0; hour < 24; hour += 1) {
    if (gap(hour, now.getHours()) >= 2 && gap(hour, now.getUTCHours()) >= 2) return hour;
  }
  return (now.getUTCHours() + 12) % 24;
})();

type Ctx = { tempDirectory: string; calls: () => number; notices: () => Array<{ taskName: string; error: string }> };

async function withEnv(
  approvalRequired: '0' | '1',
  runTest: (ctx: Ctx) => Promise<void>,
  outcome: { ok: boolean; error: string | null } = { ok: true, error: null },
): Promise<void> {
  const keys = ['DATABASE_PATH', 'PRISM_ROOT_USERS', 'PRISM_PUBLIC_WORKSPACE', 'WORKSPACES_ROOT', 'PRISM_APPROVAL_REQUIRED'] as const;
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'task-owner-usable-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  process.env.WORKSPACES_ROOT = tempDirectory;
  process.env.PRISM_PUBLIC_WORKSPACE = path.join(tempDirectory, 'public');
  process.env.PRISM_APPROVAL_REQUIRED = approvalRequired;
  await initializeDatabase();

  let calls = 0;
  const notices: Array<{ taskName: string; error: string }> = [];
  startTaskScheduler(async () => {
    calls += 1;
    return { ok: outcome.ok, exitCode: outcome.ok ? 0 : 1, aborted: false, error: outcome.error, sessionId: null };
  }, {
    notifyTaskFailed: ({ taskName, error }) => notices.push({ taskName, error }),
  });
  try {
    await runTest({ tempDirectory, calls: () => calls, notices: () => notices });
  } finally {
    stopTaskScheduler();
    closeConnection();
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** 建一个指定审批状态的主人、他自己的项目,以及一个已到点的每日任务。 */
async function seedOwnerTask(tempDirectory: string, username: string, status: ApprovalStatus) {
  const ownerId = Number(userDb.createUser(username, 'hash', status === 'rejected' ? 'approved' : status).id);
  if (status === 'rejected') userDb.setApprovalStatus(ownerId, 'rejected', null);
  const projectPath = path.join(tempDirectory, `${username}-proj`);
  await mkdir(projectPath, { recursive: true });
  projectsDb.createProjectPath(projectPath, null, ownerId);
  const taskId = `t-${username}`;
  scheduledTasksDb.insert({
    id: taskId,
    name: `${username} 的任务`,
    instructions: '跑个回归',
    project_path: projectPath,
    session_mode: 'fixed',
    fixed_session_id: null,
    frequency: 'daily',
    run_at_hour: FAR_HOUR, run_at_minute: 0, run_at_weekday: null, run_at_day: null,
    model: null, permission_mode: 'bypassPermissions',
    enabled: 1, owner_user_id: ownerId,
    next_run_at: '2020-01-01 00:00:00',
  });
  return taskId;
}

const isDue = (taskId: string) => scheduledTasksDb.listDue(toDbUtc(new Date())).some((task) => task.id === taskId);

describe('任务主人账号的可用性与登录同一口径', () => {
  test('需要审批时,待审批的主人:不跑,记一条跳过、不发失败通知,下一次推到正常周期', async () => {
    await withEnv('1', async ({ tempDirectory, calls, notices }) => {
      const taskId = await seedOwnerTask(tempDirectory, 'pat', 'pending');
      assert.equal(isDue(taskId), true, '待审批主人的任务要被捞出来,才能留下跳过记录');

      await executeTask(scheduledTasksDb.getById(taskId)!, 'schedule');

      assert.equal(calls(), 0, '不该以待审批主人的身份跑');
      assert.deepEqual(notices(), [], '通知只会发给登不进来的主人,每个周期一条,不发');
      const after = scheduledTasksDb.getById(taskId)!;
      assert.equal(after.running, 0);
      assert.equal(after.last_run_status, 'failed');
      assert.match(String(after.last_run_detail), /任务主人账号不可用\(待审批\)/);
      assert.ok(!String(after.last_run_detail).includes('自动重试'), '跳过不该进 5 分钟重试');
      assert.equal(after.next_run_at, toDbUtc(computeNextRunAt(after, new Date())!));
      assert.equal(isDue(taskId), false, '推到下一周期之后,这一拍不该再捞出来');

      const runs = scheduledTasksDb.listRuns(taskId).rows;
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, 'failed');
      assert.equal(runs[0].trigger_kind, 'schedule');
      assert.equal(runs[0].session_id, null, '跳过时不建会话');
    });
  });

  test('需要审批时,已驳回的主人同样跳过,原因写明已驳回;连续几个周期都不发通知', async () => {
    await withEnv('1', async ({ tempDirectory, calls, notices }) => {
      const taskId = await seedOwnerTask(tempDirectory, 'rita', 'rejected');
      await executeTask(scheduledTasksDb.getById(taskId)!, 'manual');
      assert.equal(calls(), 0);
      assert.match(String(scheduledTasksDb.getById(taskId)!.last_run_detail), /任务主人账号不可用\(已驳回\)/);
      await executeTask(scheduledTasksDb.getById(taskId)!, 'schedule');
      await executeTask(scheduledTasksDb.getById(taskId)!, 'schedule');
      assert.equal(scheduledTasksDb.listRuns(taskId).rows.length, 3, '每次都留运行记录');
      assert.deepEqual(notices(), []);
    });
  });

  test('主人被停用:立即运行也跳过并留下记录,不发通知', async () => {
    await withEnv('1', async ({ tempDirectory, calls, notices }) => {
      const taskId = await seedOwnerTask(tempDirectory, 'dora', 'approved');
      userDb.setActive(scheduledTasksDb.getById(taskId)!.owner_user_id, false);
      assert.equal(isDue(taskId), false, '停用的主人在 SQL 里就挡掉');

      await executeTask(scheduledTasksDb.getById(taskId)!, 'manual');
      assert.equal(calls(), 0);
      assert.match(String(scheduledTasksDb.getById(taskId)!.last_run_detail), /任务主人账号不可用\(不存在或已停用\)/);
      assert.deepEqual(notices(), []);
    });
  });

  test('对照:主人可用、回合本身失败,照常发失败通知', async () => {
    await withEnv('1', async ({ tempDirectory, calls, notices }) => {
      const taskId = await seedOwnerTask(tempDirectory, 'ann', 'approved');
      await executeTask(scheduledTasksDb.getById(taskId)!, 'manual');
      assert.equal(calls(), 1);
      assert.equal(scheduledTasksDb.getById(taskId)!.last_run_status, 'failed');
      assert.deepEqual(notices().map((notice) => notice.error), ['网关 500']);
    }, { ok: false, error: '网关 500' });
  });

  test('关掉审批(PRISM_APPROVAL_REQUIRED=0)后,待审批的主人照常跑', async () => {
    await withEnv('0', async ({ tempDirectory, calls }) => {
      const taskId = await seedOwnerTask(tempDirectory, 'pat', 'pending');
      assert.equal(isDue(taskId), true);
      await executeTask(scheduledTasksDb.getById(taskId)!, 'schedule');
      assert.equal(calls(), 1);
      assert.equal(scheduledTasksDb.getById(taskId)!.last_run_status, 'completed');
    });
  });

  test('root 不受审批约束:以待审批身份注册、后来加进 root 名单的人,任务照常跑', async () => {
    await withEnv('1', async ({ tempDirectory, calls }) => {
      const taskId = await seedOwnerTask(tempDirectory, 'boss', 'pending');
      assert.equal(isDue(taskId), true);
      await executeTask(scheduledTasksDb.getById(taskId)!, 'schedule');
      assert.equal(calls(), 1);
      assert.equal(scheduledTasksDb.getById(taskId)!.last_run_status, 'completed');
    });
  });
});
