/**
 * Coverage for server/middleware/rate-limit.js.
 *
 * These guards are the whole reason Prism can keep listening on 0.0.0.0, so
 * they need real tests rather than a manual smoke check.
 */
import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  clearLoginFailures,
  clientIp,
  createRateLimiter,
  loginLockout,
  recordLoginFailure,
  resetLoginState,
} from '../rate-limit.js';

/** Minimal express-ish req/res doubles — enough for the middleware surface. */
const makeReq = ({ ip = '10.0.0.1', body = {}, headers = {} } = {}) => ({
  ip,
  body,
  headers,
  socket: { remoteAddress: ip },
});

const makeRes = () => {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

/** Runs the middleware and reports whether next() was reached. */
const run = (middleware, req) => {
  const res = makeRes();
  let passed = false;
  middleware(req, res, () => {
    passed = true;
  });
  return { passed, res };
};

test('rate limiter allows requests up to the cap and rejects the next one', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
  const req = makeReq();

  for (let i = 0; i < 3; i += 1) {
    const { passed, res } = run(limiter, req);
    assert.equal(passed, true, `request ${i + 1} should pass`);
    assert.equal(res.headers['x-ratelimit-remaining'], String(3 - (i + 1)));
  }

  const { passed, res } = run(limiter, req);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['x-ratelimit-remaining'], '0');
  assert.ok(Number(res.headers['retry-after']) >= 0);
  assert.ok(res.body.retryAfterMs > 0);

  limiter.stop();
});

test('rate limiter counts each key independently', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });

  assert.equal(run(limiter, makeReq({ ip: '10.0.0.1' })).passed, true);
  assert.equal(run(limiter, makeReq({ ip: '10.0.0.1' })).passed, false);
  // A different IP has its own budget.
  assert.equal(run(limiter, makeReq({ ip: '10.0.0.2' })).passed, true);

  limiter.stop();
});

test('rate limiter window slides so old hits stop counting', async () => {
  const limiter = createRateLimiter({ windowMs: 40, max: 2 });
  const req = makeReq();

  assert.equal(run(limiter, req).passed, true);
  assert.equal(run(limiter, req).passed, true);
  assert.equal(run(limiter, req).passed, false);

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(run(limiter, req).passed, true, 'budget should recover after the window');
  limiter.stop();
});

test('rate limiter honors the skip predicate', () => {
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: 1,
    skip: (req) => req.headers['x-internal'] === 'yes',
  });

  const skipped = makeReq({ headers: { 'x-internal': 'yes' } });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(run(limiter, skipped).passed, true);
  }

  limiter.stop();
});

test('clientIp ignores X-Forwarded-For unless the proxy is trusted', () => {
  // PRISM_TRUST_PROXY is unset in tests, so a forged header must not win —
  // otherwise every limiter here is bypassable with one header.
  const req = makeReq({ ip: '10.0.0.9', headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(clientIp(req), '10.0.0.9');
});

test('clientIp falls back to the socket address', () => {
  const req = { headers: {}, socket: { remoteAddress: '192.168.1.5' } };
  assert.equal(clientIp(req), '192.168.1.5');
  assert.equal(clientIp({ headers: {} }), 'unknown');
});

test('login lockout engages after repeated failures and blocks further attempts', () => {
  resetLoginState();
  const req = makeReq({ ip: '10.1.0.1', body: { username: 'alice' } });

  assert.equal(run(loginLockout, req).passed, true, 'clean identity passes');

  // Default threshold is 5 failures.
  for (let i = 0; i < 4; i += 1) {
    const result = recordLoginFailure(req);
    assert.equal(result.attemptsRemaining, 4 - i);
    assert.equal(run(loginLockout, req).passed, true, 'still under the threshold');
  }

  const locked = recordLoginFailure(req);
  assert.ok(locked.lockedUntil > Date.now());
  assert.ok(locked.lockoutMs > 0);

  const { passed, res } = run(loginLockout, req);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['retry-after']) > 0);

  resetLoginState();
});

test('lockout is scoped per identity, not per IP alone', () => {
  resetLoginState();
  const alice = makeReq({ ip: '10.1.0.2', body: { username: 'alice' } });
  const bob = makeReq({ ip: '10.1.0.2', body: { username: 'bob' } });

  for (let i = 0; i < 5; i += 1) recordLoginFailure(alice);

  assert.equal(run(loginLockout, alice).passed, false);
  assert.equal(run(loginLockout, bob).passed, true, 'a different username is unaffected');

  resetLoginState();
});

test('username matching is case-insensitive', () => {
  resetLoginState();
  const lower = makeReq({ ip: '10.1.0.3', body: { username: 'alice' } });
  const upper = makeReq({ ip: '10.1.0.3', body: { username: 'ALICE' } });

  for (let i = 0; i < 5; i += 1) recordLoginFailure(lower);
  assert.equal(run(loginLockout, upper).passed, false, 'casing must not reset the counter');

  resetLoginState();
});

test('a successful login clears the failure record', () => {
  resetLoginState();
  const req = makeReq({ ip: '10.1.0.4', body: { username: 'carol' } });

  for (let i = 0; i < 3; i += 1) recordLoginFailure(req);
  clearLoginFailures(req);

  // Counter restarted: the next failure reports the full remaining budget.
  assert.equal(recordLoginFailure(req).attemptsRemaining, 4);

  resetLoginState();
});

test('successive lockouts escalate in duration', () => {
  resetLoginState();
  const req = makeReq({ ip: '10.1.0.5', body: { username: 'dave' } });

  let firstLock = null;
  for (let i = 0; i < 5; i += 1) firstLock = recordLoginFailure(req);

  // The lockout resets `failures`, so another five failures triggers the next
  // lockout — which must be longer, so an attacker pays more each round.
  let secondLock = null;
  for (let i = 0; i < 5; i += 1) secondLock = recordLoginFailure(req);

  assert.ok(firstLock.lockoutMs > 0);
  assert.equal(secondLock.lockoutMs, firstLock.lockoutMs * 2);

  resetLoginState();
});
