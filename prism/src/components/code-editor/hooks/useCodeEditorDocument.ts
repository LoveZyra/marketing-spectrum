import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import { useToast } from '../../../shared/view/ui';
import type { CodeEditorFile } from '../types/types';
import { isBinaryFile } from '../utils/binaryFile';
import { getPreviewKind } from '../utils/previewableFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  const { toast } = useToast();
  // 保存冲突基线:加载/成功保存后记录磁盘 mtime,保存时回传给服务端(D1)。
  const baseMtimeRef = useRef<number | null>(null);
  // 冲突后置真:下一次保存跳过基线检测(用户选择覆盖)。
  const forceNextSaveRef = useRef(false);
  const [content, setContent] = useState('');
  // What the server last confirmed. The HTML preview reads the file from disk,
  // so it needs to know when the buffer has moved on without it.
  const [persistedContent, setPersistedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 读文件失败时置位。关键作用是**锁掉保存** —— 否则读失败塞进去的
  // "// Error loading file…" 会被当成文件内容,用户一个 Ctrl+S 就把错误注释
  // 覆盖到真文件上(hasUnsavedChanges 此时为真,因为 persistedContent 还是空)。
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  // Some binaries (images, PDFs, audio, video) can be rendered natively, so the
  // editor shows an inline preview instead of the generic binary placeholder.
  const previewKind = getPreviewKind(file.name);
  // `fileProjectId` is the DB primary key passed down from the editor sidebar;
  // the fallback to `projectPath` preserves older callers that didn't yet
  // propagate the identifier.
  const fileProjectId = file.projectId ?? projectPath;
  // ei:项目目录之外的会话产出走产出通道,只读。
  const outputSessionId = typeof file.outputSessionId === 'string' ? file.outputSessionId : undefined;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;
  // Diff 视图(从聊天的 Edit 工具卡点开):缓冲区里装的是 **new_string 片段**,
  // 不是整个文件。这个标志是保存闸门 —— 片段被 Ctrl+S 写回,等于把真文件
  // 截断成几行。判定条件与下面 load 的 diff 分支完全一致。
  const isDiffView = Boolean(file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined);

  useEffect(() => {
    const loadFileContent = async () => {
      try {
        setLoading(true);
        setIsBinary(false);

        // Natively previewable media (image/pdf/audio/video) is rendered by
        // CodeEditorMediaPreview, so there is nothing to read as text here.
        // Clear any buffer left over from a previously opened text file so a
        // stray save can't write stale content over the binary file.
        if (getPreviewKind(file.name)) {
          setContent('');
          setLoading(false);
          return;
        }

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          setContent('');
          setIsBinary(true);
          setLoading(false);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          setContent(fileDiffNewString);
          // 同步 persisted:diff 视图只是"看改动",不算未保存编辑 ——
          // 否则 hasUnsavedChanges 恒真,beforeunload 会对着一个只读视图拦人。
          setPersistedContent(fileDiffNewString);
          setLoading(false);
          return;
        }

        if (!outputSessionId && !fileProjectId) {
          throw new Error('Missing project identifier');
        }

        const response = outputSessionId
          ? await api.sessionOutputText(outputSessionId, filePath)
          : await api.readFile(fileProjectId, filePath);
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        setContent(data.content);
        setPersistedContent(data.content);
        // 记录加载时的 mtime 作保存冲突基线(D1)。
        baseMtimeRef.current = typeof data.mtimeMs === 'number' ? data.mtimeMs : null;
        setLoadError(null);
      } catch (error) {
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        // 展示成错误文本,但同时置 loadError —— 保存会被它挡住,不会把这段注释
        // 写回磁盘。persistedContent 保持不变,hasUnsavedChanges 的真假不再是
        // "能不能覆盖真文件"的依据。
        setContent(`// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`);
        setLoadError(message);
      } finally {
        setLoading(false);
      }
    };

    loadFileContent();
  }, [file.diffInfo, file.name, fileDiffNewString, fileDiffOldString, fileName, filePath, fileProjectId, outputSessionId]);

  const handleSave = useCallback(async () => {
    // Preview-only and binary files have no editable text buffer; never write
    // them back (e.g. via Cmd/Ctrl+S) or we'd corrupt the file on disk.
    if (previewKind || isBinaryFile(fileName)) {
      return;
    }

    // Diff 视图的缓冲区是 new_string **片段** —— 写回等于把整个文件截断成几行。
    // 头部在 diff 模式下已藏掉保存按钮,这里是对 Ctrl+S 的最后一道闸。
    if (isDiffView) {
      return;
    }

    // ei:会话产出通道只读 —— 它按"这段会话写过这个路径"放行读取,写回不在
    // 它的授权范围里(项目目录以内的文件仍然走项目接口,照常可编辑可保存)。
    if (outputSessionId) {
      return;
    }

    // 读失败时缓冲区里是错误注释,不是文件内容。绝不能保存 —— 那会用注释覆盖
    // 真文件。让用户重新打开成功后再编辑。
    if (loadError) {
      setSaveError('文件未能正确加载,已禁止保存以免覆盖原文件。请重新打开该文件。');
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      if (!fileProjectId) {
        throw new Error('Missing project identifier');
      }

      // 冲突后再次点保存 = 用户选择"仍然覆盖":这次不带基线,跳过冲突检测。
      const useForce = forceNextSaveRef.current;
      forceNextSaveRef.current = false;
      const baseMtime = useForce ? undefined : (baseMtimeRef.current ?? undefined);

      const response = await api.saveFile(fileProjectId, filePath, content, baseMtime);

      // 409:磁盘版本在编辑期间变过。不覆盖,给用户"重载 / 仍覆盖"两条路 ——
      // 重载 = 关掉重新打开;仍覆盖 = 再点一次保存(下一次带 force)。
      if (response.status === 409) {
        forceNextSaveRef.current = true;
        const conflictMsg = '文件在你编辑期间被改动过。再次点击保存将覆盖磁盘版本;或关闭后重新打开以加载最新内容。';
        setSaveError(conflictMsg);
        toast({ message: '文件已被改动,未覆盖', description: '再次保存=覆盖;重新打开=加载最新', variant: 'error' });
        return;
      }

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Save failed: ${response.status}`);
        }

        const textError = await response.text();
        console.error('Non-JSON error response:', textError);
        throw new Error(`Save failed: ${response.status} ${response.statusText}`);
      }

      const saved = await response.json().catch(() => ({}));
      // 更新基线为这次写入后的 mtime,后续保存以它为准。
      if (typeof saved?.mtimeMs === 'number') baseMtimeRef.current = saved.mtimeMs;

      setPersistedContent(content);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [content, filePath, fileProjectId, outputSessionId, previewKind, fileName, isDiffView, loadError, toast]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name]);

  return {
    content,
    setContent,
    hasUnsavedChanges: content !== persistedContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    loadError,
    isBinary,
    isDiffView,
    previewKind,
    fileProjectId,
    handleSave,
    handleDownload,
  };
};
