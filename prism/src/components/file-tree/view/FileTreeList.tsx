import type { ReactNode, RefObject } from 'react';

import type { FileTreeNode as FileTreeNodeType, FileTreeViewMode } from '../types/types';

import FileTreeNode from './FileTreeNode';

type FileTreeListProps = {
  items: FileTreeNodeType[];
  viewMode: FileTreeViewMode;
  expandedDirs: Set<string>;
  onItemClick: (item: FileTreeNodeType) => void;
  renderFileIcon: (filename: string) => ReactNode;
  formatFileSize: (bytes?: number) => string;
  formatRelativeTime: (date?: string) => string;
  onRename?: (item: FileTreeNodeType) => void;
  onDelete?: (item: FileTreeNodeType) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onCopyPath?: (item: FileTreeNodeType) => void;
  onDownload?: (item: FileTreeNodeType) => void;
  onRefresh?: () => void;
  // Rename state for inline editing
  renamingItem?: FileTreeNodeType | null;
  renameValue?: string;
  setRenameValue?: (value: string) => void;
  handleConfirmRename?: () => void;
  handleCancelRename?: () => void;
  renameInputRef?: RefObject<HTMLInputElement>;
  operationLoading?: boolean;
  /** F9:拖放到指定文件夹 + 多选。见 FileTreeNode 里的说明。 */
  onItemDragOver?: (event: React.DragEvent, itemPath: string) => void;
  onItemDrop?: (event: React.DragEvent, itemPath: string) => void;
  dropTarget?: string | null;
  selectedPaths?: ReadonlySet<string>;
  onToggleSelect?: (item: FileTreeNodeType, event: React.MouseEvent) => void;
  selectionMode?: boolean;
};

export default function FileTreeList({
  items,
  viewMode,
  expandedDirs,
  onItemClick,
  renderFileIcon,
  formatFileSize,
  formatRelativeTime,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onDownload,
  onRefresh,
  renamingItem,
  renameValue,
  setRenameValue,
  handleConfirmRename,
  handleCancelRename,
  renameInputRef,
  operationLoading,
  onItemDragOver,
  onItemDrop,
  dropTarget,
  selectedPaths,
  onToggleSelect,
  selectionMode,
}: FileTreeListProps) {
  return (
    <div>
      {items.map((item) => (
        <FileTreeNode
          key={item.path}
          item={item}
          level={0}
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          onItemClick={onItemClick}
          renderFileIcon={renderFileIcon}
          formatFileSize={formatFileSize}
          formatRelativeTime={formatRelativeTime}
          onRename={onRename}
          onDelete={onDelete}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onCopyPath={onCopyPath}
          onDownload={onDownload}
          onRefresh={onRefresh}
          onItemDragOver={onItemDragOver}
          onItemDrop={onItemDrop}
          dropTarget={dropTarget}
          selectedPaths={selectedPaths}
          onToggleSelect={onToggleSelect}
          selectionMode={selectionMode}
          renamingItem={renamingItem}
          renameValue={renameValue}
          setRenameValue={setRenameValue}
          handleConfirmRename={handleConfirmRename}
          handleCancelRename={handleCancelRename}
          renameInputRef={renameInputRef}
          operationLoading={operationLoading}
        />
      ))}
    </div>
  );
}
