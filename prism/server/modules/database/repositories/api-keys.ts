/**
 * API keys repository.
 *
 * Manages API keys used for external/programmatic access to the backend.
 * Keys are prefixed with `ck_` and tied to a user via foreign key.
 *
 * Keys are stored as SHA-256 hashes, never in plaintext: the full key is
 * returned exactly once, at creation. Everything afterwards — listing,
 * validation, revocation — works off the hash plus a short display prefix.
 * A leaked database therefore yields no usable credentials.
 */

import crypto from 'crypto';

import { getConnection } from '@/modules/database/connection.js';

type ApiKeyRow = {
  id: number;
  key_name: string;
  api_key_prefix: string | null;
  created_at: string;
  last_used: string | null;
  is_active: number;
  /**
   * hl(动态 P3):这把 key 是否因为「退出所有设备 / 改密 / 重置密码」而作废
   * (签发时的 token_version 已落后于 users.token_version)。作废的 key 在列表里
   * `is_active` 也报 0;重新「启用」会把它重新签到当前版本(见 toggleApiKey)。
   */
  revoked: number;
};

type CreateApiKeyResult = {
  id: number | bigint;
  keyName: string;
  /** Full key — shown once and never retrievable again. */
  apiKey: string;
  apiKeyPrefix: string;
};

type ValidatedApiKeyUser = {
  id: number;
  username: string;
  /** hj:给调用方做「账号现在能不能用」判定(审批状态)。 */
  is_active: number;
  approval_status: string | null;
  api_key_id: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generates a cryptographically random API key with the `ck_` prefix. */
function generateApiKey(): string {
  return 'ck_' + crypto.randomBytes(32).toString('hex');
}

function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/** `ck_` + first 8 hex chars — enough to tell keys apart in a list. */
function prefixOf(apiKey: string): string {
  return apiKey.slice(0, 11);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const apiKeysDb = {
  generateApiKey,
  hashApiKey,

  /**
   * Creates a new API key for the given user and returns it for one-time display.
   *
   * hl(动态 P3):签发时记下 users.token_version —— 退出所有设备 / 改密 / 重置密码递增它,
   * 这把 key 随之作废(此前只作废 JWT 与票据,key 永远有效)。
   */
  createApiKey(userId: number, keyName: string): CreateApiKeyResult {
    const db = getConnection();
    const apiKey = generateApiKey();
    const apiKeyPrefix = prefixOf(apiKey);
    const result = db
      .prepare(
        `INSERT INTO api_keys (user_id, key_name, api_key, api_key_hash, api_key_prefix, token_version)
         VALUES (?, ?, NULL, ?, ?, (SELECT token_version FROM users WHERE id = ?))`
      )
      .run(userId, keyName, hashApiKey(apiKey), apiKeyPrefix, userId);
    return { id: result.lastInsertRowid, keyName, apiKey, apiKeyPrefix };
  },

  /**
   * Lists a user's API keys, most recent first.
   * Only the display prefix is returned — the full key no longer exists here.
   * 被版本作废的 key `is_active` 报 0 并带 `revoked = 1`,列表上看得出"它已经不能用了"。
   */
  getApiKeys(userId: number): ApiKeyRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT ak.id, ak.key_name, ak.api_key_prefix, ak.created_at, ak.last_used,
                CASE WHEN ak.token_version IS NOT NULL AND ak.token_version <> u.token_version THEN 0 ELSE ak.is_active END AS is_active,
                CASE WHEN ak.token_version IS NOT NULL AND ak.token_version <> u.token_version THEN 1 ELSE 0 END AS revoked
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE ak.user_id = ? ORDER BY ak.created_at DESC`
      )
      .all(userId) as ApiKeyRow[];
  },

  /**
   * Validates an API key and resolves the owning user.
   * If the key is valid, its `last_used` timestamp is updated as a side effect.
   * Returns undefined when the key is invalid or the user is inactive.
   * hl(动态 P3):签发时的 token_version 落后于用户当前版本的 key 一律无效。
   */
  validateApiKey(apiKey: string): ValidatedApiKeyUser | undefined {
    if (typeof apiKey !== 'string' || apiKey.length === 0) return undefined;

    const db = getConnection();
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.is_active, u.approval_status, ak.id as api_key_id
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE ak.api_key_hash = ? AND ak.is_active = 1 AND u.is_active = 1
           AND (ak.token_version IS NULL OR ak.token_version = u.token_version)`
      )
      .get(hashApiKey(apiKey)) as ValidatedApiKeyUser | undefined;

    if (row) {
      db.prepare(
        'UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(row.api_key_id);
    }

    return row;
  },

  /** Permanently removes an API key. Returns true if a row was deleted. */
  deleteApiKey(userId: number, apiKeyId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?')
      .run(apiKeyId, userId);
    return result.changes > 0;
  },

  /**
   * Enables or disables an API key without deleting it.
   *
   * hl(动态 P3):「启用」同时把 token_version 重新签到用户当前版本 —— 这是一次登录态下
   * 的明确动作,等于说"这把 key 我要继续用"。停用不动版本号。
   */
  toggleApiKey(
    userId: number,
    apiKeyId: number,
    isActive: boolean
  ): boolean {
    const db = getConnection();
    const result = isActive
      ? db
        .prepare(
          `UPDATE api_keys SET is_active = 1,
             token_version = (SELECT token_version FROM users WHERE id = api_keys.user_id)
           WHERE id = ? AND user_id = ?`
        )
        .run(apiKeyId, userId)
      : db
        .prepare('UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?')
        .run(apiKeyId, userId);
    return result.changes > 0;
  },
};
