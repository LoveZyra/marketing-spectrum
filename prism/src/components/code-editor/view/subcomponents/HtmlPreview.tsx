import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

type HtmlPreviewProps = {
  previewUrl: string | null;
  error: string | null;
  isLoading: boolean;
  /** True when the editor buffer differs from what is on disk. */
  hasUnsavedChanges: boolean;
  onReload: () => void;
  labels: {
    loading: string;
    reload: string;
    unsavedNotice: string;
  };
};

/**
 * Sandboxed preview of an HTML file.
 *
 * `allow-same-origin` is deliberately NOT granted. Together with
 * `allow-scripts` it would give the previewed document full access to Prism's
 * origin — its localStorage, its auth token, its API — which is the one
 * combination that makes the sandbox attribute meaningless. Without it the
 * iframe gets an opaque origin: scripts run, relative URLs still resolve
 * against the preview URL, and nothing it does reaches the app.
 */
export default function HtmlPreview({
  previewUrl,
  error,
  isLoading,
  hasUnsavedChanges,
  onReload,
  labels,
}: HtmlPreviewProps) {
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangle className="h-6 w-6 text-amber-500" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <button
          type="button"
          onClick={onReload}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {labels.reload}
        </button>
      </div>
    );
  }

  if (isLoading || !previewUrl) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {labels.loading}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {hasUnsavedChanges && (
        <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
          <span>{labels.unsavedNotice}</span>
          <button
            type="button"
            onClick={onReload}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40"
          >
            <RefreshCw className="h-3 w-3" />
            {labels.reload}
          </button>
        </div>
      )}
      <iframe
        key={previewUrl}
        title="HTML preview"
        src={previewUrl}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        className="h-full w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
