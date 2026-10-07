import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

/**
 * workspace 表里的收藏必须能迁进 project_stars。钉的是迁移顺序:
 *
 * `addProjectStarsTable` 的搬迁读 `SELECT … FROM projects WHERE isStarred = 1`,而 workspace
 * 表的数据要等 `migrateLegacyWorkspaceTableIntoProjects` 跑完才进 projects。顺序反了,
 * 搬迁就读到空表;而搬迁严格一次性(判据是 project_stars 表存不存在),下次启动不会重试,
 * 有登录用户时侧栏只认 project_stars,收藏就永久丢了。
 *
 * 必须设置 PRISM_ROOT_USERS:搬迁对有 owner 的项目给 owner、没 owner 的给每个 root,
 * 而从 workspace 表迁上来的项目 owner 一律是 NULL。没配 root 时两种顺序都是 0 条
 * (这是正确行为),用例就区分不出顺序对错。
 */
describe('workspace 时代的收藏升级', () => {
  it('迁移顺序正确时,老库的收藏会搬进 project_stars', async () => {
    const previousDb = process.env.DATABASE_PATH;
    const previousRoot = process.env.PRISM_ROOT_USERS;
    const dir = await mkdtemp(path.join(tmpdir(), 'legacy-stars-'));
    const dbPath = path.join(dir, 'auth.db');
    try {
      const legacy = new Database(dbPath);
      legacy.exec(
        'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)',
      );
      legacy.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('rootuser', 'h');
      legacy.exec(`
        CREATE TABLE workspace_original_paths (
          workspace_id TEXT,
          workspace_path TEXT PRIMARY KEY NOT NULL,
          original_path TEXT,
          custom_workspace_name TEXT,
          isStarred BOOLEAN DEFAULT 0,
          isArchived BOOLEAN DEFAULT 0
        )
      `);
      const insert = legacy.prepare(
        'INSERT INTO workspace_original_paths (workspace_id, workspace_path, original_path, custom_workspace_name, isStarred) VALUES (?, ?, ?, ?, ?)',
      );
      insert.run('w1', '/home/u/p1', '/home/u/p1', 'p1', 1);
      insert.run('w2', '/home/u/p2', '/home/u/p2', 'p2', 1);
      insert.run('w3', '/home/u/p3', '/home/u/p3', 'p3', 0);
      legacy.close();

      closeConnection();
      process.env.DATABASE_PATH = dbPath;
      process.env.PRISM_ROOT_USERS = 'rootuser';
      await initializeDatabase();

      const db = getConnection();
      // 三个工作区都搬成了项目
      expect((db.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c).toBe(3);
      // 两个收藏搬进了 project_stars。顺序反了的话这里是 0,而且永远回不来。
      expect((db.prepare('SELECT COUNT(*) AS c FROM project_stars').get() as { c: number }).c).toBe(2);
      // 收的是没收藏的那个不该进来
      const starredPaths = db
        .prepare(`
          SELECT p.project_path FROM project_stars s
          JOIN projects p ON p.project_id = s.project_id
          ORDER BY p.project_path
        `)
        .all() as Array<{ project_path: string }>;
      expect(starredPaths.map((r) => r.project_path)).toEqual(['/home/u/p1', '/home/u/p2']);
    } finally {
      closeConnection();
      if (previousDb === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previousDb;
      if (previousRoot === undefined) delete process.env.PRISM_ROOT_USERS;
      else process.env.PRISM_ROOT_USERS = previousRoot;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
