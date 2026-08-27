import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  resolveVisibleProjectRoot,
  userDb,
} from '@/modules/database/index.js';

/**
 * G1:`resolveVisibleProjectRoot` 的契约。
 *
 * 这个函数是**所有按 projectId 寻址的路由**的第一道门(文件读写、上传、预览、
 * 全局搜索……):它同时做归属校验与路径解析,返回 null 就是 404。
 *
 * 它此前没有直接测试 —— 而它一旦对不该看见的项目返回了路径,后面每一条路由都
 * 会照着那个路径去读写文件。这里钉的是"谁能拿到路径"这条判据本身。
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
  tempDir = await mkdtemp(path.join(tmpdir(), 'project-access-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
}

const viewerOf = (id: number, username: string) => ({ userId: id, username });

describe('resolveVisibleProjectRoot', () => {
  test('自己的项目拿得到路径;别人的私有项目拿到 null', async () => {
    delete process.env.PRISM_PUBLIC_WORKSPACE;
    process.env.PRISM_ROOT_USERS = 'boss';
    await freshDb();

    const alice = Number(userDb.createUser('alice', 'h').id);
    const bob = Number(userDb.createUser('bob', 'h').id);
    const created = projectsDb.createProjectPath('/workspace/alice/app', null, alice);
    const projectId = created.project!.project_id;

    assert.equal(resolveVisibleProjectRoot(viewerOf(alice, 'alice'), projectId), '/workspace/alice/app');
    assert.equal(resolveVisibleProjectRoot(viewerOf(bob, 'bob'), projectId), null);
  });

  test('root 拿得到任何项目 —— 但 root 身份来自 PRISM_ROOT_USERS,不是 id', async () => {
    delete process.env.PRISM_PUBLIC_WORKSPACE;
    process.env.PRISM_ROOT_USERS = 'boss';
    await freshDb();

    const alice = Number(userDb.createUser('alice', 'h').id);
    const boss = Number(userDb.createUser('boss', 'h').id);
    const projectId = projectsDb.createProjectPath('/workspace/alice/app', null, alice).project!.project_id;

    assert.equal(resolveVisibleProjectRoot(viewerOf(boss, 'boss'), projectId), '/workspace/alice/app');
    // 同一个人换个名字就不是 root 了 —— 判据是用户名,不是 id
    assert.equal(resolveVisibleProjectRoot(viewerOf(boss, 'not-boss'), projectId), null);
  });

  test('被指定授权的用户拿得到;撤销后立刻拿不到', async () => {
    delete process.env.PRISM_PUBLIC_WORKSPACE;
    delete process.env.PRISM_ROOT_USERS;
    await freshDb();

    const alice = Number(userDb.createUser('alice', 'h').id);
    const bob = Number(userDb.createUser('bob', 'h').id);
    const projectId = projectsDb.createProjectPath('/workspace/alice/app', null, alice).project!.project_id;

    assert.equal(resolveVisibleProjectRoot(viewerOf(bob, 'bob'), projectId), null);
    projectsDb.setProjectShares(projectId, [bob], alice);
    assert.equal(resolveVisibleProjectRoot(viewerOf(bob, 'bob'), projectId), '/workspace/alice/app');
    projectsDb.setProjectShares(projectId, [], alice);
    assert.equal(resolveVisibleProjectRoot(viewerOf(bob, 'bob'), projectId), null);
  });

  test('显式公共项目对所有人可见', async () => {
    delete process.env.PRISM_PUBLIC_WORKSPACE;
    delete process.env.PRISM_ROOT_USERS;
    await freshDb();

    const alice = Number(userDb.createUser('alice', 'h').id);
    const bob = Number(userDb.createUser('bob', 'h').id);
    const projectId = projectsDb.createProjectPath('/workspace/open', null, alice, 'public').project!.project_id;

    assert.equal(resolveVisibleProjectRoot(viewerOf(bob, 'bob'), projectId), '/workspace/open');
  });

  test('无主项目:在公共目录下才可见,不在就只有 root', async () => {
    const publicRoot = path.resolve('/workspace/public');
    process.env.PRISM_PUBLIC_WORKSPACE = publicRoot;
    process.env.PRISM_ROOT_USERS = 'boss';
    await freshDb();

    const alice = Number(userDb.createUser('alice', 'h').id);
    const boss = Number(userDb.createUser('boss', 'h').id);
    const inside = projectsDb.createProjectPath(path.join(publicRoot, 'shared'), null, null).project!.project_id;
    const outside = projectsDb.createProjectPath('/workspace/orphan', null, null).project!.project_id;

    assert.equal(resolveVisibleProjectRoot(viewerOf(alice, 'alice'), inside), path.join(publicRoot, 'shared'));
    assert.equal(resolveVisibleProjectRoot(viewerOf(alice, 'alice'), outside), null);
    assert.equal(resolveVisibleProjectRoot(viewerOf(boss, 'boss'), outside), '/workspace/orphan');
  });

  test('不存在的 / 空的 projectId 一律 null,不抛异常', async () => {
    await freshDb();
    const alice = Number(userDb.createUser('alice', 'h').id);

    assert.equal(resolveVisibleProjectRoot(viewerOf(alice, 'alice'), ''), null);
    assert.equal(resolveVisibleProjectRoot(viewerOf(alice, 'alice'), 'no-such-id'), null);
    // 路径穿越形状的 id 也只是"查不到",不该让调用方拿到任何路径
    assert.equal(resolveVisibleProjectRoot(viewerOf(alice, 'alice'), '../../etc'), null);
  });

  test('拿不到身份的访问者(平台模式缺 req.user)只看得到显式公共的', async () => {
    delete process.env.PRISM_PUBLIC_WORKSPACE;
    delete process.env.PRISM_ROOT_USERS;
    await freshDb();

    const alice = Number(userDb.createUser('alice', 'h').id);
    const priv = projectsDb.createProjectPath('/workspace/alice/app', null, alice).project!.project_id;
    const open = projectsDb.createProjectPath('/workspace/open', null, alice, 'public').project!.project_id;

    assert.equal(resolveVisibleProjectRoot({ userId: null, username: null }, priv), null);
    assert.equal(resolveVisibleProjectRoot({ userId: null, username: null }, open), '/workspace/open');
  });
});
