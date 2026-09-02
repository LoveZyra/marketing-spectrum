import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decodeJwtPayload,
  hasJwtShape,
  installRefreshedToken,
  shouldAcceptRefreshedToken,
} from './tokenRefresh';

/** 造一张只为读 payload 的假 JWT(签名段不参与解码,凑形状即可)。 */
const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeJwt = (payload: Record<string, unknown>): string =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig_not_checked`;

const makeStorage = (initial?: Record<string, string>) => {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    dump: () => Object.fromEntries(map),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hasJwtShape', () => {
  it('accepts three base64url segments and nothing else', () => {
    expect(hasJwtShape(fakeJwt({ userId: 1 }))).toBe(true);
    expect(hasJwtShape('a.b')).toBe(false);
    expect(hasJwtShape('a.b.c.d')).toBe(false);
    expect(hasJwtShape('has space.b.c')).toBe(false);
    expect(hasJwtShape(null)).toBe(false);
    expect(hasJwtShape(42)).toBe(false);
  });
});

describe('decodeJwtPayload', () => {
  it('reads the payload, unicode usernames included', () => {
    const payload = decodeJwtPayload(fakeJwt({ userId: 7, username: '天机·测试', tv: 0 }));
    expect(payload).toMatchObject({ userId: 7, username: '天机·测试', tv: 0 });
  });

  it('returns null for malformed input', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload(`${b64url({})}.%%%%.sig`)).toBeNull();
    // payload 段是合法 base64 但不是 JSON 对象
    expect(decodeJwtPayload(`${b64url({})}.${Buffer.from('"just a string"').toString('base64url')}.sig`)).toBeNull();
    expect(decodeJwtPayload(undefined)).toBeNull();
  });
});

describe('shouldAcceptRefreshedToken', () => {
  const rootToken = fakeJwt({ userId: 1, username: 'root' });
  const testToken = fakeJwt({ userId: 2, username: 'test' });

  it('accepts a refresh for the same userId', () => {
    const newerRoot = fakeJwt({ userId: 1, username: 'root', iat: 999 });
    expect(shouldAcceptRefreshedToken(rootToken, newerRoot)).toBe(true);
  });

  it('rejects a refresh belonging to a different user (cache replay / switch race)', () => {
    expect(shouldAcceptRefreshedToken(testToken, rootToken)).toBe(false);
  });

  it('rejects when there is no current session to refresh', () => {
    expect(shouldAcceptRefreshedToken(null, rootToken)).toBe(false);
    expect(shouldAcceptRefreshedToken('', rootToken)).toBe(false);
  });

  it('rejects malformed or non-numeric-userId tokens', () => {
    expect(shouldAcceptRefreshedToken(rootToken, 'garbage')).toBe(false);
    expect(shouldAcceptRefreshedToken(rootToken, fakeJwt({ userId: '1' }))).toBe(false);
    expect(shouldAcceptRefreshedToken('garbage', rootToken)).toBe(false);
  });
});

describe('installRefreshedToken', () => {
  const rootToken = fakeJwt({ userId: 1, username: 'root', iat: 100 });
  const newerRoot = fakeJwt({ userId: 1, username: 'root', iat: 200 });
  const testToken = fakeJwt({ userId: 2, username: 'test', iat: 150 });

  it('installs a same-user refresh', () => {
    const storage = makeStorage({ 'auth-token': rootToken });
    expect(installRefreshedToken(newerRoot, storage)).toBe(true);
    expect(storage.dump()['auth-token']).toBe(newerRoot);
  });

  it('refuses a cross-user token and keeps the current one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = makeStorage({ 'auth-token': testToken });
    expect(installRefreshedToken(rootToken, storage)).toBe(false);
    expect(storage.dump()['auth-token']).toBe(testToken);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses to resurrect a logged-out session', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = makeStorage();
    expect(installRefreshedToken(rootToken, storage)).toBe(false);
    expect(storage.dump()['auth-token']).toBeUndefined();
  });

  it('ignores malformed headers and a missing storage silently', () => {
    const storage = makeStorage({ 'auth-token': rootToken });
    expect(installRefreshedToken('not a jwt', storage)).toBe(false);
    expect(installRefreshedToken(null, storage)).toBe(false);
    expect(storage.dump()['auth-token']).toBe(rootToken);
    expect(installRefreshedToken(newerRoot, null)).toBe(false);
  });
});
