/**
 * User credentials repository.
 *
 * Manages external service tokens (GitHub, GitLab, Bitbucket, etc.)
 * stored per-user. Each credential has a type discriminator so multiple
 * credential kinds can coexist in the same table.
 *
 * Values are encrypted at rest with AES-256-GCM (see server/shared/crypto-box.js).
 * The only write path is the INSERT in `createCredential`, so rows stored as
 * plaintext before encryption existed are never rewritten by normal use:
 * `encryptLegacyPlaintext()` encrypts them in place, and `initializeDatabase`
 * runs it on every start (a no-op once no plaintext row is left). `decrypt()`
 * still passes plaintext through, so a row that pass could not reach keeps
 * working.
 */

import { getConnection } from '@/modules/database/connection.js';
import { appConfigDb } from '@/modules/database/repositories/app-config.js';
import { decrypt, encrypt, getEncryptionKey, isEncrypted } from '@/shared/crypto-box.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('db');
import type {
  CreateCredentialResult,
  CredentialPublicRow,
} from '@/shared/types.js';

const ENCRYPTION_KEY_CONFIG = 'credential_encryption_key';

/**
 * Resolves the AES key, persisting a generated one in app_config on first
 * use. crypto-box.js cannot import the database itself (server/shared must
 * not depend on server/modules), so the storage hooks are injected here.
 */
function key(): Buffer {
  return getEncryptionKey({
    loadPersistedKey: () => appConfigDb.get(ENCRYPTION_KEY_CONFIG),
    savePersistedKey: (hex: string) => appConfigDb.set(ENCRYPTION_KEY_CONFIG, hex),
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const credentialsDb = {
  /** Stores a new credential (encrypted) and returns a safe (no raw value) result. */
  createCredential(
    userId: number,
    credentialName: string,
    credentialType: string,
    credentialValue: string,
    description: string | null = null
  ): CreateCredentialResult {
    const db = getConnection();
    const result = db
      .prepare(
        'INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        userId,
        credentialName,
        credentialType,
        encrypt(credentialValue, key()),
        description
      );
    return {
      id: result.lastInsertRowid,
      credentialName,
      credentialType,
    };
  },

  /**
   * Lists credentials for a user (excluding raw values).
   * Optionally filters by credential type (e.g. 'github_token').
   */
  getCredentials(
    userId: number,
    credentialType: string | null = null
  ): CredentialPublicRow[] {
    const db = getConnection();

    if (credentialType) {
      return db
        .prepare(
          'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? AND credential_type = ? ORDER BY created_at DESC'
        )
        .all(userId, credentialType) as CredentialPublicRow[];
    }

    return db
      .prepare(
        'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? ORDER BY created_at DESC'
      )
      .all(userId) as CredentialPublicRow[];
  },

  /**
   * Returns the decrypted credential value for the most recent active
   * credential of the given type, or null if none exists.
   *
   * A row that fails to decrypt (wrong PRISM_ENCRYPTION_KEY, restored from a
   * backup taken under a different key) is reported as missing rather than
   * returned as ciphertext — handing a corrupt token to a git push would
   * fail much further from the cause.
   */
  getActiveCredential(
    userId: number,
    credentialType: string
  ): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1'
      )
      .get(userId, credentialType) as { credential_value: string } | undefined;

    if (!row) return null;

    try {
      return decrypt(row.credential_value, key());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Could not decrypt stored credential', {
        credentialType,
        error: message,
      });
      return null;
    }
  },

  /** Permanently removes a credential. Returns true if a row was deleted. */
  deleteCredential(userId: number, credentialId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?')
      .run(credentialId, userId);
    return result.changes > 0;
  },

  /** Enables or disables a credential without deleting it. */
  toggleCredential(
    userId: number,
    credentialId: number,
    isActive: boolean
  ): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        'UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?'
      )
      .run(isActive ? 1 : 0, credentialId, userId);
    return result.changes > 0;
  },

  /**
   * Encrypts, in place, every stored value that is not yet a v1 envelope.
   * Returns how many rows were rewritten. Idempotent: encrypted and empty
   * values are left alone, so a second run changes nothing.
   *
   * The key is resolved before the transaction starts. When no key exists
   * yet, `key()` generates one and persists it to app_config; doing that
   * inside the transaction would let a rollback discard the stored key while
   * the memoized copy keeps encrypting new rows with it, and those rows would
   * be unreadable after the next restart.
   *
   * Each UPDATE carries the value it read (compare-and-swap), so a row
   * changed in between is skipped instead of overwritten with a stale value.
   */
  encryptLegacyPlaintext(): number {
    const db = getConnection();
    // GLOB is case-sensitive, matching `isEncrypted()`; LIKE would also skip "V1:..." values.
    const rows = (db
      .prepare(
        "SELECT id, credential_value FROM user_credentials WHERE credential_value <> '' AND credential_value NOT GLOB 'v1:*'"
      )
      .all() as Array<{ id: number; credential_value: string }>)
      .filter((row) => !isEncrypted(row.credential_value));
    if (rows.length === 0) return 0;

    const activeKey = key();
    const update = db.prepare(
      'UPDATE user_credentials SET credential_value = ? WHERE id = ? AND credential_value = ?'
    );
    const encrypted = db.transaction(() => {
      let changed = 0;
      for (const row of rows) {
        changed += update.run(encrypt(row.credential_value, activeKey), row.id, row.credential_value).changes;
      }
      return changed;
    })();
    log.info(`已加密 ${encrypted} 条历史明文凭据`, { candidates: rows.length });
    return encrypted;
  },
};
