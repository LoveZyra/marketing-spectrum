import { memo } from 'react';
import type { ReactNode, RefObject } from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';

import { cn } from '../../../lib/utils';
import type { FileTreeNode as FileTreeNodeType, FileTreeViewMode } from '../types/types';
import { Input } from '../../../shared/view/ui';

import FileContextMenu from './FileContextMenu';

type FileTreeNodeProps = {
  item: FileTreeNodeType;
  level: number;
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
  /**
   * F9:拖放到**指定文件夹**。
   *
   * `handleItemDragOver` / `handleItemDrop` 在 useFileTreeUpload 里写好了但从来
   * 没接到任何节点上 —— 于是拖进来的文件永远落在项目根,拖到哪个文件夹上都一样。
   * 这两个回调把"悬停在哪个目录上"告诉上传逻辑。
   */
  onItemDragOver?: (event: React.DragEvent, itemPath: string) => void;
  onItemDrop?: (event: React.DragEvent, itemPath: string) => void;
  /** 当前拖放目标路径 —— 命中的那个目录会高亮,让人知道文件会落在哪。 */
  dropTarget?: string | null;
  /** F9:多选。选中集合由上层持有(跨渲染保持),整棵树共用一份。 */
  selectedPaths?: ReadonlySet<string>;
  onToggleSelect?: (item: FileTreeNodeType, event: React.MouseEvent) => void;
  selectionMode?: boolean;
};

type TreeItemIconProps = {
  item: FileTreeNodeType;
  isOpen: boolean;
  renderFileIcon: (filename: string) => ReactNode;
};

function TreeItemIcon({ item, isOpen, renderFileIcon }: TreeItemIconProps) {
  if (item.type === 'directory') {
    return (
      <span className="flex flex-shrink-0 items-center gap-0.5">
        <ChevronRight
          className={cn(
            'w-3.5 h-3.5 text-muted-foreground',
            isOpen && 'rotate-90',
          )}
        />
        {isOpen ? (
          <FolderOpen className="h-4 w-4 flex-shrink-0 text-primary" />
        ) : (
          <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        )}
      </span>
    );
  }

  return <span className="ml-[18px] flex flex-shrink-0 items-center">{renderFileIcon(item.name)}</span>;
}

/**
 * memo:大目录下每个节点都是一次完整渲染。此前 FileTree 里任何无关状态(toast、
 * 搜索框击键、上传进度)一变,整棵树的每个节点都重渲一遍。浅比较挡住无关更新;
 * 展开/收起(expandedDirs 换新 Set)与重命名期间照常重渲,行为不变。
 */
function FileTreeNode({
  item,
  level,
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
}: FileTreeNodeProps) {
  const isDropTarget = dropTarget === item.path;
  const isSelected = Boolean(selectedPaths?.has(item.path));
  const isDirectory = item.type === 'directory';
  const isOpen = isDirectory && expandedDirs.has(item.path);
  const hasChildren = Boolean(isDirectory && item.children && item.children.length > 0);
  const isRenaming = renamingItem?.path === item.path;

  /**
   * 文件名的字体交给主题(`--filename-font` / `--filename-size`):
   * 纸构蓝图整列走等宽 —— 扩展名本身就参与区分,不必全靠图标;
   * 另外两套仍是界面字体。目录名保持界面字体加粗,它是"容器"不是"文件"。
   */
  const nameClassName = cn(
    'leading-tight truncate',
    isDirectory
      ? 'font-sans text-[13px] font-medium text-foreground'
      : 'prism-filename text-body',
  );

  // View mode only changes the row layout; selection, expansion, and recursion stay shared.
  const rowClassName = cn(
    viewMode === 'detailed'
      ? 'group grid grid-cols-12 gap-2 py-[3px] pr-2 hover:bg-accent cursor-pointer items-center rounded-sm transition-colors duration-100'
      : viewMode === 'compact'
      ? 'group flex items-center justify-between py-[3px] pr-2 hover:bg-accent cursor-pointer rounded-sm transition-colors duration-100'
      : 'group flex items-center gap-1.5 py-[3px] pr-2 cursor-pointer rounded-sm hover:bg-accent transition-colors duration-100',
    // 展开的目录行以前挂一条 2px 强调色左边条 —— 一棵树展开几层就是几根绿条,
    // 而"这个目录开着"本来就有箭头方向在表达。边框保留但恒为透明,
    // 只为占住那 2px,免得开合时整行左右跳动。
    'border-l-2 border-transparent',
    // 行间分隔交给主题:纸构蓝图给一条次级发丝线(图纸的行格),
    // 另外两套什么都不加(见 index.css 的 .prism-row)。
    'prism-row',
    // F9:拖放悬停在这个目录上 —— 让人看得见文件会落在哪。
    isDropTarget && 'bg-primary/[0.10] border-l-primary/40',
    // F9:多选选中态。
    isSelected && 'bg-primary/[0.08]',
  );

  // Render rename input if this item is being renamed
  if (isRenaming && setRenameValue && handleConfirmRename && handleCancelRename) {
    return (
      <div
        className={cn(rowClassName, 'bg-accent')}
        style={{ paddingLeft: `${level * 16 + 4}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
        <Input
          ref={renameInputRef}
          type="text"
          value={renameValue || ''}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') handleConfirmRename();
            if (e.key === 'Escape') handleCancelRename();
          }}
          onBlur={() => {
            setTimeout(() => {
              handleConfirmRename();
            }, 100);
          }}
          className="h-6 flex-1 text-sm"
          disabled={operationLoading}
        />
      </div>
    );
  }

  const rowContent = (
    <div
      className={rowClassName}
      style={{ paddingLeft: `${level * 16 + 4}px` }}
      onClick={(event) => {
        // F9:选择模式下,或按住 Ctrl/Cmd/Shift 点击 —— 都是"选中",不是"打开"。
        if (onToggleSelect && (selectionMode || event.ctrlKey || event.metaKey || event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
          onToggleSelect(item, event);
          return;
        }
        onItemClick(item);
      }}
      // F9:目录才接受拖放定位 —— 拖到文件上没有意义,反而会让人以为能"放进文件里"。
      onDragOver={isDirectory && onItemDragOver ? (event) => onItemDragOver(event, item.path) : undefined}
      onDrop={isDirectory && onItemDrop ? (event) => onItemDrop(event, item.path) : undefined}
    >
      {/*
        eo:表格视图下复选框必须**长在"名称"这一格里面**,不能作为兄弟节点插在前面。
        这一行是 `grid grid-cols-12`,四格加起来正好 12(5+2+3+2);在它们前面多插
        一个网格子项就变成 13 个,最后那格「权限」被挤到第二行 —— 用户实测:
        「点了多选以后就出现换行,界面乱了」。放进名称格里,列宽和表头照旧对齐。
      */}
      {selectionMode && onToggleSelect && viewMode !== 'detailed' && (
        <input
          type="checkbox"
          checked={Boolean(isSelected)}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onToggleSelect(item, { ctrlKey: true } as React.MouseEvent)}
          aria-label={item.name}
          className="mr-1 h-3.5 w-3.5 flex-shrink-0"
        />
      )}
      {viewMode === 'detailed' ? (
        <>
          <div className="col-span-5 flex min-w-0 items-center gap-1.5">
            {selectionMode && onToggleSelect && (
              <input
                type="checkbox"
                checked={Boolean(isSelected)}
                onClick={(event) => event.stopPropagation()}
                onChange={() => onToggleSelect(item, { ctrlKey: true } as React.MouseEvent)}
                aria-label={item.name}
                className="h-3.5 w-3.5 flex-shrink-0"
              />
            )}
            <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
            <span className={nameClassName}>{item.name}</span>
          </div>
          <div className="col-span-2 font-mono text-sm tabular-nums text-muted-foreground">
            {item.type === 'file' ? formatFileSize(item.size) : ''}
          </div>
          <div className="col-span-3 font-mono text-sm text-muted-foreground">{formatRelativeTime(item.modified)}</div>
          <div className="col-span-2 font-mono text-sm text-muted-foreground">{item.permissionsRwx || ''}</div>
        </>
      ) : viewMode === 'compact' ? (
        <>
          <div className="flex min-w-0 items-center gap-1.5">
            <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
            <span className={nameClassName}>{item.name}</span>
          </div>
          <div className="ml-2 flex flex-shrink-0 items-center gap-3 text-sm text-muted-foreground">
            {item.type === 'file' && (
              <>
                <span className="font-mono tabular-nums">{formatFileSize(item.size)}</span>
                <span className="font-mono">{item.permissionsRwx}</span>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <TreeItemIcon item={item} isOpen={isOpen} renderFileIcon={renderFileIcon} />
          <span className={nameClassName}>{item.name}</span>
        </>
      )}
    </div>
  );

  // Check if context menu callbacks are provided
  const hasContextMenu = onRename || onDelete || onNewFile || onNewFolder || onCopyPath || onDownload || onRefresh;

  return (
    <div className="select-none">
      {hasContextMenu ? (
        <FileContextMenu
          item={item}
          onRename={onRename}
          onDelete={onDelete}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onCopyPath={onCopyPath}
          onDownload={onDownload}
          onRefresh={onRefresh}
        >
          {rowContent}
        </FileContextMenu>
      ) : (
        rowContent
      )}

      {isDirectory && isOpen && hasChildren && (
        <div className="relative">
          <span
            className="absolute bottom-0 top-0 border-l border-border"
            style={{ left: `${level * 16 + 14}px` }}
            aria-hidden="true"
          />
          {item.children?.map((child) => (
            <MemoizedFileTreeNode
              key={child.path}
              item={child}
              level={level + 1}
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
              renamingItem={renamingItem}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              handleConfirmRename={handleConfirmRename}
              handleCancelRename={handleCancelRename}
              renameInputRef={renameInputRef}
              operationLoading={operationLoading}
              onItemDragOver={onItemDragOver}
              onItemDrop={onItemDrop}
              dropTarget={dropTarget}
              selectedPaths={selectedPaths}
              onToggleSelect={onToggleSelect}
              selectionMode={selectionMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// 递归子节点也走 memo 包装,整棵子树都享受浅比较短路。
const MemoizedFileTreeNode = memo(FileTreeNode);
export default MemoizedFileTreeNode;
