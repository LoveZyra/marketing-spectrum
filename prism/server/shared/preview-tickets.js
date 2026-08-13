// Short-lived preview tickets for the editor's sandboxed HTML preview.
//
// Why a separate token type from publication tokens: a publication is a
// deliberate, long-lived share that stays reachable until someone revokes it;
// a preview is "let me see what this looks like" and must not leave a URL
// behind that keeps working. Reusing one for the other gets you either
// permanent links minted by accident, or shared links that die in five minutes.
//
// Why a ticket rather than the session JWT: the preview runs in an iframe with
// `sandbox` and no `allow-same-origin`, so its requests for relative assets
// (./style.css, ./chart.png) carry no Authorization header and no cookie — the
// credential has to be in the URL. A 5-minute, project-and-directory-scoped
// ticket is a much smaller thing to put in a URL than a 7-day JWT.
//
// Contract (other modules import these exact names — do not rename):
//   issuePreviewTicket({ projectId, relDir }) -> 64-char hex string
//   readPreviewTicket(ticket) -> { projectId, relDir } | null
//
// Unlike WS tickets these are NOT single-use: one preview loads a document plus
// however many assets it references.
import crypto from 'crypto';

export const PREVIEW_TICKET_TTL_MS = 5 * 60_000;

// ticket (hex string) -> { projectId, relDir, expiresAt }
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
  sweepTimer = setInterval(() => sweepExpiredTickets(), PREVIEW_TICKET_TTL_MS);
  // Never keep the process alive just to expire tickets.
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref();
  }
}

/**
 * Issue a preview ticket scoped to one directory of one project.
 *
 * @param {{ projectId: string, relDir: string }} scope
 *   `relDir` is the project-relative directory the previewed document sits in,
 *   '' for the project root. Everything the preview can read is under it.
 * @returns {string} 32 random bytes as a 64-char hex string.
 */
export function issuePreviewTicket({ projectId, relDir }) {
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, {
    projectId: String(projectId),
    relDir: String(relDir ?? ''),
    expiresAt: Date.now() + PREVIEW_TICKET_TTL_MS,
  });
  ensureSweepTimer();
  return ticket;
}

/**
 * Resolve a ticket. Returns null when unknown or expired.
 *
 * Expired entries are deleted on read as well as by the sweep, so a ticket
 * cannot come back to life if the sweep timer was cleared.
 *
 * @param {string} ticket
 * @returns {{ projectId: string, relDir: string } | null}
 */
export function readPreviewTicket(ticket) {
  if (typeof ticket !== 'string' || !ticket) return null;

  const entry = tickets.get(ticket);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    tickets.delete(ticket);
    return null;
  }

  return { projectId: entry.projectId, relDir: entry.relDir };
}

/** Test hook: drop every outstanding ticket. */
export function resetPreviewTickets() {
  tickets.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
