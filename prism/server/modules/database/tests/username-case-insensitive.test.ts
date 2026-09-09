import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';

/**
 * 用户名必须是**大小写不敏感**的,而且这是安全属性,不是便利属性。
 *
 * ## 它挡的是什么
 *
 * `isRootUser()` 拿 `username.trim().toLowerCase()` 与 `PRISM_ROOT_USERS` 比对。
 * 只要 `users.username` 还是默认的 BINARY 排序,`Alice` 与 `alice` 就能共存 ——
 * 于是任何人(**不需要任何凭据**)注册一个大小写变体就能:绕过注册审批、当场拿到
 * JWT、并且每个请求都被判定为 root(重置任意账号密码、读全站审计日志、改项目属主)。
 *
 * 实测打穿过:`Alice` 打 `/api/admin/users` 返回 200,而正常非 root 账号是 403。
 *
 * ## 为什么钉在「列的排序规则」上而不是「注册处 lower 了没有」
 *
 * 注册只是入口之一,而且库里的口径本来就不一致:`findIdByUsername` 是大小写不敏感的,
 * 登录走的 `getUserByUsername` 是敏感的。钉某一个调用点等于钉一份会漂的判据 ——
 * 下一个新增的 `WHERE username = ?` 照样会漏。钉列,所有查询一起被覆盖。
 */

async function withIsolatedDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'username-case-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  try {
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

describe('用户名大小写不敏感', () => {
  it('users.username 的 DDL 里必须有 COLLATE NOCASE', async () => {
    await withIsolatedDatabase(() => {
      const ddl = getConnection()
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
        .get() as { sql: string };
      expect(/username[^,]*collate\s+nocase/i.test(ddl.sql)).toBe(true);
    });
  });

  it('大小写变体不能共存 —— 这就是提权的那一步', async () => {
    await withIsolatedDatabase(() => {
      userDb.createUser('alice', 'hash', 'approved');
      // 攻击者试图注册 `Alice` 来冒充 root。UNIQUE 必须挡住。
      expect(() => userDb.createUser('Alice', 'hash2', 'approved')).toThrow();
      expect(() => userDb.createUser('ALICE', 'hash3', 'approved')).toThrow();
      expect(() => userDb.createUser('aLiCe', 'hash4', 'approved')).toThrow();
    });
  });

  it('按任意大小写都能查到同一个人(登录路径)', async () => {
    await withIsolatedDatabase(() => {
      const created = userDb.createUser('alice', 'hash', 'approved');
      for (const variant of ['alice', 'Alice', 'ALICE', 'aLiCe']) {
        const found = userDb.getUserByUsername(variant);
        expect(found?.id, `按 "${variant}" 查不到`).toBe(created.id);
      }
    });
  });

  it('迁移把老库的撞车行改名而不是删掉,且保留 id 最小的那个', async () => {
    const previous = process.env.DATABASE_PATH;
    const dir = await mkdtemp(path.join(tmpdir(), 'username-legacy-'));
    const dbPath = path.join(dir, 'auth.db');
    try {
      // 造一个「被攻击过」的老库:BINARY 唯一 + alice/Alice 并存 + 一个带空格的
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_login DATETIME, is_active BOOLEAN DEFAULT 1,
          git_name TEXT, git_email TEXT, has_completed_onboarding BOOLEAN DEFAULT 0,
          token_version INTEGER NOT NULL DEFAULT 0,
          approval_status TEXT NOT NULL DEFAULT 'approved',
          approved_at DATETIME, reviewed_by INTEGER
        )
      `);
      const insert = legacy.prepare(
        'INSERT INTO users (username, password_hash, approval_status) VALUES (?, ?, ?)',
      );
      insert.run('alice', 'hash-real', 'approved');     // id 1:本人
      insert.run('Alice', 'hash-attacker', 'approved'); // id 2:冒充者
      insert.run('  bob  ', 'hash-bob', 'approved');    // id 3:带空格
      insert.run('carol', 'hash-carol', 'pending');     // id 4:审批状态要保住
      legacy.close();

      closeConnection();
      process.env.DATABASE_PATH = dbPath;
      await initializeDatabase();

      const rows = getConnection()
        .prepare('SELECT id, username, password_hash, approval_status FROM users ORDER BY id')
        .all() as Array<{ id: number; username: string; password_hash: string; approval_status: string }>;

      // 一行都不许少 —— 删账号是不可逆的,迁移不替用户做主
      expect(rows).toHaveLength(4);
      // id 最小的保留原名(最早注册的,几乎必然是本人)
      expect(rows[0]).toMatchObject({ id: 1, username: 'alice', password_hash: 'hash-real' });
      // 冒充者被改名 —— isRootUser('Alice~dup2') 为 false,提权当场失效
      expect(rows[1].username).toBe('Alice~dup2');
      expect(rows[1].password_hash).toBe('hash-attacker'); // 数据没动,root 可自行处置
      // 前后空格是同一个洞的变体,一并抹平
      expect(rows[2].username).toBe('bob');
      // 无关列不许在重建里丢
      expect(rows[3]).toMatchObject({ username: 'carol', approval_status: 'pending' });

      // 重建之后新的唯一约束确实生效
      expect(() =>
        getConnection().prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('ALICE', 'x'),
      ).toThrow();
    } finally {
      closeConnection();
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('迁移是幂等的 —— 跑第二次不重建、不改名', async () => {
    const previous = process.env.DATABASE_PATH;
    const dir = await mkdtemp(path.join(tmpdir(), 'username-idem-'));
    const dbPath = path.join(dir, 'auth.db');
    try {
      closeConnection();
      process.env.DATABASE_PATH = dbPath;
      await initializeDatabase();
      userDb.createUser('alice', 'hash', 'approved');
      closeConnection();

      await initializeDatabase();
      const rows = getConnection().prepare('SELECT username FROM users').all() as Array<{ username: string }>;
      // 第二次跑完名字原样,没有被加上 ~dup 后缀
      expect(rows.map((r) => r.username)).toEqual(['alice']);
    } finally {
      closeConnection();
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
