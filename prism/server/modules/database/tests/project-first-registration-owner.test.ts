import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { canViewerSeeProject } from '@/shared/project-visibility.js';

/**
 * bu 轮回归:项目**第一次落行**就必须带对 owner。
 *
 * `createProjectPath` 的 ON CONFLICT 分支按设计不改归属(复活归档路径不得改权限)。
 * 推论:谁先落行,owner 就定格在那一笔 —— 外部 Agent API 曾在 createAppSession
 * 之前先做了一次不带 owner 的预注册,导致新路径项目永远无主:非公共目录下
 * **连创建者自己都看不见**(2026-08-14 起无主≠公开,只对 root 可见)。
 *
 * 这两条用例分别钉住"正确姿势"与"污染陷阱",防止未来再冒出第二个先注册后补
 * owner 的调用点。
 */

async function withIsolatedDatabase(runTest: (tempDirectory: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousRootUsers = process.env.PRISM_ROOT_USERS;
  const previousPublicWorkspace = process.env.PRISM_PUBLIC_WORKSPACE;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-owner-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  delete process.env.PRISM_PUBLIC_WORKSPACE;
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousRootUsers === undefined) delete process.env.PRISM_ROOT_USERS;
    else process.env.PRISM_ROOT_USERS = previousRootUsers;
    if (previousPublicWorkspace === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
    else process.env.PRISM_PUBLIC_WORKSPACE = previousPublicWorkspace;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

describe('项目首次登记的归属', () => {
  test('首次登记带 owner:归属落对,创建者可见', async () => {
    await withIsolatedDatabase(async (tempDirectory) => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id) };
      const projectPath = path.join(tempDirectory, 'proj-owned');

      const result = projectsDb.createProjectPath(projectPath, null, alice.id);
      assert.equal(result.outcome, 'created');
      assert.equal(result.project?.owner_user_id, alice.id);

      assert.equal(
        canViewerSeeProject({
          ownerUserId: result.project!.owner_user_id,
          viewerUserId: alice.id,
          viewerUsername: 'alice',
          projectPath,
          visibility: result.project!.visibility,
        }),
        true,
      );
    });
  });

  test('污染陷阱:先无主预注册,后续 createAppSession 补不回 owner,创建者反而看不见', async () => {
    await withIsolatedDatabase(async (tempDirectory) => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id) };
      const projectPath = path.join(tempDirectory, 'proj-poisoned');

      // 第一笔:不带 owner(这正是 agent.js 修掉的旧行为)。
      const first = projectsDb.createProjectPath(projectPath, null);
      assert.equal(first.outcome, 'created');
      assert.equal(first.project?.owner_user_id, null);

      // 第二笔:createAppSession 内部带着 owner 再登记 —— ON CONFLICT 不改归属。
      sessionsDb.createAppSession('session-poisoned-0001', 'claude', projectPath, alice.id);

      const row = projectsDb.getProjectPath(projectPath);
      assert.equal(row?.owner_user_id, null, 'owner 应保持 NULL:ON CONFLICT 按设计不回写归属');

      // 后果:无主 + 非公共目录 = 创建者自己都看不见。
      assert.equal(
        canViewerSeeProject({
          ownerUserId: row!.owner_user_id,
          viewerUserId: alice.id,
          viewerUsername: 'alice',
          projectPath,
          visibility: row!.visibility,
        }),
        false,
      );
    });
  });
});
