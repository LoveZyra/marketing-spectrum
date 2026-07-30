import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

/** One node of the project file tree, exactly as the frontend consumes it. */
export type FileTreeItem = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
  modified?: string | null;
  isSymlink?: boolean;
  permissions?: string;
  permissionsRwx?: string;
  children?: FileTreeItem[];
};

/**
 * Mutable traversal budget shared across one whole tree walk. When
 * `remaining` reaches zero the walk stops descending and `truncated` flips to
 * true so the route can signal the cutoff to the client.
 */
export type FileTreeBudget = {
  remaining: number;
  truncated: boolean;
};

const DEFAULT_FILETREE_MAX_ENTRIES = 5000;

/**
 * Maximum number of entries a single file-tree response may contain.
 * Configured via PRISM_FILETREE_MAX_ENTRIES (default 5000). Read per call so
 * the value can change without a restart (mirrors FS_CONCURRENCY handling
 * style elsewhere, and keeps tests simple).
 */
export function getFileTreeMaxEntries(): number {
  const parsed = Number.parseInt(process.env.PRISM_FILETREE_MAX_ENTRIES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FILETREE_MAX_ENTRIES;
}

// Helper function to convert permissions to rwx format
function permToRwx(perm: number): string {
  const r = perm & 4 ? 'r' : '-';
  const w = perm & 2 ? 'w' : '-';
  const x = perm & 1 ? 'x' : '-';
  return r + w + x;
}

// Directories that are almost never interesting for a project tree but can
// contain tens of thousands of files. Skipping them before recursion keeps
// traversal time bounded on large monorepos and high-latency filesystems
// (NFS / SMB).
const IGNORED_DIRS = new Set([
  // JS / TS toolchains
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  // VCS
  '.git', '.svn', '.hg',
  // Python
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  // Rust / Go / Java / Ruby
  'target', 'vendor',
  // Build output / IDE
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const DEFAULT_FS_CONCURRENCY = 64;
const parsedFsConcurrency = Number.parseInt(process.env.FS_CONCURRENCY || '', 10);
const FS_CONCURRENCY = Number.isFinite(parsedFsConcurrency) && parsedFsConcurrency > 0
  ? parsedFsConcurrency
  : DEFAULT_FS_CONCURRENCY;
let activeFsOperations = 0;
const pendingFsOperations: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (activeFsOperations < FS_CONCURRENCY) {
    activeFsOperations += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    pendingFsOperations.push(resolve);
  });
}

function release(): void {
  const next = pendingFsOperations.shift();
  if (next) {
    next();
    return;
  }

  activeFsOperations = Math.max(0, activeFsOperations - 1);
}

/**
 * Recursive project tree walk (moved verbatim from server/index.js), plus an
 * optional entry budget: when `budget` is provided, at most `budget.remaining`
 * nodes are emitted across the entire walk and `budget.truncated` is set as
 * soon as anything had to be dropped. Without a budget the behavior is
 * exactly the historical unbounded walk.
 */
export async function getFileTree(
  dirPath: string,
  maxDepth = 3,
  currentDepth = 0,
  showHidden = true,
  budget?: FileTreeBudget,
): Promise<FileTreeItem[]> {
  if (budget && budget.remaining <= 0) {
    budget.truncated = true;
    return [];
  }

  let entries;
  try {
    await acquire();
    try {
      entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    } finally {
      release();
    }
  } catch (error) {
    // Only log non-permission errors to avoid spam
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') {
      console.error('Error reading directory:', error);
    }
    return [];
  }

  let filteredEntries = entries.filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)));

  if (budget) {
    // Reserve this directory's direct children synchronously (no await between
    // the check and the decrement) so concurrent sibling walks can never
    // overshoot the global cap.
    if (filteredEntries.length > budget.remaining) {
      filteredEntries = filteredEntries.slice(0, budget.remaining);
      budget.truncated = true;
    }
    budget.remaining -= filteredEntries.length;
  }

  // Process every entry in parallel. On high-latency filesystems (NFS/SMB)
  // serial stat() was the real bottleneck — issuing them concurrently lets
  // the kernel pipeline the round-trips and the recursive calls overlap too.
  const items: FileTreeItem[] = await Promise.all(filteredEntries.map(async (entry) => {
    const itemPath = path.join(dirPath, entry.name);
    const item: FileTreeItem = {
      name: entry.name,
      path: itemPath,
      type: entry.isDirectory() ? 'directory' : 'file',
    };

    // Get file stats for additional metadata
    try {
      await acquire();
      try {
        const stats = await fsPromises.lstat(itemPath);
        item.size = stats.size;
        item.modified = stats.mtime.toISOString();

        // Mark symlinks so UI can distinguish them
        if (stats.isSymbolicLink()) {
          item.isSymlink = true;
        }

        // Convert permissions to rwx format
        const mode = stats.mode;
        const ownerPerm = (mode >> 6) & 7;
        const groupPerm = (mode >> 3) & 7;
        const otherPerm = mode & 7;
        item.permissions =
          ((mode >> 6) & 7).toString() +
          ((mode >> 3) & 7).toString() +
          (mode & 7).toString();
        item.permissionsRwx =
          permToRwx(ownerPerm) +
          permToRwx(groupPerm) +
          permToRwx(otherPerm);
      } finally {
        release();
      }
    } catch {
      // If stat fails, provide default values
      item.size = 0;
      item.modified = null;
      item.permissions = '000';
      item.permissionsRwx = '---------';
    }

    if (entry.isDirectory() && currentDepth < maxDepth) {
      // Recurse. Let readdir's own EACCES bubble up through the catch in
      // the recursive call rather than doing a separate access() probe
      // (which doubled the round-trip count on SMB without adding info).
      // The recursive call starts with a bounded readdir; holding a permit
      // for the whole subtree can deadlock when sibling directories are
      // waiting on their own children.
      item.children = await getFileTree(itemPath, maxDepth, currentDepth + 1, showHidden, budget);
    }

    return item;
  }));

  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}
