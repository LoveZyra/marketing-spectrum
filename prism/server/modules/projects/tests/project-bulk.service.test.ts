import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { closeConnection, initializeDatabase, projectsDb, userDb } from '@/modules/database/index.js';
import { bulkProjectAction } from '@/modules/projects/services/project-bulk.service.js';
import { readProjectPermissionsView } from '@/modules/projects/services/project-permissions.service.js';

/**
 * 项目批量操作的权限边界。
 *
 * "全选 → 删除"如果不逐条鉴权,就是一把能扫掉别人项目的扫帚。所以下面每一条测的都是
 * "别人的项目有没有被动到",而不是"接口能不能跑通"。
 *
 * 口径与单条入口一致,批量入口不比单条更严,也不更松:
 *   - 收藏按可见性走;
 *   - 归档 / 删除 / 改权限要管理权(root 或 owner),改所有者是 root 独占。
 */
const previousDatabasePath = process.env.DATABASE_PATH;
const previousPublic = process.env.PRISM_PUBLIC_WORKSPACE;
const previousRoot = process.env.PRISM_ROOT_USERS;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousPublic === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
  else process.env.PRISM_PUBLIC_WORKSPACE = previousPublic;
  if (previousRoot === undefined) delete process.env.PRISM_ROOT_USERS;
  else process.env.PRISM_ROOT_USERS = previousRoot;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function freshDb(): Promise<void> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'project-bulk-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  delete process.env.PRISM_PUBLIC_WORKSPACE;
  process.env.PRISM_ROOT_USERS = 'boss';
  await initializeDatabase();
}

const viewerOf = (id: number, username: string) => ({ userId: id, username });
const actorOf = (id: number, username: string) => ({ id, username, isRoot: username === 'boss' });
const makeProject = (projectPath: string, ownerId: number | null) =>
  projectsDb.createProjectPath(projectPath, null, ownerId).project!.project_id;

describe('bulkProjectAction —— 权限边界', () => {
  test('别人的私有项目不会被批量归档,只会被跳过', async () => {
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);
    const bob = Number(userDb.createUser('bob', 'h').id);
    const mine = makeProject('/w/alice/app', alice);
    const theirs = makeProject('/w/bob/app', bob);

    const result = await bulkProjectAction(
      { action: 'archive', projectIds: [mine, theirs] },
      viewerOf(alice, 'alice'),
      actorOf(alice, 'alice'),
    );

    assert.deepEqual(result.succeeded, [mine]);
    assert.deepEqual(result.skipped, [{ projectId: theirs, reason: 'not-visible' }]);
    // 关键:别人的项目一个字节都没动
    assert.equal(Boolean(projectsDb.getProjectById(theirs)?.isArchived), false);
  });

  test('看得见但不是自己的项目(被共享过来的)—— 能改权限吗?不能', async () => {
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);
    const bob = Number(userDb.createUser('bob', 'h').id);
    const shared = makeProject('/w/alice/app', alice);
    projectsDb.setProjectShares(shared, [bob], alice);

    const result = await bulkProjectAction(
      { action: 'permissions', projectIds: [shared], permissions: { visibility: 'public', sharedUserIds: [] } },
      viewerOf(bob, 'bob'),
      actorOf(bob, 'bob'),
    );

    // 「可见不可管」—— 共享接收方看得见,但改不了
    assert.deepEqual(result.succeeded, []);
    assert.deepEqual(result.skipped, [{ projectId: shared, reason: 'not-manageable' }]);
    assert.equal(readProjectPermissionsView(shared)?.visibility, 'shared');
  });

  test('改所有者是 root 独占 —— 非 root 直接抛,一个项目都不动', async () => {
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);
    const bob = Number(userDb.createUser('bob', 'h').id);
    const mine = makeProject('/w/alice/app', alice);

    await assert.rejects(
      () => bulkProjectAction(
        { action: 'owner', projectIds: [mine], ownerUserId: bob },
        viewerOf(alice, 'alice'),
        actorOf(alice, 'alice'),
      ),
      /Administrator access required/,
    );
    assert.equal(projectsDb.getProjectOwner(mine), alice);
  });

  test('root 能改所有者;目标用户不存在时在动第一个项目之前就报错', async () => {
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);
    const boss = Number(userDb.createUser('boss', 'h').id);
    const one = makeProject('/w/alice/one', alice);
    const two = makeProject('/w/alice/two', alice);

    await assert.rejects(
      () => bulkProjectAction(
        { action: 'owner', projectIds: [one, two], ownerUserId: 999999 },
        viewerOf(boss, 'boss'),
        actorOf(boss, 'boss'),
      ),
      /ownerUserId/,
    );
    // 前置校验的意义就在这:两个项目都还归 alice,没有"改了一个才发现填错"
    assert.equal(projectsDb.getProjectOwner(one), alice);
    assert.equal(projectsDb.getProjectOwner(two), alice);

    const ok = await bulkProjectAction(
      { action: 'owner', projectIds: [one, two], ownerUserId: boss },
      viewerOf(boss, 'boss'),
      actorOf(boss, 'boss'),
    );
    assert.equal(ok.succeeded.length, 2);
    assert.equal(projectsDb.getProjectOwner(one), boss);
  });

  test('批量收藏是设成收藏,不是逐个翻转', async () => {
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);
    const already = makeProject('/w/alice/a', alice);
    const notYet = makeProject('/w/alice/b', alice);
    projectsDb.setProjectStarForUser(already, alice, true);

    await bulkProjectAction(
      { action: 'star', projectIds: [already, notYet] },
      viewerOf(alice, 'alice'),
      actorOf(alice, 'alice'),
    );

    // 翻转的话 already 会被取消 —— 点了「收藏」看到一半被取消,没人认为那是对的
    assert.equal(projectsDb.isProjectStarredByUser(already, alice), true);
    assert.equal(projectsDb.isProjectStarredByUser(notYet, alice), true);

    await bulkProjectAction(
      { action: 'unstar', projectIds: [already, notYet] },
      viewerOf(alice, 'alice'),
      actorOf(alice, 'alice'),
    );
    assert.equal(projectsDb.isProjectStarredByUser(already, alice), false);
    assert.equal(projectsDb.isProjectStarredByUser(notYet, alice), false);
  });

  test('收藏是按人存的 —— 批量收藏不会动别人的收藏', async () => {
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);
    const boss = Number(userDb.createUser('boss', 'h').id);
    const shared = makeProject('/w/alice/app', alice);
    projectsDb.setProjectShares(shared, [boss], alice);

    await bulkProjectAction(
      { action: 'star', projectIds: [shared] }, viewerOf(boss, 'boss'), actorOf(boss, 'boss'),
    );

    assert.equal(projectsDb.isProjectStarredByUser(shared, boss), true);
    assert.equal(projectsDb.isProjectStarredByUser(shared, alice), false);
  });

  test('root 批量设权限:自己的和别人的都能改(root 就是这个意思)', async () => {
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);
    const boss = Number(userDb.createUser('boss', 'h').id);
    const hers = makeProject('/w/alice/app', alice);

    const result = await bulkProjectAction(
      { action: 'permissions', projectIds: [hers], permissions: { visibility: 'public', sharedUserIds: [] } },
      viewerOf(boss, 'boss'),
      actorOf(boss, 'boss'),
    );

    assert.deepEqual(result.succeeded, [hers]);
    assert.equal(readProjectPermissionsView(hers)?.visibility, 'public');
    // root 帮别人改权限时不该顺手夺走归属
    assert.equal(projectsDb.getProjectOwner(hers), alice);
  });

  test('一个失败不中断其余,并且如实记账', async () => {
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);
    const bob = Number(userDb.createUser('bob', 'h').id);
    const ok = makeProject('/w/alice/app', alice);

    const result = await bulkProjectAction(
      {
        action: 'permissions',
        projectIds: [ok, 'no-such-project'],
        permissions: { visibility: 'shared', sharedUserIds: [bob] },
      },
      viewerOf(alice, 'alice'),
      actorOf(alice, 'alice'),
    );

    assert.equal(result.requested, 2);
    assert.deepEqual(result.succeeded, [ok]);
    assert.equal(result.skipped.length, 1);
    assert.equal(readProjectPermissionsView(ok)?.sharedUserIds.length, 1);
  });

  test('重复 id 只算一次 —— 前端选择集重复时不该把同一个项目删两遍', async () => {
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);
    const one = makeProject('/w/alice/app', alice);

    const result = await bulkProjectAction(
      { action: 'archive', projectIds: [one, one, one] },
      viewerOf(alice, 'alice'),
      actorOf(alice, 'alice'),
    );
    assert.equal(result.requested, 1);
    assert.deepEqual(result.succeeded, [one]);
  });
});
