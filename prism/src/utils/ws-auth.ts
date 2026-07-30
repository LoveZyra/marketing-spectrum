import { IS_PLATFORM } from '../constants/config';

import { authenticatedFetch } from './api';

/**
 * Builds an authenticated websocket URL, or `null` if it cannot right now.
 *
 * Browsers cannot set headers on a `WebSocket` constructor, so the credential
 * has to travel in the URL. It used to be the raw JWT (`?token=<jwt>`), which
 * put a long-lived credential into every proxy access log and browser history
 * entry along the way. The server now refuses that by default and instead
 * accepts `?ticket=` — a 64-hex value from `POST /api/auth/ws-ticket` that
 * lives 60 seconds and is consumed on first use (`server/shared/ws-tickets.js`).
 *
 * Two consequences for callers:
 *
 * 1. This must run on *every* connection attempt, reconnects included. Caching
 *    a ticket across attempts guarantees a rejected upgrade, because the first
 *    redemption burns it.
 * 2. It is async, and it can fail for reasons that later succeed (the request
 *    is a normal fetch). A `null` return is therefore "not now", not "never" —
 *    schedule a retry on the caller's usual backoff instead of giving up, or a
 *    single blip strands the client offline until a manual reload.
 *
 * There is deliberately no `?token=` fallback. It would only be accepted by a
 * deployment that opted into `PRISM_ALLOW_QUERY_TOKEN=1` — and such a
 * deployment can still issue tickets, so the fallback could never be the
 * difference between working and not. All it would do is leak the JWT on
 * exactly the transient failures this comment exists to describe.
 */
export async function buildAuthenticatedWebSocketUrl(path: string): Promise<string | null> {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${protocol}//${window.location.host}${path}`;

  // Platform mode authenticates the upgrade upstream and skips token checks
  // server-side (see `verifyWebSocketClient`), so there is nothing to attach.
  if (IS_PLATFORM) return base;

  if (!localStorage.getItem('auth-token')) {
    console.warn(`No authentication token found for WebSocket connection to ${path}`);
    return null;
  }

  try {
    const response = await authenticatedFetch('/api/auth/ws-ticket', { method: 'POST' });
    if (!response.ok) {
      console.warn(`Could not obtain a WebSocket ticket for ${path}: HTTP ${response.status}`);
      return null;
    }

    const ticket: unknown = (await response.json())?.ticket;
    if (typeof ticket !== 'string' || !ticket) {
      console.warn(`WebSocket ticket response for ${path} contained no ticket`);
      return null;
    }

    return `${base}?ticket=${encodeURIComponent(ticket)}`;
  } catch (error) {
    console.warn(`Failed to request a WebSocket ticket for ${path}:`, error);
    return null;
  }
}
