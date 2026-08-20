import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import type { Extension } from '@codemirror/state';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import { useTheme } from '../../../contexts/ThemeContext';
import { useCodeEditorDocument } from '../hooks/useCodeEditorDocument';
import { useCodeEditorSettings } from '../hooks/useCodeEditorSettings';
import { useEditorKeyboardShortcuts } from '../hooks/useEditorKeyboardShortcuts';
import { useHtmlPreview } from '../hooks/useHtmlPreview';
import type { CodeEditorFile } from '../types/types';
import { createMinimapExtension, createScrollToFirstChunkExtension, getLanguageExtensions } from '../utils/editorExtensions';
import { getEditorStyles } from '../utils/editorStyles';
import { createEditorToolbarPanelExtension } from '../utils/editorToolbarPanel';

import CodeEditorFooter from './subcomponents/CodeEditorFooter';
import CodeEditorHeader from './subcomponents/CodeEditorHeader';
import CodeEditorLoadingState from './subcomponents/CodeEditorLoadingState';
import CodeEditorSurface from './subcomponents/CodeEditorSurface';
import CodeEditorBinaryFile from './subcomponents/CodeEditorBinaryFile';
import CodeEditorMediaPreview from './subcomponents/CodeEditorMediaPreview';
import NotebookViewer from './subcomponents/notebook/NotebookViewer';

type CodeEditorProps = {
  file: CodeEditorFile;
  onClose: () => void;
  projectPath?: string;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
};

export default function CodeEditor({
  file,
  onClose,
  projectPath,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
}: CodeEditorProps) {
  const { t } = useTranslation('codeEditor');
  const paletteOps = usePaletteOps();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiff, setShowDiff] = useState(Boolean(file.diffInfo));
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState(false);

  // The code editor follows the app-wide theme; it has no theme of its own.
  const { isDarkMode } = useTheme();

  const {
    wordWrap,
    minimapEnabled,
    showLineNumbers,
    fontSize,
  } = useCodeEditorSettings();

  const {
    content,
    setContent,
    hasUnsavedChanges,
    loading,
    saving,
    saveSuccess,
    saveError,
    loadError,
    isBinary,
    previewKind,
    fileProjectId,
    handleSave,
    handleDownload,
  } = useCodeEditorDocument({
    file,
    projectPath,
  });

  // 有未保存改动时,离开页面/刷新/关标签给浏览器原生拦截。编辑器不像聊天草稿
  // 那样有持久化,直接关掉就丢了。
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges]);

  const isMarkdownFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'md' || extension === 'markdown';
  }, [file.name]);

  const isNotebookFile = useMemo(
    () => file.name.split('.').pop()?.toLowerCase() === 'ipynb',
    [file.name],
  );

  // notebook 默认进渲染视图(点开就是"看"),要改 JSON 才切源码。
  const [notebookRaw, setNotebookRaw] = useState(false);
  useEffect(() => {
    setNotebookRaw(false);
  }, [file.path]);

  const isHtmlPreviewFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'html' || extension === 'htm';
  }, [file.name]);

  /**
   * Project-relative path of the open file.
   *
   * The preview ticket is minted against the project root, so an absolute path
   * is no use here. Null when the file sits outside the project — the editor
   * can open such files, and the preview simply says so.
   */
  const previewRelPath = useMemo(() => {
    if (!projectPath) return null;

    const normalizedRoot = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedFile = file.path.replace(/\\/g, '/');
    if (!normalizedFile.startsWith(`${normalizedRoot}/`)) return null;

    return normalizedFile.slice(normalizedRoot.length + 1);
  }, [file.path, projectPath]);

  const htmlPreviewState = useHtmlPreview({
    projectId: fileProjectId,
    relPath: previewRelPath,
    enabled: htmlPreview && isHtmlPreviewFile,
  });

  // Switching to a different file must not leave the previous file's preview
  // showing under the new file's name.
  useEffect(() => {
    setHtmlPreview(false);
  }, [file.path]);

  const minimapExtension = useMemo(
    () => (
      createMinimapExtension({
        file,
        showDiff,
        minimapEnabled,
        isDarkMode,
      })
    ),
    [file, isDarkMode, minimapEnabled, showDiff],
  );

  const scrollToFirstChunkExtension = useMemo(
    () => createScrollToFirstChunkExtension({ file, showDiff }),
    [file, showDiff],
  );

  const toolbarPanelExtension = useMemo(
    () => (
      createEditorToolbarPanelExtension({
        file,
        showDiff,
        isSidebar,
        isExpanded,
        onToggleDiff: () => setShowDiff((previous) => !previous),
        onPopOut,
        onToggleExpand,
        labels: {
          changes: t('toolbar.changes'),
          previousChange: t('toolbar.previousChange'),
          nextChange: t('toolbar.nextChange'),
          hideDiff: t('toolbar.hideDiff'),
          showDiff: t('toolbar.showDiff'),
          collapse: t('toolbar.collapse'),
          expand: t('toolbar.expand'),
        },
      })
    ),
    [file, isExpanded, isSidebar, onPopOut, onToggleExpand, showDiff, t],
  );

  const extensions = useMemo(() => {
    const allExtensions: Extension[] = [
      ...getLanguageExtensions(file.name),
      ...toolbarPanelExtension,
    ];

    if (file.diffInfo && showDiff && file.diffInfo.old_string !== undefined) {
      allExtensions.push(
        unifiedMergeView({
          original: file.diffInfo.old_string,
          mergeControls: false,
          highlightChanges: true,
          syntaxHighlightDeletions: false,
          gutter: true,
        }),
      );
      allExtensions.push(...minimapExtension);
      allExtensions.push(...scrollToFirstChunkExtension);
    }

    if (wordWrap) {
      allExtensions.push(EditorView.lineWrapping);
    }

    return allExtensions;
  }, [
    file.diffInfo,
    file.name,
    minimapExtension,
    scrollToFirstChunkExtension,
    showDiff,
    toolbarPanelExtension,
    wordWrap,
  ]);

  useEditorKeyboardShortcuts({
    onSave: handleSave,
    onClose,
    dependency: content,
  });

  if (loading) {
    return (
      <CodeEditorLoadingState
        isDarkMode={isDarkMode}
        isSidebar={isSidebar}
        loadingText={t('loading', { fileName: file.name })}
      />
    );
  }

  // Natively previewable media (image/pdf/audio/video) is rendered inline
  // instead of showing the generic "cannot be displayed" placeholder.
  if (previewKind) {
    return (
      <CodeEditorMediaPreview
        file={file}
        kind={previewKind}
        projectId={fileProjectId}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
        onClose={onClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        labels={{
          loading: t('filePreview.loading', 'Loading preview...'),
          error: t('filePreview.error', 'Unable to display this file.'),
          openInNewTab: t('filePreview.openInNewTab', 'Open in new tab'),
          fullscreen: t('actions.fullscreen', 'Fullscreen'),
          exitFullscreen: t('actions.exitFullscreen', 'Exit fullscreen'),
          close: t('actions.close', 'Close'),
        }}
      />
    );
  }

  // Binary file display
  if (isBinary) {
    return (
      <CodeEditorBinaryFile
        file={file}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
        onClose={onClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        title={t('binaryFile.title', 'Binary File')}
        message={t('binaryFile.message', 'The file "{{fileName}}" cannot be displayed in the text editor because it is a binary file.', { fileName: file.name })}
      />
    );
  }

  const outerContainerClassName = isSidebar
    ? 'w-full h-full flex flex-col'
    : `fixed inset-0 z-[9999] md:bg-[rgba(16,16,16,0.72)] md:flex md:items-center md:justify-center md:p-4 ${isFullscreen ? 'md:p-0' : ''}`;

  const innerContainerClassName = isSidebar
    ? 'bg-background flex flex-col w-full h-full'
    : `bg-background prism-modal-shadow flex flex-col w-full h-full md:rounded-lg md:prism-modal-shadow${
      isFullscreen ? ' md:w-full md:h-full md:rounded-none' : ' md:w-full md:max-w-6xl md:h-[80vh] md:max-h-[80vh]'
    }`;

  return (
    <>
      <style>{getEditorStyles(isDarkMode)}</style>
      <div className={outerContainerClassName}>
        <div className={innerContainerClassName}>
          <CodeEditorHeader
            file={file}
            isSidebar={isSidebar}
            isFullscreen={isFullscreen}
            isMarkdownFile={isMarkdownFile}
            isHtmlPreviewFile={isHtmlPreviewFile}
            markdownPreview={markdownPreview}
            htmlPreview={htmlPreview}
            isNotebookFile={isNotebookFile}
            notebookRaw={notebookRaw}
            saving={saving}
            saveSuccess={saveSuccess}
            onToggleMarkdownPreview={() => setMarkdownPreview((previous) => !previous)}
            onToggleHtmlPreview={() => setHtmlPreview((previous) => !previous)}
            onToggleNotebookRaw={() => setNotebookRaw((previous) => !previous)}
            onOpenInJupyter={() => paletteOps.openInJupyter(file.path)}
            onOpenSettings={() => paletteOps.openSettings('appearance')}
            onDownload={handleDownload}
            onSave={handleSave}
            onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
            onClose={onClose}
            labels={{
              showingChanges: t('header.showingChanges'),
              editMarkdown: t('actions.editMarkdown'),
              previewMarkdown: t('actions.previewMarkdown'),
              previewHtml: t('actions.previewHtml', 'Preview rendered HTML'),
              editHtml: t('actions.editHtml', 'Back to source'),
              previewNotebook: t('actions.previewNotebook', '预览 notebook'),
              editNotebook: t('actions.editNotebook', '查看源码 (JSON)'),
              openInJupyter: t('actions.openInJupyter', '在 JupyterLab 打开'),
              settings: t('toolbar.settings'),
              download: t('actions.download'),
              save: t('actions.save'),
              saving: t('actions.saving'),
              saved: t('actions.saved'),
              fullscreen: t('actions.fullscreen'),
              exitFullscreen: t('actions.exitFullscreen'),
              close: t('actions.close'),
            }}
          />

          {loadError && (
            <div className="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              文件加载失败:{loadError} —— 已禁止保存以免覆盖原文件,请关闭后重新打开。
            </div>
          )}

          {saveError && (
            <div className="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              {saveError}
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            {isNotebookFile && !notebookRaw ? (
              <NotebookViewer content={content} />
            ) : (
            <CodeEditorSurface
              content={content}
              onChange={setContent}
              markdownPreview={markdownPreview}
              isMarkdownFile={isMarkdownFile}
              htmlPreview={{
                active: htmlPreview && isHtmlPreviewFile,
                previewUrl: htmlPreviewState.previewUrl,
                error: htmlPreviewState.error,
                isLoading: htmlPreviewState.isLoading,
                hasUnsavedChanges,
                onReload: htmlPreviewState.reload,
                labels: {
                  loading: t('filePreview.loading', 'Loading preview...'),
                  reload: t('actions.reloadPreview', 'Reload'),
                  unsavedNotice: t(
                    'filePreview.unsavedNotice',
                    'Preview shows the saved file. Save to see your latest edits.',
                  ),
                },
              }}
              isDarkMode={isDarkMode}
              fontSize={fontSize}
              showLineNumbers={showLineNumbers}
              extensions={extensions}
            />
            )}
          </div>

          <CodeEditorFooter
            content={content}
            linesLabel={t('footer.lines')}
            charactersLabel={t('footer.characters')}
            shortcutsLabel={t('footer.shortcuts')}
          />
        </div>
      </div>
    </>
  );
}
