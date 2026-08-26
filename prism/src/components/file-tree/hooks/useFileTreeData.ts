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
};

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

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [location, setLocation] = useState<FileTreeLocation>(EMPTY_LOCATION);
  const abortControllerRef = useRef<AbortController | null>(null);
  // 上一次**成功**加载的视图标识(项目+浏览路径)。同一视图的重取(refreshKey 变)
  // 不再把 loading 置真 —— 旧行为是每次刷新都闪一遍骨架屏并清掉滚动位置。
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

    // Abort previous request
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
          setFiles(data);
          setLocation({
            root: readPathHeader(response, 'X-Prism-Tree-Root'),
            parent: readPathHeader(response, 'X-Prism-Tree-Parent'),
            projectRoot: readPathHeader(response, 'X-Prism-Tree-Project-Root'),
            externalRead: response.headers.get('X-Prism-Tree-External-Read') === '1',
          });
          // 服务端条目上限截断标记:前端此前根本不读它,大目录静默少显示。
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
  }, [projectId, browsePath, refreshKey]);

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
  };
}
