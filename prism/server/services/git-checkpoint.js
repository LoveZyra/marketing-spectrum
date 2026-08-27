/**
 * Git checkpoint service (ported from claude-web-ui 2.0 `git-v2` checkpoints).
 *
 * Before every Claude turn that runs inside a Git repository, a checkpoint of
 * the full working-tree state is captured WITHOUT touching the working tree:
 *   1. `git stash create` produces a dangling commit holding staged + unstaged
 *      changes (empty when the tree is clean).
 *   2. A dedicated ref (`refs/prism/checkpoints/<id>`) pins that commit so
 *      git GC can never collect it.
 *   3. Untracked files are snapshotted (copied) into the checkpoint store.
 *      When PRISM_CHECKPOINT_INCLUDE_IGNORED=1, gitignored files are
 *      snapshotted too (same byte budget, default OFF).
 *
 * Restore is transactional: a safety checkpoint of the CURRENT state is taken
 * first; if any restore step fails, the safety checkpoint is applied to put
 * the tree back exactly where the user was when they clicked "rollback".
 *
 * Safety invariants (see the individual functions for details):
 *   - A checkpoint whose untracked enumeration or snapshot was truncated is
 *     marked `incomplete`; restoring it NEVER deletes untracked files (the
 *     keep-set cannot be trusted) and requires an explicit `force`.
 *   - Restore refuses (409-style result) when commits were made after the
 *     checkpoint, unless forced — `git reset --hard` would silently move the
 *     branch pointer past them.
 *   - Restore aborts (422-style result) when the pre-restore safety
 *     checkpoint cannot be created while HEAD exists.
 *   - All mutating operations on the same directory (realpath-keyed)
 *     serialize through an in-process promise-chain mutex.
 *
 * Store layout:  ~/.prism/checkpoints/<checkpointId>/
 *   meta.json            checkpoint metadata (session, cwd, head, stash, ...)
 *   untracked/<path>     snapshot of every untracked file at checkpoint time
 */

import { execFile } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { getDataDir } from '../utils/runtime-paths.js';

const CHECKPOINT_TYPE = 'git-v2';
const MAX_UNTRACKED_FILES = 2000;
const MAX_UNTRACKED_BYTES = 200 * 1024 * 1024; // 200MB snapshot budget per checkpoint
const DIFF_FILE_LIMIT = 80_000; // per-file unified diff cap (chars)
const DIFF_TURN_LIMIT = 240_000; // whole-turn diff cap (chars)
const CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // prune checkpoints older than 7 days
const MAX_CHECKPOINTS_PER_SESSION = 40;
const MAX_REPORTED_COMMITS = 20; // commit details listed in a COMMITS_AFTER_CHECKPOINT refusal
const REUSE_SCAN_LIMIT = 200; // newest checkpoint dirs scanned when looking for a reusable snapshot

/** Reasons a checkpoint snapshot can be incomplete (meta.incompleteReason). */
export const INCOMPLETE_TOO_MANY_UNTRACKED = 'too_many_untracked';
export const INCOMPLETE_UNTRACKED_BYTES_BUDGET = 'untracked_bytes_budget';

/** `cp-<base36 毫秒>-<hex>` → 毫秒时间戳;不是 checkpoint 目录名就返回 null。 */
function checkpointIdTime(name) {
  const match = /^cp-([0-9a-z]+)-[0-9a-f]+$/.exec(name);
  if (!match) return null;
  const at = parseInt(match[1], 36);
  return Number.isFinite(at) ? at : null;
}

export function getCheckpointRoot() {
  return process.env.PRISM_CHECKPOINT_DIR
    || path.join(getDataDir(), 'checkpoints');
}

function run(cwd, args, options = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeoutMs || 60_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
      });
    });
  });
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- *
 *  Directory-level mutex
 * ------------------------------------------------------------------------- */

/**
 * In-process serialization of mutating checkpoint operations per directory.
 * Keyed by realpath so two sessions pointing at the same tree through
 * different paths (symlinks) still serialize. Values are promise-chain tails.
 */
const cwdLocks = new Map();

/** Realpath of a directory, falling back to a resolved path when it fails. */
export async function resolveRealPath(target) {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Queue `task` behind every other mutating checkpoint operation targeting the
 * same (real) directory. Concurrent create/restore/revert calls on one cwd
 * run strictly one-at-a-time, in arrival order; different cwds do not block
 * each other. Rejections propagate to the caller but never poison the queue.
 */
export async function withCwdLock(cwd, task) {
  const key = await resolveRealPath(cwd);
  const previous = cwdLocks.get(key) || Promise.resolve();
  const current = previous.then(task);
  const tail = current.catch(() => {});
  cwdLocks.set(key, tail);
  try {
    return await current;
  } finally {
    if (cwdLocks.get(key) === tail) {
      cwdLocks.delete(key);
    }
  }
}

/* ------------------------------------------------------------------------- *
 *  Git plumbing helpers
 * ------------------------------------------------------------------------- */

export async function isGitRepository(cwd) {
  if (!cwd) return false;
  if (!(await pathExists(cwd))) return false;
  const result = await run(cwd, ['rev-parse', '--git-dir']);
  return result.ok;
}

async function gitHead(cwd) {
  const result = await run(cwd, ['rev-parse', 'HEAD']);
  return result.ok ? result.stdout.trim() : null;
}

/** Untracked file list, honoring .gitignore, NUL-separated for exotic names. */
async function untrackedPaths(cwd) {
  const result = await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!result.ok) return [];
  return result.stdout.split('\0').filter(Boolean);
}

/** Gitignored files (only used when PRISM_CHECKPOINT_INCLUDE_IGNORED=1). */
async function ignoredFilePaths(cwd) {
  const result = await run(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  if (!result.ok) return [];
  return result.stdout.split('\0').filter(Boolean);
}

/** True when the repo has submodules (gitlinks) — those are NOT checkpointed. */
async function detectSubmodules(cwd) {
  if (await pathExists(path.join(cwd, '.gitmodules'))) return true;
  const status = await run(cwd, ['submodule', 'status']);
  return status.ok && status.stdout.trim().length > 0;
}

/* ------------------------------------------------------------------------- *
 *  NUL-separated diff parsers (pure, exported for tests)
 * ------------------------------------------------------------------------- */

/**
 * Parse `git diff --numstat -z` output.
 *
 * Record formats (verified against git 2.x):
 *   normal:  "<added>\t<deleted>\t<path>" NUL
 *   rename:  "<added>\t<deleted>\t" NUL <oldpath> NUL <newpath> NUL
 *            (the inline path field is EMPTY; the two paths follow as
 *            separate NUL-terminated fields)
 * Binary files report "-" for both counters.
 *
 * Returns [{ path, oldPath (null unless rename/copy), additions, deletions }]
 * where additions/deletions are numbers or null (binary).
 */
export function parseNumstatZ(output) {
  const entries = [];
  if (!output) return entries;
  const tokens = output.split('\0');
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const firstTab = token.indexOf('\t');
    const secondTab = firstTab === -1 ? -1 : token.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue; // not a numstat record
    const added = token.slice(0, firstTab);
    const deleted = token.slice(firstTab + 1, secondTab);
    const inlinePath = token.slice(secondTab + 1);
    let filePath = inlinePath;
    let oldPath = null;
    if (!inlinePath) {
      // Rename/copy record: the next two NUL fields are old and new paths.
      oldPath = tokens[index + 1];
      filePath = tokens[index + 2];
      index += 2;
      if (oldPath === undefined || filePath === undefined) break; // truncated output
    }
    entries.push({
      path: filePath,
      oldPath,
      additions: added === '-' ? null : parseInt(added, 10) || 0,
      deletions: deleted === '-' ? null : parseInt(deleted, 10) || 0,
    });
  }
  return entries;
}

/**
 * Parse `git diff --name-status -z` output.
 *
 * Record formats:
 *   normal:       <STATUS> NUL <path> NUL          (A/M/D/T/U/X…)
 *   rename/copy:  R<score>|C<score> NUL <oldpath> NUL <newpath> NUL
 *
 * Returns [{ status (raw, e.g. "R075"), path, oldPath|null }].
 */
export function parseNameStatusZ(output) {
  const entries = [];
  if (!output) return entries;
  const tokens = output.split('\0');
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    if (!status) {
      index += 1;
      continue;
    }
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      index += 3;
      if (oldPath === undefined || newPath === undefined) break; // truncated output
      entries.push({ status, path: newPath, oldPath });
    } else {
      const filePath = tokens[index + 1];
      index += 2;
      if (filePath === undefined) break; // truncated output
      entries.push({ status, path: filePath, oldPath: null });
    }
  }
  return entries;
}

/* ------------------------------------------------------------------------- *
 *  Incomplete-snapshot decision (pure, exported for tests)
 * ------------------------------------------------------------------------- */

/**
 * Decide whether a checkpoint's untracked snapshot is complete enough that a
 * restore may safely DELETE untracked files missing from the keep-set.
 *
 * - More untracked files than `maxFiles` → the keep-set itself is truncated:
 *   files beyond the cap would be wrongly deleted on restore. Worst case, so
 *   it wins when both conditions hold.
 * - Byte budget exhausted → every file is LISTED (keep-set complete) but not
 *   every file's CONTENT was saved; a restore could not put the tree back
 *   faithfully, and per-file provenance can't be verified.
 *
 * @param {{ untrackedCount: number, budgetExhausted: boolean, maxFiles?: number }} input
 * @returns {{ incomplete: boolean, reason: string|null }}
 */
export function assessSnapshotCompleteness({ untrackedCount, budgetExhausted, maxFiles = MAX_UNTRACKED_FILES }) {
  if (untrackedCount > maxFiles) {
    return { incomplete: true, reason: INCOMPLETE_TOO_MANY_UNTRACKED };
  }
  if (budgetExhausted) {
    return { incomplete: true, reason: INCOMPLETE_UNTRACKED_BYTES_BUDGET };
  }
  return { incomplete: false, reason: null };
}

/* ------------------------------------------------------------------------- *
 *  Snapshot + create
 * ------------------------------------------------------------------------- */

/**
 * Snapshot untracked files into the checkpoint store.
 * Symlinks are re-created as symlinks; regular files are copied.
 *
 * E9 —— 增量快照:每回合都全量 copyFile 一遍 untracked,在带 node_modules /
 * 构建产物的仓库里就是每轮几百 MB 的纯浪费。这里带上一份「上一份 checkpoint
 * 存过什么」的索引(`reuse`),同一路径只要 **size + mtimeMs + inode 三者全同**
 * 就用硬链接指向上一份的副本:没有读写、没有额外磁盘,内容与 copy 逐字节相同。
 * 判据比 git 自己的 stat 缓存还严一档(git 只看 size+mtime),因为多存一个
 * inode 几乎不要钱,却能挡住"改完再改回同样大小、mtime 被 touch 回去"这种
 * 极端替换。链接失败(跨设备 EXDEV / 文件系统不支持 EPERM / 上一份已被清理
 * ENOENT)一律静默回落成 copyFile,不影响正确性。
 *
 * 硬链接共享 inode:老 checkpoint 被 TTL 清掉时只掉一个链接数,新 checkpoint
 * 里的那份照样在;restore 走的是 copyFile(store → 工作区),也不会把 store 的
 * inode 带进工作区。
 *
 * @returns {{ stored: Array, totalBytes: number, budgetExhausted: boolean, linked: number }}
 *   `budgetExhausted` is true when MAX_UNTRACKED_BYTES stopped the snapshot
 *   before every listed file's content was saved. 复用成硬链接的字节**不计入**
 *   预算 —— 预算管的是这份 checkpoint 真正占的磁盘,而硬链接一个字节不占,
 *   且那份内容确实已经完整存下(不能因此判 incomplete)。
 */
async function snapshotUntracked(cwd, checkpointDir, paths, { startBytes = 0, markIgnored = false, reuse = null } = {}) {
  const stored = [];
  let totalBytes = startBytes;
  let budgetExhausted = false;
  let linked = 0;

  for (const relPath of paths) {
    const source = path.join(cwd, relPath);
    const target = path.join(checkpointDir, 'untracked', relPath);
    try {
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const linkTarget = await fs.readlink(source);
        await fs.symlink(linkTarget, target);
        stored.push(markIgnored
          ? { path: relPath, symlink: true, ignored: true }
          : { path: relPath, symlink: true });
        continue;
      }
      if (!stat.isFile()) continue;

      const entry = markIgnored
        ? { path: relPath, symlink: false, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, ignored: true }
        : { path: relPath, symlink: false, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };

      const previous = reuse ? reuse.get(relPath) : null;
      if (previous
        && previous.size === stat.size
        && previous.mtimeMs === stat.mtimeMs
        && previous.ino === stat.ino) {
        try {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.link(previous.storePath, target);
          entry.linked = true;
          stored.push(entry);
          linked += 1;
          continue;
        } catch {
          // 上一份被清了 / 跨设备 / 文件系统不支持 —— 回落成普通拷贝。
        }
      }

      totalBytes += stat.size;
      if (totalBytes > MAX_UNTRACKED_BYTES) {
        budgetExhausted = true;
        break;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      stored.push(entry);
    } catch (error) {
      console.warn(`[Checkpoint] Skipping untracked snapshot for ${relPath}:`, error.message);
    }
  }

  return { stored, totalBytes, budgetExhausted, linked };
}

/**
 * 上一份 checkpoint(同一个 cwd,最新的那份)存过的 untracked 文件索引,
 * 供 snapshotUntracked 判定"这个文件没变,直接硬链过来"。
 *
 * 只取最新一份就够:文件一直没动的话,每一轮都会从上一轮链过来,链条自己
 * 往前接。带 `linked` 的条目同样可复用 —— 硬链接的硬链接还是同一个 inode。
 */
export async function buildUntrackedReuseIndex(cwd) {
  const index = new Map();
  const resolvedCwd = path.resolve(cwd);
  let entries = [];
  try {
    entries = await fs.readdir(getCheckpointRoot());
  } catch {
    return index;
  }

  // 不走 listCheckpoints():那会把整个 store 的 meta.json 全 parse 一遍,而这里
  // 每回合都要跑。checkpoint id 形如 `cp-<base36 毫秒>-<hex>`,按时间戳倒序扫,
  // 命中同一个 cwd 就停 —— 正常情况下第一条就是。
  const ordered = entries
    .map((name) => ({ name, at: checkpointIdTime(name) }))
    .filter((item) => item.at !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, REUSE_SCAN_LIMIT);

  let previous = null;
  for (const item of ordered) {
    const meta = await readCheckpoint(item.name);
    if (meta && meta.cwd === resolvedCwd) {
      previous = meta;
      break;
    }
  }
  if (!previous || !Array.isArray(previous.untrackedStored)) return index;

  const previousDir = path.join(getCheckpointRoot(), previous.id, 'untracked');
  for (const entry of previous.untrackedStored) {
    if (!entry || entry.symlink) continue;
    if (typeof entry.size !== 'number' || typeof entry.mtimeMs !== 'number' || typeof entry.ino !== 'number') continue;
    index.set(entry.path, {
      storePath: path.join(previousDir, entry.path),
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ino: entry.ino,
    });
  }
  return index;
}

/**
 * Create a checkpoint of the current working tree. Never modifies the tree.
 * Returns checkpoint metadata, or null when cwd is not a git repository.
 * Serialized against restore/revert on the same directory.
 */
export async function createCheckpoint(cwd, context = {}) {
  if (!(await isGitRepository(cwd))) return null;
  return withCwdLock(cwd, () => createCheckpointLocked(cwd, context));
}

/**
 * Lock-free body of createCheckpoint. Callers must either hold the cwd lock
 * (restore's safety checkpoint) or go through the public wrapper.
 */
async function createCheckpointLocked(cwd, context = {}) {
  const head = await gitHead(cwd);
  if (!head) return null; // unborn branch (no commits yet) — nothing to anchor to

  const id = `cp-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const checkpointDir = path.join(getCheckpointRoot(), id);

  // 1. Dangling stash commit capturing staged + unstaged state.
  let stash = null;
  const stashResult = await run(cwd, ['stash', 'create', `prism checkpoint ${id}`]);
  if (stashResult.ok && stashResult.stdout.trim()) {
    stash = stashResult.stdout.trim();
    // 2. Pin the commit with a dedicated ref so GC cannot collect it.
    const refResult = await run(cwd, ['update-ref', `refs/prism/checkpoints/${id}`, stash]);
    if (!refResult.ok) {
      console.warn('[Checkpoint] Failed to pin stash ref:', refResult.stderr);
    }
  }

  // 3. Snapshot untracked files.(E9:能硬链就不拷贝,见 snapshotUntracked)
  const untracked = await untrackedPaths(cwd);
  const listedUntracked = untracked.slice(0, MAX_UNTRACKED_FILES);
  await fs.mkdir(checkpointDir, { recursive: true });
  const reuse = listedUntracked.length > 0 ? await buildUntrackedReuseIndex(cwd) : null;
  const snapshot = listedUntracked.length > 0
    ? await snapshotUntracked(cwd, checkpointDir, listedUntracked, { reuse })
    : { stored: [], totalBytes: 0, budgetExhausted: false, linked: 0 };
  const untrackedStored = snapshot.stored;
  let untrackedLinked = snapshot.linked || 0;

  // 3b. Optionally snapshot gitignored files too (opt-in, shared byte budget).
  // Ignored files never appear in the restore keep-set NOR in the delete
  // enumeration (both use --exclude-standard), so truncation here cannot
  // cause deletions — it is recorded but does not mark the checkpoint
  // incomplete.
  let ignoredIncluded = false;
  let ignoredTruncated = false;
  let ignoredStoredCount = 0;
  if (process.env.PRISM_CHECKPOINT_INCLUDE_IGNORED === '1' && !snapshot.budgetExhausted) {
    const ignored = await ignoredFilePaths(cwd);
    if (ignored.length > 0) {
      ignoredIncluded = true;
      const ignoredSnapshot = await snapshotUntracked(cwd, checkpointDir, ignored.slice(0, MAX_UNTRACKED_FILES), {
        startBytes: snapshot.totalBytes,
        markIgnored: true,
        reuse,
      });
      untrackedStored.push(...ignoredSnapshot.stored);
      untrackedLinked += ignoredSnapshot.linked || 0;
      ignoredStoredCount = ignoredSnapshot.stored.length;
      ignoredTruncated = ignoredSnapshot.budgetExhausted || ignored.length > MAX_UNTRACKED_FILES;
    }
  }

  // 4. Completeness: can a restore trust the keep-set enough to delete files?
  const completeness = assessSnapshotCompleteness({
    untrackedCount: untracked.length,
    budgetExhausted: snapshot.budgetExhausted,
  });

  const hasSubmodules = await detectSubmodules(cwd);

  const meta = {
    type: CHECKPOINT_TYPE,
    id,
    cwd: path.resolve(cwd),
    sessionId: context.sessionId || null,
    appSessionId: context.appSessionId || null,
    prompt: typeof context.prompt === 'string' ? context.prompt.slice(0, 200) : null,
    head,
    stash,
    ref: stash ? `refs/prism/checkpoints/${id}` : null,
    untracked: listedUntracked,
    untrackedTotal: untracked.length,
    untrackedStored,
    createdAt: new Date().toISOString(),
  };
  if (completeness.incomplete) {
    meta.incomplete = true;
    meta.incompleteReason = completeness.reason;
  }
  if (hasSubmodules) meta.hasSubmodules = true;
  // 复用了多少份(观测用:0 说明这轮全是新拷贝)。
  if (untrackedLinked > 0) meta.untrackedLinked = untrackedLinked;
  if (ignoredIncluded) {
    meta.ignoredIncluded = true;
    meta.ignoredStoredCount = ignoredStoredCount;
    if (ignoredTruncated) meta.ignoredTruncated = true;
  }

  await fs.writeFile(path.join(checkpointDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * Late-bind the provider session id onto a checkpoint. New conversations only
 * learn their native session id after the first turn starts, so the turn
 * runner patches it in once known.
 */
export async function updateCheckpointSession(id, sessionId) {
  const meta = await readCheckpoint(id);
  if (!meta || !sessionId || meta.sessionId === sessionId) return meta;
  meta.sessionId = sessionId;
  try {
    await fs.writeFile(
      path.join(getCheckpointRoot(), id, 'meta.json'),
      JSON.stringify(meta, null, 2)
    );
  } catch (error) {
    console.warn(`[Checkpoint] Failed to update session id for ${id}:`, error.message);
  }
  return meta;
}

export async function readCheckpoint(id) {
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const raw = await fs.readFile(path.join(getCheckpointRoot(), id, 'meta.json'), 'utf8');
    const meta = JSON.parse(raw);
    return meta?.type === CHECKPOINT_TYPE ? meta : null;
  } catch {
    return null;
  }
}

export async function listCheckpoints({ sessionId, appSessionId, cwd } = {}) {
  const root = getCheckpointRoot();
  let entries = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const checkpoints = [];
  for (const entry of entries) {
    const meta = await readCheckpoint(entry);
    if (!meta) continue;
    if (sessionId && meta.sessionId !== sessionId && meta.appSessionId !== sessionId) continue;
    if (appSessionId && meta.appSessionId !== appSessionId && meta.sessionId !== appSessionId) continue;
    if (cwd && meta.cwd !== path.resolve(cwd)) continue;
    checkpoints.push(meta);
  }

  checkpoints.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return checkpoints;
}

/* ------------------------------------------------------------------------- *
 *  Restore
 * ------------------------------------------------------------------------- */

/**
 * Commits reachable from HEAD but not from the checkpoint head — i.e. commits
 * made during/after the turn that a `reset --hard` restore would pull the
 * branch pointer back past. Details capped at MAX_REPORTED_COMMITS.
 */
export async function commitsSinceCheckpoint(cwd, head) {
  if (!head) return { count: 0, commits: [] };
  const countResult = await run(cwd, ['rev-list', '--count', `${head}..HEAD`]);
  if (!countResult.ok) return { count: 0, commits: [] };
  const count = parseInt(countResult.stdout.trim(), 10) || 0;
  if (count === 0) return { count: 0, commits: [] };

  // NUL separators everywhere: subjects may contain tabs or any non-NUL byte.
  const logResult = await run(cwd, [
    'log', '-z', '--format=%H%x00%s', '-n', String(MAX_REPORTED_COMMITS), `${head}..HEAD`,
  ]);
  const commits = [];
  if (logResult.ok) {
    const tokens = logResult.stdout.split('\0');
    for (let index = 0; index + 1 < tokens.length; index += 2) {
      const hash = tokens[index];
      if (!/^[0-9a-f]{7,64}$/i.test(hash)) break;
      commits.push({ hash, subject: tokens[index + 1] ?? '' });
    }
  }
  return { count, commits };
}

async function removeUntrackedCreatedAfter(cwd, meta) {
  const keep = new Set(meta.untracked || []);
  const current = await untrackedPaths(cwd);
  for (const relPath of current) {
    if (keep.has(relPath)) continue;
    try {
      await fs.rm(path.join(cwd, relPath), { force: true });
    } catch (error) {
      console.warn(`[Checkpoint] Failed to remove new untracked file ${relPath}:`, error.message);
    }
  }
}

async function restoreUntrackedSnapshot(cwd, meta) {
  const checkpointDir = path.join(getCheckpointRoot(), meta.id);
  for (const entry of meta.untrackedStored || []) {
    const source = path.join(checkpointDir, 'untracked', entry.path);
    const target = path.join(cwd, entry.path);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (entry.symlink) {
        const linkTarget = await fs.readlink(source);
        await fs.rm(target, { force: true });
        await fs.symlink(linkTarget, target);
      } else {
        await fs.copyFile(source, target);
      }
    } catch (error) {
      console.warn(`[Checkpoint] Failed to restore untracked file ${entry.path}:`, error.message);
    }
  }
}

/**
 * Apply a checkpoint: three-step restore.
 *   1. `git reset --hard <head>` — return tracked files to the checkpoint base
 *   2. delete untracked files that appeared after the checkpoint — SKIPPED
 *      whenever `meta.incomplete`: the keep-set may be missing files that
 *      already existed at checkpoint time, so deleting "unknown" files could
 *      destroy user data. Skipping is unconditional (even under force).
 *   3. `git stash apply --index <stash>` — replay staged/unstaged state,
 *      then restore untracked snapshots
 * Throws on hard failures so the caller can run its transaction logic.
 *
 * @returns {{ skippedUntrackedCleanup: boolean }}
 */
async function applyCheckpoint(cwd, meta) {
  const reset = await run(cwd, ['reset', '--hard', meta.head]);
  if (!reset.ok) {
    throw new Error(`git reset --hard failed: ${reset.stderr || reset.stdout}`);
  }

  const skippedUntrackedCleanup = Boolean(meta.incomplete);
  if (!skippedUntrackedCleanup) {
    await removeUntrackedCreatedAfter(cwd, meta);
  }

  if (meta.stash) {
    let apply = await run(cwd, ['stash', 'apply', '--index', meta.stash]);
    if (!apply.ok) {
      // --index can fail on exotic index states; retry without it so at least
      // the content is restored (staged/unstaged split may be lost).
      apply = await run(cwd, ['stash', 'apply', meta.stash]);
      if (!apply.ok) {
        throw new Error(`git stash apply failed: ${apply.stderr || apply.stdout}`);
      }
    }
  }

  await restoreUntrackedSnapshot(cwd, meta);
  return { skippedUntrackedCleanup };
}

/**
 * Transactional restore. Takes a safety checkpoint of the current state first;
 * if the restore fails, the safety checkpoint is applied so the user gets back
 * the exact tree they had when they clicked "rollback".
 *
 * Refusal results carry `status` (HTTP-ish) and `code` so callers can map
 * them directly:
 *   409 COMMITS_AFTER_CHECKPOINT  commits exist in meta.head..HEAD (unless force)
 *   409 CHECKPOINT_INCOMPLETE     snapshot truncated (unless force)
 *   422 SAFETY_CHECKPOINT_FAILED  no recovery point could be taken while HEAD exists
 * When both 409 conditions hold, `codes` lists them all and the commit/reason
 * details are included so a single confirmation can cover everything.
 *
 * Even with force, an incomplete checkpoint's restore NEVER deletes untracked
 * files — the delete phase is skipped and reported via
 * `skippedUntrackedCleanup` / `skippedUntrackedCleanupReason`.
 */
export async function restoreCheckpoint(id, options = {}) {
  const force = Boolean(options.force);
  const meta = await readCheckpoint(id);
  if (!meta) {
    return { ok: false, status: 404, error: 'Checkpoint not found' };
  }
  const cwd = meta.cwd;
  if (!(await isGitRepository(cwd))) {
    return { ok: false, status: 422, error: `Not a git repository: ${cwd}` };
  }

  return withCwdLock(cwd, async () => {
    // ---- pre-flight gates (each bypassable with force, but always reported) ----
    const commitInfo = await commitsSinceCheckpoint(cwd, meta.head);
    const blockerCodes = [];
    if (commitInfo.count > 0) blockerCodes.push('COMMITS_AFTER_CHECKPOINT');
    if (meta.incomplete) blockerCodes.push('CHECKPOINT_INCOMPLETE');

    if (blockerCodes.length > 0 && !force) {
      const refusal = {
        ok: false,
        status: 409,
        code: blockerCodes[0],
        codes: blockerCodes,
        error: blockerCodes[0] === 'COMMITS_AFTER_CHECKPOINT'
          ? `${commitInfo.count} commit(s) were created after this checkpoint; restoring would remove them from the branch. Retry with force=1 to proceed.`
          : `This checkpoint's untracked-file snapshot is incomplete (${meta.incompleteReason || 'unknown'}). Retry with force=1 to restore anyway (untracked files will not be deleted).`,
      };
      if (commitInfo.count > 0) {
        refusal.commitCount = commitInfo.count;
        refusal.commits = commitInfo.commits;
      }
      if (meta.incomplete) {
        refusal.reason = meta.incompleteReason || 'unknown';
      }
      return refusal;
    }

    // ---- safety checkpoint (mandatory recovery point while HEAD exists) ----
    let safety = null;
    let safetyError = null;
    try {
      safety = await createCheckpointLocked(cwd, {
        sessionId: meta.sessionId,
        appSessionId: meta.appSessionId,
        prompt: `[safety] before restoring ${meta.id}`,
      });
    } catch (error) {
      safetyError = error.message;
    }
    if (!safety) {
      // Only proceed without a recovery point when the repo genuinely has no
      // commits (unborn HEAD) — there is nothing a safety checkpoint could
      // anchor to in that case.
      const headProbe = await run(cwd, ['rev-parse', '--verify', 'HEAD']);
      if (headProbe.ok) {
        return {
          ok: false,
          status: 422,
          code: 'SAFETY_CHECKPOINT_FAILED',
          error: 'Could not create a safety checkpoint of the current state'
            + `${safetyError ? ` (${safetyError})` : ''}; aborting the restore so no state is lost.`,
        };
      }
    }

    try {
      const applyInfo = await applyCheckpoint(cwd, meta);
      const result = {
        ok: true,
        checkpoint: meta,
        safetyCheckpointId: safety?.id || null,
      };
      if (applyInfo.skippedUntrackedCleanup) {
        result.skippedUntrackedCleanup = true;
        result.skippedUntrackedCleanupReason = meta.incompleteReason || 'unknown';
      }
      if (force && blockerCodes.length > 0) {
        result.forced = true;
        result.forcedPast = blockerCodes;
        if (commitInfo.count > 0) result.discardedCommitCount = commitInfo.count;
      }
      return result;
    } catch (error) {
      console.error('[Checkpoint] Restore failed, rolling back to safety checkpoint:', error.message);
      if (safety) {
        try {
          await applyCheckpoint(cwd, safety);
          return {
            ok: false,
            status: 500,
            error: `Restore failed (${error.message}); the working tree was rolled back to its pre-restore state.`,
            recovered: true,
          };
        } catch (recoveryError) {
          return {
            ok: false,
            status: 500,
            error: `Restore failed (${error.message}) AND recovery failed (${recoveryError.message}). `
              + `A recovery checkpoint is preserved: ${safety.id}`,
            recovered: false,
            recoveryCheckpointId: safety.id,
          };
        }
      }
      return { ok: false, status: 500, error: error.message, recovered: false };
    }
  });
}

/* ------------------------------------------------------------------------- *
 *  Changed files + per-file revert
 * ------------------------------------------------------------------------- */

/** Base commit-ish representing the checkpointed working tree content. */
function checkpointBase(meta) {
  return meta.stash || meta.head;
}

/**
 * Compute the files changed between a checkpoint and the current working tree.
 * Tracked changes come from `git diff <base>`; brand-new untracked files are
 * diffed against /dev/null so they render (and can be reverted) too.
 *
 * NUL-separated (`-z`) output is used everywhere so non-ASCII paths (e.g.
 * Chinese filenames) are never C-quoted; rename records carry `oldPath`.
 */
export async function changedFilesSince(id) {
  const meta = await readCheckpoint(id);
  if (!meta) return { files: [], truncated: false };
  const cwd = meta.cwd;
  if (!(await isGitRepository(cwd))) return { files: [], truncated: false };

  const base = checkpointBase(meta);
  const files = [];
  let turnDiffBudget = DIFF_TURN_LIMIT;

  // --- tracked files ---
  const numstat = await run(cwd, ['-c', 'core.quotePath=false', 'diff', '--numstat', '-M', '-z', base]);
  if (numstat.ok) {
    for (const entry of parseNumstatZ(numstat.stdout)) {
      const file = {
        path: entry.path,
        additions: entry.additions,
        deletions: entry.deletions,
        status: entry.oldPath ? 'renamed' : 'modified',
      };
      if (entry.oldPath) file.oldPath = entry.oldPath;
      files.push(file);
    }
  }

  const statusResult = await run(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-z', base]);
  if (statusResult.ok) {
    const statusByPath = new Map();
    for (const entry of parseNameStatusZ(statusResult.stdout)) {
      const normalized = entry.status.startsWith('A') ? 'added'
        : entry.status.startsWith('D') ? 'deleted'
          : entry.status.startsWith('R') ? 'renamed'
            : 'modified';
      statusByPath.set(entry.path, { status: normalized, oldPath: entry.oldPath });
    }
    for (const file of files) {
      const info = statusByPath.get(file.path);
      if (!info) continue;
      file.status = info.status;
      if (info.oldPath && !file.oldPath) file.oldPath = info.oldPath;
    }
  }

  // --- untracked files created since the checkpoint ---
  const knownUntracked = new Set(meta.untracked || []);
  const currentUntracked = await untrackedPaths(cwd);
  for (const relPath of currentUntracked) {
    if (knownUntracked.has(relPath)) continue;
    let additions = null;
    try {
      const content = await fs.readFile(path.join(cwd, relPath), 'utf8');
      additions = content.split('\n').length;
    } catch { /* binary or unreadable */ }
    files.push({ path: relPath, additions, deletions: 0, status: 'added', untracked: true });
  }

  // --- per-file unified diffs (budgeted) ---
  let truncated = false;
  for (const file of files) {
    if (turnDiffBudget <= 0) {
      file.diff = null;
      file.diffTruncated = true;
      truncated = true;
      continue;
    }
    let diffText = '';
    if (file.untracked) {
      const diffResult = await run(cwd, ['-c', 'core.quotePath=false', 'diff', '--no-index', '--', '/dev/null', file.path]);
      diffText = diffResult.stdout; // --no-index exits 1 when files differ
    } else {
      // For renames both paths must be in the pathspec, otherwise -M cannot
      // pair them and the diff degrades to a bare add of the new path.
      const pathspec = file.oldPath ? [file.oldPath, file.path] : [file.path];
      const diffResult = await run(cwd, ['-c', 'core.quotePath=false', 'diff', '-M', base, '--', ...pathspec]);
      diffText = diffResult.ok ? diffResult.stdout : '';
    }
    if (diffText.length > DIFF_FILE_LIMIT) {
      file.diff = diffText.slice(0, DIFF_FILE_LIMIT);
      file.diffTruncated = true;
      file.revertible = false;
      truncated = true;
    } else {
      file.diff = diffText || null;
      file.diffTruncated = false;
      file.revertible = Boolean(diffText);
    }
    // For an incomplete checkpoint an "untracked" entry may actually be a
    // file that existed at checkpoint time but fell outside the truncated
    // snapshot — reverting (deleting) it could destroy user data.
    if (meta.incomplete && file.untracked) {
      file.revertible = false;
      file.revertBlocked = 'checkpoint_incomplete';
    }
    turnDiffBudget -= diffText.length;
  }

  const result = { files, truncated, checkpointId: meta.id };
  if (meta.hasSubmodules) {
    result.hasSubmodules = true;
    result.warnings = ['submodules_not_covered'];
  }
  if (meta.incomplete) {
    result.incomplete = true;
    result.incompleteReason = meta.incompleteReason || 'unknown';
  }
  return result;
}

/**
 * Revert a single file back to its checkpoint state by reverse-applying its
 * diff. `git apply --reverse --check` validates before touching anything.
 * Serialized against restore/create on the same directory.
 */
export async function revertFile(id, relPath) {
  const meta = await readCheckpoint(id);
  if (!meta) return { ok: false, error: 'Checkpoint not found' };
  const cwd = meta.cwd;
  if (!relPath || relPath.includes('..') || path.isAbsolute(relPath)) {
    return { ok: false, error: 'Invalid path' };
  }

  return withCwdLock(cwd, async () => {
    const { files } = await changedFilesSince(id);
    const file = files.find((entry) => entry.path === relPath);
    if (!file) return { ok: false, error: 'File has no changes relative to the checkpoint' };
    if (meta.incomplete && file.untracked) {
      return {
        ok: false,
        code: 'CHECKPOINT_INCOMPLETE',
        error: 'This checkpoint\'s untracked snapshot is incomplete, so this file cannot be verified as new; refusing to delete it.',
      };
    }
    if (!file.diff || file.diffTruncated) {
      return { ok: false, error: 'Diff is unavailable or truncated; use full rollback instead' };
    }

    const patch = file.diff.endsWith('\n') ? file.diff : `${file.diff}\n`;
    const tmpPatch = path.join(os.tmpdir(), `prism-revert-${crypto.randomBytes(6).toString('hex')}.patch`);
    await fs.writeFile(tmpPatch, patch);
    try {
      const check = await run(cwd, ['apply', '--reverse', '--check', tmpPatch]);
      if (!check.ok) {
        return { ok: false, error: `Patch no longer applies cleanly: ${check.stderr || check.stdout}` };
      }
      const apply = await run(cwd, ['apply', '--reverse', tmpPatch]);
      if (!apply.ok) {
        return { ok: false, error: `Reverse apply failed: ${apply.stderr || apply.stdout}` };
      }
      return { ok: true, path: relPath };
    } finally {
      await fs.rm(tmpPatch, { force: true });
    }
  });
}

/** Prune old checkpoints (age + per-session count) and their pinned refs. */
export async function pruneCheckpoints() {
  const all = await listCheckpoints();
  const bySession = new Map();
  const now = Date.now();

  for (const meta of all) {
    const key = meta.appSessionId || meta.sessionId || 'unknown';
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(meta);
  }

  for (const metas of bySession.values()) {
    for (let index = 0; index < metas.length; index += 1) {
      const meta = metas[index];
      const age = now - new Date(meta.createdAt).getTime();
      if (index >= MAX_CHECKPOINTS_PER_SESSION || age > CHECKPOINT_TTL_MS) {
        try {
          if (meta.ref && await isGitRepository(meta.cwd)) {
            await run(meta.cwd, ['update-ref', '-d', meta.ref]);
          }
          await fs.rm(path.join(getCheckpointRoot(), meta.id), { recursive: true, force: true });
        } catch (error) {
          console.warn(`[Checkpoint] Prune failed for ${meta.id}:`, error.message);
        }
      }
    }
  }
}
