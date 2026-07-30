/**
 * Authenticated symmetric encryption for secrets held at rest.
 *
 * Prism stores third-party tokens (GitHub PATs, provider keys) in a plain
 * SQLite file under the user's home directory. Anything that can read that
 * file — a backup, a sync client, another process — could previously read
 * those tokens verbatim. This module wraps them in AES-256-GCM so the
 * database alone is not enough.
 *
 * Key resolution, in order:
 *   1. PRISM_ENCRYPTION_KEY  — 64 hex chars (32 bytes) or a passphrase that
 *                              gets scrypt-stretched. Operator-managed:
 *                              survives a lost database, required for
 *                              multi-host or restore-elsewhere setups.
 *   2. app_config            — a key generated on first use and stored
 *                              alongside the data. Protects against file
 *                              exfiltration but not against an attacker who
 *                              also takes app_config.
 *
 * Ciphertext format (single string, colon-delimited, all base64url):
 *   v1:<iv>:<authTag>:<ciphertext>
 *
 * `decrypt()` passes through any value that does not carry the v1 prefix, so
 * rows written before encryption existed keep working and get upgraded
 * lazily on their next write.
 */

import crypto from 'crypto';

const PREFIX = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32;
// Fixed salt: the passphrase path needs determinism across restarts, and the
// salt is not the secret here — the passphrase is.
const SCRYPT_SALT = Buffer.from('prism-credential-encryption-v1');

let cachedKey = null;

/** Derives a 32-byte key from an operator-supplied string. */
function deriveKeyFromEnv(raw) {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  return crypto.scryptSync(trimmed, SCRYPT_SALT, KEY_BYTES);
}

/**
 * Returns the active encryption key, generating and persisting one on first
 * use. `loadPersistedKey` / `savePersistedKey` are injected by the caller so
 * this module stays free of a database import (server/shared must not depend
 * on server/modules — see the eslint boundaries config).
 */
export function getEncryptionKey({ loadPersistedKey, savePersistedKey } = {}) {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.PRISM_ENCRYPTION_KEY;
  if (fromEnv && fromEnv.trim()) {
    cachedKey = deriveKeyFromEnv(fromEnv);
    return cachedKey;
  }

  if (typeof loadPersistedKey === 'function') {
    const stored = loadPersistedKey();
    if (stored) {
      cachedKey = Buffer.from(stored, 'hex');
      return cachedKey;
    }
  }

  const generated = crypto.randomBytes(KEY_BYTES);
  if (typeof savePersistedKey === 'function') {
    savePersistedKey(generated.toString('hex'));
  }
  cachedKey = generated;
  return cachedKey;
}

/** Drops the memoized key. Only useful for tests and key rotation. */
export function resetEncryptionKey() {
  cachedKey = null;
}

/** True when the string is a v1 envelope produced by `encrypt()`. */
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

/**
 * Encrypts a UTF-8 string. Returns the v1 envelope.
 * Empty/nullish input passes through unchanged — an absent secret should
 * stay absent rather than becoming a decryptable empty ciphertext.
 */
export function encrypt(plaintext, key) {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return plaintext;
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    PREFIX,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Decrypts a v1 envelope. Values without the prefix are returned as-is
 * (pre-encryption rows). A malformed or tampered envelope throws, because
 * silently returning ciphertext would push a corrupt token into a git
 * operation and produce a far more confusing failure downstream.
 */
export function decrypt(value, key) {
  if (!isEncrypted(value)) return value;

  const parts = value.split(':');
  if (parts.length !== 4) {
    throw new Error('Malformed encrypted value: expected 4 segments');
  }

  const [, ivPart, tagPart, dataPart] = parts;
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivPart, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** SHA-256 hex digest — used for API-key lookup columns. */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
