import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, test } from 'vitest';

import { closeConnection, getConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';

/**
 * eu:技能训练撤掉之后,把它留在库里的东西清干净 —— **只跑一次**。
 *
 * 两件事各有各的风险,都要钉:
 *
 * 1. **误删**。清账要删 `projects` 行,判据错一点就是删掉用户真实的项目。
 *    所以下面大半用例是反向的:名字里带 skillopt 的正常项目、路径里带 work 的
 *    正常项目,一个都不许命中。
 * 2. **反复删**。无条件的 `DROP TABLE IF EXISTS` 在功能重新接回来时会把新建的
 *    表又悄悄删掉。所以做过要留标记,第二次启动必须什么都不动。
 */
const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) { await rm(tempDir, { recursive: true, force: true }); tempDir = null; }
});

/** 造一个"技能训练时代"的老库:有 skillopt_runs 表、幽灵项目、审计行。 */
async function legacyDb(): Promise<string> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'skillopt-cleanup-'));
  const databasePath = path.join(tempDir, 'auth.db');
  closeConnection();

  const seed = new Database(databasePath);
  seed.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME,
      is_active BOOLEAN DEFAULT 1
    );
    CREATE TABLE skillopt_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      skill_name TEXT NOT NULL,
      scorer TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      spec_json TEXT NOT NULL,
      out_root TEXT NOT NULL
    );
  `);
  seed.prepare(`
    INSERT INTO skillopt_runs (run_id, skill_name, scorer, status, spec_json, out_root)
    VALUES ('run_x', 'extract-terms', 'reference', 'succeeded', '{}', '/tmp/x')
  `).run();
  seed.close();

  process.env.DATABASE_PATH = databasePath;
  return databasePath;
}

const tableExists = (name: string): boolean => Boolean(
  getConnection().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),
);

describe('eu:清掉技能训练留在库里的东西', () => {
  test('删表、删幽灵项目、删审计行;真项目一个不动', async () => {
    await legacyDb();
    await initializeDatabase();

    // 迁移建好表之后再塞数据,然后手工再跑一次清账(模拟"升级上来的老库")
    getConnection().prepare('DELETE FROM app_config WHERE key = ?').run('cleanup.skillopt.v1');

    const ghostA = projectsDb.createProjectPath(
      '/home/u/.prism/skillopt/runs/r1/steps/step_0001/rollout/work/smoke-01', null, null,
    ).project!.project_id;
    const ghostB = projectsDb.createProjectPath('/tmp/skillopt_claude_2ry8_92x', null, null)
      .project!.project_id;
    const real = projectsDb.createProjectPath('/home/u/work/marketing', null, null)
      .project!.project_id;
    const alsoReal = projectsDb.createProjectPath('/home/u/projects/skillopt-notes', null, null)
      .project!.project_id;
    const workNamed = projectsDb.createProjectPath('/home/u/code/work/my-app', null, null)
      .project!.project_id;

    getConnection().prepare(
      "INSERT INTO audit_log (username, event, outcome) VALUES ('demo', 'skillopt_run_start', 'success')",
    ).run();
    getConnection().prepare(
      "INSERT INTO audit_log (username, event, outcome) VALUES ('demo', 'login', 'success')",
    ).run();

    closeConnection();
    await initializeDatabase(); // 迁移再跑一遍 → 清账执行

    assert.equal(tableExists('skillopt_runs'), false, 'skillopt_runs 应该被删掉');
    assert.equal(projectsDb.getProjectById(ghostA), null);
    assert.equal(projectsDb.getProjectById(ghostB), null);
    // 反向:这三个都是用户真实的项目
    assert.ok(projectsDb.getProjectById(real), '真项目被误删');
    assert.ok(projectsDb.getProjectById(alsoReal), '名字里带 skillopt 的项目被误删');
    assert.ok(projectsDb.getProjectById(workNamed), '路径里带 work 的项目被误删');

    const events = (getConnection().prepare('SELECT event FROM audit_log').all() as Array<{ event: string }>)
      .map((row) => row.event);
    assert.deepEqual(events, ['login'], 'skillopt 审计行该删,其余不动');
  });

  test('**只跑一次** —— 功能重新接回来时不会把新建的表又删掉', async () => {
    await legacyDb();
    await initializeDatabase();
    assert.equal(tableExists('skillopt_runs'), false);

    // 模拟"以后又把这个功能接回来了":重新建表
    getConnection().exec('CREATE TABLE skillopt_runs (id INTEGER PRIMARY KEY)');
    closeConnection();

    await initializeDatabase(); // 再启动一次
    assert.equal(tableExists('skillopt_runs'), true, '标记没生效,新表被二次删除了');
  });

  test('全新安装:没有这些东西也不该报错', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'skillopt-cleanup-fresh-'));
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
    await initializeDatabase();
    assert.equal(tableExists('skillopt_runs'), false);
    assert.ok(tableExists('projects'));
  });
});
