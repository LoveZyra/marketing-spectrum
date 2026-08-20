import { Code2, Download, Eye, ExternalLink, Maximize2, Minimize2, Save, Settings as SettingsIcon, X } from 'lucide-react';

import type { CodeEditorFile } from '../../types/types';

type CodeEditorHeaderProps = {
  file: CodeEditorFile;
  isSidebar: boolean;
  isFullscreen: boolean;
  isMarkdownFile: boolean;
  isHtmlPreviewFile: boolean;
  markdownPreview: boolean;
  htmlPreview: boolean;
  isNotebookFile?: boolean;
  notebookRaw?: boolean;
  saving: boolean;
  saveSuccess: boolean;
  onToggleMarkdownPreview: () => void;
  onToggleHtmlPreview: () => void;
  onToggleNotebookRaw?: () => void;
  onOpenInJupyter?: () => void;
  onOpenSettings: () => void;
  onDownload: () => void;
  onSave: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  labels: {
    showingChanges: string;
    editMarkdown: string;
    previewMarkdown: string;
    previewHtml: string;
    editHtml: string;
    previewNotebook?: string;
    editNotebook?: string;
    openInJupyter?: string;
    settings: string;
    download: string;
    save: string;
    saving: string;
    saved: string;
    fullscreen: string;
    exitFullscreen: string;
    close: string;
  };
};

export default function CodeEditorHeader({
  file,
  isSidebar,
  isFullscreen,
  isMarkdownFile,
  isHtmlPreviewFile,
  markdownPreview,
  htmlPreview,
  isNotebookFile = false,
  notebookRaw = false,
  saving,
  saveSuccess,
  onToggleMarkdownPreview,
  onToggleHtmlPreview,
  onToggleNotebookRaw,
  onOpenInJupyter,
  onOpenSettings,
  onDownload,
  onSave,
  onToggleFullscreen,
  onClose,
  labels,
}: CodeEditorHeaderProps) {
  const saveTitle = saveSuccess ? labels.saved : saving ? labels.saving : labels.save;

  return (
    <div className="flex min-w-0 flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
      {/* File info - can shrink */}
      <div className="flex min-w-0 flex-1 shrink items-center gap-2">
        <div className="min-w-0 shrink">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-medium text-foreground">{file.name}</h3>
            {file.diffInfo && (
              <span className="shrink-0 whitespace-nowrap rounded bg-primary/[0.08] px-1.5 py-0.5 text-[10px] text-card-foreground dark:text-primary">
                {labels.showingChanges}
              </span>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{file.path}</p>
        </div>
      </div>

      {/* Buttons - don't shrink, always visible */}
      <div className="flex shrink-0 items-center gap-0.5">
        {isMarkdownFile && (
          <button
            type="button"
            onClick={onToggleMarkdownPreview}
            className={`flex items-center justify-center rounded-md p-1.5 transition-colors ${
              markdownPreview
                ? 'bg-primary/[0.08] text-card-foreground dark:text-primary'
                : 'text-body hover:bg-muted hover:text-foreground'
            }`}
            title={markdownPreview ? labels.editMarkdown : labels.previewMarkdown}
          >
            {markdownPreview ? <Code2 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}

        {isNotebookFile && (
          <>
            <button
              type="button"
              onClick={onToggleNotebookRaw}
              className={`flex items-center justify-center rounded-md p-1.5 transition-colors ${
                !notebookRaw
                  ? 'bg-muted text-muted-foreground'
                  : 'text-body hover:bg-muted hover:text-foreground'
              }`}
              title={notebookRaw ? labels.previewNotebook : labels.editNotebook}
            >
              {notebookRaw ? <Eye className="h-4 w-4" /> : <Code2 className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onOpenInJupyter}
              className="flex items-center justify-center rounded-md p-1.5 text-body transition-colors hover:bg-muted hover:text-foreground"
              title={labels.openInJupyter}
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          </>
        )}

        {isHtmlPreviewFile && (
          <button
            type="button"
            onClick={onToggleHtmlPreview}
            className={`flex items-center justify-center rounded-md p-1.5 ${
              htmlPreview
                ? 'bg-accent text-foreground'
                : 'text-body hover:bg-muted hover:text-foreground'
            }`}
            title={htmlPreview ? labels.editHtml : labels.previewHtml}
          >
            {htmlPreview ? <Code2 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}

        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center justify-center rounded-md p-1.5 text-body hover:bg-muted hover:text-foreground"
          title={labels.settings}
        >
          <SettingsIcon className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={onDownload}
          className="flex items-center justify-center rounded-md p-1.5 text-body hover:bg-muted hover:text-foreground"
          title={labels.download}
        >
          <Download className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className={`flex items-center justify-center rounded-md p-1.5 transition-colors disabled:opacity-50 ${
            saveSuccess
              ? 'bg-primary/[0.08] text-card-foreground dark:text-primary'
              : 'text-body hover:bg-muted hover:text-foreground'
          }`}
          title={saveTitle}
        >
          {saveSuccess ? (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <Save className="h-4 w-4" />
          )}
        </button>

        {!isSidebar && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            className="flex items-center justify-center rounded-md p-1.5 text-body hover:bg-muted hover:text-foreground"
            title={isFullscreen ? labels.exitFullscreen : labels.fullscreen}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center rounded-md p-1.5 text-body hover:bg-muted hover:text-foreground"
          title={labels.close}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
