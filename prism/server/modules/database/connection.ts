/**
 * Database connection management.
 *
 * Owns the single SQLite connection used across all repositories.
 * Handles path resolution, directory creation, legacy database migration,
 * and eager app_config bootstrap so the auth middleware can read the
 * JWT secret before the full schema is applied.
 *
 * Consumers should never create their own Database instance — they use
 * `getConnection()` to obtain the shared singleton.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { APP_CONFIG_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('db');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the database file path from environment or falls back
 * to the legacy location inside the server/database/ folder.
 *
 * Priority:
 *   1. DATABASE_PATH environment variable (set by cli.js or load-env-vars.js)
 *   2. Legacy path: server/database/auth.db
 */
function resolveDatabasePath(): string {
    // process.env.DATABASE_PATH is set by load-env-vars.js to either the .env value or a default(~/.prism/auth.db) in the user's home directory. 
    return process.env.DATABASE_PATH || resolveLegacyDatabasePath();
}

/**
 * Resolves the legacy database path (always inside server/database/).
 * Used for the one-time migration to the new external location.
 */
function resolveLegacyDatabasePath(): string {
  const serverDir = path.resolve(__dirname, '..', '..', '..');
  return path.join(serverDir, 'database', 'auth.db');
}

// ---------------------------------------------------------------------------
// Directory & migration helpers
// ---------------------------------------------------------------------------

function ensureDatabaseDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info('Created database directory:', dir);
  }
}

/**
 * If the database was moved to an external location (e.g. ~/.prism/)
 * but the user still has a legacy auth.db inside the install directory,
 * copy it to the new location as a one-time migration.
 */
function migrateLegacyDatabase(targetPath: string): void {
  const legacyPath = resolveLegacyDatabasePath();

  if (targetPath === legacyPath) return;
  if (fs.existsSync(targetPath)) return;
  if (!fs.existsSync(legacyPath)) return;

  try {
    fs.copyFileSync(legacyPath, targetPath);
    log.info('Migrated legacy database', { from: legacyPath, to: targetPath });


    // copy the write-ahead log and shared memory files (auth.db-wal, auth.db-shm) if they exist, to preserve any uncommitted transactions
    for (const suffix of ['-wal', '-shm']) {
      const src = legacyPath + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, targetPath + suffix);
      }
    }
  } catch (err: any) {
    log.error('Could not migrate legacy database', { error: err.message });
  }
}


// ---------------------------------------------------------------------------
// Singleton connection
// ---------------------------------------------------------------------------

let instance: Database.Database | null = null;

/**
 * Returns the shared database connection, creating it on first call.
 *
 * The first invocation:
 *   1. Resolves the target database path
 *   2. Ensures the parent directory exists
 *   3. Migrates from the legacy install-directory path if needed
 *   4. Opens the SQLite connection
 *   5. Eagerly creates the app_config table (auth reads JWT secret at import time)
 *   6. Logs the database location
 */
export function getConnection(): Database.Database {
  if (instance) return instance;

  const dbPath = resolveDatabasePath();

  ensureDatabaseDirectory(dbPath);
  migrateLegacyDatabase(dbPath);

  instance = new Database(dbPath);
  applyPragmas(instance);

  // app_config must exist immediately — the auth middleware reads
  // the JWT secret at module-load time, before initializeDatabase() runs.
  instance.exec(APP_CONFIG_TABLE_SCHEMA_SQL);

  return instance;
}

// ---------------------------------------------------------------------------
// Durability & concurrency
// ---------------------------------------------------------------------------

/**
 * Connection-level pragmas, applied once per process.
 *
 * WAL matters here specifically: the sessions watcher, the chat WebSocket
 * handlers, and HTTP request handlers all write through this one connection
 * while long reads (session history scans) are in flight. Under the default
 * rollback journal those readers block writers and vice versa, which showed
 * up as intermittent SQLITE_BUSY during large project scans.
 *
 * `busy_timeout` covers the remaining contention window instead of failing
 * the query immediately. `foreign_keys` is off by default in SQLite and must
 * be set per connection — without it the ON DELETE CASCADE clauses declared
 * throughout schema.ts are silently inert.
 */
function applyPragmas(db: Database.Database): void {
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    // NORMAL is the recommended pairing with WAL: durable across process
    // crashes, only at risk on OS/power loss, and avoids an fsync per commit.
    db.pragma('synchronous = NORMAL');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Could not apply database pragmas', { error: message });
  }
}

/**
 * Writes a consistent snapshot of the database next to it and prunes old
 * ones. `VACUUM INTO` is used rather than copying the file because it takes
 * a read lock and produces a defragmented, fully-checkpointed copy — a raw
 * copy of a WAL-mode database without its -wal sidecar can be stale.
 *
 * Called on a daily timer from init-db.ts; retention is `keep` most-recent
 * files (default 7).
 */
/**
 * 增量备份每批拷多少页。
 *
 * 100 页 × 4KB ≈ 400KB —— 单批的耗时远小于一帧预算,而批数够少,不至于让
 * 回调本身成为开销。调大它会让备份更快但更"顿",调小反之。
 */
const BACKUP_PAGES_PER_STEP = 100;

export async function backupDatabase(keep = 7): Promise<string | null> {
  const dbPath = resolveDatabasePath();
  if (!fs.existsSync(dbPath)) return null;

  const backupDir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = path.basename(dbPath, path.extname(dbPath));
  const target = path.join(backupDir, `${baseName}-${stamp}.db`);

  try {
    const db = getConnection();
    // 同一秒重试是空操作(目标文件已存在)。
    if (fs.existsSync(target)) return target;

    /**
     * 用 `db.backup()` 而不是 `VACUUM INTO`。
     *
     * 两者都能产出一份完整副本,区别在**阻不阻塞**:
     *
     * - `VACUUM INTO` 是 better-sqlite3 的同步 API,整份库拷完之前**事件循环一步都走不了**。
     *   108MB 的库实测停 611ms;按现在的增长,1GB 就是每天卡 6 秒 —— 期间所有人的
     *   WebSocket 帧、所有 HTTP 请求、所有定时任务一起停摆,而这只是一次例行备份。
     * - `db.backup()` 是**增量**的:每次 `progress` 回调返回下一批要拷的页数,
     *   两批之间事件循环能喘气。100 页一批,在 4KB 页大小下约 400KB —— 单批远小于
     *   一帧的预算,拷 1GB 也不会让任何一次请求明显变慢。
     *
     * 代价是 `backup()` **不做碎片整理**(VACUUM 会),所以备份文件可能比源库略大。
     * 对一份备份来说这不重要 —— 它是拿来恢复的,不是拿来省空间的;而"每天卡几秒"
     * 是所有人都能感觉到的。
     *
     * 返回 Promise 之后调用方(init-db 的两个定时器)也跟着不再阻塞。
     */
    await db.backup(target, {
      progress: ({ remainingPages }) => (remainingPages > 0 ? BACKUP_PAGES_PER_STEP : 0),
    });
    pruneBackups(backupDir, baseName, keep);
    return target;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Database backup failed', { error: message });
    return null;
  }
}

/** Deletes all but the `keep` newest backups for the given database name. */
function pruneBackups(backupDir: string, baseName: string, keep: number): void {
  const entries = fs
    .readdirSync(backupDir)
    .filter((name) => name.startsWith(`${baseName}-`) && name.endsWith('.db'))
    .sort()
    .reverse();

  for (const stale of entries.slice(keep)) {
    try {
      fs.unlinkSync(path.join(backupDir, stale));
    } catch {
      // A backup we cannot remove is not worth failing the run over.
    }
  }
}

/**
 * Returns the resolved database file path without opening a connection.
 * Useful for diagnostics and CLI status commands.
 */
export function getDatabasePath(): string {
  return resolveDatabasePath();
}

/**
 * Closes the database connection and clears the singleton.
 * Primarily used for graceful shutdown or testing.
 */
export function closeConnection(): void {
  if (instance) {
    instance.close();
    instance = null;
    log.info('Database connection closed');
  }
}
