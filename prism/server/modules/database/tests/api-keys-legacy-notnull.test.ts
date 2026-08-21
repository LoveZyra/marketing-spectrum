import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, test } from 'vitest';

import { apiKeysDb, closeConnection, getConnection, initializeDatabase, userDb } from '@/modules/database/index.js';

/**
 * 老库里的 `api_keys.api_key` 是 `NOT NULL`,而新代码往那一列写 NULL ——
 * **新建 API 密钥永远失败**,报 `NOT NULL constraint failed: api_keys.api_key`。
 *
 * 全新安装撞不到(建表就是新形状),所以它只在升级上来的库上出现;
 * 而且**一把密钥都没建过的库最隐蔽** —— 那段哈希迁移只 UPDATE
 * `api_key IS NOT NULL` 的行,一行都没有就什么也没做,约束原样留着。
 *
 * 这两条用例先按上游最初的形状造一张老表,再跑迁移,验证约束真的松掉了、
 * 而且既有密钥没丢。
 */

const LEGACY_API_KEYS_DDL = `
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key_name TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used DATETIME,
  is_active BOOLEAN DEFAULT 1
);
`;

async function withLegacyDatabase(
  seed: (db: Database.Database) => void,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'api-keys-legacy-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();

  // 先手工造一张「老形状」的库,再交给 initializeDatabase 走迁移。
  const seedDb = new Database(databasePath);
  seedDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME,
      is_active BOOLEAN DEFAULT 1
    );
  `);
  seedDb.exec(LEGACY_API_KEYS_DDL);
  seed(seedDb);
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

const apiKeyIsNullable = () => {
  const column = (getConnection().prepare('PRAGMA table_info(api_keys)').all() as Array<{
    name: string;
    notnull: number;
  }>).find((c) => c.name === 'api_key');
  return column ? Number(column.notnull) === 0 : false;
};

describe('老库的 api_keys.api_key NOT NULL', () => {
  test('一把密钥都没有的老库:约束被松掉,新建能成功', async () => {
    await withLegacyDatabase(() => { /* 一行都不塞 —— 最隐蔽的那种 */ }, () => {
      assert.equal(apiKeyIsNullable(), true, '迁移后这一列必须可空');

      const user = userDb.createUser('root', 'hash');
      const created = apiKeysDb.createApiKey(Number(user.id), 'test');
      assert.ok(created.apiKey.startsWith('ck_'));
      assert.equal(apiKeysDb.getApiKeys(Number(user.id)).length, 1);

      // 建第二把:两行的 api_key 都是 NULL,不能被 UNIQUE 判成重复。
      apiKeysDb.createApiKey(Number(user.id), 'second');
      assert.equal(apiKeysDb.getApiKeys(Number(user.id)).length, 2);
    });
  });

  test('已有明文密钥的老库:密钥不丢,而且仍然能用来鉴权', async () => {
    await withLegacyDatabase((db) => {
      db.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)').run('root', 'hash');
      db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (1, ?, ?)')
        .run('old-key', 'ck_legacyplaintextvalue');
    }, () => {
      assert.equal(apiKeyIsNullable(), true);

      const keys = apiKeysDb.getApiKeys(1);
      assert.equal(keys.length, 1);
      assert.equal(keys[0].key_name, 'old-key');

      // 明文被哈希收走了,但那把 key 本身照旧能鉴权 —— 用户不用重发。
      const validated = apiKeysDb.validateApiKey('ck_legacyplaintextvalue');
      assert.equal(validated?.username, 'root');

      // 老库修好之后照样能建新的。
      apiKeysDb.createApiKey(1, 'new-key');
      assert.equal(apiKeysDb.getApiKeys(1).length, 2);
    });
  });
});
