import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, X, Folder, Upload } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { FAMILY_COLOR_CLASS, ICON_SIZE_CLASS, getFileFamily, getFileIconData } from '../constants/fileIcons';
import { useExpandedDirectories } from '../hooks/useExpandedDirectories';
import { useFileTreeData } from '../hooks/useFileTreeData';
import { useFileTreeOperations, type ToastMessage } from '../hooks/useFileTreeOperations';
import { useFileTreeSearch } from '../hooks/useFileTreeSearch';
import { useFileTreeViewMode } from '../hooks/useFileTreeViewMode';
import { useFileTreeUpload } from '../hooks/useFileTreeUpload';
import type { FileTreeImageSelection, FileTreeNode } from '../types/types';
import { formatFileSize, formatRelativeTime, isImageFile } from '../utils/fileTreeUtils';
import { Project } from '../../../types/app';
import { ScrollArea, Input } from '../../../shared/view/ui';

import FileTreeBody from './FileTreeBody';
import FileTreeDetailedColumns from './FileTreeDetailedColumns';
import FileTreeHeader from './FileTreeHeader';
import FileTreeLoadingState from './FileTreeLoadingState';
import FileTreeUploadProgress from './FileTreeUploadProgress';
import ProjectSearchPanel from './ProjectSearchPanel';
import ImageViewer from './ImageViewer';


type FileTreeProps = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
};

/** 按路径集合从树里捞出对应节点(深度优先,顺序即显示顺序)。 */
function collectByPaths(nodes: FileTreeNode[], paths: ReadonlySet<string>): FileTreeNode[] {
  const found: FileTreeNode[] = [];
  const walk = (list: FileTreeNode[]) => {
    for (const node of list) {
      if (paths.has(node.path)) found.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return found;
}

export default function FileTree({ selectedProject, onFileOpen }: FileTreeProps) {
  const { t } = useTranslation();
  const [selectedImage, setSelectedImage] = useState<FileTreeImageSelection | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  /**
   * F9:多选。
   *
   * 选择模式明确用一个开关进入,而不是"点着点着就进去了" —— 文件树的默认动作是
   * 打开文件,把它偷偷改成选中会让人删错东西。开关之外,按住 Ctrl/Cmd/Shift
   * 点击也算选中(与文件管理器一致)。
   */
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  /** F10:全局内容搜索面板(与文件名搜索是两回事,所以是独立面板而不是同一个输入框)。 */
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Show toast notification
  const showToast = useCallback((message: string, type: ToastMessage['type']) => {
    setToast({ message, type });
  }, []);

  // Auto-hide toast
  useEffect(() => {
    if (toast) {
      // warning 里带着目录名,3 秒读不完 —— 给它更长的停留时间。
      const timer = setTimeout(() => setToast(null), toast.type === 'warning' ? 8000 : 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const {
    files,
    loading,
    truncated,
    refreshFiles,
    location,
    isInProject,
    navigateUp,
    resetToProject,
  } = useFileTreeData(selectedProject);

  const { viewMode, changeViewMode } = useFileTreeViewMode();
  const { expandedDirs, toggleDirectory, collapseAll } = useExpandedDirectories();
  const { searchQuery, setSearchQuery, filteredFiles, searchExpandedPaths } = useFileTreeSearch({
    files,
  });

  // 搜索期间的展开是**临时并集**:命中项的祖先在渲染时临时摊开,清空关键词即还原,
  // 不再把它们永久写进用户的展开状态(旧行为:搜一次,整棵树永远摊开)。
  const effectiveExpandedDirs = useMemo(() => {
    if (searchExpandedPaths.size === 0) return expandedDirs;
    const union = new Set(expandedDirs);
    for (const path of searchExpandedPaths) union.add(path);
    return union;
  }, [expandedDirs, searchExpandedPaths]);

  // File operations
  const operations = useFileTreeOperations({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
  });

  // File upload (drag and drop)
  const upload = useFileTreeUpload({
    selectedProject,
    onRefresh: refreshFiles,
    showToast,
  });
  const operationLoading = operations.operationLoading || upload.operationLoading;

  // Focus input when creating new item
  useEffect(() => {
    if (operations.isCreating && newItemInputRef.current) {
      newItemInputRef.current.focus();
      newItemInputRef.current.select();
    }
  }, [operations.isCreating]);

  // Focus input when renaming
  useEffect(() => {
    if (operations.renamingItem && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [operations.renamingItem]);

  /**
   * 图标沿用 `getFileIconData` 的映射,颜色改走**七个语义族**。
   *
   * 族色是 CSS 变量(`--filetype-*`):两套浅色主题给设计稿的七色,霓虹终端
   * 下落回次级墨色 —— 那一稿没有分色这回事,不该被这轮顺手改掉。
   */
  const renderFileIcon = useCallback((filename: string) => {
    const { icon: Icon } = getFileIconData(filename);
    const family = getFileFamily(filename);
    return <Icon className={cn(ICON_SIZE_CLASS, FAMILY_COLOR_CLASS[family])} />;
  }, []);

  /**
   * Whether the file endpoints will serve this path.
   *
   * Browsing above the project root lists files the read endpoints still
   * refuse (they are project-scoped unless the operator sets
   * PRISM_FILETREE_ALLOW_EXTERNAL_READ). Checking here keeps a click from
   * turning into an opaque 403 in the editor pane.
   */
  const canOpenPath = useCallback(
    (filePath: string) => {
      if (location.externalRead) return true;
      const root = location.projectRoot;
      if (!root) return true;
      return filePath === root || filePath.startsWith(`${root}/`);
    },
    [location.externalRead, location.projectRoot],
  );

  // Centralized click behavior keeps file actions identical across all presentation modes.
  const handleItemClick = useCallback(
    (item: FileTreeNode) => {
      if (item.type === 'directory') {
        toggleDirectory(item.path);
        return;
      }

      if (!canOpenPath(item.path)) {
        // The path is still useful even when the bytes are off-limits: it is
        // usually what the user came up here for, to paste into a prompt.
        //
        // Goes through copyTextToClipboard, not navigator.clipboard directly:
        // the Clipboard API is only defined in a secure context, and this app
        // is routinely served over plain HTTP on a LAN address, where
        // `navigator.clipboard` is undefined and reading .writeText off it
        // throws straight out of the click handler. The helper feature-detects
        // and falls back to execCommand, and never rejects — so the branch
        // below picks the message from its boolean rather than from a catch.
        void copyTextToClipboard(item.path).then((copied) =>
          copied
            ? showToast(
                t('fileTree.outsideProjectCopied', 'Outside the project folder — path copied instead'),
                'success',
              )
            : showToast(
                t('fileTree.outsideProject', 'This file is outside the project folder and cannot be opened here'),
                'error',
              ),
        );
        return;
      }

      if (isImageFile(item.name) && selectedProject) {
        setSelectedImage({
          name: item.name,
          path: item.path,
          projectPath: selectedProject.path,
          // Image URL uses the DB projectId so ImageViewer can hit the
          // /api/projects/:projectId/files/content endpoint directly.
          projectId: selectedProject.projectId,
        });
        return;
      }

      onFileOpen?.(item.path);
    },
    [canOpenPath, onFileOpen, selectedProject, showToast, t, toggleDirectory],
  );

  /**
   * Uploads always land in the project folder, so a drop while browsing
   * elsewhere would silently write somewhere the user is not looking. Refuse
   * it — and still preventDefault, or the browser navigates away to the
   * dropped file.
   */
  const toggleSelect = useCallback((item: FileTreeNode) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setSelectionMode(false);
  }, []);

  /** 批量下载:逐个走单文件下载(目录走 ZIP),失败逐条提示但不中断其余。 */
  const downloadSelected = useCallback(async () => {
    const targets = collectByPaths(filteredFiles, selectedPaths);
    let failed = 0;
    for (const item of targets) {
      try {
        await operations.handleDownload(item);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      showToast(t('fileTree.batchDownloadPartial', { failed, defaultValue: `有 ${failed} 项下载失败` }), 'warning');
    }
    clearSelection();
  }, [filteredFiles, selectedPaths, operations, showToast, t, clearSelection]);

  /**
   * 批量删除:确认一次,然后逐个删。
   *
   * 删除是不可逆的,所以确认里写清有几项 —— "确定删除?"配上一个看不见数量的
   * 选择集合,是最容易造成事故的组合。
   */
  const deleteSelected = useCallback(async () => {
    const targets = collectByPaths(filteredFiles, selectedPaths);
    if (targets.length === 0) return;
    if (!window.confirm(t('fileTree.batchDeleteConfirm', {
      count: targets.length,
      defaultValue: `删除选中的 ${targets.length} 项?此操作不可撤销。`,
    }))) {
      return;
    }

    let failed = 0;
    for (const item of targets) {
      try {
        await operations.deleteItemDirectly(item);
      } catch {
        failed += 1;
      }
    }
    clearSelection();
    refreshFiles();
    if (failed > 0) {
      showToast(t('fileTree.batchDeletePartial', { failed, defaultValue: `有 ${failed} 项删除失败` }), 'warning');
    }
  }, [filteredFiles, selectedPaths, operations, refreshFiles, showToast, t, clearSelection]);

  /**
   * F9:Cmd+N / Cmd+Shift+N 做实。
   *
   * 这两个组合原来只写在按钮的 tooltip 里 —— 按下去什么都不会发生,是个纯粹的
   * 谎言。现在真的接上,并且只在文件页有焦点、且没在输入框里打字时生效
   * (否则会把编辑器里的 Cmd+N 抢走)。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'n') return;
      if (!isInProject) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      // 树没在屏上(切到别的标签页)就不抢 —— 这个监听挂在 document 上。
      if (!upload.treeRef.current?.isConnected) return;

      event.preventDefault();
      operations.handleStartCreate('', event.shiftKey ? 'directory' : 'file');
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isInProject, operations, upload.treeRef]);

  /**
   * F10:Ctrl/Cmd+Shift+F 打开全局搜索。
   *
   * 与聊天里的 Ctrl+F(会话内查找)错开一个 Shift —— 两者是不同的东西,
   * 共用一个键会让人永远猜不准打开的是哪个。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'f') return;
      if (!isInProject || !selectedProject) return;
      if (!upload.treeRef.current?.isConnected) return;
      event.preventDefault();
      setShowSearchPanel(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isInProject, selectedProject, upload.treeRef]);

  const handleTreeDrop = useCallback(
    (event: DragEvent) => {
      if (!isInProject) {
        event.preventDefault();
        event.stopPropagation();
        showToast(
          t('fileTree.uploadInProjectOnly', 'Uploads go to the project folder — go back to it to upload'),
          'error',
        );
        return;
      }
      void upload.handleDrop(event);
    },
    [isInProject, showToast, t, upload],
  );

  const formatRelativeTimeLabel = useCallback(
    (date?: string) => formatRelativeTime(date, t),
    [t],
  );

  if (loading) {
    return <FileTreeLoadingState />;
  }

  return (
    <div
      ref={upload.treeRef}
      className="relative flex h-full flex-col bg-background"
      onDragEnter={upload.handleDragEnter}
      onDragOver={upload.handleDragOver}
      onDragLeave={upload.handleDragLeave}
      onDrop={handleTreeDrop}
    >
      {/* Drag overlay */}
      {upload.isDragOver && isInProject && (
        <div className="absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-primary/[0.32] bg-primary/[0.08]">
          <div className="prism-modal-shadow flex items-center gap-3 rounded-lg bg-background px-6 py-4">
            <Upload className="h-6 w-6 text-primary" />
            <span className="text-sm font-medium">{t('fileTree.dropToUpload', 'Drop files to upload')}</span>
          </div>
        </div>
      )}

      <FileTreeHeader
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onUploadFiles={upload.handleFileSelect}
        onNewFile={() => operations.handleStartCreate('', 'file')}
        onNewFolder={() => operations.handleStartCreate('', 'directory')}
        onRefresh={refreshFiles}
        onCollapseAll={collapseAll}
        onToggleSearch={() => setShowSearchPanel((current) => !current)}
        searchPanelOpen={showSearchPanel}
        onToggleSelectionMode={() => {
          setSelectionMode((current) => {
            if (current) setSelectedPaths(new Set());
            return !current;
          });
        }}
        selectionMode={selectionMode}
        currentPath={location.root}
        parentPath={location.parent}
        isInProject={isInProject}
        onNavigateUp={navigateUp}
        onNavigateToProject={resetToProject}
        readOnly={!isInProject}
        loading={loading}
        operationLoading={operationLoading}
        isUploading={upload.uploadProgress?.status === 'uploading'}
        uploadProgress={upload.uploadProgress?.progress ?? null}
      />

      {showSearchPanel && selectedProject && (
        <div className="h-1/2 min-h-[200px] flex-shrink-0">
          <ProjectSearchPanel
            projectId={selectedProject.projectId}
            onOpenMatch={(relativePath) => {
              // 命中项打开的是文件本身。搜索返回的是相对项目根的路径(绝对路径
              // 既没用又泄漏服务器目录结构),这里拼回去交给编辑器。
              const absolute = location.root ? `${location.root}/${relativePath}` : relativePath;
              onFileOpen?.(absolute);
            }}
            onClose={() => setShowSearchPanel(false)}
          />
        </div>
      )}

      <FileTreeUploadProgress upload={upload.uploadProgress} />

      {/* F9:多选工具条。只在选择模式或已有选中项时出现,平时不占位置。 */}
      {(selectionMode || selectedPaths.size > 0) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">
            {t('fileTree.selectedCount', { count: selectedPaths.size, defaultValue: `已选 ${selectedPaths.size} 项` })}
          </span>
          <button
            type="button"
            onClick={() => void downloadSelected()}
            disabled={selectedPaths.size === 0 || operationLoading}
            className="rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-50"
          >
            {t('fileTree.batchDownload', '批量下载')}
          </button>
          <button
            type="button"
            onClick={() => void deleteSelected()}
            disabled={selectedPaths.size === 0 || operationLoading}
            className="rounded-md border border-border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent disabled:opacity-50"
          >
            {t('fileTree.batchDelete', '批量删除')}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
          >
            {t('fileTree.exitSelection', '退出多选')}
          </button>
        </div>
      )}

      {viewMode === 'detailed' && filteredFiles.length > 0 && <FileTreeDetailedColumns />}

      <ScrollArea className="flex-1 px-2 py-1">
        {/* New item input */}
        {operations.isCreating && (
          <div
            className="mb-1 flex items-center gap-1.5 py-[3px] pr-2"
            style={{ paddingLeft: `${(operations.newItemParent.split('/').length - 1) * 16 + 4}px` }}
          >
            {operations.newItemType === 'directory' ? (
              <Folder className={cn(ICON_SIZE_CLASS, 'text-primary')} />
            ) : (
              <span className="ml-[18px]">{renderFileIcon(operations.newItemName)}</span>
            )}
            <Input
              ref={newItemInputRef}
              type="text"
              value={operations.newItemName}
              onChange={(e) => operations.setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') operations.handleConfirmCreate();
                if (e.key === 'Escape') operations.handleCancelCreate();
              }}
              onBlur={() => {
                setTimeout(() => {
                  if (operations.isCreating) operations.handleConfirmCreate();
                }, 100);
              }}
              className="h-6 flex-1 text-sm"
              disabled={operationLoading}
            />
          </div>
        )}

        {truncated && (
          // 服务端因条目上限截断了列表(X-Prism-Truncated)。此前前端不读这个头,
          // 大目录静默少显示 —— 用户以为看到的就是全部。
          <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{t('fileTree.truncatedNotice', '目录条目过多,仅显示部分内容。可进入子目录查看更多。')}</span>
          </div>
        )}

        <FileTreeBody
          files={files}
          filteredFiles={filteredFiles}
          searchQuery={searchQuery}
          viewMode={viewMode}
          expandedDirs={effectiveExpandedDirs}
          onItemClick={handleItemClick}
          renderFileIcon={renderFileIcon}
          formatFileSize={formatFileSize}
          formatRelativeTime={formatRelativeTimeLabel}
          onRename={operations.handleStartRename}
          onDelete={operations.handleStartDelete}
          onNewFile={(path) => operations.handleStartCreate(path, 'file')}
          onNewFolder={(path) => operations.handleStartCreate(path, 'directory')}
          onCopyPath={operations.handleCopyPath}
          onDownload={operations.handleDownload}
          onRefresh={refreshFiles}
          // Pass rename state and handlers for inline editing
          renamingItem={operations.renamingItem}
          renameValue={operations.renameValue}
          setRenameValue={operations.setRenameValue}
          handleConfirmRename={operations.handleConfirmRename}
          handleCancelRename={operations.handleCancelRename}
          renameInputRef={renameInputRef}
          operationLoading={operationLoading}
          // F9:拖到具体目录上就落在那个目录(此前这两个回调写好了却从没接线,
          // 拖进来的文件永远落在项目根)。
          onItemDragOver={upload.handleItemDragOver}
          onItemDrop={upload.handleItemDrop}
          dropTarget={upload.dropTarget}
          selectedPaths={selectedPaths}
          onToggleSelect={toggleSelect}
          selectionMode={selectionMode}
        />
      </ScrollArea>

      {selectedImage && (
        <ImageViewer
          file={selectedImage}
          onClose={() => setSelectedImage(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {operations.deleteConfirmation.isOpen && operations.deleteConfirmation.item && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[rgba(16,16,16,0.72)]">
          <div className="prism-modal-shadow mx-4 max-w-sm rounded-lg border border-border bg-background p-4">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-destructive/10 p-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">
                  {t('fileTree.delete.title', 'Delete {{type}}', {
                    type: operations.deleteConfirmation.item.type === 'directory' ? 'Folder' : 'File'
                  })}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {operations.deleteConfirmation.item.name}
                </p>
              </div>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">
              {operations.deleteConfirmation.item.type === 'directory'
                ? t('fileTree.delete.folderWarning', 'This folder and all its contents will be permanently deleted.')
                : t('fileTree.delete.fileWarning', 'This file will be permanently deleted.')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={operations.handleCancelDelete}
                disabled={operationLoading}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={operations.handleConfirmDelete}
                disabled={operationLoading}
                className="flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground transition-colors hover:bg-destructive disabled:opacity-50"
              >
                {t('fileTree.delete.confirm', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-4 right-4 z-[9999] px-4 py-2 rounded-lg prism-modal-shadow flex items-center gap-2',
            // 失败不用红:红只留给不可逆的销毁确认,这里靠图标 + 文案区分
            toast.type === 'success'
              ? 'bg-primary text-primary-foreground'
              : 'border border-border bg-card text-card-foreground'
          )}
        >
          {toast.type === 'success' ? (
            <Check className="h-4 w-4" />
          ) : toast.type === 'warning' ? (
            // 「做完了但不完整」—— 与失败区分开,否则用户会以为下载压根没成
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          ) : (
            <X className="h-4 w-4" />
          )}
          <span className="text-sm">{toast.message}</span>
        </div>
      )}
    </div>
  );
}
