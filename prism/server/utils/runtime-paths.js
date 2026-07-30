import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export function getModuleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

// ── Application data directory ──────────────────────────────────────────────
// Prism keeps user-level state (auth.db, assets, markers, …) in one folder.
// Historically this was ~/.cloudcli; it is now ~/.prism, overridable with
// PRISM_DATA_DIR. Every backend file must resolve the folder through
// getDataDir() so the location changes in exactly one place.

const LEGACY_DATA_DIR_NAME = '.cloudcli';
const DATA_DIR_NAME = '.prism';

/**
 * Absolute path of Prism's per-user data directory.
 *
 * Resolution: PRISM_DATA_DIR env var when set, otherwise ~/.prism. The env
 * var is read on every call so tests (and the CLI, which loads .env late)
 * observe changes without a process restart.
 *
 * @returns {string}
 */
export function getDataDir() {
  const fromEnv = process.env.PRISM_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv.trim());
  }

  return path.join(os.homedir(), DATA_DIR_NAME);
}

function copyDirRecursiveSync(sourceDir, targetDir) {
  // fs.cpSync is available on Node >= 16.7; the project targets Node 22.
  fs.cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: false, force: false });
}

/**
 * One-time migration of the legacy ~/.cloudcli data folder to getDataDir().
 *
 * Must run BEFORE anything opens files inside the data dir (the auth DB is
 * opened as a side effect of importing middleware/auth.js, so load-env.js —
 * the very first import of the server entrypoint — calls this).
 *
 * Behavior:
 * - PRISM_DATA_DIR explicitly set → no-op (that folder is a destination the
 *   operator chose, not a place to move somebody else's data into)
 * - target already exists, or legacy dir missing → no-op (idempotent)
 * - same filesystem → fs.renameSync (atomic move)
 * - EXDEV (cross-device) → recursive copy, then leave the original in place
 *   with a MIGRATED.txt note so users know which copy is live.
 *
 * @returns {boolean} true when a migration was performed in this call.
 */
export function migrateLegacyDataDir() {
  /* PRISM_DATA_DIR_EXPLICIT_GUARD */
  // An explicit PRISM_DATA_DIR means "use exactly this folder" — never treat it
  // as a migration target, or a second instance (or a test run) would silently
  // move the default instance's ~/.cloudcli out from under it.
  const explicit = process.env.PRISM_DATA_DIR;
  if (typeof explicit === 'string' && explicit.trim().length > 0) return false;

  const legacyDir = path.join(os.homedir(), LEGACY_DATA_DIR_NAME);
  const targetDir = getDataDir();

  try {
    if (fs.existsSync(targetDir)) return false;
    if (!fs.existsSync(legacyDir)) return false;

    try {
      fs.renameSync(legacyDir, targetDir);
      console.log(`[INFO] Migrated Prism data directory: ${legacyDir} -> ${targetDir}`);
      return true;
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        // Different filesystems (e.g. bind-mounted home): copy instead of move
        // and keep the original so nothing is destroyed on a partial copy.
        copyDirRecursiveSync(legacyDir, targetDir);
        try {
          fs.writeFileSync(
            path.join(legacyDir, 'MIGRATED.txt'),
            `This folder was migrated to ${targetDir} on ${new Date().toISOString()}.\n` +
            'Prism now reads and writes only the new location; this copy is kept as a backup.\n',
            'utf8'
          );
        } catch {
          // The note is best-effort; the copy above is what matters.
        }
        console.log(`[INFO] Copied Prism data directory across filesystems: ${legacyDir} -> ${targetDir}`);
        return true;
      }
      throw error;
    }
  } catch (error) {
    // A failed migration must never prevent startup — the server falls back to
    // whatever state exists at the (possibly fresh) target directory.
    console.warn('[WARN] Prism data directory migration failed:', error?.message || error);
    return false;
  }
}

export function findServerRoot(startDir) {
  // Source files live under /server, while compiled files live under /dist-server/server.
  // Walking up to the nearest "server" folder gives every backend module one stable anchor
  // that works in both layouts instead of relying on fragile "../.." assumptions.
  let currentDir = startDir;

  while (path.basename(currentDir) !== 'server') {
    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error(`Could not resolve the backend server root from "${startDir}".`);
    }

    currentDir = parentDir;
  }

  return currentDir;
}

export function findAppRoot(startDir) {
  const serverRoot = findServerRoot(startDir);
  const parentOfServerRoot = path.dirname(serverRoot);

  // Source files live at <app>/server, while compiled files live at <app>/dist-server/server.
  // When the nearest server folder sits inside dist-server we need to hop one extra level up
  // so repo-level files still resolve from the real app root instead of the build directory.
  return path.basename(parentOfServerRoot) === 'dist-server'
    ? path.dirname(parentOfServerRoot)
    : parentOfServerRoot;
}
