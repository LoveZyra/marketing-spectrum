import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, test } from 'vitest';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { REQUIRED_COLUMNS, findMissingColumns } from '@/modules/database/migrations.js';

/**
 * **2026-09-15 生产事故的回归测试。**
 *
 * `rebuildUsersTableWithCaseInsensitiveUsername` 是 DROP + 按**写死的列清单**重建。
 * `attachment_quota_mb` 是后来由迁移加的列,加的人没回头补那份清单 —— 而那批
 * `addColumn` 又跑在重建**之前**。于是生产首启时:先加上、再被重建连列带数据抹掉,
 * 「账号管理」页当场 500(`no such column: u.attachment_quota_mb`),
 * 每人的附件配额覆盖值一起没了。
 *
 * 测试环境永远复现不了:重建开头有守卫,`username` 已经是 COLLATE NOCASE 就直接返回,
 * 而测试库早就是 NOCASE。**只有从"老形状"升上来的库才会跑那段** —— 所以这里必须
 * 手工造一张 BINARY username 的老库。
 */

/** 老形状:username 是默认的 BINARY 排序,且已经有 attachment_quota_mb 和值。 */
const LEGACY_USERS_DDL = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME,
  is_active BOOLEAN DEFAULT 1,
  git_name TEXT,
  git_email TEXT,
  has_completed_onboarding BOOLEAN DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  approval_status TEXT NOT NULL DEFAULT 'approved',
  approved_at DATETIME,
  reviewed_by INTEGER,
  attachment_quota_mb INTEGER
);
`;

async function withLegacyDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'users-rebuild-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();

  const seedDb = new Database(databasePath);
  seedDb.exec(LEGACY_USERS_DDL);
  seedDb.prepare(
    'INSERT INTO users (username, password_hash, attachment_quota_mb) VALUES (?, ?, ?)'
  ).run('tianji.chang', 'hash-1', 4096);
  seedDb.prepare(
    'INSERT INTO users (username, password_hash, attachment_quota_mb) VALUES (?, ?, ?)'
  ).run('jinbao', 'hash-2', null);
  seedDb.close();

  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const userColumns = (): string[] =>
  (getConnection().prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>)
    .map((column) => column.name);

describe('users 表重建:列与数据都不许丢', () => {
  test('老库(BINARY username)跑完迁移:重建确实发生了', async () => {
    await withLegacyDatabase(() => {
      const ddl = (getConnection()
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
        .get() as { sql?: string } | undefined)?.sql ?? '';
      // 这一条是前提:重建没跑的话,下面两条测的就不是这次的病
      assert.match(ddl, /username[^,]*COLLATE\s+NOCASE/i, '重建应当发生过');
    });
  });

  test('**关键**:attachment_quota_mb 这一列还在', async () => {
    await withLegacyDatabase(() => {
      assert.ok(
        userColumns().includes('attachment_quota_mb'),
        '重建把这一列吞了 —— 账号管理页会 500'
      );
    });
  });

  test('**关键**:每人的配额覆盖值也还在', async () => {
    await withLegacyDatabase(() => {
      const row = getConnection()
        .prepare('SELECT attachment_quota_mb FROM users WHERE username = ?')
        .get('tianji.chang') as { attachment_quota_mb: number | null } | undefined;
      assert.equal(row?.attachment_quota_mb, 4096, '配额覆盖值被重建抹掉了');
      const none = getConnection()
        .prepare('SELECT attachment_quota_mb FROM users WHERE username = ?')
        .get('jinbao') as { attachment_quota_mb: number | null } | undefined;
      assert.equal(none?.attachment_quota_mb, null, 'NULL(跟随全局)应当原样保留');
    });
  });

  test('REQUIRED_COLUMNS 声明的列,迁移之后一个不少', async () => {
    await withLegacyDatabase(() => {
      assert.deepEqual(findMissingColumns(getConnection()), {}, '有表缺列');
      for (const name of REQUIRED_COLUMNS.users) {
        assert.ok(userColumns().includes(name), `users 缺列:${name}`);
      }
    });
  });

  test('守卫本身认得出缺列(直接喂一张缺列的表)', async () => {
    // 不依赖迁移:手工造一张少了那一列的 users,验证 findMissingColumns 真的报得出来。
    // 这是第三层防线自己的单测 —— 前两层都失守时,它是最后一个开口说话的。
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'missing-col-'));
    const db = new Database(path.join(tempDirectory, 'probe.db'));
    try {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          created_at DATETIME, last_login DATETIME, is_active BOOLEAN,
          git_name TEXT, git_email TEXT, has_completed_onboarding BOOLEAN,
          token_version INTEGER, approval_status TEXT, approved_at DATETIME,
          reviewed_by INTEGER
        );
      `);
      assert.deepEqual(findMissingColumns(db), { users: ['attachment_quota_mb'] });
    } finally {
      db.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test('REQUIRED_COLUMNS 与重建函数那份写死的清单必须一致', async () => {
    // 源码断言:两份清单分居两处,只改一处就是这次事故的复刻
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, '..', 'migrations.ts'), 'utf8');
    const ddl = source.slice(
      source.indexOf('CREATE TABLE users__new'),
      source.indexOf('INSERT INTO users__new')
    );
    for (const name of REQUIRED_COLUMNS.users) {
      assert.ok(
        new RegExp(`\\b${name}\\b`).test(ddl),
        `重建的 CREATE TABLE users__new 里没有 ${name} —— 它会在重建时被吞掉`
      );
    }
    const insert = source.slice(
      source.indexOf('INSERT INTO users__new'),
      source.indexOf('FROM users\n', source.indexOf('INSERT INTO users__new'))
    );
    for (const name of REQUIRED_COLUMNS.users) {
      if (name === 'id' || name === 'username' || name === 'password_hash') continue;
      assert.ok(
        new RegExp(`\\b${name}\\b`).test(insert),
        `重建的 INSERT … SELECT 里没有搬 ${name} —— 列在但数据丢`
      );
    }
  });
});
