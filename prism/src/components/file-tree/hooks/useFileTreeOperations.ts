import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import JSZip from 'jszip';

import { api } from '../../../utils/api';
import { copyTextToClipboard } from '../../../utils/clipboard';
import type { FileTreeNode } from '../types/types';
import type { Project } from '../../../types/app';

// Invalid filename characters
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export type ToastMessage = {
  message: string;
  /** `warning` 用于"做完了,但结果不完整" —— 例如 ZIP 少打了没加载到的子目录。 */
  type: 'success' | 'error' | 'warning';
};

export type DeleteConfirmation = {
  isOpen: boolean;
  item: FileTreeNode | null;
};

export type UseFileTreeOperationsOptions = {
  selectedProject: Project | null;
  onRefresh: () => void;
  showToast: (message: string, type: ToastMessage['type']) => void;
};

export type UseFileTreeOperationsResult = {
  // Rename operations
  renamingItem: FileTreeNode | null;
  renameValue: string;
  handleStartRename: (item: FileTreeNode) => void;
  handleCancelRename: () => void;
  handleConfirmRename: () => Promise<void>;
  setRenameValue: (value: string) => void;

  // Delete operations
  deleteConfirmation: DeleteConfirmation;
  handleStartDelete: (item: FileTreeNode) => void;
  handleCancelDelete: () => void;
  handleConfirmDelete: () => Promise<void>;
  /**
   * F9:不经确认框直接删一项 —— 批量删除自己已经确认过一次了,
   * 逐项再弹一次就成了点二十下"确定"。抛错交给调用方计数。
   */
  deleteItemDirectly: (item: FileTreeNode) => Promise<void>;

  // Create operations
  isCreating: boolean;
  newItemParent: string;
  newItemType: 'file' | 'directory';
  newItemName: string;
  handleStartCreate: (parentPath: string, type: 'file' | 'directory') => void;
  handleCancelCreate: () => void;
  handleConfirmCreate: () => Promise<void>;
  setNewItemName: (name: string) => void;

  // Other operations
  handleCopyPath: (item: FileTreeNode) => void;
  handleDownload: (item: FileTreeNode) => Promise<void>;

  // Loading state
  operationLoading: boolean;

  // Validation
  validateFilename: (name: string) => string | null;
};

export function useFileTreeOperations({
  selectedProject,
  onRefresh,
  showToast,
}: UseFileTreeOperationsOptions): UseFileTreeOperationsResult {
  const { t } = useTranslation();

  // State
  const [renamingItem, setRenamingItem] = useState<FileTreeNode | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation>({
    isOpen: false,
    item: null,
  });
  const [isCreating, setIsCreating] = useState(false);
  const [newItemParent, setNewItemParent] = useState('');
  const [newItemType, setNewItemType] = useState<'file' | 'directory'>('file');
  const [newItemName, setNewItemName] = useState('');
  const [operationLoading, setOperationLoading] = useState(false);

  // Validation
  const validateFilename = useCallback((name: string): string | null => {
    if (!name || !name.trim()) {
      return t('fileTree.validation.emptyName', 'Filename cannot be empty');
    }
    if (INVALID_FILENAME_CHARS.test(name)) {
      return t('fileTree.validation.invalidChars', 'Filename contains invalid characters');
    }
    if (RESERVED_NAMES.test(name)) {
      return t('fileTree.validation.reserved', 'Filename is a reserved name');
    }
    if (/^\.+$/.test(name)) {
      return t('fileTree.validation.dotsOnly', 'Filename cannot be only dots');
    }
    return null;
  }, [t]);

  // Rename operations
  const handleStartRename = useCallback((item: FileTreeNode) => {
    setRenamingItem(item);
    setRenameValue(item.name);
    setIsCreating(false);
  }, []);

  const handleCancelRename = useCallback(() => {
    setRenamingItem(null);
    setRenameValue('');
  }, []);

  const handleConfirmRename = useCallback(async () => {
    if (!renamingItem || !selectedProject) return;

    const error = validateFilename(renameValue);
    if (error) {
      showToast(error, 'error');
      return;
    }

    if (renameValue === renamingItem.name) {
      handleCancelRename();
      return;
    }

    setOperationLoading(true);
    try {
      const response = await api.renameFile(selectedProject.projectId, {
        oldPath: renamingItem.path,
        newName: renameValue,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to rename');
      }

      showToast(t('fileTree.toast.renamed', 'Renamed successfully'), 'success');
      onRefresh();
      handleCancelRename();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [renamingItem, renameValue, selectedProject, validateFilename, showToast, t, onRefresh, handleCancelRename]);

  // Delete operations
  const handleStartDelete = useCallback((item: FileTreeNode) => {
    setDeleteConfirmation({ isOpen: true, item });
  }, []);

  const handleCancelDelete = useCallback(() => {
    setDeleteConfirmation({ isOpen: false, item: null });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    const { item } = deleteConfirmation;
    if (!item || !selectedProject) return;

    setOperationLoading(true);
    try {
      const response = await api.deleteFile(selectedProject.projectId, {
        path: item.path,
        type: item.type,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete');
      }

      showToast(
        item.type === 'directory'
          ? t('fileTree.toast.folderDeleted', 'Folder deleted')
          : t('fileTree.toast.fileDeleted', 'File deleted'),
        'success'
      );
      onRefresh();
      handleCancelDelete();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [deleteConfirmation, selectedProject, showToast, t, onRefresh, handleCancelDelete]);

  const deleteItemDirectly = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject) return;
    const response = await api.deleteFile(selectedProject.projectId, {
      path: item.path,
      type: item.type,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || 'Failed to delete');
    }
  }, [selectedProject]);

  // Create operations
  const handleStartCreate = useCallback((parentPath: string, type: 'file' | 'directory') => {
    setNewItemParent(parentPath || '');
    setNewItemType(type);
    setNewItemName(type === 'file' ? 'untitled.txt' : 'new-folder');
    setIsCreating(true);
    setRenamingItem(null);
  }, []);

  const handleCancelCreate = useCallback(() => {
    setIsCreating(false);
    setNewItemParent('');
    setNewItemName('');
  }, []);

  const handleConfirmCreate = useCallback(async () => {
    if (!selectedProject) return;

    const error = validateFilename(newItemName);
    if (error) {
      showToast(error, 'error');
      return;
    }

    setOperationLoading(true);
    try {
      const response = await api.createFile(selectedProject.projectId, {
        path: newItemParent,
        type: newItemType,
        name: newItemName,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create');
      }

      showToast(
        newItemType === 'file'
          ? t('fileTree.toast.fileCreated', 'File created successfully')
          : t('fileTree.toast.folderCreated', 'Folder created successfully'),
        'success'
      );
      onRefresh();
      handleCancelCreate();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [selectedProject, newItemParent, newItemType, newItemName, validateFilename, showToast, t, onRefresh, handleCancelCreate]);

  // Copy path to clipboard.
  //
  // The old spelling was `navigator.clipboard.writeText(...).catch(...)`, whose
  // comment named non-HTTPS as the failure case it handled — but over plain
  // HTTP `navigator.clipboard` is undefined, so reading .writeText threw a
  // TypeError before any promise existed and the .catch never ran. It also
  // announced success synchronously, ahead of the write it was reporting on.
  // copyTextToClipboard feature-detects, falls back to execCommand, and
  // resolves to whether the text actually landed.
  const handleCopyPath = useCallback((item: FileTreeNode) => {
    void copyTextToClipboard(item.path).then((copied) =>
      copied
        ? showToast(t('fileTree.toast.pathCopied', 'Path copied to clipboard'), 'success')
        : showToast(t('fileTree.toast.copyFailed', 'Failed to copy path'), 'error'),
    );
  }, [showToast, t]);

  const triggerBrowserDownload = useCallback((blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = fileName;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, []);

  // Download file or folder
  const handleDownload = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject) return;

    setOperationLoading(true);
    try {
      if (item.type === 'directory') {
        // Download folder as ZIP
        await downloadFolderAsZip(item);
      } else {
        // Download single file
        await downloadSingleFile(item);
      }
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [selectedProject, showToast]);

  /**
   * 把下载失败的 HTTP 状态翻成一句能看懂的中文。
   *
   * 之前统一抛 "Failed to download file" —— 中文界面里一句含糊的英文,用户读不出
   * "到底是没权限还是文件没了",体感就是"点了没反应"。按状态分:401 登录失效、
   * 403/404 无权限或文件不存在(files/content 对看不见的项目回 404、路径越界回 403),
   * 其余给出状态码兜底。
   */
  const describeDownloadFailure = useCallback((status: number, name: string): string => {
    if (status === 401) {
      return t('fileTree.download.unauthorized', { name, defaultValue: `登录已失效,请重新登录后再下载「${name}」` });
    }
    if (status === 403 || status === 404) {
      return t('fileTree.download.forbidden', { name, defaultValue: `没有权限下载「${name}」,或该文件已不存在` });
    }
    return t('fileTree.download.failed', { name, status, defaultValue: `下载「${name}」失败(HTTP ${status})` });
  }, [t]);

  // Download a single file
  const downloadSingleFile = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject) return;

    // Use the binary streaming endpoint so downloads preserve raw bytes.
    const response = await api.readFileBlob(selectedProject.projectId, item.path);

    if (!response.ok) {
      throw new Error(describeDownloadFailure(response.status, item.name));
    }

    const blob = await response.blob();
    triggerBrowserDownload(blob, item.name);
  }, [selectedProject, triggerBrowserDownload, describeDownloadFailure]);

  /**
   * 打包下载目录(D6:残缺必须说出来)。
   *
   * ZIP 是拿**前端已经加载的那棵树**打的,而那棵树不是全量:服务端的目录遍历
   * 有深度上限(超过就不带 `children`)和条目预算(超了整棵树打截断标记),
   * node_modules/.git 这类目录则压根不进树。原来这些情况一律静默跳过 ——
   * 用户拿到一个看着正常、其实少了整棵子树的包,而且无从知道。
   *
   * 现在:未加载的子目录被记下来,并且**照样在包里建出空目录**(保住结构),
   * 打完给一条"少了什么、去哪儿拿"的提示。真正的修法是服务端流式 zip
   * (中期),但在那之前,残缺至少不能是无声的。
   */
  const downloadFolderAsZip = useCallback(async (folder: FileTreeNode) => {
    if (!selectedProject) return;

    const zip = new JSZip();
    const skippedDirectories: string[] = [];

    // Recursively get all files in the folder
    const collectFiles = async (node: FileTreeNode, currentPath: string) => {
      const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;

      if (node.type === 'file') {
        const response = await api.readFileBlob(selectedProject.projectId, node.path);
        if (!response.ok) {
          throw new Error(describeDownloadFailure(response.status, node.name));
        }

        // Store raw bytes in the archive so binary files stay intact.
        const fileBytes = await response.arrayBuffer();
        zip.file(fullPath, fileBytes);
        return;
      }

      if (node.type !== 'directory') return;

      // `children === undefined` = 服务端遍历到深度上限就没往下走(不是"空目录",
      // 空目录给的是 `[]`)。这才是真正被吞掉的那部分。
      if (!node.children) {
        skippedDirectories.push(fullPath);
        zip.folder(fullPath);
        return;
      }

      // 空目录也显式建出来,否则 JSZip 只按文件路径推目录,空的就没了。
      if (node.children.length === 0) {
        zip.folder(fullPath);
        return;
      }

      for (const child of node.children) {
        await collectFiles(child, fullPath);
      }
    };

    // If the folder has children, process them
    if (folder.children && folder.children.length > 0) {
      for (const child of folder.children) {
        await collectFiles(child, '');
      }
    }

    // Generate ZIP file
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    triggerBrowserDownload(zipBlob, `${folder.name}.zip`);

    if (skippedDirectories.length > 0) {
      const preview = skippedDirectories.slice(0, 3).join('、');
      showToast(
        t('fileTree.toast.folderDownloadedPartial', {
          // 用 skipped 而不是 count:i18next 见到 count 会走复数键(_one/_other),
          // 这条文案不需要复数变体。
          skipped: skippedDirectories.length,
          preview,
          defaultValue: `已打包,但 ${skippedDirectories.length} 个子目录未包含(层级太深没加载):${preview}${skippedDirectories.length > 3 ? ' 等' : ''}。进入该子目录后再单独下载可拿到完整内容。`,
        }),
        'warning',
      );
      return;
    }

    showToast(t('fileTree.toast.folderDownloaded', 'Folder downloaded as ZIP'), 'success');
  }, [selectedProject, showToast, t, triggerBrowserDownload, describeDownloadFailure]);

  return {
    // Rename operations
    renamingItem,
    renameValue,
    handleStartRename,
    handleCancelRename,
    handleConfirmRename,
    setRenameValue,

    // Delete operations
    deleteConfirmation,
    handleStartDelete,
    handleCancelDelete,
    handleConfirmDelete,
    deleteItemDirectly,

    // Create operations
    isCreating,
    newItemParent,
    newItemType,
    newItemName,
    handleStartCreate,
    handleCancelCreate,
    handleConfirmCreate,
    setNewItemName,

    // Other operations
    handleCopyPath,
    handleDownload,

    // Loading state
    operationLoading,

    // Validation
    validateFilename,
  };
}
