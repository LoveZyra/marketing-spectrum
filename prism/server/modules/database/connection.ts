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
    console.log('Created database directory:', dir);
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
    console.log('Migrated legacy database', { from: legacyPath, to: targetPath });


    // copy the write-ahead log and shared memory files (auth.db-wal, auth.db-shm) if they exist, to preserve any uncommitted transactions
    for (const suffix of ['-wal', '-shm']) {
      const src = legacyPath + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, targetPath + suffix);
      }
    }
  } catch (err: any) {
    console.error('Could not migrate legacy database', { error: err.message });
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
    console.warn('Could not apply database pragmas', { error: message });
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
export function backupDatabase(keep = 7): string | null {
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
    // VACUUM INTO refuses to overwrite, so a same-second retry is a no-op.
    if (fs.existsSync(target)) return target;
    db.prepare('VACUUM INTO ?').run(target);
    pruneBackups(backupDir, baseName, keep);
    return target;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Database backup failed', { error: message });
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
    console.log('Database connection closed');
  }
}
