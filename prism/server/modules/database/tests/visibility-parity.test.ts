import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { canViewerSeeSession, closeConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { NO_SUCH_USER_ID } from '@/modules/database/visibility-sql.js';
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

/**
 * E10 把归档会话列表的可见性也下推进了 SQL(`getArchivedSessionsPage`)。会话
 * 没有自己的 owner —— 它挂在项目上,所以这条 SQL 是 sessions LEFT JOIN projects
 * 再套同一段判定。它必须与 JS 侧 `canViewerSeeSession` 逐条一致,否则就是
 * "归档面板里列得出来、点进去 404",或者反过来 —— 越权。
 *
 * 三种项目行都要覆盖:有主 / 显式 public / 被指定授权 / 无主(公共目录内外),
 * 外加**项目行根本不存在**的会话(watcher 先索引了 transcript,项目还没落行)。
 */
describe('归档会话列表的 SQL 口径与 canViewerSeeSession 一致', () => {
  const listedFor = (userId: number): string[] =>
    sessionsDb
      .getArchivedSessionsPage({ kind: 'user', userId }, 500, 0)
      .rows.map((row) => row.session_id);

  test('五种项目形态 + 无项目行的会话,SQL 与 JS 逐条同答案', async () => {
    const publicRoot = path.resolve('/workspace/public');
    process.env.PRISM_PUBLIC_WORKSPACE = publicRoot;
    delete process.env.PRISM_ROOT_USERS;
    await freshDb();

    const alice = { id: Number(userDb.createUser('alice', 'h').id), username: 'alice' };
    const bob = { id: Number(userDb.createUser('bob', 'h').id), username: 'bob' };
    const carol = { id: Number(userDb.createUser('carol', 'h').id), username: 'carol' };

    projectsDb.createProjectPath('/workspace/alice/app', null, alice.id);
    projectsDb.createProjectPath('/workspace/bob/open', null, bob.id, 'public');
    const shared = projectsDb.createProjectPath('/workspace/bob/duo', null, bob.id);
    projectsDb.setProjectShares(shared.project!.project_id, [alice.id], bob.id);
    projectsDb.createProjectPath('/workspace/bob/solo', null, bob.id);
    projectsDb.createProjectPath(path.join(publicRoot, 'shared'), null, null);
    projectsDb.createProjectPath('/workspace/orphan/x', null, null);

    const sessionPaths: Array<[string, string]> = [
      ['s-alice', '/workspace/alice/app'],
      ['s-open', '/workspace/bob/open'],
      ['s-duo', '/workspace/bob/duo'],
      ['s-solo', '/workspace/bob/solo'],
      ['s-pub-unowned', path.join(publicRoot, 'shared')],
      ['s-orphan', '/workspace/orphan/x'],
      // 项目行不存在的两条:一条在公共目录下(应可见),一条不在(仅 root)。
      ['s-noproject-public', path.join(publicRoot, 'never-registered')],
      ['s-noproject-private', '/workspace/never-registered'],
    ];
    for (const [sessionId, projectPath] of sessionPaths) {
      sessionsDb.createSession(sessionId, 'claude', projectPath, sessionId);
      sessionsDb.updateSessionIsArchived(sessionId, true);
    }
    // 一条没有项目路径的会话:两侧都只有 root 看得到。
    sessionsDb.createSession('s-nopath', 'claude', '', 's-nopath');
    sessionsDb.updateSessionIsArchived('s-nopath', true);

    const everySessionId = [...sessionPaths.map(([id]) => id), 's-nopath'];

    for (const viewer of [alice, bob, carol]) {
      const listed = listedFor(viewer.id);
      for (const sessionId of everySessionId) {
        const jsSays = canViewerSeeSession(sessionId, { userId: viewer.id, username: viewer.username });
        assert.equal(
          listed.includes(sessionId),
          jsSays,
          `不一致:viewer=${viewer.username} session=${sessionId} SQL=${listed.includes(sessionId)} JS=${jsSays}`,
        );
      }
    }

    // 具体断言,免得两边同时错还"一致"。
    assert.deepEqual(listedFor(alice.id).sort(), [
      's-alice', 's-duo', 's-noproject-public', 's-open', 's-pub-unowned',
    ]);
    assert.deepEqual(listedFor(carol.id).sort(), [
      's-noproject-public', 's-open', 's-pub-unowned',
    ]);

    // root(scope=all)看全部,且总数与页内条数对得上。
    const rootPage = sessionsDb.getArchivedSessionsPage({ kind: 'all' }, 500, 0);
    assert.equal(rootPage.total, everySessionId.length);
    assert.deepEqual(rootPage.rows.map((row) => row.session_id).sort(), [...everySessionId].sort());

    // 匿名访问者(拿不到数字 id)= NO_SUCH_USER_ID:只剩显式 public 与公共目录下的无主项目。
    assert.deepEqual(listedFor(NO_SUCH_USER_ID).sort(), [
      's-noproject-public', 's-open', 's-pub-unowned',
    ]);
  });

  test('分页:total 是过滤后的总数,limit/offset 切的是同一份可见集合', async () => {
    delete process.env.PRISM_PUBLIC_WORKSPACE;
    delete process.env.PRISM_ROOT_USERS;
    await freshDb();

    const alice = { id: Number(userDb.createUser('alice', 'h').id), username: 'alice' };
    const bob = { id: Number(userDb.createUser('bob', 'h').id), username: 'bob' };
    projectsDb.createProjectPath('/workspace/alice/app', null, alice.id);
    projectsDb.createProjectPath('/workspace/bob/solo', null, bob.id);

    for (let index = 0; index < 5; index += 1) {
      sessionsDb.createSession(`a-${index}`, 'claude', '/workspace/alice/app', `a-${index}`);
      sessionsDb.updateSessionIsArchived(`a-${index}`, true);
      sessionsDb.createSession(`b-${index}`, 'claude', '/workspace/bob/solo', `b-${index}`);
      sessionsDb.updateSessionIsArchived(`b-${index}`, true);
    }

    const first = sessionsDb.getArchivedSessionsPage({ kind: 'user', userId: alice.id }, 2, 0);
    const second = sessionsDb.getArchivedSessionsPage({ kind: 'user', userId: alice.id }, 2, 2);

    assert.equal(first.total, 5, 'total 必须是过滤后的数,不是全表数');
    assert.equal(second.total, 5);
    assert.equal(first.rows.length, 2);
    assert.equal(second.rows.length, 2);
    assert.ok(first.rows.every((row) => row.session_id.startsWith('a-')), '翻页不能漏出别人的会话');
    assert.ok(second.rows.every((row) => row.session_id.startsWith('a-')));
    assert.equal(
      new Set([...first.rows, ...second.rows].map((row) => row.session_id)).size,
      4,
      '两页不能重叠',
    );
  });
});

/**
 * fb 把**未归档**会话列表的可见性也下推进了 SQL(`getVisibleSessionsPage`),
 * 给外部 API `GET /api/agent/sessions` 用 —— 它原来是整表捞出来再在 JS 侧逐行过滤,
 * 而过滤函数每行查库,4000 条会话就把同步的事件循环按住 219ms。
 *
 * 归档那条已经有 parity 测试(见上一个 describe),但这次新增的是**另外两档**
 * (`exclude` 与 `include`),它们各自的 WHERE 不一样。下推可见性最大的风险就是
 * SQL 与 JS 判据漂开 —— 一漂就是"列得出来点进去 404",或者反过来:越权。
 * 所以三档都得钉。
 */
describe('未归档 / 全部会话列表的 SQL 口径与 canViewerSeeSession 一致', () => {
  test('exclude 与 include 两档都与 JS 逐条同答案', async () => {
    const publicRoot = path.resolve('/workspace/public');
    process.env.PRISM_PUBLIC_WORKSPACE = publicRoot;
    delete process.env.PRISM_ROOT_USERS;
    await freshDb();

    const alice = { id: Number(userDb.createUser('alice', 'h').id), username: 'alice' };
    const bob = { id: Number(userDb.createUser('bob', 'h').id), username: 'bob' };

    projectsDb.createProjectPath('/workspace/alice/app', null, alice.id);
    projectsDb.createProjectPath('/workspace/bob/open', null, bob.id, 'public');
    projectsDb.createProjectPath('/workspace/bob/solo', null, bob.id);
    projectsDb.createProjectPath(path.join(publicRoot, 'shared'), null, null);

    // 一半归档一半不归档 —— 两档的 WHERE 才真的被分开验到
    const live: Array<[string, string]> = [
      ['live-alice', '/workspace/alice/app'],
      ['live-open', '/workspace/bob/open'],
      ['live-solo', '/workspace/bob/solo'],
      ['live-pub', path.join(publicRoot, 'shared')],
    ];
    const archived: Array<[string, string]> = [
      ['arch-alice', '/workspace/alice/app'],
      ['arch-solo', '/workspace/bob/solo'],
    ];
    for (const [sessionId, projectPath] of [...live, ...archived]) {
      sessionsDb.createSession(sessionId, 'claude', projectPath, sessionId);
    }
    for (const [sessionId] of archived) sessionsDb.updateSessionIsArchived(sessionId, true);

    const idsIn = (result: { rows: Array<{ session_id: string }> }) =>
      result.rows.map((row) => row.session_id).sort();

    for (const viewer of [alice, bob]) {
      const scope = { kind: 'user' as const, userId: viewer.id };

      // exclude:只该有未归档的,且逐条与 JS 一致
      const excluded = sessionsDb.getVisibleSessionsPage(scope, 500, 0, { archived: 'exclude' });
      for (const [sessionId] of archived) {
        assert.ok(!idsIn(excluded).includes(sessionId), `exclude 档漏进了归档会话 ${sessionId}`);
      }
      for (const [sessionId] of live) {
        const jsSays = canViewerSeeSession(sessionId, { userId: viewer.id, username: viewer.username });
        assert.equal(
          idsIn(excluded).includes(sessionId), jsSays,
          `exclude 不一致:viewer=${viewer.username} session=${sessionId}`,
        );
      }

      // include:归档与未归档都在,同样逐条与 JS 一致
      const included = sessionsDb.getVisibleSessionsPage(scope, 500, 0, { archived: 'include' });
      for (const [sessionId] of [...live, ...archived]) {
        const jsSays = canViewerSeeSession(sessionId, { userId: viewer.id, username: viewer.username });
        assert.equal(
          idsIn(included).includes(sessionId), jsSays,
          `include 不一致:viewer=${viewer.username} session=${sessionId}`,
        );
      }
    }

    // 具体断言,免得两边同时错还"一致"
    const aliceScope = { kind: 'user' as const, userId: alice.id };
    assert.deepEqual(
      idsIn(sessionsDb.getVisibleSessionsPage(aliceScope, 500, 0, { archived: 'exclude' })),
      ['live-alice', 'live-open', 'live-pub'],
    );
    assert.deepEqual(
      idsIn(sessionsDb.getVisibleSessionsPage(aliceScope, 500, 0, { archived: 'include' })),
      ['arch-alice', 'live-alice', 'live-open', 'live-pub'],
    );

    // total 必须是**过滤后**的总数,不是全表 —— 分页的正确性全靠它
    const bobExcluded = sessionsDb.getVisibleSessionsPage(
      { kind: 'user', userId: bob.id }, 500, 0, { archived: 'exclude' },
    );
    assert.equal(bobExcluded.total, bobExcluded.rows.length);

    // 分页本身:limit/offset 走 SQL,两页拼起来正好是全集且不重不漏
    const rootAll = sessionsDb.getVisibleSessionsPage({ kind: 'all' }, 500, 0, { archived: 'include' });
    const p1 = sessionsDb.getVisibleSessionsPage({ kind: 'all' }, 3, 0, { archived: 'include' });
    const p2 = sessionsDb.getVisibleSessionsPage({ kind: 'all' }, 3, 3, { archived: 'include' });
    assert.equal(p1.total, rootAll.total);
    assert.deepEqual(
      [...p1.rows, ...p2.rows].map((r) => r.session_id).sort(),
      rootAll.rows.map((r) => r.session_id).sort(),
    );
  });
});
