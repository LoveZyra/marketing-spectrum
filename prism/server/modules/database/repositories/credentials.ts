/**
 * User credentials repository.
 *
 * Manages external service tokens (GitHub, GitLab, Bitbucket, etc.)
 * stored per-user. Each credential has a type discriminator so multiple
 * credential kinds can coexist in the same table.
 *
 * Values are encrypted at rest with AES-256-GCM (see server/shared/crypto-box.js).
 * Rows written before encryption existed are still readable — `decrypt()`
 * passes through anything without the v1 envelope — and get upgraded the next
 * time they are written.
 */

import { getConnection } from '@/modules/database/connection.js';
import { appConfigDb } from '@/modules/database/repositories/app-config.js';
import { decrypt, encrypt, getEncryptionKey } from '@/shared/crypto-box.js';
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
      console.error('Could not decrypt stored credential', {
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
};
