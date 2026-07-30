/**
 * Coverage for server/shared/crypto-box.js.
 *
 * The properties that matter here are: a round trip returns the original
 * string, tampering is detected rather than ignored, legacy plaintext rows
 * survive, and key resolution prefers the operator-supplied env key.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { test } from 'vitest';

import {
  decrypt,
  encrypt,
  getEncryptionKey,
  isEncrypted,
  resetEncryptionKey,
  sha256Hex,
} from '../crypto-box.js';

const KEY = crypto.randomBytes(32);

/** Restores env + memoized key so tests don't leak into each other. */
const withEnv = (name, value, fn) => {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetEncryptionKey();
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
    resetEncryptionKey();
  }
};

test('encrypt/decrypt round-trips a secret', () => {
  const secret = 'ghp_exampleTokenValue1234567890';
  const envelope = encrypt(secret, KEY);

  assert.notEqual(envelope, secret, 'ciphertext must not equal plaintext');
  assert.equal(isEncrypted(envelope), true);
  assert.equal(decrypt(envelope, KEY), secret);
});

test('envelope has the documented v1 shape', () => {
  const envelope = encrypt('value', KEY);
  const parts = envelope.split(':');

  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  // 12-byte IV and 16-byte GCM tag, base64url encoded (no padding).
  assert.equal(Buffer.from(parts[1], 'base64url').length, 12);
  assert.equal(Buffer.from(parts[2], 'base64url').length, 16);
  assert.ok(!envelope.includes('='), 'base64url output should be unpadded');
});

test('the same plaintext encrypts differently every time', () => {
  // A fresh random IV per call: identical secrets must not produce identical
  // rows, or the database leaks which entries share a value.
  const a = encrypt('same-value', KEY);
  const b = encrypt('same-value', KEY);

  assert.notEqual(a, b);
  assert.equal(decrypt(a, KEY), decrypt(b, KEY));
});

test('round-trips unicode and long values', () => {
  const unicode = '令牌-🔐-token';
  assert.equal(decrypt(encrypt(unicode, KEY), KEY), unicode);

  const long = 'x'.repeat(20_000);
  assert.equal(decrypt(encrypt(long, KEY), KEY), long);
});

test('empty and nullish values pass through unchanged', () => {
  assert.equal(encrypt('', KEY), '');
  assert.equal(encrypt(null, KEY), null);
  assert.equal(encrypt(undefined, KEY), undefined);
});

test('legacy plaintext values decrypt to themselves', () => {
  // Rows written before encryption existed carry no v1 prefix.
  const legacy = 'plain-text-token-from-an-older-install';
  assert.equal(isEncrypted(legacy), false);
  assert.equal(decrypt(legacy, KEY), legacy);
  assert.equal(decrypt(null, KEY), null);
});

test('a tampered ciphertext throws instead of returning garbage', () => {
  const envelope = encrypt('super-secret', KEY);
  const parts = envelope.split(':');

  // Flip a byte in the ciphertext segment.
  const data = Buffer.from(parts[3], 'base64url');
  data[0] ^= 0xff;
  const tampered = [parts[0], parts[1], parts[2], data.toString('base64url')].join(':');

  assert.throws(() => decrypt(tampered, KEY));
});

test('a tampered auth tag throws', () => {
  const envelope = encrypt('super-secret', KEY);
  const parts = envelope.split(':');
  const tag = Buffer.from(parts[2], 'base64url');
  tag[0] ^= 0xff;

  assert.throws(() =>
    decrypt([parts[0], parts[1], tag.toString('base64url'), parts[3]].join(':'), KEY),
  );
});

test('decrypting with the wrong key throws', () => {
  const envelope = encrypt('super-secret', KEY);
  assert.throws(() => decrypt(envelope, crypto.randomBytes(32)));
});

test('a malformed envelope is rejected by shape', () => {
  assert.throws(() => decrypt('v1:onlytwo', KEY), /expected 4 segments/);
});

test('a 64-hex PRISM_ENCRYPTION_KEY is used verbatim', () => {
  const hex = crypto.randomBytes(32).toString('hex');
  withEnv('PRISM_ENCRYPTION_KEY', hex, () => {
    const key = getEncryptionKey();
    assert.equal(key.toString('hex'), hex);
  });
});

test('a passphrase PRISM_ENCRYPTION_KEY is stretched deterministically', () => {
  const first = withEnv('PRISM_ENCRYPTION_KEY', 'correct horse battery staple', () =>
    getEncryptionKey().toString('hex'),
  );
  const second = withEnv('PRISM_ENCRYPTION_KEY', 'correct horse battery staple', () =>
    getEncryptionKey().toString('hex'),
  );

  assert.equal(first, second, 'same passphrase must yield the same key across restarts');
  assert.equal(Buffer.from(first, 'hex').length, 32);

  const different = withEnv('PRISM_ENCRYPTION_KEY', 'a different passphrase', () =>
    getEncryptionKey().toString('hex'),
  );
  assert.notEqual(first, different);
});

test('the env key wins over a persisted key', () => {
  const hex = crypto.randomBytes(32).toString('hex');
  const persisted = crypto.randomBytes(32).toString('hex');

  withEnv('PRISM_ENCRYPTION_KEY', hex, () => {
    const key = getEncryptionKey({ loadPersistedKey: () => persisted });
    assert.equal(key.toString('hex'), hex);
  });
});

test('a persisted key is loaded when no env key is set', () => {
  const persisted = crypto.randomBytes(32).toString('hex');

  withEnv('PRISM_ENCRYPTION_KEY', undefined, () => {
    const key = getEncryptionKey({ loadPersistedKey: () => persisted });
    assert.equal(key.toString('hex'), persisted);
  });
});

test('a key is generated and persisted on first use', () => {
  let saved = null;

  withEnv('PRISM_ENCRYPTION_KEY', undefined, () => {
    const key = getEncryptionKey({
      loadPersistedKey: () => saved,
      savePersistedKey: (hex) => {
        saved = hex;
      },
    });

    assert.equal(key.length, 32);
    assert.equal(saved, key.toString('hex'), 'generated key must be written back');
  });
});

test('the resolved key is memoized until reset', () => {
  withEnv('PRISM_ENCRYPTION_KEY', undefined, () => {
    let loads = 0;
    const persisted = crypto.randomBytes(32).toString('hex');
    const load = () => {
      loads += 1;
      return persisted;
    };

    getEncryptionKey({ loadPersistedKey: load });
    getEncryptionKey({ loadPersistedKey: load });

    assert.equal(loads, 1, 'the storage hook should be consulted once');
  });
});

test('sha256Hex matches a known digest', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(sha256Hex('abc').length, 64);
  assert.notEqual(sha256Hex('abc'), sha256Hex('abd'));
});
