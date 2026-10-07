import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';

/**
 * Where the currently rendered tree sits on disk, as reported by the server.
 *
 * All four fields come from response headers rather than being computed in the
 * browser, because the server owns the navigation boundary (WORKSPACES_ROOT)
 * and duplicating that rule here would let the two drift: a client-side guess
 * would either offer an "up" button that 403s or hide one that would have
 * worked.
 */
type FileTreeLocation = {
  /** Directory being listed, server-resolved (symlinks already followed). */
  root: string | null;
  /** Next directory up, or null when the tree is already at the boundary. */
  parent: string | null;
  /** The project's own root, for the "back to project" control. */
  projectRoot: string | null;
  /** Whether the server will serve file content from outside the project. */
  externalRead: boolean;
};

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  /** 首次进入某个视图(项目/目录)且还没有内容可显示时才为真。 */
  loading: boolean;
  /** 同一视图的重取(刷新/上传后)进行中 —— 旧内容保持可见,只是数据在路上。 */
  refreshing: boolean;
  /** 服务端因条目过多截断了本次列表(X-Prism-Truncated)。 */
  truncated: boolean;
  refreshFiles: () => void;
  location: FileTreeLocation;
  /** False while browsing above or beside the project root. */
  isInProject: boolean;
  navigateTo: (dirPath: string) => void;
  navigateUp: () => void;
  resetToProject: () => void;
  /**
   * 把一个被截断的目录单独列一遍(`?path=`,再给一份完整预算),结果原地接进树里。
   * 失败时抛错,由调用方提示。
   */
  loadSubtree: (dirPath: string) => Promise<void>;
  /** 正在懒加载的目录路径集合(行上画转圈用)。 */
  loadingSubtrees: ReadonlySet<string>;
};

/** 把 `dirPath` 那个节点的 children 换成新列出的子树;找不到就原样返回。 */
export function replaceSubtree(
  nodes: FileTreeNode[],
  dirPath: string,
  children: FileTreeNode[],
  stillTruncated: boolean,
): FileTreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.path === dirPath) {
      changed = true;
      return { ...node, children, truncated: stillTruncated || undefined };
    }
    if (node.children && node.children.length > 0) {
      const replaced = replaceSubtree(node.children, dirPath, children, stillTruncated);
      if (replaced !== node.children) {
        changed = true;
        return { ...node, children: replaced };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

/**
 * 整树刷新之后,哪些懒加载过的目录要重新拉。
 *
 * 刷新时不把缓存的旧子树盖回新数据(否则懒加载过的目录会一直显示第一次拉到的内容,
 * 别人新建 / 删掉的文件都看不到),只挑出仍然存在、仍然没列全(truncated)、
 * 而且此刻展开着的缓存目录,重新请求一遍。
 */
export function pickSubtreesToReload(
  nodes: FileTreeNode[],
  cachedPaths: Iterable<string>,
  isExpanded: (path: string) => boolean,
): string[] {
  const wanted = new Set(cachedPaths);
  const found: string[] = [];
  const walk = (list: FileTreeNode[]) => {
    for (const node of list) {
      if (wanted.has(node.path) && node.type === 'directory' && node.truncated && isExpanded(node.path)) {
        found.push(node.path);
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

/** 按并发上限逐个跑异步任务(懒加载重拉用,别一次把十几个目录同时打到服务端)。 */
export async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

const SUBTREE_RELOAD_CONCURRENCY = 3;

const EMPTY_LOCATION: FileTreeLocation = {
  root: null,
  parent: null,
  projectRoot: null,
  externalRead: false,
};

/** Headers carry percent-encoded paths so non-ASCII folder names survive latin-1. */
function readPathHeader(response: Response, name: string): string | null {
  const raw = response.headers.get(name);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape should degrade to the raw value rather than blank the
    // breadcrumb entirely.
    return raw;
  }
}

export function useFileTreeData(
  selectedProject: Project | null,
  /** 哪些目录此刻展开着(刷新后只重拉展开着的懒加载目录)。用 ref 读,不进依赖。 */
  isDirExpanded?: (path: string) => boolean,
): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [location, setLocation] = useState<FileTreeLocation>(EMPTY_LOCATION);
  const [loadingSubtrees, setLoadingSubtrees] = useState<ReadonlySet<string>>(new Set());
  const abortControllerRef = useRef<AbortController | null>(null);
  /**
   * 懒加载过的子树路径:整树刷新(上传 / 改名 / 手动刷新)会把它们又截断掉,刷新后按路径
   * 重新拉取展开着的那些,别让用户每次刷新都再点一遍「…还有更多」。换视图(换项目 / 进目录)时清空。
   */
  const lazySubtreesRef = useRef<Set<string>>(new Set());
  const isDirExpandedRef = useRef(isDirExpanded);
  isDirExpandedRef.current = isDirExpanded;
  /** 每次整树加载 +1;旧一轮的懒加载重拉看到代数变了就停。 */
  const generationRef = useRef(0);
  // 上一次成功加载的视图标识(项目 + 浏览路径)。同一视图的重取(refreshKey 变)
  // 只标 refreshing、不把 loading 置真,免得每次刷新都闪一遍骨架屏并清掉滚动位置。
  const loadedViewRef = useRef<string | null>(null);

  // File-tree requests use the DB projectId; the backend resolves it to the
  // project's absolute path through the projects table.
  const projectId = selectedProject?.projectId;

  // The browse target is stored WITH the project it belongs to so switching
  // projects cannot carry a stale directory across — deriving the active path
  // instead of clearing it in an effect avoids a render where the new project
  // is paired with the old project's path.
  const [browse, setBrowse] = useState<{ projectId: string; path: string } | null>(null);
  const browsePath = browse && browse.projectId === projectId ? browse.path : null;

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  const navigateTo = useCallback((dirPath: string) => {
    if (!projectId || !dirPath) return;
    setBrowse({ projectId, path: dirPath });
  }, [projectId]);

  const resetToProject = useCallback(() => {
    setBrowse(null);
  }, []);

  const navigateUp = useCallback(() => {
    if (!location.parent) return;
    navigateTo(location.parent);
  }, [location.parent, navigateTo]);

  const fetchSubtree = useCallback(async (dirPath: string, generation: number) => {
    if (!projectId || !dirPath) return null;
    setLoadingSubtrees((current) => new Set(current).add(dirPath));
    try {
      const response = await api.getFiles(projectId, {}, dirPath);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      const children = (await response.json()) as FileTreeNode[];
      // 这一层自己还是没列全(单独给的预算也用完了)才保留 truncated;子孙的标记在节点上。
      const stillTruncated = response.headers.get('X-Prism-Root-Truncated') === '1';
      // 期间已经整树重载过:这份结果属于旧树,丢掉(新一轮会自己重拉)。
      if (generation !== generationRef.current) return null;
      lazySubtreesRef.current.add(dirPath);
      setFiles((current) => replaceSubtree(current, dirPath, children, stillTruncated));
      return { children, stillTruncated };
    } finally {
      setLoadingSubtrees((current) => {
        const next = new Set(current);
        next.delete(dirPath);
        return next;
      });
    }
  }, [projectId]);

  const loadSubtree = useCallback(async (dirPath: string) => {
    await fetchSubtree(dirPath, generationRef.current);
  }, [fetchSubtree]);

  /**
   * 整树刷新后把展开着的懒加载目录重新拉一遍(按层推进:外层拉回来之后,嵌在里面的
   * 懒加载目录才重新出现在树上,下一波再拉它们)。
   */
  const reloadLazySubtrees = useCallback(async (tree: FileTreeNode[], cached: Set<string>, generation: number) => {
    let current = tree;
    const remaining = new Set(cached);
    const isExpanded = (path: string) => isDirExpandedRef.current?.(path) ?? false;
    for (;;) {
      if (generation !== generationRef.current) return;
      const wave = pickSubtreesToReload(current, remaining, isExpanded);
      if (wave.length === 0) return;
      for (const path of wave) remaining.delete(path);
      await runWithConcurrency(wave, SUBTREE_RELOAD_CONCURRENCY, async (path) => {
        try {
          const result = await fetchSubtree(path, generation);
          if (result) current = replaceSubtree(current, path, result.children, result.stillTruncated);
        } catch (error) {
          console.error('[file-tree] 刷新后重拉懒加载目录失败:', path, error);
        }
      });
    }
  }, [fetchSubtree]);

  useEffect(() => {
    if (!projectId) {
      setFiles([]);
      setLocation(EMPTY_LOCATION);
      setLoading(false);
      setRefreshing(false);
      setTruncated(false);
      loadedViewRef.current = null;
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;
    const viewKey = `${projectId}:${browsePath ?? ''}`;
    const isSameView = loadedViewRef.current === viewKey;

    const fetchFiles = async () => {
      if (isActive) {
        // 视图没变(刷新/上传后的重取)→ 只标 refreshing,旧内容留在屏上;
        // 视图变了(换项目/进目录)→ 才走骨架屏。
        if (isSameView) setRefreshing(true);
        else setLoading(true);
      }
      try {
        const response = await api.getFiles(
          projectId,
          { signal: abortControllerRef.current!.signal },
          browsePath || undefined,
        );

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
            // Drop back to the project tree rather than stranding the user in
            // a directory the server just refused: without this, every
            // subsequent refresh re-requests the same rejected path.
            if (browsePath) setBrowse(null);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          // 不把缓存的旧子树盖回新数据:记下哪些目录懒加载过,稍后按需重拉(见 pickSubtreesToReload)。
          generationRef.current += 1;
          const generation = generationRef.current;
          const cached = isSameView ? new Set(lazySubtreesRef.current) : new Set<string>();
          lazySubtreesRef.current = new Set();
          setFiles(data);
          if (cached.size > 0) void reloadLazySubtrees(data, cached, generation);
          setLocation({
            root: readPathHeader(response, 'X-Prism-Tree-Root'),
            parent: readPathHeader(response, 'X-Prism-Tree-Parent'),
            projectRoot: readPathHeader(response, 'X-Prism-Tree-Project-Root'),
            externalRead: response.headers.get('X-Prism-Tree-External-Read') === '1',
          });
          // 服务端条目上限截断标记:不读它的话,大目录会静默少显示。
          setTruncated(response.headers.get('X-Prism-Truncated') === '1');
          loadedViewRef.current = viewKey;
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
        }
      } finally {
        if (isActive) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [projectId, browsePath, refreshKey, reloadLazySubtrees]);

  // Compared against the server-resolved paths rather than against browsePath,
  // so a path that resolves back into the project (a symlink, or "..", or the
  // project root typed out in full) is correctly treated as being in-project.
  const isInProject = useMemo(() => {
    const { root, projectRoot } = location;
    if (!root || !projectRoot) return true;
    return root === projectRoot || root.startsWith(`${projectRoot}/`);
  }, [location]);

  return {
    files,
    loading,
    refreshing,
    truncated,
    refreshFiles,
    location,
    isInProject,
    navigateTo,
    navigateUp,
    resetToProject,
    loadSubtree,
    loadingSubtrees,
  };
}
