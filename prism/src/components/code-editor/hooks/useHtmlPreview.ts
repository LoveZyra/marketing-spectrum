import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

type PreviewTicketResponse = {
  success?: boolean;
  url?: string;
  error?: string;
};

/**
 * The sandboxed HTML preview's source URL.
 *
 * The preview used to open a new window and hand the iframe a `srcdoc` of the
 * editor buffer. That renders the markup but nothing it references: `srcdoc`
 * documents have no base URL, so `<link href="style.css">` and
 * `<img src="./chart.png">` resolve to nothing and every agent-generated report
 * with a separate stylesheet previewed as unstyled text.
 *
 * Pointing the iframe at a real URL under `/preview/<ticket>/` fixes that —
 * relative references resolve against it and load through the same
 * directory-scoped, 5-minute ticket.
 *
 * The trade-off is that the preview shows the file **on disk**, not the unsaved
 * buffer. That is surfaced in the UI rather than hidden: previewing your own
 * unsaved edits and not seeing them would be the more confusing failure.
 */
export function useHtmlPreview({
  projectId,
  relPath,
  enabled,
}: {
  projectId: string | null | undefined;
  relPath: string | null;
  enabled: boolean;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const requestTicket = useCallback(async () => {
    if (!projectId || !relPath) {
      setError('Preview is only available for files inside a project');
      setPreviewUrl(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectId)}/preview-ticket`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relPath }),
        },
      );
      const payload = (await response.json()) as PreviewTicketResponse;
      if (!response.ok || !payload.url) {
        throw new Error(payload.error || 'Failed to open preview');
      }
      setPreviewUrl(payload.url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to open preview');
      setPreviewUrl(null);
    } finally {
      setIsLoading(false);
    }
  }, [projectId, relPath]);

  useEffect(() => {
    if (!enabled) {
      setPreviewUrl(null);
      setError(null);
      return;
    }
    void requestTicket();
  }, [enabled, requestTicket]);

  return { previewUrl, error, isLoading, reload: requestTicket };
}
