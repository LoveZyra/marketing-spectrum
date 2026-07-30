import assert from 'node:assert/strict';

import { test } from 'vitest';

import { FetchHistoryCache, type CachedHistory } from '@/modules/providers/list/claude/history-cache.js';
import { buildHistoryPage } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

function history(messageCount: number, total = messageCount): CachedHistory {
  const messages = Array.from({ length: messageCount }, (_unused, index) => ({
    id: `m${index}`,
    kind: 'text',
    content: `message ${index}`,
  })) as unknown as NormalizedMessage[];

  return { messages, total };
}

test('a hit returns the stored history for a matching fingerprint', () => {
  const cache = new FetchHistoryCache();
  cache.set('s1', 'mtime-1:100', 100, history(3));

  const hit = cache.get('s1', 'mtime-1:100');

  assert.ok(hit);
  assert.equal(hit.messages.length, 3);
  assert.equal(hit.total, 3);
});

/**
 * The failure this guards is silent data loss, not slowness: a running session
 * appends to its transcript, and serving the pre-append entry would show the
 * user a conversation that stops short of what they just sent.
 */
test('an appended transcript misses instead of serving a truncated history', () => {
  const cache = new FetchHistoryCache();
  cache.set('s1', 'mtime-1:100', 100, history(3));

  assert.equal(cache.get('s1', 'mtime-2:420'), null);
  // Dropped, not merely bypassed — a superseded fingerprint can never come back,
  // so leaving it charged against the budget would evict live entries for it.
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

test('an unknown key misses without disturbing the cache', () => {
  const cache = new FetchHistoryCache();
  cache.set('s1', 'f1', 100, history(3));

  assert.equal(cache.get('s2', 'f1'), null);
  assert.equal(cache.size, 1);
});

/**
 * Budgeting in bytes rather than entries is the whole point. Transcripts range
 * from a few KB to tens of MB, so a "keep N entries" cap would retain anywhere
 * from kilobytes to hundreds of megabytes depending on which sessions the user
 * happened to open.
 */
test('entries are evicted until the byte budget fits', () => {
  const cache = new FetchHistoryCache({ maxBytes: 1_000 });

  cache.set('a', 'f', 400, history(1));
  cache.set('b', 'f', 400, history(1));
  assert.equal(cache.bytes, 800);
  assert.equal(cache.size, 2);

  cache.set('c', 'f', 400, history(1));

  assert.equal(cache.size, 2);
  assert.equal(cache.bytes, 800);
  assert.equal(cache.get('a', 'f'), null, 'oldest entry should have been evicted');
  assert.ok(cache.get('b', 'f'));
  assert.ok(cache.get('c', 'f'));
});

test('a read makes an entry the most recently used', () => {
  const cache = new FetchHistoryCache({ maxBytes: 1_000 });
  cache.set('a', 'f', 400, history(1));
  cache.set('b', 'f', 400, history(1));

  // Touching 'a' must make 'b' the eviction candidate instead.
  assert.ok(cache.get('a', 'f'));
  cache.set('c', 'f', 400, history(1));

  assert.ok(cache.get('a', 'f'), 'recently read entry should have survived');
  assert.equal(cache.get('b', 'f'), null);
});

/**
 * Without this, opening one 40 MB session would evict the working set of every
 * other open conversation to store something that cannot be kept anyway.
 */
test('a transcript larger than the whole budget is not cached at all', () => {
  const cache = new FetchHistoryCache({ maxBytes: 1_000 });
  cache.set('small', 'f', 500, history(1));

  cache.set('huge', 'f', 5_000, history(1));

  assert.equal(cache.get('huge', 'f'), null);
  assert.ok(cache.get('small', 'f'), 'existing entries must survive an oversized insert');
  assert.equal(cache.bytes, 500);
});

test('re-setting a key replaces it without double-charging the budget', () => {
  const cache = new FetchHistoryCache({ maxBytes: 1_000 });

  cache.set('a', 'f1', 300, history(1));
  cache.set('a', 'f2', 400, history(2));

  // Only the replacement is charged. Getting this wrong leaks budget rather
  // than memory: the entries are gone but the counter still reserves their
  // bytes, so the cache slowly evicts itself down to holding nothing.
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 400);
  assert.equal(cache.get('a', 'f2')?.messages.length, 2);
});

test('clear releases everything it was holding', () => {
  const cache = new FetchHistoryCache({ maxBytes: 1_000 });
  cache.set('a', 'f', 400, history(1));

  cache.clear();

  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

/**
 * buildHistoryPage is shared by the cached and uncached read paths. If they
 * disagreed about `hasMore`, the frontend would either request older messages
 * forever or silently stop loading them, depending on which path answered.
 */
test('buildHistoryPage returns the newest page and reports more to load', () => {
  const page = buildHistoryPage(history(10), 3, 0);

  assert.equal(page.messages.length, 3);
  assert.deepEqual(page.messages.map((message) => message.id), ['m7', 'm8', 'm9']);
  assert.equal(page.hasMore, true);
  assert.equal(page.total, 10);
  assert.equal(page.offset, 0);
  assert.equal(page.limit, 3);
});

test('buildHistoryPage reports no more to load once the oldest page is reached', () => {
  const page = buildHistoryPage(history(10), 4, 6);

  assert.deepEqual(page.messages.map((message) => message.id), ['m0', 'm1', 'm2', 'm3']);
  assert.equal(page.hasMore, false);
});

test('buildHistoryPage returns the whole history when no limit is given', () => {
  const page = buildHistoryPage(history(10), null, 0);

  assert.equal(page.messages.length, 10);
  assert.equal(page.hasMore, false);
  assert.equal(page.limit, null);
});

test('buildHistoryPage clamps negative pagination instead of slicing backwards', () => {
  // Array.prototype.slice treats negative indices as offsets from the end, so an
  // unclamped negative limit or offset would silently return a wrong window
  // rather than an error.
  const page = buildHistoryPage(history(10), -5, -3);

  assert.equal(page.offset, 0);
  assert.equal(page.limit, 0);
  assert.equal(page.messages.length, 0);
  assert.equal(page.total, 10);
});

/**
 * `total` counts frontend-normalized messages excluding tool_result records, so
 * it does not equal messages.length. It is carried through the cache verbatim
 * because recomputing it from a page would report the page size to the client
 * as the conversation length.
 */
test('buildHistoryPage reports the stored total, not the page or array length', () => {
  const page = buildHistoryPage(history(10, 7), 3, 0);

  assert.equal(page.total, 7);
  assert.equal(page.messages.length, 3);
});
