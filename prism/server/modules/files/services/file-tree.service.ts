import { promises as fsPromises, type Dirent } from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/shared/logger.js';
const log = createLogger('files');

/** One node of the project file tree, exactly as the frontend consumes it. */
export type FileTreeItem = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
  modified?: string | null;
  isSymlink?: boolean;
  /**
   * hl(P3 文件组):软链**指向**的类型。树上按目标类型显示(指向目录的软链画成
   * 文件夹、可展开),`isSymlink` 仍为真让前端画角标。悬空软链没有这个字段。
   */
  symlinkTarget?: 'directory' | 'file';
  permissions?: string;
  permissionsRwx?: string;
  children?: FileTreeItem[];
  /**
   * hl(动态 P2-10):这个目录的内容**没有列全** —— 要么条目预算在它这里用完了,
   * 要么它已到深度上限。前端据此画「…还有更多」并按 `?path=` 懒加载它。
   * 以前预算耗尽的目录只是 `children: []`,与真正的空目录无法区分。
   */
  truncated?: boolean;
};

/**
 * Mutable traversal budget shared across one whole tree walk. When
 * `remaining` reaches zero the walk stops descending and `truncated` flips to
 * true so the route can signal the cutoff to the client.
 */
export type FileTreeBudget = {
  remaining: number;
  truncated: boolean;
  /**
   * hl(动态 P2-10):被列的那个根目录**自己的直接子项**被截断了。根没有节点可打标,
   * 所以单独记一位,路由用响应头(X-Prism-Root-Truncated)告诉前端。
   */
  rootTruncated?: boolean;
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

/** 目录项的排序:目录在前,再按名字 —— 与前端显示顺序一致,截断时砍掉的是尾巴。 */
function compareEntries(a: { name: string; isDir: boolean }, b: { name: string; isDir: boolean }): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function readDirectory(dirPath: string): Promise<Dirent[] | null> {
  try {
    await acquire();
    try {
      return await fsPromises.readdir(dirPath, { withFileTypes: true });
    } finally {
      release();
    }
  } catch (error) {
    // Only log non-permission errors to avoid spam
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') {
      log.error('Error reading directory:', error);
    }
    return null;
  }
}

/** 一个目录项 → 树节点(带 lstat 元数据)。软链再 stat 一次目标,拿到它指向什么。 */
async function buildItem(dirPath: string, entry: Dirent): Promise<{ item: FileTreeItem; isDir: boolean }> {
  const itemPath = path.join(dirPath, entry.name);
  const item: FileTreeItem = {
    name: entry.name,
    path: itemPath,
    type: entry.isDirectory() ? 'directory' : 'file',
  };
  let isDir = entry.isDirectory();

  try {
    await acquire();
    try {
      const stats = await fsPromises.lstat(itemPath);
      item.size = stats.size;
      item.modified = stats.mtime.toISOString();

      // Mark symlinks so UI can distinguish them
      if (stats.isSymbolicLink()) {
        item.isSymlink = true;
        // hl(P3 文件组):软链按目标类型显示。指向目录的软链此前被当成文件,点开就是 EISDIR。
        try {
          const target = await fsPromises.stat(itemPath);
          item.symlinkTarget = target.isDirectory() ? 'directory' : 'file';
          if (target.isDirectory()) {
            item.type = 'directory';
            isDir = true;
          }
        } catch {
          /* 悬空软链:保持文件形态,没有 symlinkTarget */
        }
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

  return { item, isDir };
}

type PendingDirectory = {
  /** null = 被列的根目录本身(它没有节点)。 */
  item: FileTreeItem | null;
  dirPath: string;
  depth: number;
};

/**
 * Project tree walk with an optional entry budget.
 *
 * hl(动态 P2-10):原来的实现是深度优先 + 各目录并发扣预算 —— 先 readdir 完的目录先拿到
 * 名额,5000+ 条目的项目里哪个小目录被显示成「空目录」全看磁盘抖动,而且被砍掉的内容
 * 无路可达。现在改成**逐层广度优先、按目录顺序串行扣减**:
 *   - 同一层的目录先全部 readdir(并发,只是 I/O),然后**按排序后的固定顺序**逐个扣预算,
 *     所以同样的目录树每次得到同样的结果;
 *   - 浅层永远优先于深层:第 1 层的目录都列出来了才轮到第 2 层;
 *   - 名额用完的目录不再是 `children: []`,而是 `truncated: true`,前端画「…还有更多」,
 *     点击按 `?path=` 单独列它(再给 5000 名额);
 *   - 到了深度上限、还没进去看的目录同样打 `truncated`。
 * 不带 budget 时(/api/browse-filesystem)行为与以前一致:不打标,深度上限之外不列。
 *
 * `showHidden` 沿用旧签名,历来没有实际过滤(保留以免改动调用方)。
 */
export async function getFileTree(
  dirPath: string,
  maxDepth = 3,
  currentDepth = 0,
  _showHidden = true,
  budget?: FileTreeBudget,
): Promise<FileTreeItem[]> {
  const rootChildren: FileTreeItem[] = [];
  let level: PendingDirectory[] = [{ item: null, dirPath, depth: currentDepth }];

  while (level.length > 0) {
    // 整层一起 readdir —— 并发只影响速度,不影响谁先拿到名额(下面按顺序扣)。
    const listed = await Promise.all(level.map(async (pending) => ({
      pending,
      entries: await readDirectory(pending.dirPath),
    })));

    const work: Array<{ pending: PendingDirectory; entries: Dirent[] }> = [];
    for (const { pending, entries } of listed) {
      if (!entries) {
        if (pending.item) pending.item.children = [];
        continue;
      }
      let filtered = entries
        .filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)))
        .sort((a, b) => compareEntries(
          { name: a.name, isDir: a.isDirectory() },
          { name: b.name, isDir: b.isDirectory() },
        ));

      if (budget) {
        if (filtered.length > budget.remaining) {
          filtered = filtered.slice(0, Math.max(0, budget.remaining));
          budget.truncated = true;
          if (pending.item) pending.item.truncated = true;
          else budget.rootTruncated = true;
        }
        budget.remaining -= filtered.length;
      }
      work.push({ pending, entries: filtered });
    }

    // 名额分完了再并发 stat —— 这一步只填元数据,顺序无关。
    const built = await Promise.all(work.map(async ({ pending, entries }) => ({
      pending,
      items: await Promise.all(entries.map((entry) => buildItem(pending.dirPath, entry))),
    })));

    const next: PendingDirectory[] = [];
    for (const { pending, items } of built) {
      // 软链指向目录会把 type 改成 directory,排序要按最终类型重排一次。
      items.sort((a, b) => compareEntries(
        { name: a.item.name, isDir: a.isDir },
        { name: b.item.name, isDir: b.isDir },
      ));
      const children = items.map(({ item }) => item);
      if (pending.item) pending.item.children = children;
      else rootChildren.push(...children);

      for (const { item, isDir } of items) {
        if (!isDir) continue;
        // 软链目录不递归:它可能指向树外或指回祖先(环),用户点「…还有更多」再按路径列它。
        if (item.isSymlink) {
          if (budget) item.truncated = true;
          continue;
        }
        if (pending.depth < maxDepth) {
          next.push({ item, dirPath: item.path, depth: pending.depth + 1 });
        } else if (budget) {
          // 深度上限:没进去看过,不能假装它是空的。
          item.truncated = true;
        }
      }
    }
    level = next;
  }

  return rootChildren;
}
