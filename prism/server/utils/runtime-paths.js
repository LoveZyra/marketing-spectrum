import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export function getModuleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

// ── Application data directory ──────────────────────────────────────────────
// Prism keeps user-level state (auth.db, assets, markers, …) in one folder:
// ~/.prism, overridable with PRISM_DATA_DIR. Every backend file must resolve
// the folder through getDataDir() so the location changes in exactly one place.

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
