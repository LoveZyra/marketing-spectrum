/**
 * Reconnect and liveness policy for the chat websocket.
 *
 * Kept apart from WebSocketContext because both rules guard against failures
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
 * The event this must survive is a server restart: every open tab drops at the
 * same instant, and a fixed retry interval would bring them all back in
 * lockstep, into a server that is least able to accept them. Exponential growth
 * bounds the load a long outage puts on an unresponsive server; jitter
 * decorrelates clients that dropped together. The jitter is partial — drawn
 * from [d/2, d] rather than [0, d] — because full jitter's low draws put the
 * first retries within milliseconds of the drop.
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
 * Deliberately not `Date.now()`: the wall clock steps (NTP corrections, every
 * resume from suspend). A backwards step makes the measured silence negative,
 * which reads as "we just heard from the peer" and suppresses the liveness
 * check for as long as the step was large — so a phone that slept for an hour
 * would not notice its dead socket for another hour. Clamping to zero does not
 * help, since zero also yields `idle`; only a clock that cannot run backwards
 * does.
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
 * `readyState === OPEN` while the peer is gone. No `close` event fires, so the
 * UI keeps reporting "connected" and every message sent disappears. Prism is
 * reached from phones over the LAN, where those transitions are routine.
 *
 * Absence of inbound traffic is the only available signal. The server answers
 * `{type:'ping'}` with `{type:'pong'}`, so a healthy socket ticks between
 * `idle` and `ping` forever; on a dead one silence grows past every threshold
 * and the client tears the socket down itself.
 *
 * `now` and `lastFrameAt` must come from `monotonicNow` (see there for why a
 * clock that can step backwards defeats this check entirely).
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
