import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../../types/app';
import type { CodeEditorDiffInfo, CodeEditorFile } from '../types/types';
import { confirmDiscardEditorChanges } from '../utils/editorDirtyState';

/** 同时开着的编辑器标签上限。再多标签条自己就不可读了。 */
const MAX_OPEN_EDITOR_TABS = 12;

type UseEditorSidebarOptions = {
  selectedProject: Project | null;
  isMobile: boolean;
  initialWidth?: number;
};

export const useEditorSidebar = ({
  selectedProject,
  isMobile,
  initialWidth = 600,
}: UseEditorSidebarOptions) => {
  const { t } = useTranslation('codeEditor');
  /**
   * F10:编辑器多标签。
   *
   * 之前一次只能开一个文件 —— 对着一份代码改另一份(照着接口写实现、比对两处
   * 配置)时,每看一眼就要把当前文件关掉,回来还要重新找。
   *
   * 打开的文件按**打开顺序**排,活动的那个由 `activeEditorPath` 指;这样"关掉
   * 当前这个"之后落到哪一个是可预测的(左边那个),而不是跳到一个随机的。
   *
   * 上限 12 个:再多的标签条自己就不可读了,而"开了三十个文件"通常意味着人想要
   * 的其实是搜索(F10 的另一半),不是标签。
   */
  const [openFiles, setOpenFiles] = useState<CodeEditorFile[]>([]);
  const [activeEditorPath, setActiveEditorPath] = useState<string | null>(null);
  const [editorWidth, setEditorWidth] = useState(initialWidth);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [hasManualWidth, setHasManualWidth] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);

  // 关闭/换文件都会卸载(或重载)当前 CodeEditor,未保存的编辑随之蒸发 ——
  // beforeunload 只拦浏览器级离开,应用内的这两条路在这里拦。
  const confirmDiscard = useCallback(
    () =>
      confirmDiscardEditorChanges(
        t('unsaved.confirmDiscard', {
          defaultValue: '当前文件有未保存的改动,离开将丢失这些改动。确定丢弃吗?',
        }),
      ),
    [t],
  );

  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null) => {
      // 切走当前这个标签会卸载它的 CodeEditor —— 未保存的改动随之蒸发,所以先问。
      if (!confirmDiscard()) {
        return;
      }

      const normalizedPath = filePath.replace(/\\/g, '/');
      const fileName = normalizedPath.split('/').pop() || filePath;
      const nextFile: CodeEditorFile = {
        name: fileName,
        path: filePath,
        // DB projectId is forwarded to the editor so it can read/save files
        // via `/api/projects/:projectId/file` endpoints.
        projectId: selectedProject?.projectId,
        diffInfo,
      };

      setOpenFiles((current) => {
        const existing = current.findIndex((file) => file.path === filePath);
        if (existing >= 0) {
          // 已经开着就复用那个标签,但用新的 diffInfo 覆盖 —— 从聊天里点同一个
          // 文件的 diff 卡时,要看的是**这次**的 diff。
          const next = [...current];
          next[existing] = nextFile;
          return next;
        }
        const appended = [...current, nextFile];
        // 超过上限就挤掉最早打开的那个(不是当前这个)。
        return appended.length > MAX_OPEN_EDITOR_TABS ? appended.slice(appended.length - MAX_OPEN_EDITOR_TABS) : appended;
      });
      setActiveEditorPath(filePath);
    },
    [confirmDiscard, selectedProject?.projectId],
  );

  /** 关掉某一个标签。不传就是关当前这个。 */
  const handleCloseFile = useCallback((filePath?: string) => {
    const target = filePath ?? activeEditorPath;
    if (!target) return;
    // 只有关**当前**这个才可能丢改动 —— 后台标签根本没挂载编辑器。
    if (target === activeEditorPath && !confirmDiscard()) {
      return;
    }

    setOpenFiles((current) => {
      const index = current.findIndex((file) => file.path === target);
      if (index < 0) return current;
      const next = current.filter((file) => file.path !== target);

      if (target === activeEditorPath) {
        // 落到左边那个;没有左边就落到右边;都没有就是关光了。
        const fallback = next[index - 1] ?? next[index] ?? null;
        setActiveEditorPath(fallback?.path ?? null);
        if (!fallback) setEditorExpanded(false);
      }
      return next;
    });
  }, [activeEditorPath, confirmDiscard]);

  const handleSelectFile = useCallback((filePath: string) => {
    if (filePath === activeEditorPath) return;
    if (!confirmDiscard()) return;
    setActiveEditorPath(filePath);
  }, [activeEditorPath, confirmDiscard]);

  /** 关掉全部标签(标签条上的"关闭全部")。 */
  const handleCloseEditor = useCallback(() => {
    if (!confirmDiscard()) {
      return;
    }
    setOpenFiles([]);
    setActiveEditorPath(null);
    setEditorExpanded(false);
  }, [confirmDiscard]);

  const handleToggleEditorExpand = useCallback(() => {
    setEditorExpanded((previous) => !previous);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isMobile) {
        return;
      }

      // After first drag interaction, the editor width is user-controlled.
      setHasManualWidth(true);
      setIsResizing(true);
      event.preventDefault();
    },
    [isMobile],
  );

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      if (!isResizing) {
        return;
      }

      // Get the main container (parent of EditorSidebar's parent) that contains both left content and editor
      const editorContainer = resizeHandleRef.current?.parentElement;
      const mainContainer = editorContainer?.parentElement;
      if (!mainContainer) {
        return;
      }

      const containerRect = mainContainer.getBoundingClientRect();
      // Calculate new editor width: distance from mouse to right edge of main container
      const newWidth = containerRect.right - event.clientX;

      const minWidth = 300;
      const maxWidth = containerRect.width * 0.8;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setEditorWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  const editingFile = openFiles.find((file) => file.path === activeEditorPath) ?? null;

  return {
    editingFile,
    openFiles,
    activeEditorPath,
    handleCloseFile,
    handleSelectFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  };
};
