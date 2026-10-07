import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { startBrowserDownload } from '../../../utils/browserDownload';
import { copyTextToClipboard } from '../../../utils/clipboard';
import type { FileTreeNode } from '../types/types';
import { describeFileServerError } from '../utils/serverErrorText';
import type { Project } from '../../../types/app';

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;


export type ToastMessage = {
  message: string;
  /**
   * `warning` 用于"做完了,但结果不完整或需要留意":例如批量删除有几项失败、上传覆盖了同名文件。
   *
   * `info` 是"正在做,还没好"。它和 warning 一样停留 8 秒(见 FileTree.tsx 的自动隐藏),
   * 也会被随后的成功 / 失败提示顶掉:一条 3 秒就走的"正在准备"对一个 40 秒的下载
   * 毫无意义,用户只会在剩下的时间里继续以为"点了没反应"。
   */
  type: 'success' | 'error' | 'warning' | 'info';
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
   * 不经确认框直接删一项:批量删除自己已经确认过一次了,
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
  /** 批量下载用:一次把选中的全部路径交给服务端,打成一个包。 */
  downloadPaths: (paths: string[], label: string) => Promise<void>;

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
        const data = await response.json().catch(() => ({}));
        throw new Error(describeFileServerError((data as { error?: string }).error || 'Failed to rename', t));
      }

      showToast(t('fileTree.toast.renamed', 'Renamed successfully'), 'success');
      onRefresh();
      handleCancelRename();
    } catch (err) {
      // 失败不退出改名态:输入框留着让人换个名字再试;
      // 焦点由 FileTree 里的 effect 在 operationLoading 落回 false 后放回输入框。
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
        const data = await response.json().catch(() => ({}));
        throw new Error(describeFileServerError((data as { error?: string }).error || 'Failed to delete', t));
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
      throw new Error(describeFileServerError((data as { error?: string }).error || 'Failed to delete', t));
    }
  }, [selectedProject, t]);

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
        const data = await response.json().catch(() => ({}));
        throw new Error(describeFileServerError((data as { error?: string }).error || 'Failed to create', t));
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

  // Copy path to clipboard. Over plain HTTP `navigator.clipboard` is undefined,
  // so calling it directly throws before any promise exists. copyTextToClipboard
  // feature-detects, falls back to execCommand, and resolves to whether the text
  // actually landed, so the toast reports the real outcome.
  const handleCopyPath = useCallback((item: FileTreeNode) => {
    void copyTextToClipboard(item.path).then((copied) =>
      copied
        ? showToast(t('fileTree.toast.pathCopied', 'Path copied to clipboard'), 'success')
        : showToast(t('fileTree.toast.copyFailed', 'Failed to copy path'), 'error'),
    );
  }, [showToast, t]);

  /**
   * 把下载失败的 HTTP 状态翻成一句能看懂的话,让用户分得清是没权限还是文件没了。
   *
   * 按状态分:401 登录失效、403/404 无权限或文件不存在(files/content 对看不见的项目回 404、
   * 路径越界回 403),其余给出状态码兜底。
   */
  const describeDownloadFailure = useCallback((status: number, name: string, serverMessage?: string): string => {
    // 打包名额满时签票就回 429(带中文原因),原样给用户。
    if (status === 429 && serverMessage) {
      return serverMessage;
    }
    if (status === 401) {
      return t('fileTree.download.unauthorized', { name, defaultValue: `登录已失效,请重新登录后再下载「${name}」` });
    }
    if (status === 403 || status === 404) {
      return t('fileTree.download.forbidden', { name, defaultValue: `没有权限下载「${name}」,或该文件已不存在` });
    }
    return t('fileTree.download.failed', { name, status, defaultValue: `下载「${name}」失败(HTTP ${status})` });
  }, [t]);

  /**
   * 换票 → 交给浏览器。三个入口(单文件、目录、批量多选)共用这一条。
   *
   * 服务端按"传进来的是什么"自己决定直传还是打包:一个文件 → 直传;目录或多个
   * 路径 → 一个 ZIP。前端不替它判断 —— 判断需要知道每个路径是不是目录,
   * 而那只有服务端 stat 过才算数。
   */
  const downloadPaths = useCallback(async (paths: string[], label: string) => {
    if (!selectedProject || paths.length === 0) return;

    const response = await api.issueDownloadTicket(selectedProject.projectId, paths);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(describeDownloadFailure(response.status, label, body?.error));
    }
    const { url, kind } = await response.json() as { url: string; kind: 'file' | 'zip' };

    // 打包要先在服务端走一遍目录才开始出字节,慢一点;给一句话填上这段静默。
    // 直传不需要:下载栏是立刻出现的,那本身就是最好的反馈。
    // 这条 info 有 8 秒上限(见 FileTree 的自动隐藏):浏览器导航式下载拿不到"完成"事件,
    // 永不消失的「正在准备」比没有更糟;打包排队满的失败已在签票时拦下。
    if (kind === 'zip') {
      showToast(
        t('fileTree.toast.downloadPreparing', {
          name: label,
          defaultValue: `已开始打包「${label}」,进度与结果请看浏览器下载栏`,
        }),
        'info',
      );
    }
    startBrowserDownload(url);
  }, [selectedProject, describeDownloadFailure, showToast, t]);

  /**
   * 下载:签一张票,然后让浏览器自己去下。
   *
   * 两步:先 POST 换一张 5 分钟失效、只指向这一个目标的票(权限、路径、文件存在与否全在这一步挡掉,
   * 失败还在 fetch 语境里,弹得出提示),再把带票的 URL 交给浏览器:下载栏立刻出现,进度条是浏览器画的。
   * 不在标签页里先把整份文件读进内存:下载是右键菜单里的一项,点完菜单就收起,大文件那几十秒界面
   * 完全是静的;几 GB 的文件还会把标签页撑崩,目录在浏览器里打包峰值约 2× 目录大小。
   *
   * 单个文件 → 直传,有百分比;目录或多选 → 服务端边压边发,只有"已下载 XX MB"
   * (边压边发算不出总大小,JupyterLab 下文件夹也是这样)。
   */
  const handleDownload = useCallback(async (item: FileTreeNode) => {
    if (!selectedProject) return;
    setOperationLoading(true);
    try {
      await downloadPaths([item.path], item.name);
    } catch (err) {
      // 右键菜单这条路没有别的接错处:这里不接就是一个未处理的 rejection,
      // 用户什么都看不到。批量下载直接调 downloadPaths,错误照常抛给调用方处理。
      showToast((err as Error).message, 'error');
    } finally {
      setOperationLoading(false);
    }
  }, [selectedProject, downloadPaths, showToast]);

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
    downloadPaths,

    // Loading state
    operationLoading,

    // Validation
    validateFilename,
  };
}
