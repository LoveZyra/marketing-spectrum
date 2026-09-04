import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
import { pruneInternalProjects } from '@/modules/projects/services/project-prune.service.js';
import { isPrismInternalProjectPath } from '@/shared/prism-internal-transcripts.js';

/**
 * 清掉 Prism 自己跑出来的幽灵项目行。
 *
 * 忽略判据只挡住"新的进不来";项目一旦落进 `projects` 表,侧栏就直接读表,
 * 判不判都在。所以要有这一步按真实路径的清账。
 *
 * 这个功能只有一个真正的风险:**判错一个就是删掉用户真实的项目**。所以下面
 * 大半的用例是反向的 —— 一个都不许被当成幽灵。
 */
const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) { await rm(tempDir, { recursive: true, force: true }); tempDir = null; }
});

async function freshDb(): Promise<void> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'project-prune-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  await initializeDatabase();
}

describe('isPrismInternalProjectPath', () => {
  test('模型探测的临时目录 —— 认出来', () => {
    assert.equal(isPrismInternalProjectPath('/tmp/prism-model-probe-abc123'), true);
    assert.equal(isPrismInternalProjectPath('/tmp/prism_model_probe_abc123'), true);
  });

  test('**用户的真实项目一个都不许误伤**', () => {
    for (const projectPath of [
      '/home/u/work/marketing',
      '/home/u/projects/probe-notes',
      '/home/u/prism',
      '/home/u/code/model/probe',
      '',
    ]) {
      assert.equal(isPrismInternalProjectPath(projectPath), false, projectPath);
    }
  });
});

describe('pruneInternalProjects', () => {
  test('删掉幽灵行,留下真项目', async () => {
    await freshDb();
    const ghost = projectsDb.createProjectPath('/tmp/prism-model-probe-xyz', null, null)
      .project!.project_id;
    const real = projectsDb.createProjectPath('/home/u/work/marketing', null, null)
      .project!.project_id;

    const { removed } = pruneInternalProjects();

    assert.equal(removed.length, 1);
    assert.equal(projectsDb.getProjectById(ghost), null);
    assert.ok(projectsDb.getProjectById(real), '真项目被误删了');
  });

  test('没有幽灵时是空转 —— 一行都不动', async () => {
    await freshDb();
    projectsDb.createProjectPath('/home/u/work/a', null, null);
    projectsDb.createProjectPath('/home/u/work/b', null, null);

    assert.deepEqual(pruneInternalProjects().removed, []);
    assert.equal(projectsDb.listAllProjectPaths().length, 2);
  });

  test('可以反复跑(每次启动都会跑一次)', async () => {
    await freshDb();
    projectsDb.createProjectPath('/tmp/prism-model-probe-1', null, null);
    assert.equal(pruneInternalProjects().removed.length, 1);
    assert.equal(pruneInternalProjects().removed.length, 0);
  });
});
