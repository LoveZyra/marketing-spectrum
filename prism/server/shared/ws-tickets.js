// Single-use, short-lived WebSocket auth tickets.
//
// Flow: an authenticated HTTP client calls POST /api/auth/ws-ticket (see
// server/routes/auth.js), which calls `issueTicket(userId)` and returns the
// opaque ticket string. The browser then opens the WebSocket with
// `?ticket=<value>` and the upgrade handler calls `consumeTicket()` exactly
// once. This keeps long-lived JWTs out of query strings (where they leak into
// proxy/access logs); the legacy `?token=` JWT path is only honored when
// PRISM_ALLOW_QUERY_TOKEN === '1'.
//
// Contract (other modules import these exact names — do not rename):
//   issueTicket(userId)  -> 64-char hex string, valid for 60s, single use
//   consumeTicket(ticket) -> { userId } | null
import crypto from 'crypto';

export const WS_TICKET_TTL_MS = 60_000;

// ticket (hex string) -> { userId, expiresAt }
const tickets = new Map();

let sweepTimer = null;

function sweepExpiredTickets(now = Date.now()) {
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) {
      tickets.delete(ticket);
    }
  }

  if (tickets.size === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function ensureSweepTimer() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepExpiredTickets(), WS_TICKET_TTL_MS);
  // Never keep the process alive just to expire tickets.
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref();
  }
}

/**
 * Issues a single-use WebSocket auth ticket for the given user.
 *
 * @param {string|number} userId - Authenticated user id the ticket represents.
 * @returns {string} 32 random bytes as a 64-char hex string.
 */
export function issueTicket(userId) {
  if (userId === undefined || userId === null || userId === '') {
    throw new Error('issueTicket requires a userId');
  }

  // Opportunistic cleanup keeps the map bounded even if the timer was unref'd
  // away in short-lived processes.
  sweepExpiredTickets();

  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, {
    userId,
    expiresAt: Date.now() + WS_TICKET_TTL_MS,
  });
  ensureSweepTimer();

  return ticket;
}

/**
 * Consumes a ticket. A ticket is valid exactly once and only within its TTL.
 *
 * @param {unknown} ticket - Value received from the client.
 * @returns {{ userId: string|number } | null} The owning user id, or null when
 *   the ticket is unknown, already used, or expired.
 */
export function consumeTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length === 0) {
    return null;
  }

  const entry = tickets.get(ticket);
  if (!entry) {
    return null;
  }

  // Single use: remove before the expiry check so an expired ticket can never
  // be replayed either.
  tickets.delete(ticket);

  if (entry.expiresAt <= Date.now()) {
    return null;
  }

  return { userId: entry.userId };
}
