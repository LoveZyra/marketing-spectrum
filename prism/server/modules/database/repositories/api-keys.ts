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

  /** Creates a new API key for the given user and returns it for one-time display. */
  createApiKey(userId: number, keyName: string): CreateApiKeyResult {
    const db = getConnection();
    const apiKey = generateApiKey();
    const apiKeyPrefix = prefixOf(apiKey);
    const result = db
      .prepare(
        'INSERT INTO api_keys (user_id, key_name, api_key, api_key_hash, api_key_prefix) VALUES (?, ?, NULL, ?, ?)'
      )
      .run(userId, keyName, hashApiKey(apiKey), apiKeyPrefix);
    return { id: result.lastInsertRowid, keyName, apiKey, apiKeyPrefix };
  },

  /**
   * Lists a user's API keys, most recent first.
   * Only the display prefix is returned — the full key no longer exists here.
   */
  getApiKeys(userId: number): ApiKeyRow[] {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, key_name, api_key_prefix, created_at, last_used, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
      )
      .all(userId) as ApiKeyRow[];
  },

  /**
   * Validates an API key and resolves the owning user.
   * If the key is valid, its `last_used` timestamp is updated as a side effect.
   * Returns undefined when the key is invalid or the user is inactive.
   */
  validateApiKey(apiKey: string): ValidatedApiKeyUser | undefined {
    if (typeof apiKey !== 'string' || apiKey.length === 0) return undefined;

    const db = getConnection();
    const row = db
      .prepare(
        `SELECT u.id, u.username, ak.id as api_key_id
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE ak.api_key_hash = ? AND ak.is_active = 1 AND u.is_active = 1`
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

  /** Enables or disables an API key without deleting it. */
  toggleApiKey(
    userId: number,
    apiKeyId: number,
    isActive: boolean
  ): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        'UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?'
      )
      .run(isActive ? 1 : 0, apiKeyId, userId);
    return result.changes > 0;
  },
};
