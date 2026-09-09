import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

/**
 * workspace 时代的收藏必须能升上来。
 *
 * ## 这条钉的是**迁移顺序**
 *
 * `addProjectStarsTable` 的搬迁读 `SELECT … FROM projects WHERE isStarred = 1`,
 * 而 workspace 时代的数据在 `migrateLegacyWorkspaceTableIntoProjects` 跑完之前
 * 还躺在 `workspace_original_paths` 里。两个函数原来的调用顺序是反的 ——
 * 搬迁读到一张空表,一条都没搬。
 *
 * 更糟的是搬迁**严格一次性**(`if (existing) return`,判据是 project_stars 表存不存在),
 * 所以下次启动永不重试:老库升上来之后旧的 isStarred 列还在,但有登录用户时侧栏
 * 只认 project_stars —— 界面上**收藏全没了**,而且再也回不来。
 *
 * 实测过两种顺序:旧的 0 条、新的 2 条。
 *
 * ## 为什么需要 PRISM_ROOT_USERS
 *
 * 搬迁的两条分支是「有 owner 就给 owner」「没 owner 就给每个 root」。
 * 从 workspace 表升上来的项目 owner 一律是 NULL(那个时代还没有归属概念),
 * 所以走的是第二条 —— 没有配 root 就没有收件人,0 条是**正确行为**,不是这条要抓的 bug。
 * 因此这个用例必须设置 PRISM_ROOT_USERS,否则它会因为错误的原因变绿。
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
