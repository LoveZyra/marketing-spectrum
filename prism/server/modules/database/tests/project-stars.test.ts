import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, test } from 'vitest';

import { closeConnection, initializeDatabase, projectsDb, userDb } from '@/modules/database/index.js';

/**
 * 收藏按用户隔离(project_stars)的真库测试:
 * 1. A 的收藏不影响 B 和 root 的视角(修的就是"谁收藏全员变星"这个 bug);
 * 2. 迁移把旧全局 isStarred 归给 owner,无主的归给 root 账号。
 */

const previousDatabasePath = process.env.DATABASE_PATH;
const previousRoot = process.env.PRISM_ROOT_USERS;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousRoot === undefined) delete process.env.PRISM_ROOT_USERS;
  else process.env.PRISM_ROOT_USERS = previousRoot;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function freshDb(): Promise<string> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'project-stars-'));
  closeConnection();
  const dbPath = path.join(tempDir, 'auth.db');
  process.env.DATABASE_PATH = dbPath;
  await initializeDatabase();
  return dbPath;
}

describe('project_stars 按用户隔离', () => {
  test('一人收藏不再全员变星:A 收藏后 B 与其他人的集合仍为空', async () => {
    delete process.env.PRISM_ROOT_USERS;
    await freshDb();

    const alice = Number(userDb.createUser('alice', 'h').id);
    const bob = Number(userDb.createUser('bob', 'h').id);
    const created = projectsDb.createProjectPath('/workspace/team/app', null, alice);
    const projectId = created.project!.project_id;

    projectsDb.setProjectStarForUser(projectId, alice, true);

    assert.deepEqual(projectsDb.getStarredProjectIdsForUser(alice), [projectId]);
    assert.deepEqual(projectsDb.getStarredProjectIdsForUser(bob), []);
    assert.equal(projectsDb.isProjectStarredByUser(projectId, alice), true);
    assert.equal(projectsDb.isProjectStarredByUser(projectId, bob), false);

    // 取消只删自己的行,幂等
    projectsDb.setProjectStarForUser(projectId, alice, false);
    projectsDb.setProjectStarForUser(projectId, alice, false);
    assert.deepEqual(projectsDb.getStarredProjectIdsForUser(alice), []);
  });

  test('迁移搬旧账:有主的旧收藏归 owner,无主的归 root 账号', async () => {
    process.env.PRISM_ROOT_USERS = 'admin';
    const dbPath = await freshDb();

    const admin = Number(userDb.createUser('admin', 'h').id);
    const alice = Number(userDb.createUser('alice', 'h').id);

    const owned = projectsDb.createProjectPath('/workspace/alice/app', null, alice).project!;
    const orphan = projectsDb.createProjectPath('/workspace/orphan/x', null, null).project!;
    const plain = projectsDb.createProjectPath('/workspace/alice/other', null, alice).project!;

    // 布置旧世界:全局列标星,再把新表删掉,模拟"老库第一次升级"。
    projectsDb.updateProjectIsStarredById(owned.project_id, true);
    projectsDb.updateProjectIsStarredById(orphan.project_id, true);
    closeConnection();
    const raw = new Database(dbPath);
    raw.exec('DROP TABLE project_stars');
    raw.close();

    await initializeDatabase(); // 重跑迁移 → 建表 + 搬迁

    assert.deepEqual(projectsDb.getStarredProjectIdsForUser(alice).sort(), [owned.project_id]);
    assert.deepEqual(projectsDb.getStarredProjectIdsForUser(admin).sort(), [orphan.project_id]);
    assert.equal(projectsDb.isProjectStarredByUser(plain.project_id, alice), false);

    // 迁移只跑一次:再重启不重复搬,取消后的状态不会被旧列"复活"。
    projectsDb.setProjectStarForUser(owned.project_id, alice, false);
    closeConnection();
    await initializeDatabase();
    assert.equal(projectsDb.isProjectStarredByUser(owned.project_id, alice), false);
  });
});
