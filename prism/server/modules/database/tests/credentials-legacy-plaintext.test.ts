import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, test } from 'vitest';

import {
  appConfigDb,
  closeConnection,
  credentialsDb,
  getConnection,
  githubTokensDb,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';
import { isEncrypted, resetEncryptionKey } from '@/shared/crypto-box.js';

/**
 * 加密上线之前写进 `user_credentials` 的明文值,启动时就地加密一次。
 *
 * 写路径只有 INSERT(新行一定是密文),没有任何地方会改写老行;不在启动时处理,
 * 库文件与备份里就一直躺着明文 token。这里钉住:只动没有 v1 信封的行、加密后读出来与原值一致、
 * 重复跑是空操作、新生成的密钥先落库再写密文(重启后照样解得开)、启动流程会跑它。
 */

const previous = { db: process.env.DATABASE_PATH, key: process.env.PRISM_ENCRYPTION_KEY };
let tempDir: string | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'credentials-legacy-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDir, 'auth.db');
  delete process.env.PRISM_ENCRYPTION_KEY;
  resetEncryptionKey();
  await initializeDatabase();
});

afterEach(async () => {
  closeConnection();
  resetEncryptionKey();
  if (previous.db === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previous.db;
  if (previous.key === undefined) delete process.env.PRISM_ENCRYPTION_KEY;
  else process.env.PRISM_ENCRYPTION_KEY = previous.key;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

/** 绕过仓库层直接写一行,模拟加密上线之前留下的明文行。 */
function insertRaw(userId: number, type: string, value: string): number {
  const result = getConnection()
    .prepare('INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value) VALUES (?, ?, ?, ?)')
    .run(userId, `${type} 老数据`, type, value);
  return Number(result.lastInsertRowid);
}

const rawValue = (id: number) => (getConnection()
  .prepare('SELECT credential_value FROM user_credentials WHERE id = ?')
  .get(id) as { credential_value: string }).credential_value;

describe('历史明文凭据的就地加密', () => {
  test('只加密没有 v1 信封的行;读出来与原值一致;再跑一次是空操作', () => {
    const userId = Number(userDb.createUser('alice', 'hash').id);
    const github = insertRaw(userId, 'github_token', 'ghp_legacyPlainToken123');
    const gitlab = insertRaw(userId, 'gitlab_token', 'glpat-legacy-plain');
    const empty = insertRaw(userId, 'bitbucket_token', '');
    const fresh = Number(credentialsDb.createCredential(userId, '新的', 'other_token', 'already-encrypted').id);
    const freshCipher = rawValue(fresh);
    assert.ok(isEncrypted(freshCipher));

    assert.equal(credentialsDb.encryptLegacyPlaintext(), 2);

    for (const id of [github, gitlab]) {
      assert.ok(isEncrypted(rawValue(id)), `第 ${id} 行还是明文`);
    }
    assert.equal(rawValue(fresh), freshCipher, '已经是密文的行不该被重写');
    assert.equal(rawValue(empty), '', '空值保持为空');

    assert.equal(credentialsDb.getActiveCredential(userId, 'github_token'), 'ghp_legacyPlainToken123');
    assert.equal(credentialsDb.getActiveCredential(userId, 'gitlab_token'), 'glpat-legacy-plain');
    assert.equal(githubTokensDb.getGithubTokenById(userId, github)?.github_token, 'ghp_legacyPlainToken123');

    const snapshot = [github, gitlab].map(rawValue);
    assert.equal(credentialsDb.encryptLegacyPlaintext(), 0);
    assert.deepEqual([github, gitlab].map(rawValue), snapshot, '第二次跑不该再动任何行');
  });

  test('库里还没有密钥时,先把新生成的密钥落库,重启后照样解得开', () => {
    const userId = Number(userDb.createUser('bob', 'hash').id);
    assert.equal(appConfigDb.get('credential_encryption_key'), null);
    insertRaw(userId, 'github_token', 'ghp_beforeAnyKey');

    assert.equal(credentialsDb.encryptLegacyPlaintext(), 1);
    assert.ok(appConfigDb.get('credential_encryption_key'), '密钥没有落库');

    resetEncryptionKey(); // 相当于重启:内存里的密钥没了,只能从库里读
    assert.equal(credentialsDb.getActiveCredential(userId, 'github_token'), 'ghp_beforeAnyKey');
  });

  test('没有明文行时不生成密钥', () => {
    const userId = Number(userDb.createUser('carol', 'hash').id);
    assert.equal(credentialsDb.encryptLegacyPlaintext(), 0);
    assert.equal(appConfigDb.get('credential_encryption_key'), null);
    assert.deepEqual(credentialsDb.getCredentials(userId), []);
  });

  test('启动流程会跑这一步:重新初始化之后明文行已是密文', async () => {
    const userId = Number(userDb.createUser('dave', 'hash').id);
    const id = insertRaw(userId, 'github_token', 'ghp_encryptedAtStartup');
    closeConnection();
    resetEncryptionKey();

    await initializeDatabase();

    assert.ok(isEncrypted(rawValue(id)));
    assert.equal(credentialsDb.getActiveCredential(userId, 'github_token'), 'ghp_encryptedAtStartup');
  });
});
