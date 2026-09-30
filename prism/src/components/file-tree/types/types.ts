import type { LucideIcon } from 'lucide-react';

export type FileTreeViewMode = 'simple' | 'compact' | 'detailed';

export type FileTreeItemType = 'file' | 'directory';

export interface FileTreeNode {
  name: string;
  type: FileTreeItemType;
  path: string;
  size?: number;
  modified?: string;
  permissionsRwx?: string;
  children?: FileTreeNode[];
  /** 软链;`symlinkTarget` 是它指向的类型(悬空软链没有)。 */
  isSymlink?: boolean;
  symlinkTarget?: 'directory' | 'file';
  /**
   * hl(动态 P2-10):服务端没把这个目录列全(条目预算用尽 / 到了深度上限 / 软链目录不递归)。
   * 展开时显示「…还有更多」,点击按 `?path=` 单独加载它。
   */
  truncated?: boolean;
  [key: string]: unknown;
}

export interface FileTreeImageSelection {
  name: string;
  path: string;
  projectPath?: string;
  // DB projectId; used by ImageViewer to build the raw content URL.
  projectId: string;
}

export interface FileIconData {
  icon: LucideIcon;
  color: string;
}

export type FileIconMap = Record<string, FileIconData>;
