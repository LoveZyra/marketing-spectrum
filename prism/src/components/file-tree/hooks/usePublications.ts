import { useCallback, useEffect, useMemo, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type Publication = {
  id: string;
  relPath: string;
  kind: 'file' | 'folder';
  token: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

type PublicationsResponse = {
  success?: boolean;
  publications?: Publication[];
  publication?: Publication;
  error?: string;
};

/**
 * Publication state for one project.
 *
 * Keyed by the project-relative path rather than by id, because that is what
 * the file tree has in hand when it renders a row and needs to know whether to
 * offer "publish" or "unpublish".
 */
export function usePublications(projectId: string | null | undefined) {
  const [publications, setPublications] = useState<Publication[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setPublications([]);
      return;
    }

    setIsLoading(true);
    try {
      const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/publications`);
      const payload = (await response.json()) as PublicationsResponse;
      setPublications(response.ok ? payload.publications ?? [] : []);
    } catch (error) {
      console.error('Failed to load publications:', error);
      setPublications([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const byRelPath = useMemo(() => {
    const index = new Map<string, Publication>();
    for (const entry of publications) {
      index.set(entry.relPath, entry);
    }
    return index;
  }, [publications]);

  const publish = useCallback(
    async (relPath: string, kind: 'file' | 'folder'): Promise<Publication | null> => {
      if (!projectId) return null;

      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectId)}/publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relPath, kind }),
        },
      );
      const payload = (await response.json()) as PublicationsResponse;
      if (!response.ok || !payload.publication) {
        throw new Error(payload.error || 'Failed to publish');
      }

      await refresh();
      return payload.publication;
    },
    [projectId, refresh],
  );

  const unpublish = useCallback(
    async (id: string): Promise<void> => {
      if (!projectId) return;

      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectId)}/publish/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as PublicationsResponse;
        throw new Error(payload.error || 'Failed to unpublish');
      }

      await refresh();
    },
    [projectId, refresh],
  );

  /** Absolute URL for sharing. Relative links are useless once pasted elsewhere. */
  const absoluteUrl = useCallback((publication: Publication): string => {
    if (typeof window === 'undefined') return publication.url;
    return new URL(publication.url, window.location.origin).toString();
  }, []);

  return { publications, byRelPath, isLoading, refresh, publish, unpublish, absoluteUrl };
}
