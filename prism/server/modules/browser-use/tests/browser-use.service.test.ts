import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';

import { browserUseService, markSessionStopped } from '@/modules/browser-use/browser-use.service.js';
import { getDataDir } from '@/utils/runtime-paths.js';

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

/**
 * Builds a session in the shape the service holds in its Map, with a
 * screenshot already captured. The cast keeps the fixture readable without
 * exporting the internal session type purely for tests.
 */
function readySessionWithScreenshot() {
  return {
    id: 'session-1',
    ownerId: 'agent',
    createdBy: 'agent',
    runtime: 'local',
    status: 'ready',
    url: 'https://example.com',
    title: 'Example',
    screenshotDataUrl: `data:image/jpeg;base64,${'A'.repeat(4096)}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastAction: 'navigate',
    message: null,
    profileName: null,
    viewport: { width: 1280, height: 720 },
    cursor: null,
  } as unknown as Parameters<typeof markSessionStopped>[0];
}

test('markSessionStopped releases the captured screenshot', () => {
  const session = readySessionWithScreenshot();

  markSessionStopped(session, {
    lastAction: 'stop',
    message: 'Browser session stopped.',
    at: Date.parse('2026-02-03T04:05:06.000Z'),
  });

  // The invariant that matters: a stopped session must not keep pinning a full
  // base64 JPEG, because only deleteSession() removes the entry from the Map.
  assert.equal(session.screenshotDataUrl, null);
  assert.equal(session.status, 'stopped');
  assert.equal(session.lastAction, 'stop');
  assert.equal(session.message, 'Browser session stopped.');
  assert.equal(session.updatedAt, '2026-02-03T04:05:06.000Z');
});

test('markSessionStopped preserves the metadata the UI needs to explain the stop', () => {
  const session = readySessionWithScreenshot();

  markSessionStopped(session, {
    lastAction: 'expire',
    message: 'Browser session expired after inactivity.',
  });

  // Dropping the screenshot must not take the rest of the record with it —
  // the panel still renders the last known page for a stopped session.
  assert.equal(session.url, 'https://example.com');
  assert.equal(session.title, 'Example');
  assert.deepEqual(session.viewport, { width: 1280, height: 720 });
  assert.equal(session.id, 'session-1');
});

/**
 * Persistent Chromium profiles used to be written to a hardcoded
 * `~/.cloudcli/browser-use/profiles`, which the one-time data-dir migration
 * renames away — leaving the service writing to a folder nothing else reads.
 */
test('browser profiles resolve under the configured data dir', () => {
  const previous = process.env.PRISM_DATA_DIR;
  try {
    process.env.PRISM_DATA_DIR = path.join(path.sep, 'tmp', 'prism-data-dir-fixture');
    assert.equal(
      path.join(getDataDir(), 'browser-use', 'profiles'),
      path.join(path.sep, 'tmp', 'prism-data-dir-fixture', 'browser-use', 'profiles'),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PRISM_DATA_DIR;
    } else {
      process.env.PRISM_DATA_DIR = previous;
    }
  }
});
