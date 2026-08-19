import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { closeConnection, initializeDatabase, projectsDb, userDb } from '@/modules/database/index.js';
import { canViewerSeeProject } from '@/shared/project-visibility.js';

/**
 * 两道可见性门必须逐字一致:SQL 侧 `getProjectPaths(visibleTo)`(侧栏列表)和
 * JS 侧 `canViewerSeeProject`(逐路由校验、实时广播)。任何一边改了口径而另一边
 * 没跟上,就会出现"列表里看得到但点进去 404"或反过来"列表里没有却能直接调接口"
 * —— 后者就是越权。这个测试在同一组样本上交叉验证两者给出相同答案。
 *
 * 新口径(2026-08-14):无主项目只有落在 PRISM_PUBLIC_WORKSPACE 之下才对非 root
 * 可见,其余仅 root。
 *
 * 2026-08-18 扩展(创建项目的权限三选):visibility='public' 对所有人可见;
 * project_shares 里被指定的用户可见 —— 两侧同步扩,交叉验证同样覆盖。
 */

/** 与调用点同构的完整 JS 判定输入(含显式可见性与指定授权)。 */
const jsVerdict = (
  row: { project_id: string; project_path: string; owner_user_id: number | null; visibility: string | null },
  viewer: { id: number; username: string },
): boolean => canViewerSeeProject({
  ownerUserId: row.owner_user_id ?? null,
  viewerUserId: viewer.id,
  viewerUsername: viewer.username,
  projectPath: row.project_path,
  visibility: row.visibility ?? null,
  sharedUserIds: projectsDb.getProjectSharedUserIds(row.project_id),
});

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
  tempDir = await mkdtemp(path.join(tmpdir(), 'visibility-parity-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
}

describe('SQL 列表口径与 JS 逐路由口径一致', () => {
  test('无主项目:公共目录内出现在列表,公共目录外不出现(与 canViewerSeeProject 一致)', async () => {
    const publicRoot = path.resolve('/workspace/public');
    process.env.PRISM_PUBLIC_WORKSPACE = publicRoot;
    delete process.env.PRISM_ROOT_USERS;
    await freshDb();

    const alice = { id: Number(userDb.createUser('alice', 'h').id), username: 'alice' };

    // alice 自己的项目
    projectsDb.createProjectPath('/workspace/alice/app', null, alice.id);
    // 无主 + 公共目录内
    projectsDb.createProjectPath(path.join(publicRoot, 'shared'), null, null);
    // 无主 + 公共目录外
    projectsDb.createProjectPath('/workspace/orphan/x', null, null);
    // 别人的项目
    const bob = { id: Number(userDb.createUser('bob', 'h').id), username: 'bob' };
    projectsDb.createProjectPath('/workspace/bob/app', null, bob.id);

    const listedForAlice = projectsDb.getProjectPaths(alice.id).map((r) => r.project_path).sort();

    // 交叉验证:列表里出现的,canViewerSeeProject 必须也说 true;没出现的,必须 false。
    for (const row of projectsDb.getProjectPaths(null)) {
      const inList = listedForAlice.includes(row.project_path);
      const jsSays = jsVerdict(row, alice);
      assert.equal(inList, jsSays, `不一致:${row.project_path}(owner=${row.owner_user_id}) 列表=${inList} JS=${jsSays}`);
    }

    // 具体断言,免得两边同时错还"一致"
    assert.deepEqual(listedForAlice, [
      '/workspace/alice/app',
      path.join(publicRoot, 'shared'),
    ].sort());
  });

  test('没配公共目录:非 root 只看得到自己的,所有无主项目都从列表消失', async () => {
    delete process.env.PRISM_PUBLIC_WORKSPACE;
    delete process.env.PRISM_ROOT_USERS;
    await freshDb();

    const alice = { id: Number(userDb.createUser('alice', 'h').id), username: 'alice' };
    projectsDb.createProjectPath('/workspace/alice/app', null, alice.id);
    projectsDb.createProjectPath('/workspace/orphan/x', null, null);
    projectsDb.createProjectPath('/workspace/orphan/y', null, null);

    const listed = projectsDb.getProjectPaths(alice.id).map((r) => r.project_path);
    assert.deepEqual(listed, ['/workspace/alice/app']);

    for (const row of projectsDb.getProjectPaths(null)) {
      const inList = listed.includes(row.project_path);
      const jsSays = jsVerdict(row, alice);
      assert.equal(inList, jsSays, `不一致:${row.project_path}`);
    }
  });

  test('权限三选:公共对所有人可见,指定用户只对被授权者可见,两侧口径一致', async () => {
    delete process.env.PRISM_PUBLIC_WORKSPACE;
    delete process.env.PRISM_ROOT_USERS;
    await freshDb();

    const alice = { id: Number(userDb.createUser('alice', 'h').id), username: 'alice' };
    const bob = { id: Number(userDb.createUser('bob', 'h').id), username: 'bob' };
    const carol = { id: Number(userDb.createUser('carol', 'h').id), username: 'carol' };

    // bob 建的公共项目:所有人可见
    projectsDb.createProjectPath('/workspace/bob/open', null, bob.id, 'public');
    // bob 建的指定用户项目:只授权给 alice
    const shared = projectsDb.createProjectPath('/workspace/bob/duo', null, bob.id);
    projectsDb.setProjectShares(shared.project!.project_id, [alice.id], bob.id);
    // bob 的个人项目:只有 bob
    projectsDb.createProjectPath('/workspace/bob/solo', null, bob.id);

    const listedForAlice = projectsDb.getProjectPaths(alice.id).map((r) => r.project_path).sort();
    assert.deepEqual(listedForAlice, ['/workspace/bob/duo', '/workspace/bob/open'].sort(), 'alice 应见公共 + 被授权');

    const listedForCarol = projectsDb.getProjectPaths(carol.id).map((r) => r.project_path).sort();
    assert.deepEqual(listedForCarol, ['/workspace/bob/open'], 'carol 只应见公共');

    // 三个 viewer 全量交叉验证 SQL vs JS
    for (const viewer of [alice, bob, carol]) {
      const listed = projectsDb.getProjectPaths(viewer.id).map((r) => r.project_path);
      for (const row of projectsDb.getProjectPaths(null)) {
        assert.equal(
          listed.includes(row.project_path),
          jsVerdict(row, viewer),
          `不一致:viewer=${viewer.username} ${row.project_path}`,
        );
      }
    }
  });

  test('公共根路径含 LIKE 通配符(%/_)时不被当成通配', async () => {
    const publicRoot = path.resolve('/workspace/pub_100%');
    process.env.PRISM_PUBLIC_WORKSPACE = publicRoot;
    await freshDb();

    projectsDb.createProjectPath(path.join(publicRoot, 'a'), null, null); // 真在公共目录下
    projectsDb.createProjectPath('/workspace/pubX100Y/a', null, null);    // 只有当 _ % 被当通配才会误匹配

    const alice = { id: Number(userDb.createUser('alice', 'h').id), username: 'alice' };
    const listed = projectsDb.getProjectPaths(alice.id).map((r) => r.project_path);

    assert.ok(listed.includes(path.join(publicRoot, 'a')));
    assert.ok(!listed.includes('/workspace/pubX100Y/a'), '通配符转义失效,相邻目录被误判为公共');
  });
});
