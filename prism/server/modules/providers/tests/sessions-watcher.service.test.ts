import assert from 'node:assert/strict';
import path from 'node:path';

import { test } from 'vitest';

import {
  buildWatchOptions,
  nextFlushDelay,
  shouldIgnoreWatchPath,
} from '@/modules/providers/services/sessions-watcher.service.js';

const fileStats = { isDirectory: () => false };
const dirStats = { isDirectory: () => true };

test('watcher uses native filesystem events by default', () => {
  const options = buildWatchOptions({});

  assert.equal(options.usePolling, false);
  // Not merely unset to a falsy value: chokidar only reads `interval` when
  // polling, and leaving a stale one in the object invites a future edit to
  // flip usePolling back on and silently inherit a 6 s tick.
  assert.equal('interval' in options, false);
  assert.equal('binaryInterval' in options, false);
  assert.equal(options.ignoreInitial, true);
  assert.equal(options.followSymlinks, false);
});

/**
 * Native events do not reach NFS/SMB shares or some container bind mounts, and
 * there a non-polling watcher fails *silently* — no events, no error. This env
 * var is the only recovery path for those users, so it has to accept the
 * spellings people actually write in a .env file.
 */
test('PRISM_WATCH_POLL turns polling back on for filesystems without native events', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
    const options = buildWatchOptions({ PRISM_WATCH_POLL: value });
    assert.equal(options.usePolling, true, `PRISM_WATCH_POLL=${JSON.stringify(value)}`);
    assert.equal(options.interval, 6_000, `PRISM_WATCH_POLL=${JSON.stringify(value)}`);
    assert.equal(options.binaryInterval, 6_000, `PRISM_WATCH_POLL=${JSON.stringify(value)}`);
  }
});

test('PRISM_WATCH_POLL stays off for unset, empty, and non-boolean values', () => {
  // `PRISM_WATCH_POLL=` in a .env file arrives as the empty string, not
  // undefined, so an `if (env.PRISM_WATCH_POLL)` check would already be wrong.
  for (const value of [undefined, '', '   ', '0', 'false', 'no', 'off', 'maybe']) {
    const options = buildWatchOptions(value === undefined ? {} : { PRISM_WATCH_POLL: value });
    assert.equal(options.usePolling, false, `PRISM_WATCH_POLL=${JSON.stringify(value)}`);
  }
});

test('poll interval override rejects values that would spin the CPU', () => {
  assert.equal(
    buildWatchOptions({ PRISM_WATCH_POLL: '1', PRISM_WATCH_POLL_INTERVAL_MS: '30000' }).interval,
    30_000
  );

  // A zero, negative, or unparseable interval must fall back rather than be
  // handed to chokidar, which would poll the whole tree as fast as it can.
  for (const value of ['0', '-1', 'soon', '']) {
    assert.equal(
      buildWatchOptions({ PRISM_WATCH_POLL: '1', PRISM_WATCH_POLL_INTERVAL_MS: value }).interval,
      6_000,
      `PRISM_WATCH_POLL_INTERVAL_MS=${JSON.stringify(value)}`
    );
  }
});

/**
 * The previous ignore list was glob strings (`'**\/node_modules/**'`). chokidar 4
 * dropped glob support and treats a plain string as an exact path, so every one
 * of those patterns had become inert without anything failing.
 */
test('subagent transcripts are pruned from the watch tree', () => {
  const subagentFile = path.join('projects', '-home-me-app', 'sess-1', 'subagents', 'agent-9.jsonl');

  // Rejected as a file and as a directory: pruning the directory is the point,
  // since it saves a watch descriptor per session rather than per file.
  assert.equal(shouldIgnoreWatchPath(subagentFile, fileStats), true);
  assert.equal(shouldIgnoreWatchPath(path.dirname(subagentFile), dirStats), true);
  assert.equal(shouldIgnoreWatchPath(subagentFile), true);
});

test('non-transcript files are pruned but directories are always descended', () => {
  assert.equal(shouldIgnoreWatchPath(path.join('projects', 'a', 'notes.txt'), fileStats), true);
  assert.equal(shouldIgnoreWatchPath(path.join('projects', 'a', '.DS_Store'), fileStats), true);
  assert.equal(shouldIgnoreWatchPath(path.join('projects', 'a', 'sess.jsonl'), fileStats), false);
  assert.equal(shouldIgnoreWatchPath(path.join('projects', 'a'), dirStats), false);
});

/**
 * chokidar calls the matcher with no stats for paths it has not stat()ed yet.
 * Rejecting those on extension would prune whole subtrees — a project at
 * `/srv/my.app` encodes to a directory name with a dot in it — and the only
 * symptom would be a watcher that never fires.
 */
test('paths without stats are never pruned on extension alone', () => {
  assert.equal(shouldIgnoreWatchPath(path.join('projects', '-srv-my.app')), false);
  assert.equal(shouldIgnoreWatchPath(path.join('projects', 'a', 'notes.txt')), false);
});

test('nextFlushDelay debounces a fresh burst', () => {
  assert.equal(nextFlushDelay(1_000, 1_000, 300, 3_000), 300);
  assert.equal(nextFlushDelay(1_100, 1_000, 300, 3_000), 300);
});

/**
 * The starvation case this clamp exists for: a running session appends to its
 * transcript faster than the debounce window, so a plain debounce would push
 * the deadline forward forever and the sidebar would not update until the run
 * ended.
 */
test('nextFlushDelay caps total wait so a continuously written file still flushes', () => {
  assert.equal(nextFlushDelay(3_800, 1_000, 300, 3_000), 200);
  assert.equal(nextFlushDelay(4_000, 1_000, 300, 3_000), 0);
  assert.equal(nextFlushDelay(9_999, 1_000, 300, 3_000), 0);
});

test('nextFlushDelay never returns a negative delay', () => {
  // Clocks step backwards across NTP corrections and suspend/resume. A negative
  // delay is not an error in setTimeout — it fires immediately — so the guard
  // is about not letting a backwards clock defeat the coalescing entirely.
  assert.equal(nextFlushDelay(500, 1_000, 300, 3_000), 300);
});
