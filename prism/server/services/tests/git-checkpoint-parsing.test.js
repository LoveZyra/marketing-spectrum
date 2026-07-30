/**
 * Unit tests for the pure parsing/decision helpers of the git-checkpoint
 * service:
 *   - parseNumstatZ / parseNameStatusZ: NUL-separated (`-z`) diff parsers,
 *     exercised with byte-for-byte captures of real `git diff --numstat -z -M`
 *     and `git diff --name-status -z -M` output (git 2.x) from a repo
 *     containing CJK filenames, renames (pure + content-changing), and paths
 *     with spaces.
 *   - assessSnapshotCompleteness: the incomplete-checkpoint decision used to
 *     refuse deleting untracked files on restore when the snapshot was
 *     truncated.
 *
 * Test style note: written in vitest import style (describe/it blocks with
 * top-level named imports). vitest itself is not a dependency of this repo —
 * the runner is node:test, matching the other suites under services/tests.
 * To move to vitest later, only the two import lines change
 * (`import { describe, it, expect } from 'vitest'`).
 *
 * Run: node --test server/services/tests/git-checkpoint-parsing.test.js
 */

import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  INCOMPLETE_TOO_MANY_UNTRACKED,
  INCOMPLETE_UNTRACKED_BYTES_BUDGET,
  assessSnapshotCompleteness,
  parseNameStatusZ,
  parseNumstatZ,
} from '../git-checkpoint.js';

/**
 * Captured from a real repo (see header) after:
 *   - deleting keep.txt
 *   - renaming "file with space.txt" -> "renamed with space.txt" (+1 line)
 *   - purely renaming "sub/旧名字.txt" -> "sub/新名字.txt"
 *   - adding "新增文件.txt"
 *   - modifying "测试文件.txt" (+1 line)
 * Rename records carry an EMPTY inline path ("added\tdeleted\t") followed by
 * the old and new paths as separate NUL-terminated fields.
 */
const REAL_NUMSTAT_Z = '0\t1\tkeep.txt\0'
  + '1\t0\t\0file with space.txt\0renamed with space.txt\0'
  + '0\t0\t\0sub/旧名字.txt\0sub/新名字.txt\0'
  + '1\t0\t新增文件.txt\0'
  + '1\t0\t测试文件.txt\0';

/** Captured `git diff --name-status -M -z` for the same tree state. */
const REAL_NAME_STATUS_Z = 'D\0keep.txt\0'
  + 'R075\0file with space.txt\0renamed with space.txt\0'
  + 'R100\0sub/旧名字.txt\0sub/新名字.txt\0'
  + 'A\0新增文件.txt\0'
  + 'M\0测试文件.txt\0';

describe('parseNumstatZ', () => {
  it('parses plain, CJK, and spaced paths from real -z output', () => {
    const entries = parseNumstatZ(REAL_NUMSTAT_Z);
    assert.equal(entries.length, 5);

    assert.deepEqual(entries[0], {
      path: 'keep.txt', oldPath: null, additions: 0, deletions: 1,
    });
    assert.deepEqual(entries[3], {
      path: '新增文件.txt', oldPath: null, additions: 1, deletions: 0,
    });
    assert.deepEqual(entries[4], {
      path: '测试文件.txt', oldPath: null, additions: 1, deletions: 0,
    });
  });

  it('parses rename records (empty inline path + two NUL fields), including CJK and spaces', () => {
    const entries = parseNumstatZ(REAL_NUMSTAT_Z);

    assert.deepEqual(entries[1], {
      path: 'renamed with space.txt',
      oldPath: 'file with space.txt',
      additions: 1,
      deletions: 0,
    });
    assert.deepEqual(entries[2], {
      path: 'sub/新名字.txt',
      oldPath: 'sub/旧名字.txt',
      additions: 0,
      deletions: 0,
    });
  });

  it('maps binary "-" counters to null, for plain and rename records', () => {
    const entries = parseNumstatZ('-\t-\tbin.dat\0-\t-\t\0旧图.png\0新图.png\0');
    assert.deepEqual(entries, [
      { path: 'bin.dat', oldPath: null, additions: null, deletions: null },
      { path: '新图.png', oldPath: '旧图.png', additions: null, deletions: null },
    ]);
  });

  it('handles paths containing tabs (only the first two tabs are separators)', () => {
    const entries = parseNumstatZ('2\t3\tweird\tname.txt\0');
    assert.deepEqual(entries, [
      { path: 'weird\tname.txt', oldPath: null, additions: 2, deletions: 3 },
    ]);
  });

  it('returns [] for empty output and ignores stray records', () => {
    assert.deepEqual(parseNumstatZ(''), []);
    assert.deepEqual(parseNumstatZ('\0'), []);
    assert.deepEqual(parseNumstatZ('not-a-numstat-line\0'), []);
  });

  it('does not throw on a truncated rename record', () => {
    const entries = parseNumstatZ('1\t0\t\0only-old-path.txt');
    assert.deepEqual(entries, []);
  });
});

describe('parseNameStatusZ', () => {
  it('parses the real capture: delete, two renames (R075/R100), add, modify', () => {
    const entries = parseNameStatusZ(REAL_NAME_STATUS_Z);
    assert.deepEqual(entries, [
      { status: 'D', path: 'keep.txt', oldPath: null },
      { status: 'R075', path: 'renamed with space.txt', oldPath: 'file with space.txt' },
      { status: 'R100', path: 'sub/新名字.txt', oldPath: 'sub/旧名字.txt' },
      { status: 'A', path: '新增文件.txt', oldPath: null },
      { status: 'M', path: '测试文件.txt', oldPath: null },
    ]);
  });

  it('treats copy records (C###) as two-path records too', () => {
    const entries = parseNameStatusZ('C075\0模板.md\0副本.md\0M\0其他.md\0');
    assert.deepEqual(entries, [
      { status: 'C075', path: '副本.md', oldPath: '模板.md' },
      { status: 'M', path: '其他.md', oldPath: null },
    ]);
  });

  it('returns [] for empty output and survives truncated records', () => {
    assert.deepEqual(parseNameStatusZ(''), []);
    assert.deepEqual(parseNameStatusZ('\0'), []);
    assert.deepEqual(parseNameStatusZ('R100\0old-only.txt'), []);
    assert.deepEqual(parseNameStatusZ('M'), []);
  });
});

describe('assessSnapshotCompleteness', () => {
  it('is complete when the count is within the cap and the budget held', () => {
    assert.deepEqual(
      assessSnapshotCompleteness({ untrackedCount: 5, budgetExhausted: false }),
      { incomplete: false, reason: null },
    );
  });

  it('is complete at exactly the file cap (boundary)', () => {
    assert.deepEqual(
      assessSnapshotCompleteness({ untrackedCount: 100, budgetExhausted: false, maxFiles: 100 }),
      { incomplete: false, reason: null },
    );
  });

  it('flags too_many_untracked when the enumeration exceeds the cap', () => {
    assert.deepEqual(
      assessSnapshotCompleteness({ untrackedCount: 101, budgetExhausted: false, maxFiles: 100 }),
      { incomplete: true, reason: INCOMPLETE_TOO_MANY_UNTRACKED },
    );
  });

  it('uses the default 2000-file cap when maxFiles is omitted', () => {
    assert.equal(
      assessSnapshotCompleteness({ untrackedCount: 2000, budgetExhausted: false }).incomplete,
      false,
    );
    assert.deepEqual(
      assessSnapshotCompleteness({ untrackedCount: 2001, budgetExhausted: false }),
      { incomplete: true, reason: INCOMPLETE_TOO_MANY_UNTRACKED },
    );
  });

  it('flags untracked_bytes_budget when the byte budget stopped the snapshot', () => {
    assert.deepEqual(
      assessSnapshotCompleteness({ untrackedCount: 3, budgetExhausted: true }),
      { incomplete: true, reason: INCOMPLETE_UNTRACKED_BYTES_BUDGET },
    );
  });

  it('prioritizes too_many_untracked when both conditions hold (keep-set loss is worse)', () => {
    assert.deepEqual(
      assessSnapshotCompleteness({ untrackedCount: 101, budgetExhausted: true, maxFiles: 100 }),
      { incomplete: true, reason: INCOMPLETE_TOO_MANY_UNTRACKED },
    );
  });
});
