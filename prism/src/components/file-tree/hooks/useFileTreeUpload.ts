import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { IS_PLATFORM } from '../../../constants/config';
import type { Project } from '../../../types/app';
import { apiKeyHeaders, authenticatedFetch } from '../../../utils/api';
import { installRefreshedToken } from '../../../utils/tokenRefresh';
import {
  MAX_FILE_UPLOAD_COUNT,
  MAX_FILE_UPLOAD_SIZE_BYTES,
  MAX_FILE_UPLOAD_SIZE_LABEL,
  MAX_FILE_UPLOAD_TOTAL_BYTES,
  MAX_FILE_UPLOAD_TOTAL_LABEL,
} from '../constants/constants';
import { formatFileSize } from '../utils/fileTreeUtils';
import { describeFileServerError } from '../utils/serverErrorText';

type UseFileTreeUploadOptions = {
  selectedProject: Project | null;
  onRefresh: () => void;
  showToast: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;
  /**
   * hl(动态 P2-12):上传前查一下树里有没有同名 —— 返回会被覆盖的相对路径列表。
   * 由 FileTree 提供(它手里有整棵树);不传就只在上传后按服务端返回的 `overwritten` 提示。
   */
  findExisting?: (relativePaths: string[], targetPath: string) => string[];
};

export type FileTreeUploadProgressState = {
  status: 'uploading' | 'complete' | 'error';
  progress: number;
  fileCount: number;
  uploadedCount?: number;
  fileName?: string;
  targetPath?: string;
  error?: string;
};

type UploadResponse = {
  error?: string;
  message?: string;
  files?: unknown[];
  uploadedCount?: number;
  requestedFileCount?: number;
  /** hl(动态 P2-12):服务端落盘前查到的同名文件(相对目标目录)。 */
  overwritten?: string[];
};

const COMPLETE_PROGRESS_CLEAR_DELAY_MS = 1400;
const ERROR_PROGRESS_CLEAR_DELAY_MS = 3200;

const getRelativePath = (file: File) => {
  const fileWithRelativePath = file as File & { webkitRelativePath?: string };
  return fileWithRelativePath.webkitRelativePath || file.name;
};

const getFileDisplayName = (file: File) => {
  const relativePath = getRelativePath(file);
  return relativePath.split(/[\\/]/).pop() || file.name;
};

type Translate = (key: string, options: Record<string, unknown> & { defaultValue: string }) => string;

/**
 * hl(P3 文件组):不再按「一次最多 20 个」整批拒绝 —— 超过的按 20 个一批分批发
 * (见 uploadFiles)。这里只剩单文件与总量两道闸。
 */
const validateFilesForUpload = (files: File[], t: Translate): string | null => {
  const oversizedFile = files.find((file) => file.size > MAX_FILE_UPLOAD_SIZE_BYTES);
  if (oversizedFile) {
    return t('fileTree.upload.fileTooLarge', {
      name: getFileDisplayName(oversizedFile),
      limit: MAX_FILE_UPLOAD_SIZE_LABEL,
      defaultValue: `「${getFileDisplayName(oversizedFile)}」超过单文件上限 ${MAX_FILE_UPLOAD_SIZE_LABEL}`,
    });
  }

  // Every file can clear the per-file cap and the batch still be enormous, which
  // is the case that fills the server's disk. Reporting the actual total makes
  // the message actionable — the user can see how much to drop.
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_FILE_UPLOAD_TOTAL_BYTES) {
    return t('fileTree.upload.totalTooLarge', {
      total: formatFileSize(totalBytes),
      limit: MAX_FILE_UPLOAD_TOTAL_LABEL,
      defaultValue: `这批文件共 ${formatFileSize(totalBytes)},一次上传最多 ${MAX_FILE_UPLOAD_TOTAL_LABEL}`,
    });
  }

  return null;
};

/** 按服务端每请求的文件数上限切批。 */
export const chunkUploadBatches = <T,>(files: T[], size = MAX_FILE_UPLOAD_COUNT): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < files.length; index += size) {
    batches.push(files.slice(index, index + size));
  }
  return batches;
};

const parseUploadResponse = (xhr: XMLHttpRequest): UploadResponse => {
  if (!xhr.responseText) {
    return {};
  }

  try {
    return JSON.parse(xhr.responseText) as UploadResponse;
  } catch {
    return {};
  }
};

const formatUploadSuccessMessage = (uploadedCount: number, requestedFileCount: number, t: Translate) => {
  if (uploadedCount !== requestedFileCount) {
    return t('fileTree.upload.partial', {
      uploaded: uploadedCount,
      total: requestedFileCount,
      defaultValue: `已上传 ${uploadedCount} / ${requestedFileCount} 个文件`,
    });
  }

  return t('fileTree.upload.success', {
    uploaded: uploadedCount,
    defaultValue: `已上传 ${uploadedCount} 个文件`,
  });
};

/** hl(动态 P2-12):被覆盖的文件列表 → 一句提示(最多列 3 个,其余计数)。 */
export const formatOverwrittenMessage = (overwritten: string[], t: Translate): string => {
  const shown = overwritten.slice(0, 3).join('、');
  const rest = overwritten.length - 3;
  return rest > 0
    ? t('fileTree.upload.overwrittenMany', {
        names: shown,
        rest,
        defaultValue: `已覆盖同名文件:${shown},另有 ${rest} 个`,
      })
    : t('fileTree.upload.overwritten', {
        names: shown,
        defaultValue: `已覆盖同名文件:${shown}`,
      });
};

const buildUploadFormData = (files: File[], targetPath: string) => {
  const formData = new FormData();
  const relativePaths: string[] = [];

  formData.append('targetPath', targetPath);
  formData.append('requestedFileCount', String(files.length));

  files.forEach((file) => {
    const relativePath = getRelativePath(file);
    const cleanFile = new File([file], relativePath.split(/[\\/]/).pop() || file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });

    formData.append('files', cleanFile);
    relativePaths.push(relativePath);
  });

  formData.append('relativePaths', JSON.stringify(relativePaths));

  return formData;
};

/**
 * prism: 分片上传单个大文件。反向代理(nginx/openresty)的 client_max_body_size 会在
 * 请求到达 Prism 之前砍掉超限的请求体并返回它自己的 413 —— 服务端允许 1GB 也没用,
 * 那层拒绝在应用日志里不留痕迹。切成小于代理上限的片逐个发,代理只看单请求大小。
 * 片大小由服务端 /files/upload/limits 给出(默认 15MB),前端不再自己硬编码。
 */
const UPLOAD_CHUNK_FALLBACK_BYTES = 15 * 1024 * 1024;
const UPLOAD_CHUNK_RETRIES = 3;

let uploadLimitsCache: { chunkBytes: number } | null = null;

const fetchUploadLimits = async (projectId: string): Promise<{ chunkBytes: number }> => {
  if (uploadLimitsCache) return uploadLimitsCache;
  try {
    const response = await authenticatedFetch(
      `/api/projects/${encodeURIComponent(projectId)}/files/upload/limits`,
    );
    const payload = await response.json().catch(() => ({}));
    const chunkBytes = Number(payload?.chunkBytes);
    uploadLimitsCache = {
      chunkBytes: Number.isFinite(chunkBytes) && chunkBytes > 0 ? chunkBytes : UPLOAD_CHUNK_FALLBACK_BYTES,
    };
  } catch {
    // 老服务端没有这个端点:退回内置值,分片照样能工作。
    uploadLimitsCache = { chunkBytes: UPLOAD_CHUNK_FALLBACK_BYTES };
  }
  return uploadLimitsCache;
};

const uploadOneFileInChunks = async (
  projectId: string,
  file: File,
  targetPath: string,
  chunkBytes: number,
  onBytes: (bytesSent: number) => void,
): Promise<UploadResponse> => {
  const relativePath = getRelativePath(file);
  const base = `/api/projects/${encodeURIComponent(projectId)}/files/upload`;

  const started = await authenticatedFetch(`${base}/start`, {
    method: 'POST',
    body: JSON.stringify({
      name: relativePath.split(/[\\/]/).pop() || file.name,
      relativePath,
      size: file.size,
      targetPath,
    }),
  });
  const startPayload = await started.json().catch(() => ({}));
  if (!started.ok) throw new Error(startPayload?.error || `Upload start failed (${started.status})`);

  const uploadId: string = startPayload.uploadId;
  const effectiveChunk = Number(startPayload.chunkBytes) || chunkBytes;
  const totalChunks = Math.ceil(file.size / effectiveChunk);

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * effectiveChunk;
      const blob = file.slice(start, Math.min(start + effectiveChunk, file.size));
      const formData = new FormData();
      formData.append('uploadId', uploadId);
      formData.append('index', String(index));
      formData.append('chunk', blob, `${file.name}.part${index}`);

      // 单片重试:传到一半被一次网络抖动打断,不该从头再来。服务端对已收分片幂等。
      let lastError: unknown = null;
      for (let attempt = 0; attempt < UPLOAD_CHUNK_RETRIES; attempt += 1) {
        try {
          await uploadFormDataWithProgress(projectId, formData, undefined, `${base}/chunk`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => { setTimeout(resolve, 500 * (attempt + 1)); });
        }
      }
      if (lastError) throw lastError;
      onBytes(start + blob.size);
    }
  } catch (error) {
    // 主动收尸:不通知的话服务端那个 .part 要挂到 TTL 到期才被清扫器收走。
    await authenticatedFetch(`${base}/abort`, {
      method: 'POST',
      body: JSON.stringify({ uploadId }),
    }).catch(() => {});
    throw error;
  }

  const finished = await authenticatedFetch(`${base}/complete`, {
    method: 'POST',
    body: JSON.stringify({ uploadId }),
  });
  const payload = await finished.json().catch(() => ({}));
  if (!finished.ok) throw new Error(payload?.error || `Upload finalize failed (${finished.status})`);
  return payload as UploadResponse;
};

const uploadFormDataWithProgress = (
  projectId: string,
  formData: FormData,
  // 分片路径不需要单请求级别的百分比(进度按全局字节算),所以两者都可选。
  onProgress?: (progress: number) => void,
  url?: string,
) =>
  new Promise<UploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open('POST', url || `/api/projects/${encodeURIComponent(projectId)}/files/upload`);

    // authenticatedFetch sends these on every other request; this hand-rolled
    // XHR exists only for the progress events, so it has to reproduce the same
    // headers. Omitting the API key made file-tree uploads the one path that
    // would break the moment PRISM_API_KEY was configured.
    Object.entries(apiKeyHeaders()).forEach(([header, value]) => {
      xhr.setRequestHeader(header, value);
    });

    const token = localStorage.getItem('auth-token');
    if (!IS_PLATFORM && token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }

      // Keep 100% for the server response so the UI can distinguish transfer
      // completion from the final write/refresh step.
      if (onProgress) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.onload = () => {
      // 经共享闸门落盘:形状不对、或与当前用户不一致(缓存重放/换号竞态)都丢弃(dj)。
      installRefreshedToken(xhr.getResponseHeader('X-Refreshed-Token'));

      const payload = parseUploadResponse(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }

      reject(new Error(payload.error || payload.message || `Upload failed with status ${xhr.status}`));
    };

    // 文案在 uploadFiles 的 catch 里经 describeFileServerError 翻成界面语言。
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload canceled.'));

    xhr.send(formData);
  });

// Helper function to read all files from a directory entry recursively
const readAllDirectoryEntries = async (directoryEntry: FileSystemDirectoryEntry, basePath = ''): Promise<File[]> => {
  const files: File[] = [];

  const reader = directoryEntry.createReader();
  let entries: FileSystemEntry[] = [];

  // Read all entries from the directory (may need multiple reads)
  let batch: FileSystemEntry[];
  do {
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    entries = entries.concat(batch);
  } while (batch.length > 0);

  // Files to ignore (system files)
  const ignoredFiles = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

  for (const entry of entries) {
    const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject);
      });

      // Skip ignored files
      if (ignoredFiles.includes(file.name)) {
        continue;
      }

      // Create a new file with the relative path as the name
      const fileWithPath = new File([file], entryPath, {
        type: file.type,
        lastModified: file.lastModified,
      });
      files.push(fileWithPath);
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const subFiles = await readAllDirectoryEntries(dirEntry, entryPath);
      files.push(...subFiles);
    }
  }

  return files;
};

const collectDroppedFiles = async (dataTransfer: DataTransfer) => {
  const files: File[] = [];

  // Use DataTransferItemList for folder support
  const { items } = dataTransfer;
  if (items) {
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') {
        continue;
      }

      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (!entry) {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
        continue;
      }

      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => {
          (entry as FileSystemFileEntry).file(resolve, reject);
        });
        files.push(file);
      } else if (entry.isDirectory) {
        // Pass the directory name as basePath so files include the folder path
        const dirFiles = await readAllDirectoryEntries(entry as FileSystemDirectoryEntry, entry.name);
        files.push(...dirFiles);
      }
    }
    return files;
  }

  // Fallback for browsers that don't support webkitGetAsEntry
  for (const file of Array.from(dataTransfer.files)) {
    files.push(file);
  }

  return files;
};

export const useFileTreeUpload = ({
  selectedProject,
  onRefresh,
  showToast,
  findExisting,
}: UseFileTreeUploadOptions) => {
  const { t } = useTranslation();
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [operationLoading, setOperationLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<FileTreeUploadProgressState | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const clearProgressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearProgressTimer = useCallback(() => {
    if (clearProgressTimerRef.current) {
      clearTimeout(clearProgressTimerRef.current);
      clearProgressTimerRef.current = null;
    }
  }, []);

  const scheduleProgressClear = useCallback(
    (delay: number) => {
      clearProgressTimer();
      clearProgressTimerRef.current = setTimeout(() => {
        setUploadProgress(null);
        clearProgressTimerRef.current = null;
      }, delay);
    },
    [clearProgressTimer],
  );

  useEffect(() => clearProgressTimer, [clearProgressTimer]);

  const setUploadError = useCallback(
    (message: string, fileCount: number, targetPath = '', fileName?: string, progress = 0) => {
      setUploadProgress({
        status: 'error',
        progress,
        fileCount,
        fileName,
        targetPath,
        error: message,
      });
      scheduleProgressClear(ERROR_PROGRESS_CLEAR_DELAY_MS);
    },
    [scheduleProgressClear],
  );

  const uploadFiles = useCallback(
    async (files: File[], targetPath = '') => {
      if (files.length === 0) {
        setDropTarget(null);
        return;
      }

      const fileName = files.length === 1 ? getFileDisplayName(files[0]) : undefined;

      if (!selectedProject) {
        const message = t('fileTree.upload.noProject', { defaultValue: '请先选择一个项目再上传' });
        showToast(message, 'error');
        setUploadError(message, files.length, targetPath, fileName);
        return;
      }

      const validationError = validateFilesForUpload(files, t);
      if (validationError) {
        showToast(validationError, 'error');
        setUploadError(validationError, files.length, targetPath, fileName);
        return;
      }

      // hl(动态 P2-12):树里已经能看到同名的,先问一句再覆盖 —— 覆盖是不可逆的。
      if (findExisting) {
        const clashes = findExisting(files.map(getRelativePath), targetPath);
        if (clashes.length > 0) {
          const listed = clashes.slice(0, 5).join('\n');
          const more = clashes.length > 5 ? `\n…` : '';
          const confirmed = window.confirm(t('fileTree.upload.overwriteConfirm', {
            count: clashes.length,
            names: `${listed}${more}`,
            defaultValue: `目标目录里已有 ${clashes.length} 个同名文件,上传会覆盖它们:\n${listed}${more}\n\n确定覆盖吗?`,
          }));
          if (!confirmed) {
            setDropTarget(null);
            return;
          }
        }
      }

      clearProgressTimer();
      setOperationLoading(true);
      setUploadProgress({
        status: 'uploading',
        progress: 0,
        fileCount: files.length,
        fileName,
        targetPath,
      });

      let latestProgress = 0;

      try {
        const { chunkBytes } = await fetchUploadLimits(selectedProject.projectId);
        // 小于一片的文件继续走原来的批量请求:它们本来就能穿过代理,拆开只是徒增往返。
        // 超过一片的逐个分片传 —— 这是唯一能穿过 client_max_body_size 的走法。
        const smallFiles = files.filter((file) => file.size <= chunkBytes);
        const largeFiles = files.filter((file) => file.size > chunkBytes);
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0) || 1;

        // 进度按全局字节算,而不是按"第几个文件":一个 500MB 配十个 1KB 的批次,
        // 按文件数算的进度条会在 99% 处停很久。
        let completedBytes = 0;
        const reportBytes = (bytesSent: number) => {
          const progress = Math.min(99, Math.round(((completedBytes + bytesSent) / totalBytes) * 100));
          latestProgress = progress;
          setUploadProgress((current) =>
            current && current.status === 'uploading' ? { ...current, progress } : current,
          );
        };

        let uploadedCount = 0;
        let response: UploadResponse = {};
        const overwritten: string[] = [];

        // hl(P3 文件组):服务端每请求最多 20 个,超过的分批发而不是整批拒。
        for (const batch of chunkUploadBatches(smallFiles)) {
          const batchBytes = batch.reduce((sum, file) => sum + file.size, 0);
          response = await uploadFormDataWithProgress(
            selectedProject.projectId,
            buildUploadFormData(batch, targetPath),
            (progress) => reportBytes((batchBytes * progress) / 100),
          );
          uploadedCount += typeof response.uploadedCount === 'number'
            ? response.uploadedCount
            : response.files?.length ?? batch.length;
          if (Array.isArray(response.overwritten)) overwritten.push(...response.overwritten);
          completedBytes += batchBytes;
        }

        for (const file of largeFiles) {
          const startedAt = completedBytes;
          const one = await uploadOneFileInChunks(
            selectedProject.projectId,
            file,
            targetPath,
            chunkBytes,
            (bytesSent) => { completedBytes = startedAt; reportBytes(bytesSent); },
          );
          uploadedCount += typeof one.uploadedCount === 'number' ? one.uploadedCount : 1;
          if (Array.isArray(one.overwritten)) overwritten.push(...one.overwritten);
          completedBytes = startedAt + file.size;
          response = one;
        }

        const requestedFileCount = files.length;

        setUploadProgress({
          status: 'complete',
          progress: 100,
          fileCount: requestedFileCount,
          uploadedCount,
          fileName,
          targetPath,
        });

        // hl(动态 P2-12):覆盖了同名文件就用 warning 列出来,而不是一句「上传完成」。
        if (overwritten.length > 0) {
          showToast(formatOverwrittenMessage(overwritten, t), 'warning');
        } else {
          showToast(formatUploadSuccessMessage(uploadedCount, requestedFileCount, t), 'success');
        }
        scheduleProgressClear(COMPLETE_PROGRESS_CLEAR_DELAY_MS);
        onRefresh();
      } catch (err) {
        const message = describeFileServerError(
          err instanceof Error ? err.message : t('fileTree.uploadFailed', { defaultValue: '上传失败' }),
          t,
        );
        console.error('Upload error:', err);
        showToast(message, 'error');
        setUploadError(message, files.length, targetPath, fileName, latestProgress);
      } finally {
        setOperationLoading(false);
        setDropTarget(null);
      }
    },
    [
      clearProgressTimer,
      findExisting,
      onRefresh,
      scheduleProgressClear,
      selectedProject,
      setUploadError,
      showToast,
      t,
    ],
  );

  const handleFileSelect = useCallback(
    async (fileList: FileList | File[]) => {
      await uploadFiles(Array.from(fileList), '');
    },
    [uploadFiles],
  );

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set isDragOver to false if we're leaving the entire tree
    if (treeRef.current && !treeRef.current.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
      setDropTarget(null);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const targetPath = dropTarget || '';

      try {
        const files = await collectDroppedFiles(e.dataTransfer);
        await uploadFiles(files, targetPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : t('fileTree.upload.readDropFailed', { defaultValue: '无法读取拖入的文件' });
        console.error('Upload error:', err);
        showToast(message, 'error');
        setUploadError(message, 0, targetPath);
        setDropTarget(null);
      }
    },
    [dropTarget, setUploadError, showToast, t, uploadFiles],
  );

  const handleItemDragOver = useCallback((e: DragEvent, itemPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(itemPath);
  }, []);

  const handleItemDrop = useCallback((e: DragEvent, itemPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(itemPath);
  }, []);

  return {
    isDragOver,
    dropTarget,
    operationLoading,
    uploadProgress,
    treeRef,
    handleFileSelect,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleItemDragOver,
    handleItemDrop,
    setDropTarget,
  };
};
