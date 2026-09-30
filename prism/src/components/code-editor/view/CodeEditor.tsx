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
import { setEditorDirty } from '../utils/editorDirtyState';
import { createMinimapExtension, createScrollToFirstChunkExtension, getLanguageExtensions } from '../utils/editorExtensions';
import { getEditorStyles } from '../utils/editorStyles';
import { resolveEditorEscapeAction } from '../utils/editorEscape';
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
    readOnlyReason,
    isBinary,
    isDiffView,
    previewKind,
    fileProjectId,
    handleSave,
    handleDownload,
  } = useCodeEditorDocument({
    file,
    projectPath,
  });

  // 真正的"脏":用户改了、而且这份改动是能保存的。diff 视图与读失败缓冲不算
  // (那不是用户的编辑);只读文件不算(改不了也存不了,拦人没有意义)。
  // hl(P3 文件组):beforeunload 原来只看 hasUnsavedChanges —— 读失败 / 只读文件也会弹「离开站点?」。
  const isDirty = hasUnsavedChanges && !isDiffView && !loadError && !readOnlyReason;

  // 有未保存改动时,离开页面/刷新/关标签给浏览器原生拦截。编辑器不像聊天草稿
  // 那样有持久化,直接关掉就丢了。
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  // 应用内的关闭/换文件同样要拦(beforeunload 只管浏览器级离开):把脏态登记进
  // 单例,useEditorSidebar 在关闭与打开新文件前查它;卸载时清零,别让残影拦住下一次打开。
  useEffect(() => {
    setEditorDirty(isDirty);
    return () => setEditorDirty(false);
  }, [isDirty]);

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
   * eh:**能渲染的文件,点开就是渲染后的样子**。
   *
   * notebook 早就是这个约定(上面的 notebookRaw),markdown 与 html 却还默认落在
   * 源码上 —— 用户点开一份报告 / 一张网页,第一眼看到的是标签和井号,得再找一次
   * 那枚眼睛。图片 / PDF / 音视频走的是另一条分支(CodeEditorMediaPreview),本来
   * 就是渲染。现在三类文本渲染视图统一:进来先看结果,要改再切源码。
   *
   * 依赖里带 `file.path`:换文件时重置,不把上一份的"我切到源码了"粘过来。
   */
  useEffect(() => {
    // 换文件时先归零再按类型给默认值,顺带兜掉"上一份的预览挂在新文件名下"
    // 这件事(这也是原来那个 setHtmlPreview(false) 的职责,已合并到这里)。
    setMarkdownPreview(isMarkdownFile);
    setHtmlPreview(isHtmlPreviewFile);
  }, [file.path, isMarkdownFile, isHtmlPreviewFile]);

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

  // hl 复核 P3-5:固定引用 —— 每次渲染新建对象会让 markdown 图片整批重挂载、重复下载。
  const markdownBase = useMemo(
    () => ({ projectId: fileProjectId, relPath: previewRelPath }),
    [fileProjectId, previewRelPath],
  );

  const htmlPreviewState = useHtmlPreview({
    projectId: fileProjectId,
    relPath: previewRelPath,
    enabled: htmlPreview && isHtmlPreviewFile,
  });

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
        // ec:「最大化 / 还原」搬到了头部(所有文件形态共用),CodeMirror 工具条
        // 上不再放第二个同款按钮;这里只剩 diff 与弹出。
        onToggleExpand: null,
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
    [file, isExpanded, isSidebar, onPopOut, showDiff, t],
  );

  // ec:最大化时第一次 Esc 只还原,第二次才关(见 utils/editorEscape.ts)。
  const escapeAction = resolveEditorEscapeAction({
    isSidebar,
    isExpanded,
    hasToggleExpand: Boolean(onToggleExpand),
  });
  const handleEscape = escapeAction === 'restore' && onToggleExpand ? onToggleExpand : onClose;
  const maximizeLabels = {
    maximize: t('actions.maximize', '最大化'),
    restore: t('actions.restore', '还原'),
  };

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
    onEscape: handleEscape,
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
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        onClose={onClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        labels={{
          loading: t('filePreview.loading', 'Loading preview...'),
          error: t('filePreview.error', 'Unable to display this file.'),
          openInNewTab: t('filePreview.openInNewTab', 'Open in new tab'),
          fullscreen: t('actions.fullscreen', 'Fullscreen'),
          exitFullscreen: t('actions.exitFullscreen', 'Exit fullscreen'),
          ...maximizeLabels,
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
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        maximizeLabel={maximizeLabels.maximize}
        restoreLabel={maximizeLabels.restore}
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
            dirty={isDirty}
            // ei:会话产出通道是只读的(项目目录之外的产出),保存按钮不渲染。
            // hl(动态 P2-11):读失败的标签页保存与下载按钮都不渲染 —— 缓冲区里是错误注释,不是文件。
            canSave={!isDiffView && !file.outputSessionId && !readOnlyReason && !loadError}
            canDownload={!loadError}
            onToggleMarkdownPreview={() => setMarkdownPreview((previous) => !previous)}
            onToggleHtmlPreview={() => setHtmlPreview((previous) => !previous)}
            onToggleNotebookRaw={() => setNotebookRaw((previous) => !previous)}
            onOpenInJupyter={() => paletteOps.openInJupyter(file.path)}
            onOpenSettings={() => paletteOps.openSettings('appearance')}
            onDownload={handleDownload}
            onSave={handleSave}
            onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
            isExpanded={isExpanded}
            onToggleExpand={onToggleExpand}
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
              unsaved: t('unsaved.marker', '未保存'),
              fullscreen: t('actions.fullscreen'),
              exitFullscreen: t('actions.exitFullscreen'),
              ...maximizeLabels,
              close: t('actions.close'),
            }}
          />

          {/* hl(P3 文件组):错误态横幅用警示色,与只读说明(中性)区分开 —— 深色下原来三条一个样。 */}
          {loadError && (
            <div role="alert" className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
              {t('loadFailedBanner', { error: loadError, defaultValue: `文件加载失败:${loadError} —— 已禁止保存以免覆盖原文件,请关闭后重新打开。` })}
            </div>
          )}

          {readOnlyReason && !loadError && (
            <div className="border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground" data-testid="editor-readonly-reason">
              {readOnlyReason}
            </div>
          )}

          {saveError && (
            <div role="alert" className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
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
              readOnly={Boolean(readOnlyReason)}
              markdownPreview={markdownPreview}
              isMarkdownFile={isMarkdownFile}
              markdownBase={markdownBase}
              htmlPreview={{
                active: htmlPreview && isHtmlPreviewFile,
                previewUrl: htmlPreviewState.previewUrl,
                error: htmlPreviewState.error,
                isLoading: htmlPreviewState.isLoading,
                hasUnsavedChanges,
                expired: htmlPreviewState.expired,
                onReload: htmlPreviewState.reload,
                labels: {
                  loading: t('filePreview.loading', 'Loading preview...'),
                  reload: t('actions.reloadPreview', 'Reload'),
                  unsavedNotice: t(
                    'filePreview.unsavedNotice',
                    'Preview shows the saved file. Save to see your latest edits.',
                  ),
                  expiredNotice: t('filePreview.expiredNotice', '预览链接已过期(5 分钟有效):页面里之后加载的资源可能失败,点「重新加载」换一张新链接。'),
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
