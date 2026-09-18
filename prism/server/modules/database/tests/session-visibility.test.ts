import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

import {
  canViewerManageSession,
  canViewerSeeSession,
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousRootUsers = process.env.PRISM_ROOT_USERS;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-visibility-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousRootUsers === undefined) delete process.env.PRISM_ROOT_USERS;
    else process.env.PRISM_ROOT_USERS = previousRootUsers;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * 会话级归属判定。
 *
 * 这条规则补的是一个真实缺口:账号隔离原先只做在项目列表和侧栏广播上,会话相关的
 * 接口一个都没过滤。归档会话接口会把所有人的 projectId 直接吐出来,而 projectId
 * 正是所有 project 级接口唯一的凭据 —— "你得先知道 id" 这个前提当时并不成立。
 */
describe('会话可见性', () => {
  test('本人可见,他人不可见', async () => {
    await withIsolatedDatabase(() => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id) };
      const bob = { id: Number(userDb.createUser('bob', 'hash').id) };
      projectsDb.createProjectPath('/workspace/alice', null, alice.id);
      sessionsDb.createAppSession('s-alice', 'claude', '/workspace/alice', alice.id);

      assert.equal(canViewerSeeSession('s-alice', { userId: alice.id, username: 'alice' }), true);
      assert.equal(canViewerSeeSession('s-alice', { userId: bob.id, username: 'bob' }), false);
    });
  });

  test('root 看得到所有人的会话', async () => {
    await withIsolatedDatabase(() => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id) };
      const boss = { id: Number(userDb.createUser('boss', 'hash').id) };
      projectsDb.createProjectPath('/workspace/alice', null, alice.id);
      sessionsDb.createAppSession('s-alice', 'claude', '/workspace/alice', alice.id);

      assert.equal(canViewerSeeSession('s-alice', { userId: boss.id, username: 'boss' }), true);
    });
  });

  test('无主项目下的会话:在公共目录内所有人可见,目录外仅 root', async () => {
    // 2026-08-14 口径变更:无主 ≠ 公开,取决于是否落在 PRISM_PUBLIC_WORKSPACE 下。
    const previousPublic = process.env.PRISM_PUBLIC_WORKSPACE;
    process.env.PRISM_PUBLIC_WORKSPACE = '/workspace/public';
    try {
      await withIsolatedDatabase(() => {
        const bob = { id: Number(userDb.createUser('bob', 'hash').id) };

        // 无主 + 公共目录内 —— 所有人可见
        projectsDb.createProjectPath('/workspace/public/shared');
        sessionsDb.createAppSession('s-pub', 'claude', '/workspace/public/shared');
        assert.equal(canViewerSeeSession('s-pub', { userId: bob.id, username: 'bob' }), true);

        // 无主 + 公共目录外 —— bob 看不到,root(boss)看得到
        projectsDb.createProjectPath('/workspace/orphan');
        sessionsDb.createAppSession('s-orphan', 'claude', '/workspace/orphan');
        assert.equal(canViewerSeeSession('s-orphan', { userId: bob.id, username: 'bob' }), false);
        assert.equal(canViewerSeeSession('s-orphan', { userId: 999, username: 'boss' }), true);
      });
    } finally {
      if (previousPublic === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
      else process.env.PRISM_PUBLIC_WORKSPACE = previousPublic;
    }
  });

  /**
   * 这条是这次修复的核心回归点。`createAppSession` 原先调
   * `projectsDb.createProjectPath(path)` 只传一个参数,第三参 ownerUserId 默认
   * null,而 null 的语义是"公共项目" —— 于是**每一个新建会话所在的目录都对全服务器
   * 公开**。日常路径就能触发:在终端里于任何尚未登记的目录跑一次 claude 即可。
   */
  test('新建会话会把项目登记到创建者名下,而不是留成公共', async () => {
    await withIsolatedDatabase(() => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id) };
      const bob = { id: Number(userDb.createUser('bob', 'hash').id) };

      sessionsDb.createAppSession('s-new', 'claude', '/workspace/brand-new', alice.id);

      const project = projectsDb.getProjectPath('/workspace/brand-new');
      assert.equal(project?.owner_user_id, alice.id, '项目应当落在创建者名下');
      assert.equal(canViewerSeeSession('s-new', { userId: bob.id, username: 'bob' }), false);
    });
  });

  test('不存在的会话返回 false —— 调用点据此回 404,与"不属于你"同形', async () => {
    await withIsolatedDatabase(() => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id) };
      assert.equal(canViewerSeeSession('no-such-session', { userId: alice.id, username: 'alice' }), false);
    });
  });

  test('匿名访问者(没有登录身份)看不到有主的会话', async () => {
    await withIsolatedDatabase(() => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id) };
      projectsDb.createProjectPath('/workspace/alice', null, alice.id);
      sessionsDb.createAppSession('s-alice', 'claude', '/workspace/alice', alice.id);

      assert.equal(canViewerSeeSession('s-alice', { userId: null, username: null }), false);
    });
  });

  /**
   * gk:**看得见 ≠ 能永久删。**
   *
   * 2026-09-14 的事故:共享项目里任何一位协作者都能把别人跑了一天的对话连 transcript
   * 一起永久删掉。不可逆的那一档收紧到项目 owner / root;共享给的用户、公共项目的
   * 访客、无主项目下的非 root 一律不能。改回"可见即可删",下面第二个断言立刻红。
   */
  test('gk:永久删除只给项目 owner 与 root(共享用户看得见但删不了)', async () => {
    await withIsolatedDatabase(() => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id) };
      const bob = { id: Number(userDb.createUser('bob', 'hash').id) };
      projectsDb.createProjectPath('/workspace/alice', null, alice.id);
      sessionsDb.createAppSession('s-alice', 'claude', '/workspace/alice', alice.id);
      const project = projectsDb.getProjectPath('/workspace/alice');
      projectsDb.setProjectShares(project!.project_id, [bob.id], alice.id);
      assert.equal(canViewerSeeSession('s-alice', { userId: bob.id, username: 'bob' }), true, '共享用户看得见');

      assert.equal(canViewerManageSession('s-alice', { userId: alice.id, username: 'alice' }), true, 'owner 可以');
      assert.equal(canViewerManageSession('s-alice', { userId: bob.id, username: 'bob' }), false, '共享用户不可以');
      assert.equal(canViewerManageSession('s-alice', { userId: 999, username: 'boss' }), true, 'root 可以');
      assert.equal(canViewerManageSession('missing', { userId: 999, username: 'boss' }), false, '不存在的会话 root 也是 false');

      /**
       * 无主项目没有"负责人"这一档 → 回落到可见性(看得见就能永久删)。
       *
       * 分两种,因为无主的可见性本身是收着的:
       *   - 不在公共目录:非 root 看不见 → 也管不了(调用方那条路本来就是 404);
       *   - 在 PRISM_PUBLIC_WORKSPACE 之下:对所有人可见 → 也对所有人可删(gj 口径)。
       * 收紧成"无主也只有 root 能永久删"会误伤公共目录部署:监视器扫到新路径时
       * 就是不带 owner 地建项目行(有人在终端里直接跑 `claude`),那些会话普通用户
       * 会突然删不掉,而「清空归档」逐条跳过、界面上像点了没反应。
       */
      projectsDb.createProjectPath('/workspace/orphan');
      sessionsDb.createAppSession('s-orphan', 'claude', '/workspace/orphan');
      assert.equal(canViewerSeeSession('s-orphan', { userId: alice.id, username: 'alice' }), false, '无主且不在公共目录:看不见');
      assert.equal(canViewerManageSession('s-orphan', { userId: alice.id, username: 'alice' }), false, '看不见 → 也管不了');
      assert.equal(canViewerManageSession('s-orphan', { userId: 999, username: 'boss' }), true);

      const previousPublicWorkspace = process.env.PRISM_PUBLIC_WORKSPACE;
      process.env.PRISM_PUBLIC_WORKSPACE = '/workspace/shared';
      try {
        projectsDb.createProjectPath('/workspace/shared/scan-me');
        sessionsDb.createAppSession('s-public', 'claude', '/workspace/shared/scan-me');
        assert.equal(canViewerSeeSession('s-public', { userId: bob.id, username: 'bob' }), true, '公共目录下的无主项目:所有人可见');
        assert.equal(canViewerManageSession('s-public', { userId: bob.id, username: 'bob' }), true, '可见即可永久删(无主没有负责人这一档)');
      } finally {
        if (previousPublicWorkspace === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
        else process.env.PRISM_PUBLIC_WORKSPACE = previousPublicWorkspace;
      }

      // 没有项目路径的会话仍然只有 root —— 与 canViewerSeeSession 同口径
      sessionsDb.createAppSession('s-nopath', 'claude', '');
      assert.equal(canViewerManageSession('s-nopath', { userId: alice.id, username: 'alice' }), false, '无项目路径:非 root 不行');
      assert.equal(canViewerManageSession('s-nopath', { userId: 999, username: 'boss' }), true);
    });
  });
});
