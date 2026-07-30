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
  loading: boolean;
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [location, setLocation] = useState<FileTreeLocation>(EMPTY_LOCATION);
  const abortControllerRef = useRef<AbortController | null>(null);

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
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
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
    refreshFiles,
    location,
    isInProject,
    navigateTo,
    navigateUp,
    resetToProject,
  };
}
