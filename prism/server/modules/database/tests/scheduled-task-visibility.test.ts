import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import {
  canViewerSeeProjectPath,
  closeConnection,
  initializeDatabase,
  projectsDb,
  scheduledTasksDb,
  userDb,
} from '@/modules/database/index.js';

/**
 * 定时任务的权限面**整个挂在项目可见性上**:项目分享给谁,任务就跟着给谁,
 * 而且是全权(看 / 改 / 删 / 立即运行同一道判据,不分读写)。
 *
 * 这里盯两件事:
 *   1. SQL 侧的 `listVisibleTo` 和 JS 侧的 `canViewerSeeProjectPath` **不许漂**。
 *      两者漂开的那条缝就是权限洞 —— 项目/会话那边已经因为同类问题栽过一次
 *      (HTTP 列表按 owner 过滤了、广播没有),所以这条 parity 必须钉住。
 *   2. 主人自己建的任务,哪怕项目还没被扫描进 projects 表,也必须看得见。
 */
const previousDatabasePath = process.env.DATABASE_PATH;
const previousPublic = process.env.PRISM_PUBLIC_WORKSPACE;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousPublic === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
  else process.env.PRISM_PUBLIC_WORKSPACE = previousPublic;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function freshDb() {
  tempDir = await mkdtemp(path.join(tmpdir(), 'task-vis-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.PRISM_PUBLIC_WORKSPACE = '/srv/public';
  await initializeDatabase();
  return {
    alice: Number(userDb.createUser('alice', 'h').id),
    bob: Number(userDb.createUser('bob', 'h').id),
  };
}

let seq = 0;
function makeTask(ownerUserId: number, projectPath: string): string {
  const id = `t${++seq}`;
  scheduledTasksDb.insert({
    id,
    name: `任务 ${id}`,
    instructions: '干活',
    project_path: projectPath,
    session_mode: 'fixed',
    fixed_session_id: null,
    frequency: 'daily',
    run_at_hour: 9,
    run_at_minute: 0,
    run_at_weekday: null,
    run_at_day: null,
    model: null,
    permission_mode: 'bypassPermissions',
    enabled: 1,
    owner_user_id: ownerUserId,
    next_run_at: null,
  });
  return id;
}

const idsVisibleTo = (userId: number) =>
  new Set(scheduledTasksDb.listVisibleTo(userId).map((task) => task.id));

describe('定时任务可见性跟随项目', () => {
  test('别人的私有项目上的任务:看不到', async () => {
    const { alice, bob } = await freshDb();
    projectsDb.createProjectPath('/srv/alice-private', null, alice, null);
    const task = makeTask(alice, '/srv/alice-private');

    assert.equal(idsVisibleTo(alice).has(task), true);
    assert.equal(idsVisibleTo(bob).has(task), false);
  });

  test('项目分享给他之后:任务跟着可见', async () => {
    const { alice, bob } = await freshDb();
    const created = projectsDb.createProjectPath('/srv/alice-shared', null, alice, null);
    const task = makeTask(alice, '/srv/alice-shared');
    assert.equal(idsVisibleTo(bob).has(task), false);

    projectsDb.setProjectShares(created.project.project_id, [bob], alice);
    assert.equal(idsVisibleTo(bob).has(task), true);
  });

  test('显式公共项目:所有人都看得到', async () => {
    const { alice, bob } = await freshDb();
    projectsDb.createProjectPath('/srv/team', null, alice, 'public');
    const task = makeTask(alice, '/srv/team');
    assert.equal(idsVisibleTo(bob).has(task), true);
  });

  test('无主项目:只有落在公共目录下才可见', async () => {
    const { alice, bob } = await freshDb();
    projectsDb.createProjectPath('/srv/public/shared-dir', null, null, null);
    projectsDb.createProjectPath('/srv/elsewhere/orphan', null, null, null);
    const inPublic = makeTask(alice, '/srv/public/shared-dir');
    const outside = makeTask(alice, '/srv/elsewhere/orphan');

    const bobSees = idsVisibleTo(bob);
    assert.equal(bobSees.has(inPublic), true);
    assert.equal(bobSees.has(outside), false);
  });

  test('主人自己的任务:项目还没进 projects 表也看得见', async () => {
    const { alice, bob } = await freshDb();
    const task = makeTask(alice, '/srv/not-scanned-yet');
    assert.equal(idsVisibleTo(alice).has(task), true);
    // 而别人看不见 —— 无主 + 不在公共目录
    assert.equal(idsVisibleTo(bob).has(task), false);
  });

  test('SQL 侧与 JS 侧逐条对齐(parity)', async () => {
    const { alice, bob } = await freshDb();
    const shared = projectsDb.createProjectPath('/srv/shared', null, alice, null);
    projectsDb.setProjectShares(shared.project.project_id, [bob], alice);
    projectsDb.createProjectPath('/srv/private', null, alice, null);
    projectsDb.createProjectPath('/srv/team', null, alice, 'public');
    projectsDb.createProjectPath('/srv/public/orphan', null, null, null);
    projectsDb.createProjectPath('/srv/elsewhere/orphan', null, null, null);

    const paths = ['/srv/shared', '/srv/private', '/srv/team', '/srv/public/orphan', '/srv/elsewhere/orphan'];
    // 全部挂在 alice 名下,这样"可见"只可能来自项目那一支 —— 主人兜底那支被排除。
    const byPath = new Map(paths.map((p) => [p, makeTask(alice, p)]));

    const viewer = { userId: bob, username: 'bob' };
    const sqlSide = idsVisibleTo(bob);
    for (const p of paths) {
      const jsSide = canViewerSeeProjectPath(viewer, p);
      assert.equal(
        sqlSide.has(byPath.get(p)!),
        jsSide,
        `${p}:SQL 侧 listVisibleTo 与 JS 侧 canViewerSeeProjectPath 不一致`,
      );
    }
  });
});

describe('listDue 只跑有效账号的任务', () => {
  test('主人被停用之后,他的任务不再被捞出来', async () => {
    const { alice } = await freshDb();
    const task = makeTask(alice, '/srv/public/anywhere');
    scheduledTasksDb.update(task, { next_run_at: '2020-01-01 00:00:00' });
    assert.equal(scheduledTasksDb.listDue('2030-01-01 00:00:00').some((t) => t.id === task), true);

    // 直接改列 —— 这条断言盯的是 listDue 的判据,不是停用账号那个 API 的形态。
    const { getConnection } = await import('@/modules/database/connection.js');
    getConnection().prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(alice);

    assert.equal(scheduledTasksDb.listDue('2030-01-01 00:00:00').some((t) => t.id === task), false);
  });
});
