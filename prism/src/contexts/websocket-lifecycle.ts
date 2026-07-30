/**
 * Reconnect and liveness policy for the chat websocket.
 *
 * Split out of WebSocketContext because both rules protect against failures
 * that are invisible in a browser: neither produces an error, a rejected
 * promise, or a `readyState` that says anything is wrong. They can only be
 * verified by driving the clock, which is what the tests beside this file do.
 */

export type BackoffOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests; production uses Math.random. */
  random?: () => number;
};

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Delay before reconnect attempt number `attempt` (0-based).
 *
 * The previous policy was a flat 3 s retry. That is the worst case for the
 * event it actually has to survive — a server restart — because every open tab
 * drops at the same instant and then retries in lockstep every 3 s, so the
 * server comes back up into a synchronized stampede and each client's first
 * attempt is the one most likely to be refused.
 *
 * So: exponential growth to bound the load a long outage puts on a server that
 * is not answering, and jitter to decorrelate clients that dropped together.
 * The jitter is *partial* — the delay is drawn from [d/2, d] rather than
 * [0, d] — because full jitter's low draws put the first retries back within
 * milliseconds of the drop, which is exactly when a restarting server is least
 * able to accept them.
 */
export function nextReconnectDelay(attempt: number, options: BackoffOptions = {}): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;

  // Math.min absorbs the overflow to Infinity, so a client that has been
  // retrying for days does not compute a NaN delay and stop retrying.
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** safeAttempt);
  const floor = ceiling / 2;

  return Math.round(floor + random() * floor);
}

/**
 * Monotonic milliseconds, for measuring how long a socket has been silent.
 *
 * Deliberately not `Date.now()`. The wall clock steps — NTP corrections, and
 * every resume from suspend on a laptop or phone. A backwards step makes the
 * measured silence negative, which reads as "we just heard from the peer" and
 * so suppresses the liveness check for as long as the step was large. That is
 * the exact scenario the heartbeat exists for: a phone that slept for an hour
 * wakes with a dead socket, and a wall-clock measurement would decline to
 * check it for an hour.
 *
 * Clamping a negative elapsed time to zero does *not* fix this — the whole
 * point is that a negative value already falls through every threshold to
 * `idle`, which is the wrong answer either way. Only a clock that cannot run
 * backwards does.
 */
export function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export type HeartbeatAction = 'idle' | 'ping' | 'reconnect';

export type HeartbeatOptions = {
  pingAfterMs: number;
  reconnectAfterMs: number;
};

/** Send a ping once the socket has been silent this long. */
export const HEARTBEAT_PING_AFTER_MS = 25_000;
/** Give up on the socket once it has been silent this long. */
export const HEARTBEAT_RECONNECT_AFTER_MS = 60_000;
/**
 * How often the liveness check runs. Deliberately shorter than the ping
 * threshold, so between `pingAfterMs` and `reconnectAfterMs` a few pings go
 * out rather than one: on a lossy mobile link a single dropped ping would
 * otherwise be enough to tear down a socket that was still usable.
 */
export const HEARTBEAT_TICK_MS = 10_000;

/**
 * Decides what the liveness tick should do, given how long the socket has been
 * silent.
 *
 * The failure this exists for is the half-open connection: a NAT idle timeout,
 * a laptop suspend, or a phone moving from wifi to cellular leaves the socket
 * `readyState === OPEN` on the client while the peer is gone. No `close` event
 * ever fires, so the reconnect path is never entered — the UI keeps reporting
 * "connected" and every message the user sends disappears. This matters far
 * more here than in a localhost-only tool, since Prism is reached from phones
 * over the LAN, where exactly those transitions are routine.
 *
 * Absence of inbound traffic is the only available signal, so that is the whole
 * rule. It works because the server answers `{type:'ping'}` with
 * `{type:'pong'}`: on a healthy socket the pong resets the silence timer, so
 * the socket ticks between `idle` and `ping` forever and never reaches the
 * reconnect threshold. On a dead one nothing comes back, silence grows past
 * every threshold, and the client tears the socket down itself.
 *
 * `now` and `lastFrameAt` must come from `monotonicNow`, not the wall clock:
 * see that function for why a clock that can step backwards defeats this
 * check entirely rather than merely perturbing it.
 */
export function heartbeatAction(
  now: number,
  lastFrameAt: number,
  options: HeartbeatOptions = {
    pingAfterMs: HEARTBEAT_PING_AFTER_MS,
    reconnectAfterMs: HEARTBEAT_RECONNECT_AFTER_MS,
  },
): HeartbeatAction {
  const silenceMs = now - lastFrameAt;

  if (silenceMs >= options.reconnectAfterMs) {
    return 'reconnect';
  }
  if (silenceMs >= options.pingAfterMs) {
    return 'ping';
  }
  return 'idle';
}
