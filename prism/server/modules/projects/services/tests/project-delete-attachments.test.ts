import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, test } from 'vitest';

import {
  attachmentsDb,
  closeConnection,
  initializeDatabase,
  projectsDb,
  userDb,
} from '@/modules/database/index.js';
import { ATTACHMENT_DIR_NAME } from '@/shared/attachment-storage.js';

import { deleteOrArchiveProject } from '../project-delete.service.js';

/**
 * B10 回归:force 删项目要清掉它的 attachments 目录 + 台账行。
 *
 * 修前:删项目只清 sessions/transcripts/项目行,附件行继续按用户计配额,只能
 * 等 30 天 TTL —— 而那时目录可能已随项目消失,徒留僵尸配额行。
 */

async function withDb(runTest: (tempDir: string) => Promise<void>): Promise<void> {
  const prevDb = process.env.DATABASE_PATH;
  const prevRoot = process.env.PRISM_ROOT_USERS;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'proj-del-att-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  process.env.PRISM_ROOT_USERS = 'boss';
  await initializeDatabase();
  try {
    await runTest(tempDir);
  } finally {
    closeConnection();
    if (prevDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prevDb;
    if (prevRoot === undefined) delete process.env.PRISM_ROOT_USERS; else process.env.PRISM_ROOT_USERS = prevRoot;
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe('force 删项目清附件', () => {
  test('删项目 → attachments 目录被删、台账行清零、配额释放', async () => {
    await withDb(async (tempDir) => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id) };
      const projectPath = path.join(tempDir, 'proj-a');
      const attachmentsDir = path.join(projectPath, ATTACHMENT_DIR_NAME);
      await mkdir(attachmentsDir, { recursive: true });

      const fileA = path.join(attachmentsDir, 'a.bin');
      const fileB = path.join(attachmentsDir, 'b.bin');
      await writeFile(fileA, Buffer.alloc(1000));
      await writeFile(fileB, Buffer.alloc(2000));

      const reg = projectsDb.createProjectPath(projectPath, null, alice.id);
      const projectId = reg.project!.project_id;

      attachmentsDb.record({ userId: alice.id, sessionId: null, projectPath, kind: 'file', absPath: fileA, bytes: 1000 });
      attachmentsDb.record({ userId: alice.id, sessionId: null, projectPath, kind: 'file', absPath: fileB, bytes: 2000 });
      assert.equal(attachmentsDb.totalBytesForUser(alice.id), 3000, '前置:配额应计入两份附件');

      await deleteOrArchiveProject(projectId, true);

      assert.equal(await exists(attachmentsDir), false, 'attachments 目录应被删除');
      assert.equal(attachmentsDb.totalBytesForUser(alice.id), 0, '台账行应清零,配额释放');
      assert.equal(projectsDb.getProjectById(projectId), null, '项目行应删除');
    });
  });

  test('软删(archive)不动附件', async () => {
    await withDb(async (tempDir) => {
      const alice = { id: Number(userDb.createUser('alice', 'hash').id) };
      const projectPath = path.join(tempDir, 'proj-b');
      const attachmentsDir = path.join(projectPath, ATTACHMENT_DIR_NAME);
      await mkdir(attachmentsDir, { recursive: true });
      const file = path.join(attachmentsDir, 'keep.bin');
      await writeFile(file, Buffer.alloc(500));

      const reg = projectsDb.createProjectPath(projectPath, null, alice.id);
      attachmentsDb.record({ userId: alice.id, sessionId: null, projectPath, kind: 'file', absPath: file, bytes: 500 });

      await deleteOrArchiveProject(reg.project!.project_id, false);

      assert.equal(await exists(file), true, '软删不该动附件文件');
      assert.equal(attachmentsDb.totalBytesForUser(alice.id), 500, '软删不该动台账');
    });
  });
});
