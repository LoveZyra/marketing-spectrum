import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAuthenticatedWebSocketUrl } from './ws-auth';

/**
 * These tests exist because this exact contract broke silently once already.
 *
 * The server was hardened to reject `?token=<jwt>` on websocket upgrades and to
 * require a single-use `?ticket=`, but the frontend kept sending the token. Every
 * server-side test still passed — the server was doing precisely what it was
 * asked to — and every client-side test still passed, because nothing asserted
 * on the URL the client builds. The whole chat feature was dead in the default
 * configuration and only a real browser hitting a real server revealed it.
 *
 * So: assert on the URL string itself, and assert that the JWT is not in it.
 */

type FetchArgs = [input: string, init?: { method?: string }];

const store = new Map<string, string>();
let fetchCalls: FetchArgs[] = [];

const stubBrowser = () => {
  store.clear();
  fetchCalls = [];
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'prism.example:3001' } });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
};

/** Installs a fetch that answers the ticket endpoint however the test wants. */
const stubFetch = (respond: () => unknown) => {
  vi.stubGlobal('fetch', (...args: FetchArgs) => {
    fetchCalls.push(args);
    return Promise.resolve(respond());
  });
};

const okTicket = (ticket: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: () => Promise.resolve({ ticket }),
});

describe('buildAuthenticatedWebSocketUrl', () => {
  beforeEach(() => {
    stubBrowser();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attaches a ticket from the ticket endpoint, never the JWT', async () => {
    store.set('auth-token', 'header.payload.signature');
    stubFetch(() => okTicket('a'.repeat(64)));

    const url = await buildAuthenticatedWebSocketUrl('/ws');

    expect(url).toBe(`ws://prism.example:3001/ws?ticket=${'a'.repeat(64)}`);
    // The regression this file guards: the credential must not be the JWT.
    expect(url).not.toContain('token=');
    expect(url).not.toContain('header.payload.signature');
    expect(fetchCalls[0][0]).toBe('/api/auth/ws-ticket');
    expect(fetchCalls[0][1]?.method).toBe('POST');
  });

  it('upgrades the scheme to wss on an https page', async () => {
    vi.stubGlobal('window', { location: { protocol: 'https:', host: 'prism.example' } });
    store.set('auth-token', 'a.b.c');
    stubFetch(() => okTicket('t'));

    expect(await buildAuthenticatedWebSocketUrl('/shell')).toBe(
      'wss://prism.example/shell?ticket=t',
    );
  });

  it('percent-encodes the ticket rather than splicing it in raw', async () => {
    store.set('auth-token', 'a.b.c');
    stubFetch(() => okTicket('has spaces&and=specials'));

    expect(await buildAuthenticatedWebSocketUrl('/ws')).toBe(
      'ws://prism.example:3001/ws?ticket=has%20spaces%26and%3Dspecials',
    );
  });

  it('requests a new ticket for every call, because tickets are single-use', async () => {
    store.set('auth-token', 'a.b.c');
    let n = 0;
    stubFetch(() => okTicket(`ticket-${++n}`));

    const first = await buildAuthenticatedWebSocketUrl('/ws');
    const second = await buildAuthenticatedWebSocketUrl('/ws');

    expect(first).toContain('ticket-1');
    expect(second).toContain('ticket-2');
    expect(fetchCalls).toHaveLength(2);
  });

  it('returns null without calling the API when there is no stored token', async () => {
    stubFetch(() => okTicket('unused'));

    expect(await buildAuthenticatedWebSocketUrl('/ws')).toBeNull();
    expect(fetchCalls).toHaveLength(0);
  });

  it.each([
    ['a non-OK response', () => ({ ok: false, status: 503, headers: { get: () => null } })],
    ['a body with no ticket', () => okTicket(undefined)],
    ['a non-string ticket', () => okTicket(12345)],
    ['an empty-string ticket', () => okTicket('')],
  ])('returns null on %s rather than a credential-less URL', async (_label, respond) => {
    store.set('auth-token', 'a.b.c');
    stubFetch(respond);

    // Null means "retry later". Returning the bare URL would produce an
    // unauthenticated upgrade that the server refuses, and the caller would
    // read that as a connection problem instead of an auth one.
    expect(await buildAuthenticatedWebSocketUrl('/ws')).toBeNull();
  });

  it('returns null when the ticket request throws', async () => {
    store.set('auth-token', 'a.b.c');
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));

    await expect(buildAuthenticatedWebSocketUrl('/ws')).resolves.toBeNull();
  });
});
