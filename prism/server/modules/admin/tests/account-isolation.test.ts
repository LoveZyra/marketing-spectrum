import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

import {
  appConfigDb,
  closeConnection,
  initializeDatabase,
  projectsDb,
  userDb,
} from '@/modules/database/index.js';

import { backfillProjectOwners } from '../project-owner-backfill.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'account-isolation-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

describe('项目归属与可见性', () => {
  test('未指定 owner 的项目默认不再公开:不在公共目录下时对非 root 不可见', async () => {
    // 2026-08-14 口径变更:无主 ≠ 公开。没配公共目录时,无主项目对普通用户
    // 一个都不出现(只有 root 的不过滤视图看得到)。
    const previousPublic = process.env.PRISM_PUBLIC_WORKSPACE;
    delete process.env.PRISM_PUBLIC_WORKSPACE;
    try {
      await withIsolatedDatabase(() => {
        const alice = userDb.createUser('alice', 'hash');
        projectsDb.createProjectPath('/workspace/shared'); // 无主

        const visibleToAlice = projectsDb.getProjectPaths(Number(alice.id));
        assert.equal(visibleToAlice.length, 0);
        // root 的不过滤视图仍然看得到
        assert.equal(projectsDb.getProjectPaths(null).length, 1);
      });
    } finally {
      if (previousPublic === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
      else process.env.PRISM_PUBLIC_WORKSPACE = previousPublic;
    }
  });

  test('列表按 owner 过滤:自己的 + 公共目录下的无主项目可见,别人的和目录外无主项目不可见', async () => {
    const previousPublic = process.env.PRISM_PUBLIC_WORKSPACE;
    process.env.PRISM_PUBLIC_WORKSPACE = '/workspace/public';
    try {
      await withIsolatedDatabase(() => {
        const alice = Number(userDb.createUser('alice', 'hash').id);
        const bob = Number(userDb.createUser('bob', 'hash').id);

        projectsDb.createProjectPath('/workspace/alice-only', null, alice);
        projectsDb.createProjectPath('/workspace/bob-only', null, bob);
        projectsDb.createProjectPath('/workspace/public/shared'); // 无主 + 公共目录下
        projectsDb.createProjectPath('/workspace/orphan');        // 无主 + 目录外

        const alicePaths = projectsDb.getProjectPaths(alice).map((row) => row.project_path).sort();
        assert.deepEqual(alicePaths, ['/workspace/alice-only', '/workspace/public/shared']);

        // null = 不过滤,这是 root 拿到的视图 —— 四个都在
        assert.equal(projectsDb.getProjectPaths(null).length, 4);
      });
    } finally {
      if (previousPublic === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
      else process.env.PRISM_PUBLIC_WORKSPACE = previousPublic;
    }
  });

  test('重新注册一个已归档项目不会改变它的归属', async () => {
    await withIsolatedDatabase(() => {
      const alice = Number(userDb.createUser('alice', 'hash').id);
      const created = projectsDb.createProjectPath('/workspace/p', null, alice);
      projectsDb.updateProjectIsArchivedById(created.project!.project_id, true);

      // 会话监听器重新发现这个路径时不带 owner —— 不能因此把项目变成公共的
      projectsDb.createProjectPath('/workspace/p');

      assert.equal(projectsDb.getProjectOwner(created.project!.project_id), alice);
    });
  });

  test('setProjectOwner 传 null 把项目变成公共', async () => {
    await withIsolatedDatabase(() => {
      const alice = Number(userDb.createUser('alice', 'hash').id);
      const created = projectsDb.createProjectPath('/workspace/p', null, alice);
      const projectId = created.project!.project_id;

      assert.equal(projectsDb.setProjectOwner(projectId, null), true);
      assert.equal(projectsDb.getProjectOwner(projectId), null);
      assert.equal(projectsDb.setProjectOwner('no-such-project', null), false);
    });
  });
});

describe('存量项目回填给 root', () => {
  test('root 账号还没注册时什么都不做,也不写标记 —— 下次启动再试', async () => {
    await withIsolatedDatabase(() => {
      projectsDb.createProjectPath('/workspace/legacy');

      const outcome = backfillProjectOwners({ PRISM_ROOT_USERS: 'tianji.chang' } as NodeJS.ProcessEnv);

      assert.equal(outcome.status, 'no_root_account');
      assert.equal(appConfigDb.get('projects_owner_backfilled'), null);
    });
  });

  test('root 存在时把所有无主项目收归 root,并且只跑一次', async () => {
    await withIsolatedDatabase(() => {
      const root = Number(userDb.createUser('Tianji.Chang', 'hash').id);
      projectsDb.createProjectPath('/workspace/legacy-a');
      projectsDb.createProjectPath('/workspace/legacy-b');

      const env = { PRISM_ROOT_USERS: 'tianji.chang' } as NodeJS.ProcessEnv;
      const first = backfillProjectOwners(env);
      assert.equal(first.status, 'backfilled');
      assert.equal(first.status === 'backfilled' && first.projectsAssigned, 2);
      assert.equal(projectsDb.getProjectPaths(root).length, 2);

      // root 之后把一个项目设成公共 —— 重启不能把它抢回去
      const target = projectsDb.getProjectPaths(null)[0];
      projectsDb.setProjectOwner(target.project_id, null);

      assert.equal(backfillProjectOwners(env).status, 'already_done');
      assert.equal(projectsDb.getProjectOwner(target.project_id), null);
    });
  });
});

describe('注册审批状态', () => {
  test('新账号可以直接建成 pending,存量账号默认 approved', async () => {
    await withIsolatedDatabase(() => {
      const existing = Number(userDb.createUser('alice', 'hash').id);
      const pending = Number(userDb.createUser('bob', 'hash', 'pending').id);

      assert.equal(userDb.getApprovalStatus(existing), 'approved');
      assert.equal(userDb.getApprovalStatus(pending), 'pending');
    });
  });

  test('审批留痕:通过时记审批人与时间,驳回时清掉通过时间', async () => {
    await withIsolatedDatabase(() => {
      const root = Number(userDb.createUser('tianji.chang', 'hash').id);
      const bob = Number(userDb.createUser('bob', 'hash', 'pending').id);

      assert.equal(userDb.setApprovalStatus(bob, 'approved', root), true);
      let row = userDb.listUsersForAdmin().find((u) => u.id === bob)!;
      assert.equal(row.approval_status, 'approved');
      assert.equal(row.reviewed_by, root);
      assert.equal(row.reviewed_by_username, 'tianji.chang');
      assert.ok(row.approved_at);

      assert.equal(userDb.setApprovalStatus(bob, 'rejected', root), true);
      row = userDb.listUsersForAdmin().find((u) => u.id === bob)!;
      assert.equal(row.approval_status, 'rejected');
      assert.equal(row.approved_at, null);

      assert.equal(userDb.setApprovalStatus(999_999, 'approved', root), false);
    });
  });

  test('待审账号排在列表最前面 —— 审批面板要先看到它们', async () => {
    await withIsolatedDatabase(() => {
      userDb.createUser('alice', 'hash');
      userDb.createUser('bob', 'hash', 'pending');
      userDb.createUser('carol', 'hash');

      assert.equal(userDb.listUsersForAdmin()[0].username, 'bob');
    });
  });
});
