/**
 * In-process rate limiting and login lockout.
 *
 * Prism listens on 0.0.0.0 by default so phones and other machines on the
 * same LAN can reach it. That choice is deliberate, so the exposure it
 * creates is mitigated here instead: every /api route gets a sliding-window
 * request cap, and the credential endpoints additionally get a per-identity
 * lockout with escalating backoff.
 *
 * The server is single-process, so plain Maps are sufficient and avoid a
 * Redis dependency. All state is intentionally lost on restart — a restart
 * is operator-initiated and already clears far more than this.
 *
 * Tuning (all optional):
 *   PRISM_RATE_LIMIT           `0` disables every limiter in this module
 *   PRISM_RATE_LIMIT_WINDOW_MS default 60000
 *   PRISM_RATE_LIMIT_MAX       default 600   (per IP per window, /api overall)
 *   PRISM_LOGIN_MAX_ATTEMPTS   default 5     (failures before lockout)
 *   PRISM_LOGIN_WINDOW_MS      default 900000 (15 min failure window)
 *   PRISM_LOGIN_LOCKOUT_MS     default 900000 (15 min base lockout)
 *   PRISM_TRUST_PROXY          `1` honors X-Forwarded-For (set behind nginx)
 */

const envFlag = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};

const envInt = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const RATE_LIMIT_ENABLED = envFlag('PRISM_RATE_LIMIT', true);
export const TRUST_PROXY = envFlag('PRISM_TRUST_PROXY', false);

const DEFAULT_WINDOW_MS = envInt('PRISM_RATE_LIMIT_WINDOW_MS', 60_000);
const DEFAULT_MAX = envInt('PRISM_RATE_LIMIT_MAX', 600);

const LOGIN_MAX_ATTEMPTS = envInt('PRISM_LOGIN_MAX_ATTEMPTS', 5);
const LOGIN_WINDOW_MS = envInt('PRISM_LOGIN_WINDOW_MS', 15 * 60_000);
const LOGIN_LOCKOUT_MS = envInt('PRISM_LOGIN_LOCKOUT_MS', 15 * 60_000);
// Lockouts escalate 1x, 2x, 4x, 8x… capped so an operator locked out by a
// bot can still get back in the same day.
const LOGIN_LOCKOUT_MAX_MS = 24 * 60 * 60_000;

/**
 * Best-effort client IP.
 *
 * X-Forwarded-For is honored only when PRISM_TRUST_PROXY is set, because an
 * attacker who can reach the socket directly can otherwise forge a fresh IP
 * per request and bypass every limiter in this file.
 */
export function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Sliding-window limiter
// ---------------------------------------------------------------------------

/**
 * Returns an express middleware enforcing `max` requests per `windowMs`
 * per key. The window slides: each key keeps the timestamps of its recent
 * hits and expires them individually, so a burst at the end of one fixed
 * window can't be immediately followed by another at the start of the next.
 */
export function createRateLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  max = DEFAULT_MAX,
  keyFn = clientIp,
  message = 'Too many requests',
  skip = null,
} = {}) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  // Drop keys whose entire window has aged out. Unref'd so it never keeps
  // the process alive during shutdown.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of hits) {
      const live = timestamps.filter((t) => t > cutoff);
      if (live.length === 0) hits.delete(key);
      else hits.set(key, live);
    }
  }, Math.max(windowMs, 30_000));
  sweeper.unref();

  const middleware = (req, res, next) => {
    if (!RATE_LIMIT_ENABLED) return next();
    if (skip && skip(req)) return next();

    const key = keyFn(req);
    const now = Date.now();
    const cutoff = now - windowMs;

    const timestamps = (hits.get(key) || []).filter((t) => t > cutoff);

    if (timestamps.length >= max) {
      const retryAfterMs = Math.max(0, timestamps[0] + windowMs - now);
      hits.set(key, timestamps);
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', '0');
      return res.status(429).json({ error: message, retryAfterMs });
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(max - timestamps.length));
    return next();
  };

  // Exposed for tests and for shutdown paths that want to stop the sweeper.
  middleware.reset = () => hits.clear();
  middleware.stop = () => clearInterval(sweeper);
  return middleware;
}

/** Overall cap for every /api request. Generous — it stops floods, not use. */
export const apiRateLimiter = createRateLimiter({
  windowMs: DEFAULT_WINDOW_MS,
  max: DEFAULT_MAX,
  message: 'Too many requests, slow down',
});

// ---------------------------------------------------------------------------
// Credential-endpoint lockout
// ---------------------------------------------------------------------------

/**
 * @type {Map<string, { failures: number, firstFailureAt: number, lockedUntil: number, lockCount: number }>}
 */
const loginState = new Map();

const loginSweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, state] of loginState) {
    const windowExpired = now - state.firstFailureAt > LOGIN_WINDOW_MS;
    const lockExpired = state.lockedUntil <= now;
    // Keep locked entries and entries inside the failure window; drop the rest
    // so a long-running server doesn't accumulate one entry per probing IP.
    if (windowExpired && lockExpired) loginState.delete(key);
  }
}, 60_000);
loginSweeper.unref();

const loginKey = (req) => {
  const username =
    typeof req.body?.username === 'string' ? req.body.username.toLowerCase() : '';
  return `${clientIp(req)}|${username}`;
};

/**
 * Records a failed credential attempt and locks the identity out once it
 * crosses the threshold. Each successive lockout doubles in length.
 */
export function recordLoginFailure(req) {
  if (!RATE_LIMIT_ENABLED) return null;

  const key = loginKey(req);
  const now = Date.now();
  const existing = loginState.get(key);

  const state =
    existing && now - existing.firstFailureAt <= LOGIN_WINDOW_MS
      ? existing
      : { failures: 0, firstFailureAt: now, lockedUntil: 0, lockCount: existing?.lockCount ?? 0 };

  state.failures += 1;

  if (state.failures >= LOGIN_MAX_ATTEMPTS) {
    const duration = Math.min(
      LOGIN_LOCKOUT_MS * Math.pow(2, state.lockCount),
      LOGIN_LOCKOUT_MAX_MS
    );
    state.lockedUntil = now + duration;
    state.lockCount += 1;
    state.failures = 0;
    state.firstFailureAt = now;
    loginState.set(key, state);
    return { lockedUntil: state.lockedUntil, lockoutMs: duration };
  }

  loginState.set(key, state);
  return { attemptsRemaining: LOGIN_MAX_ATTEMPTS - state.failures };
}

/** Clears the failure record after a successful authentication. */
export function clearLoginFailures(req) {
  loginState.delete(loginKey(req));
}

/**
 * Blocks requests from an identity that is currently locked out.
 * Mount before the handler that verifies credentials.
 */
export function loginLockout(req, res, next) {
  if (!RATE_LIMIT_ENABLED) return next();

  const state = loginState.get(loginKey(req));
  const now = Date.now();

  if (state && state.lockedUntil > now) {
    const retryAfterMs = state.lockedUntil - now;
    res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
    return res.status(429).json({
      error: 'Too many failed attempts. Try again later.',
      retryAfterMs,
    });
  }

  return next();
}

/**
 * Hard per-IP cap on credential endpoints, independent of the per-identity
 * lockout above — it stops username spraying, where every request uses a
 * different username and so never trips a single identity's counter.
 */
export const authRateLimiter = createRateLimiter({
  windowMs: envInt('PRISM_AUTH_RATE_WINDOW_MS', 15 * 60_000),
  max: envInt('PRISM_AUTH_RATE_MAX', 50),
  message: 'Too many authentication attempts',
});

/** Test/reset helper. */
export function resetLoginState() {
  loginState.clear();
}
