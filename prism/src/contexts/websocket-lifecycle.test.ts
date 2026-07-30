import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  HEARTBEAT_PING_AFTER_MS,
  HEARTBEAT_RECONNECT_AFTER_MS,
  HEARTBEAT_TICK_MS,
  heartbeatAction,
  monotonicNow,
  nextReconnectDelay,
} from './websocket-lifecycle';

const noJitter = { random: () => 0 };
const maxJitter = { random: () => 1 };

test('backoff grows exponentially with each failed attempt', () => {
  const options = { baseDelayMs: 1_000, maxDelayMs: 30_000, ...maxJitter };

  assert.equal(nextReconnectDelay(0, options), 1_000);
  assert.equal(nextReconnectDelay(1, options), 2_000);
  assert.equal(nextReconnectDelay(2, options), 4_000);
  assert.equal(nextReconnectDelay(3, options), 8_000);
});

test('backoff is capped so a long outage does not schedule a retry hours away', () => {
  const options = { baseDelayMs: 1_000, maxDelayMs: 30_000, ...maxJitter };

  assert.equal(nextReconnectDelay(20, options), 30_000);
  // 2 ** 2000 overflows to Infinity. Math.min has to absorb it, or the delay
  // becomes NaN, setTimeout fires immediately, and the client spins.
  assert.equal(nextReconnectDelay(2_000, options), 30_000);
});

/**
 * The event this policy exists for is a server restart: every open tab drops in
 * the same instant. Without jitter they all retry in the same instant too, so
 * the server comes back up into a synchronized stampede.
 */
test('jitter spreads clients that dropped at the same moment', () => {
  const options = { baseDelayMs: 1_000, maxDelayMs: 30_000 };

  const earliest = nextReconnectDelay(3, { ...options, ...noJitter });
  const latest = nextReconnectDelay(3, { ...options, ...maxJitter });

  assert.equal(earliest, 4_000);
  assert.equal(latest, 8_000);
  assert.ok(earliest < latest, 'the random draw must actually move the delay');
});

/**
 * Partial rather than full jitter: a draw near zero would put the retry within
 * milliseconds of the drop, which is precisely when a restarting server is
 * least able to accept it.
 */
test('jitter never collapses the delay toward zero', () => {
  for (const attempt of [0, 1, 5, 12]) {
    const delay = nextReconnectDelay(attempt, { baseDelayMs: 1_000, ...noJitter });
    assert.ok(delay >= 500, `attempt ${attempt} produced ${delay}ms`);
  }
});

test('a nonsense attempt count still yields a usable delay', () => {
  const options = { baseDelayMs: 1_000, maxDelayMs: 30_000, ...maxJitter };

  for (const attempt of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const delay = nextReconnectDelay(attempt, options);
    assert.ok(Number.isFinite(delay) && delay > 0, `attempt=${attempt} -> ${delay}`);
  }
});

test('a socket with recent traffic is left alone', () => {
  const options = { pingAfterMs: 25_000, reconnectAfterMs: 60_000 };

  assert.equal(heartbeatAction(1_000, 1_000, options), 'idle');
  assert.equal(heartbeatAction(25_999, 1_000, options), 'idle');
});

test('a quiet socket is probed before it is given up on', () => {
  const options = { pingAfterMs: 25_000, reconnectAfterMs: 60_000 };

  assert.equal(heartbeatAction(26_000, 1_000, options), 'ping');
  assert.equal(heartbeatAction(60_000, 1_000, options), 'ping');
});

/**
 * The half-open socket: the peer is gone but the browser still reports OPEN and
 * never fires `close`, so nothing else in the stack will ever start a
 * reconnect. Silence is the only evidence available.
 */
test('a socket that has answered nothing for a full minute is torn down', () => {
  const options = { pingAfterMs: 25_000, reconnectAfterMs: 60_000 };

  assert.equal(heartbeatAction(61_000, 1_000, options), 'reconnect');
  assert.equal(heartbeatAction(600_000, 1_000, options), 'reconnect');
});

/**
 * A backwards clock step reads as negative silence, which falls through every
 * threshold to `idle` — the check simply stops running for as long as the step
 * was large, which on a phone waking from an hour's sleep means an hour of not
 * noticing a dead socket. No clamp inside `heartbeatAction` can repair that,
 * because `idle` is already what a clamped zero produces. The only fix is a
 * clock that cannot run backwards, so that is what the timestamps come from.
 *
 * A test cannot make the wall clock step backwards, so it cannot observe that
 * failure directly. What it can observe is the property that prevents it: the
 * reading is not derived from the wall clock at all. An epoch-magnitude value
 * here means someone put `Date.now()` back.
 */
test('the heartbeat clock is not the wall clock', () => {
  const reading = monotonicNow();

  assert.ok(Number.isFinite(reading) && reading >= 0, `unusable reading: ${reading}`);
  // Unix-epoch milliseconds are ~1.7e12. Any monotonic source is milliseconds
  // since some recent origin (page load, process start), so it is smaller by
  // orders of magnitude — this only misfires after ~28,000 years of uptime.
  assert.ok(
    reading < Date.now() / 2,
    `${reading} looks like a wall-clock timestamp, not elapsed time`,
  );
});

test('the heartbeat clock actually advances, and never backwards', () => {
  const startedAt = monotonicNow();
  let previous = startedAt;
  let latest = startedAt;
  let iterations = 0;

  // Busy-wait rather than sleep: the test is synchronous and has to span enough
  // real time that a working clock is guaranteed to move. The iteration cap is
  // what makes a *stopped* clock fail the assertion below rather than spin here
  // forever.
  while (latest - startedAt < 2 && iterations < 2_000_000) {
    latest = monotonicNow();
    assert.ok(latest >= previous, `clock went backwards: ${latest} after ${previous}`);
    previous = latest;
    iterations += 1;
  }

  assert.ok(
    latest > startedAt,
    'a clock that never advances reports every socket as freshly active forever',
  );
});

test('the tick runs often enough to retry a lost ping before giving up', () => {
  // Between the two thresholds there must be room for more than one probe, or a
  // single dropped ping on a lossy mobile link tears down a live socket.
  const probes = (HEARTBEAT_RECONNECT_AFTER_MS - HEARTBEAT_PING_AFTER_MS) / HEARTBEAT_TICK_MS;

  assert.ok(probes >= 2, `only ${probes} probe(s) fit before the reconnect threshold`);
  assert.ok(HEARTBEAT_PING_AFTER_MS < HEARTBEAT_RECONNECT_AFTER_MS);
});
