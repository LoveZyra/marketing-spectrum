import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, test } from 'vitest';

import { closeConnection, getConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { REQUIRED_COLUMNS, findMissingColumns } from '@/modules/database/migrations.js';

/**
 * 缺列的老库:`model_catalog` 没有 `gateway_id` / `allowed_users`,`model_gateways` /
 * `gateway_user_keys` / `user_models` 三张表不存在。迁移要把两列补上(已有条目 = 网关 0、
 * 所有人)、建出三张表与它们的唯一索引,列清单自检不报缺。
 */

const previousDatabasePath = process.env.DATABASE_PATH;
let tempDir: string | null = null;

afterEach(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

/** 加上网关相关两列之前的 model_catalog,用来测旧库升级。 */
const HN_MODEL_CATALOG_DDL = `
CREATE TABLE model_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    vendor TEXT,
    description TEXT,
    context_window INTEGER,
    effort_levels TEXT,
    effort_default TEXT,
    recommended INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    last_probe TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER
);
`;

async function legacyDatabase(): Promise<string> {
  tempDir = await mkdtemp(path.join(tmpdir(), 'hq-migration-'));
  closeConnection();
  const databasePath = path.join(tempDir, 'auth.db');
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
  `);
  seed.exec(HN_MODEL_CATALOG_DDL);
  seed.prepare(`INSERT INTO model_catalog (model_id, label, effort_levels, recommended, sort_order, enabled, is_default)
    VALUES ('glm-5.2', 'GLM', '["high"]', 1, 10, 1, 1)`).run();
  seed.close();
  process.env.DATABASE_PATH = databasePath;
  return databasePath;
}

const columnsOf = (table: string) => (getConnection().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const indexes = (table: string) => getConnection().prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
const indexColumns = (index: string) => (getConnection().prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('网关与 key 的迁移', () => {
  test('老 model_catalog 补上 gateway_id / allowed_users;老条目 = 网关 0、所有人;三张新表与唯一索引建好', async () => {
    await legacyDatabase();
    await initializeDatabase();

    const catalogColumns = columnsOf('model_catalog');
    assert.ok(catalogColumns.includes('gateway_id'));
    assert.ok(catalogColumns.includes('allowed_users'));
    const row = getConnection().prepare('SELECT model_id, gateway_id, allowed_users, is_default FROM model_catalog').get();
    assert.deepEqual(row, { model_id: 'glm-5.2', gateway_id: null, allowed_users: null, is_default: 1 });
    // (服务层把 NULL 读成「网关 0、所有人」—— 见 server/tests/model-visibility.test.ts)

    const missing = findMissingColumns(getConnection());
    for (const table of ['model_catalog', 'model_gateways', 'gateway_user_keys', 'user_models']) {
      assert.equal(missing[table], undefined, `${table} 缺列 ${missing[table]}`);
      assert.deepEqual(columnsOf(table).sort(), [...REQUIRED_COLUMNS[table]].sort(), `${table} 的列与 REQUIRED_COLUMNS 不一致`);
    }

    const keyIndex = indexes('gateway_user_keys').find((index) => index.name === 'idx_gateway_user_keys_unique');
    assert.equal(keyIndex?.unique, 1);
    assert.deepEqual(indexColumns('idx_gateway_user_keys_unique'), ['gateway_id', 'user_id']);
    const modelIndex = indexes('user_models').find((index) => index.name === 'idx_user_models_unique');
    assert.equal(modelIndex?.unique, 1);
    assert.deepEqual(indexColumns('idx_user_models_unique'), ['user_id', 'model_id']);
    assert.ok(indexes('model_gateways').some((index) => index.name === 'idx_model_gateways_owner'));
    assert.ok(indexes('gateway_user_keys').some((index) => index.name === 'idx_gateway_user_keys_user'));

    // 唯一索引真的拦得住
    const userId = Number(userDb.createUser('alice', 'hash').id);
    const insertKey = getConnection().prepare('INSERT INTO gateway_user_keys (gateway_id, user_id, key_enc) VALUES (?, ?, ?)');
    insertKey.run(0, userId, 'v1:a:b:c');
    assert.throws(() => insertKey.run(0, userId, 'v1:d:e:f'), /UNIQUE/);
    const insertModel = getConnection().prepare('INSERT INTO user_models (user_id, gateway_id, model_id, label) VALUES (?, ?, ?, ?)');
    insertModel.run(userId, 1, 'm', 'm');
    assert.throws(() => insertModel.run(userId, 2, 'm', 'm'), /UNIQUE/);
  });

  test('迁移可重入:再跑一遍不报错、不丢数据', async () => {
    await legacyDatabase();
    await initializeDatabase();
    getConnection().prepare('UPDATE model_catalog SET gateway_id = 3, allowed_users = ? WHERE model_id = ?').run('[1,2]', 'glm-5.2');
    closeConnection();
    await initializeDatabase();
    const row = getConnection().prepare('SELECT gateway_id, allowed_users FROM model_catalog WHERE model_id = ?').get('glm-5.2');
    assert.deepEqual(row, { gateway_id: 3, allowed_users: '[1,2]' });
    assert.deepEqual(findMissingColumns(getConnection()), {});
  });

  test('新库:建表即带全部列(与 REQUIRED_COLUMNS 逐列一致)', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'hq-migration-new-'));
    closeConnection();
    process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
    await initializeDatabase();
    for (const table of ['model_catalog', 'model_gateways', 'gateway_user_keys', 'user_models']) {
      assert.deepEqual(columnsOf(table).sort(), [...REQUIRED_COLUMNS[table]].sort(), table);
    }
  });
});
