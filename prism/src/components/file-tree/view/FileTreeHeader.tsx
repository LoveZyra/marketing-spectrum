import { useRef } from 'react';
import type { ChangeEvent } from 'react';
import { CheckSquare, ChevronDown, FileSearch, CornerLeftUp, Eye, FileText, FolderPlus, Home, List, RefreshCw, Search, TableProperties, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../shared/view/ui';
import { cn } from '../../../lib/utils';
import { MAX_FILE_UPLOAD_SIZE_LABEL } from '../constants/constants';
import type { FileTreeViewMode } from '../types/types';

type FileTreeHeaderProps = {
  viewMode: FileTreeViewMode;
  onViewModeChange: (mode: FileTreeViewMode) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  // Toolbar actions
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onUploadFiles?: (files: FileList) => void;
  onRefresh?: () => void;
  onCollapseAll?: () => void;
  /** F9:进入/退出多选。默认动作是打开文件,所以多选必须显式进入。 */
  onToggleSelectionMode?: () => void;
  selectionMode?: boolean;
  /** F10:全局内容搜索(与上面那个文件名搜索框是两回事)。 */
  onToggleSearch?: () => void;
  searchPanelOpen?: boolean;
  // Navigation
  /** Absolute path of the directory currently listed. */
  currentPath?: string | null;
  /** Absolute path one level up, or null at the navigation boundary. */
  parentPath?: string | null;
  /** False while browsing outside the project root. */
  isInProject?: boolean;
  onNavigateUp?: () => void;
  onNavigateToProject?: () => void;
  /**
   * Hides the create/upload controls. Set while browsing outside the project
   * root, where those endpoints answer 403 by design — showing a button whose
   * only possible outcome is an error is worse than not showing it.
   */
  readOnly?: boolean;
  // Loading state
  loading?: boolean;
  operationLoading?: boolean;
  isUploading?: boolean;
  uploadProgress?: number | null;
};

/** Last path segment, with the root ("/") kept visible as itself. */
function basename(fullPath: string): string {
  const trimmed = fullPath.replace(/[/\\]+$/, '');
  if (!trimmed) return fullPath.slice(0, 1) || fullPath;
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

export default function FileTreeHeader({
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchQueryChange,
  onNewFile,
  onNewFolder,
  onUploadFiles,
  onRefresh,
  onCollapseAll,
  onToggleSelectionMode,
  selectionMode,
  onToggleSearch,
  searchPanelOpen,
  currentPath,
  parentPath,
  isInProject = true,
  onNavigateUp,
  onNavigateToProject,
  readOnly,
  loading,
  operationLoading,
  isUploading,
  uploadProgress,
}: FileTreeHeaderProps) {
  const { t } = useTranslation();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const locationLabel = currentPath ? basename(currentPath) : t('fileTree.files');

  const handleUploadInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { files } = event.target;
    if (files && files.length > 0) {
      onUploadFiles?.(files);
    }
    event.target.value = '';
  };

  return (
    <div className="space-y-2 border-b border-border px-3 pb-2 pt-3">
      {/* Title and Toolbar */}
      <div className="flex items-center justify-between gap-1">
        {/* Location: where the tree is rooted right now, and the way back up */}
        <div className="flex min-w-0 items-center gap-0.5">
          {onNavigateUp && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 flex-shrink-0 p-0"
              onClick={onNavigateUp}
              disabled={!parentPath}
              title={
                parentPath
                  ? t('fileTree.goUpTo', 'Up to {{path}}', { path: parentPath })
                  : t('fileTree.goUpBlocked', 'Already at the highest folder you can browse')
              }
              aria-label={t('fileTree.goUp', 'Up one level')}
            >
              <CornerLeftUp className="h-3.5 w-3.5" />
            </Button>
          )}
          <h3
            className="truncate text-sm font-medium text-foreground"
            title={currentPath || undefined}
          >
            {locationLabel}
          </h3>
          {!isInProject && onNavigateToProject && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 flex-shrink-0 gap-1 px-1.5 text-[11px] text-muted-foreground"
              onClick={onNavigateToProject}
              title={t('fileTree.backToProject', 'Back to the project folder')}
            >
              <Home className="h-3 w-3" />
              {t('fileTree.backToProjectShort', 'Project')}
            </Button>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {/* Action buttons */}
          {onUploadFiles && !readOnly && (
            <>
              <input
                ref={uploadInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleUploadInputChange}
                tabIndex={-1}
                aria-hidden="true"
              />
              <Button
                variant="ghost"
                size="sm"
                className="relative h-7 w-7 p-0"
                onClick={() => uploadInputRef.current?.click()}
                title={
                  isUploading
                    ? t('fileTree.uploadingFiles', 'Uploading files')
                    : t('fileTree.uploadFiles', 'Upload files (max {{size}} each)', {
                        size: MAX_FILE_UPLOAD_SIZE_LABEL,
                      })
                }
                aria-label={t('fileTree.uploadFiles', 'Upload files (max {{size}} each)', {
                  size: MAX_FILE_UPLOAD_SIZE_LABEL,
                })}
                disabled={operationLoading}
              >
                {/* 上传中不转圈:图标改用主色 + 下方进度条,状态是静态可读的 */}
                <Upload className={cn('w-3.5 h-3.5', isUploading && 'text-primary')} />
                {isUploading && typeof uploadProgress === 'number' && (
                  <span className="absolute bottom-0.5 left-1/2 h-0.5 w-4 -translate-x-1/2 overflow-hidden rounded-full bg-border">
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </span>
                )}
              </Button>
            </>
          )}
          {onNewFile && !readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onNewFile}
              title={t('fileTree.newFile', 'New File (Cmd+N)')}
              aria-label={t('fileTree.newFile', 'New File (Cmd+N)')}
              disabled={operationLoading}
            >
              <FileText className="h-3.5 w-3.5" />
            </Button>
          )}
          {onNewFolder && !readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onNewFolder}
              title={t('fileTree.newFolder', 'New Folder (Cmd+Shift+N)')}
              aria-label={t('fileTree.newFolder', 'New Folder (Cmd+Shift+N)')}
              disabled={operationLoading}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
          )}
          {onToggleSearch && (
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-7 w-7 p-0', searchPanelOpen && 'bg-accent text-foreground')}
              onClick={onToggleSearch}
              title={t('fileTree.search.toggle', '在项目内搜索内容 (Ctrl+Shift+F)')}
              aria-label={t('fileTree.search.toggle', '在项目内搜索内容 (Ctrl+Shift+F)')}
              aria-pressed={Boolean(searchPanelOpen)}
            >
              <FileSearch className="h-3.5 w-3.5" />
            </Button>
          )}
          {onToggleSelectionMode && !readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className={cn('h-7 w-7 p-0', selectionMode && 'bg-accent text-foreground')}
              onClick={onToggleSelectionMode}
              title={t('fileTree.selectionMode', '多选')}
              aria-label={t('fileTree.selectionMode', '多选')}
              aria-pressed={Boolean(selectionMode)}
              disabled={operationLoading}
            >
              <CheckSquare className="h-3.5 w-3.5" />
            </Button>
          )}
          {onRefresh && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onRefresh}
              title={t('fileTree.refresh', 'Refresh')}
              aria-label={t('fileTree.refresh', 'Refresh')}
              disabled={operationLoading}
            >
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'text-primary')} />
            </Button>
          )}
          {onCollapseAll && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onCollapseAll}
              title={t('fileTree.collapseAll', 'Collapse All')}
              aria-label={t('fileTree.collapseAll', 'Collapse All')}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          )}
          {/* Divider */}
          <div className="mx-0.5 h-4 w-px bg-border" />
          {/* View mode buttons */}
          <Button
            variant={viewMode === 'simple' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onViewModeChange('simple')}
            title={t('fileTree.simpleView')}
            aria-label={t('fileTree.simpleView')}
          >
            <List className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={viewMode === 'compact' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onViewModeChange('compact')}
            title={t('fileTree.compactView')}
            aria-label={t('fileTree.compactView')}
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={viewMode === 'detailed' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onViewModeChange('detailed')}
            title={t('fileTree.detailedView')}
            aria-label={t('fileTree.detailedView')}
          >
            <TableProperties className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder={t('fileTree.searchPlaceholder')}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          className="h-8 pl-8 pr-8 text-sm"
        />
        {searchQuery && (
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-0.5 top-1/2 h-5 w-5 -translate-y-1/2 p-0 hover:bg-accent"
            onClick={() => onSearchQueryChange('')}
            title={t('fileTree.clearSearch')}
            aria-label={t('fileTree.clearSearch')}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
