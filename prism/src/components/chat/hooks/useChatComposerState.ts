import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { authenticatedFetch } from '../../../utils/api';
import { uploadFormDataWithProgress } from '../../../utils/uploadWithProgress';
import type { MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import { grantClaudeToolPermission } from '../utils/chatPermissions';
import {
  clearQueuedMessage,
  readQueuedMessage,
  safeLocalStorage,
  writeQueuedMessage,
  type QueuedSendOptions,
} from '../utils/chatStorage';
import type {
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  SessionEstablishedContext,
} from '../types/types';
import type { Project, ProjectSession, LLMProvider, ProviderModelsCacheInfo } from '../../../types/app';
import { escapeRegExp } from '../utils/chatFormatting';
import { buildDocsBlock, type AttachedDoc } from '../utils/attachmentPrompt';

/**
 * prism: 分片落盘。反向代理(nginx/openresty)的 client_max_body_size 会在请求到
 * 达 Prism 之前就把大请求体砍掉并返回它自己的 413 —— 服务端允许 500MB 也没用,
 * 而且那层拒绝在应用日志里不留痕迹。把文件切成小于代理上限的片逐个发,代理只看
 * 单请求大小,于是任意大小都能穿过去。片大小由服务端 /api/documents/limits 给出
 * (默认 15MB,本部署实测通过的值),前端不再自己硬编码一个会漂移的常量。
 */
const LAND_CHUNK_FALLBACK_BYTES = 15 * 1024 * 1024;
const LAND_CHUNK_RETRIES = 3;

let landLimitsCache: { chunkBytes: number } | null = null;

const fetchLandLimits = async (): Promise<{ chunkBytes: number }> => {
  if (landLimitsCache) return landLimitsCache;
  try {
    const response = await authenticatedFetch('/api/documents/limits');
    const payload = await response.json().catch(() => ({}));
    const chunkBytes = Number(payload?.chunkBytes);
    landLimitsCache = { chunkBytes: Number.isFinite(chunkBytes) && chunkBytes > 0 ? chunkBytes : LAND_CHUNK_FALLBACK_BYTES };
  } catch {
    // 老服务端没有这个端点:退回内置值,分片照样能工作。
    landLimitsCache = { chunkBytes: LAND_CHUNK_FALLBACK_BYTES };
  }
  return landLimitsCache;
};

type LandPayload = { name?: string; text?: string; chars?: number; truncated?: boolean };

const landFileInChunks = async (
  file: File,
  chunkBytes: number,
  onPercent: (percent: number) => void,
): Promise<LandPayload> => {
  const started = await authenticatedFetch('/api/documents/land/start', {
    method: 'POST',
    body: JSON.stringify({ name: file.name, size: file.size }),
  });
  const startPayload = await started.json().catch(() => ({}));
  if (!started.ok) {
    throw new Error(startPayload?.error || `Upload start failed (${started.status})`);
  }
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

      // 单片重试:大文件传到一半被一次网络抖动打断,不该让用户从头再来。
      // 服务端对"已收过的片"是幂等的(直接回当前进度,不重复追加),所以重发是安全的。
      let lastError: unknown = null;
      for (let attempt = 0; attempt < LAND_CHUNK_RETRIES; attempt += 1) {
        try {
          await uploadFormDataWithProgress('/api/documents/land/chunk', formData, (percent) => {
            const sent = start + (blob.size * percent) / 100;
            onPercent(Math.min(99, Math.round((sent / file.size) * 100)));
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => { setTimeout(resolve, 500 * (attempt + 1)); });
        }
      }
      if (lastError) throw lastError;
      onPercent(Math.min(99, Math.round(((start + blob.size) / file.size) * 100)));
    }
  } catch (error) {
    // 主动收尸:不通知的话服务端那个 .part 要挂到 TTL 到期才被清扫器收走 ——
    // 一个失败的 54MB 上传就是 54MB 的僵尸文件。best-effort:连这个请求都发不
    // 出去时,服务端的清扫器仍然是兜底。
    await authenticatedFetch('/api/documents/land/abort', {
      method: 'POST',
      body: JSON.stringify({ uploadId }),
    }).catch(() => {});
    throw error;
  }

  const finished = await authenticatedFetch('/api/documents/land/complete', {
    method: 'POST',
    body: JSON.stringify({ uploadId }),
  });
  const payload = await finished.json().catch(() => ({}));
  if (!finished.ok) {
    throw new Error(payload?.error || `Upload finalize failed (${finished.status})`);
  }
  return payload as LandPayload;
};

import { useFileMentions } from './useFileMentions';
import { isPromptCommand, type SlashCommand, useSlashCommands } from './useSlashCommands';

/**
 * prism: in-flight transfer state for the generic attach button.
 *
 * `percent` is null until the browser reports a computable length, which is how
 * the UI distinguishes "still measuring" from a genuine 0%. `index`/`total`
 * exist because the attach button takes a multi-file selection and uploads it
 * serially — without them a five-file drop looks like one upload that keeps
 * restarting.
 */
export interface DocUploadProgress {
  fileName: string;
  percent: number | null;
  index: number;
  total: number;
}

/**
 * Re-exported so existing importers (ChatComposer) keep resolving the type from
 * the hook they already depend on. The shape and the prompt-assembly rules live
 * in utils/attachmentPrompt.ts, which is testable without a React renderer.
 */
export type { AttachedDoc };

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  claudeModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  isConnected: boolean;
  /** Returns false when the socket was not open, so the draft can be kept. */
  sendMessage: (message: unknown) => boolean;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
}

interface MentionableFile {
  name: string;
  path: string;
}

interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
}

export type ModelCommandData = {
  current?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
  };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: Array<{
    value: string;
    label?: string;
    description?: string;
  }>;
  defaultModel?: string;
  cache?: ProviderModelsCacheInfo;
};

export type CostCommandData = {
  tokenUsage?: {
    used?: number;
    total?: number;
  };
  tokenBreakdown?: {
    input?: number;
    output?: number;
  };
  provider?: string;
  model?: string;
};

export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
  };
};

export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{
    name: string;
    description?: string;
    namespace?: string;
  }>;
};

export type CommandModalKind = 'help' | 'models' | 'cost' | 'status';

export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

export type QueuedDraft = {
  content: string;
  images: File[];
  /**
   * Send options snapshotted at queue time. Persisted with the draft so the
   * app-level auto-send can dispatch the message with the right model and
   * permission settings while another session is being viewed.
   */
  options?: QueuedSendOptions;
};

const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  // Image attachments can't survive a reload; only text and options persist.
  return saved ? { content: saved.content, images: [], options: saved.options } : null;
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  claudeModel,
  currentProviderEffort,
  isLoading,
  canAbortSession,
  tokenBudget,
  isConnected,
  sendMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      // Draft inputs are keyed by the DB projectId so per-project drafts
      // survive display-name changes.
      return safeLocalStorage.getItem(`draft_input_${selectedProject.projectId}`) || '';
    }
    return '';
  });
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [uploadingImages, setUploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());
  // prism: parsed document attachments (PDF/DOCX/PPTX/XLSX/… and URLs).
  // Their extracted text rides along with the prompt as tagged blocks.
  const [attachedDocs, setAttachedDocs] = useState<AttachedDoc[]>([]);
  const [parsingDocsCount, setParsingDocsCount] = useState(0);
  // prism: transfer progress for the generic attach path, which accepts files up
  // to 500MB. parsingDocsCount alone renders a bare spinner, and on a file that
  // size a spinner is indistinguishable from a frozen tab for several minutes.
  const [docUploadProgress, setDocUploadProgress] = useState<DocUploadProgress | null>(null);
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  // Prism: pending fork descriptor for edit-and-rerun. When set, the next send
  // starts a brand-new session branched off the parent's native conversation.
  const pendingForkRef = useRef<{ providerSessionId: string; resumeSessionAt: string | null } | null>(null);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;

  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return null;
    }
    return restoreQueuedDraft(sessionKey);
  });
  // Which session the in-memory `queuedDraft` belongs to. On a session switch
  // there is one commit where `sessionKey` already points at the new session
  // while `queuedDraft` still holds the old session's draft; the persistence
  // effect must not write across that gap.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId,
          provider,
          model: claudeModel,
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch('/api/commands/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            args,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      claudeModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  /**
   * 打开 /models 弹窗 —— 给输入框上的模型徽标点击用。
   *
   * 和 showCostModal 同一个形状:走 executeCommand 而不是直接 set 弹窗状态,
   * 这样点徽标和敲 /models 是**同一条代码路径**,弹窗拿到的数据(当前模型、
   * provider、可选列表)不会因入口不同而分叉。preserveInput:点徽标不该吃掉
   * 用户已经打了一半的消息。
   */
  const showModelsModal = useCallback(() => {
    executeCommand(
      {
        name: '/models',
        description: 'Browse available models for the active provider',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/models',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
    sessionId: sessionKey,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleImageFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (!file.type || !file.type.startsWith('image/')) {
          return false;
        }

        if (!file.size || file.size > 5 * 1024 * 1024) {
          const fileName = file.name || 'Unknown file';
          setImageErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 5MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedImages((previous) => [...previous, ...validFiles].slice(0, 5));
    }
  }, []);

  /**
   * prism: parse document files server-side (PDF/DOCX/PPTX/XLSX/CSV/…)
   * and attach the extracted text to the next send.
   */
  const handleDocFiles = useCallback(async (files: File[] | FileList) => {
    const list = Array.from(files || []).slice(0, 5);
    for (const file of list) {
      if (!file || !file.size) continue;
      if (file.size > 20 * 1024 * 1024) {
        addMessage({
          type: 'error',
          content: `Document too large (max 20MB): ${file.name}`,
          timestamp: new Date(),
        });
        continue;
      }
      setParsingDocsCount((count) => count + 1);
      try {
        const formData = new FormData();
        formData.append('document', file);
        const response = await authenticatedFetch('/api/documents/parse', {
          method: 'POST',
          headers: {},
          body: formData,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error || `Parse failed (${response.status})`);
        }
        setAttachedDocs((previous) => [...previous, {
          name: payload.name || file.name,
          text: payload.text || '',
          chars: payload.chars || (payload.text || '').length,
          truncated: Boolean(payload.truncated),
          source: 'file' as const,
          // /parse stages .html instead of extracting it and answers with the
          // disk path. Trust the server's `kind`, but keep the htmlPath sniff
          // so a server that predates the field still classifies correctly.
          kind: (payload.kind === 'path' || payload.htmlPath ? 'path' : 'text') as 'path' | 'text',
        }].slice(0, 8));
      } catch (error) {
        addMessage({
          type: 'error',
          content: `Failed to parse document ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
      } finally {
        setParsingDocsCount((count) => Math.max(0, count - 1));
      }
    }
  }, [addMessage]);

  /** prism: land any attached file to disk and attach its disk path (generic
   * attach-any-file button). Routes to /api/documents/land, which writes the
   * file to a non-served staging dir and returns the path in `text`; the path
   * then rides with the prompt so the agent can publish (/upload-html) or
   * analyze (Read) it based on the user's message. */
  const handleAnyFiles = useCallback(async (files: File[] | FileList) => {
    const list = Array.from(files || []).slice(0, 5);
    for (const [index, file] of list.entries()) {
      if (!file || !file.size) continue;
      // Must stay in step with MAX_LAND_BYTES in server/routes/documents.js —
      // this check only exists to fail fast in the browser, and a client cap
      // above the server's would mean uploading for minutes just to be rejected.
      if (file.size > 500 * 1024 * 1024) {
        addMessage({
          type: 'error',
          content: `File too large (max 500MB): ${file.name}`,
          timestamp: new Date(),
        });
        continue;
      }
      setParsingDocsCount((count) => count + 1);
      // Start indeterminate: the first progress event may be a while out on a
      // large file, and showing 0% before then implies stalled rather than
      // starting.
      setDocUploadProgress({ fileName: file.name, percent: null, index, total: list.length });
      try {
        // 进度回调对两条路是同一个:只推进"当前正在发的这个文件"的那一条,
        // 上一轮迟到的事件不会把进度条往回拽。
        const reportPercent = (percent: number) => {
          setDocUploadProgress((current) => (
            current && current.fileName === file.name ? { ...current, percent } : current
          ));
        };
        const { chunkBytes } = await fetchLandLimits();
        // 小于一片的文件继续走原来的单请求路径:它本来就能穿过代理,
        // 多绕一趟 start/chunk/complete 只是徒增三次往返与失败面。
        let payload: LandPayload;
        if (file.size > chunkBytes) {
          payload = await landFileInChunks(file, chunkBytes, reportPercent);
        } else {
          const formData = new FormData();
          formData.append('document', file);
          payload = await uploadFormDataWithProgress<LandPayload>(
            '/api/documents/land', formData, reportPercent,
          );
        }
        setAttachedDocs((previous) => [...previous, {
          name: payload.name || file.name,
          text: payload.text || '',
          chars: payload.chars || (payload.text || '').length,
          truncated: Boolean(payload.truncated),
          source: 'file' as const,
          // /land never parses: `text` is the staged disk path, so it rides
          // with the prompt as a bare line rather than inside an envelope.
          kind: 'path' as const,
        }].slice(0, 8));
      } catch (error) {
        addMessage({
          type: 'error',
          content: `Failed to upload ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
      } finally {
        setParsingDocsCount((count) => Math.max(0, count - 1));
        setDocUploadProgress((current) => (current && current.fileName === file.name ? null : current));
      }
    }
  }, [addMessage]);

  /** prism: fetch a public URL's readable text and attach it. */
  const attachDocFromUrl = useCallback(async (url: string) => {
    const trimmed = (url || '').trim();
    if (!trimmed) return;
    setParsingDocsCount((count) => count + 1);
    try {
      const response = await authenticatedFetch('/api/documents/fetch-url', {
        method: 'POST',
        body: JSON.stringify({ url: trimmed }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `Fetch failed (${response.status})`);
      }
      setAttachedDocs((previous) => [...previous, {
        name: payload.title || payload.url || trimmed,
        text: payload.text || '',
        chars: payload.chars || (payload.text || '').length,
        truncated: Boolean(payload.truncated),
        source: 'url' as const,
        url: payload.url || trimmed,
        // Fetched page text is third-party content, so it keeps the envelope.
        kind: 'text' as const,
      }].slice(0, 8));
    } catch (error) {
      addMessage({
        type: 'error',
        content: `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    } finally {
      setParsingDocsCount((count) => Math.max(0, count - 1));
    }
  }, [addMessage]);

  const removeAttachedDoc = useCallback((index: number) => {
    setAttachedDocs((previous) => previous.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  /**
   * Prism: begin edit-and-rerun for a user message. Resolves the native fork
   * point, loads the message text into the composer, and arms a pending fork
   * so the next send branches into a fresh session.
   */
  const startEditRerun = useCallback(async (message: ChatMessage) => {
    const messageId = typeof message.id === 'string' ? message.id : '';
    const activeSessionId = sessionKey;
    if (!activeSessionId) return;

    try {
      const response = await authenticatedFetch('/api/claude/fork-point', {
        method: 'POST',
        body: JSON.stringify({ sessionId: activeSessionId, messageId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.providerSessionId) {
        throw new Error(data?.error || '无法定位分叉点');
      }
      pendingForkRef.current = {
        providerSessionId: data.providerSessionId,
        resumeSessionAt: data.resumeSessionAt || null,
      };
      const content = String(message.content || '');
      setInput(content);
      inputValueRef.current = content;
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.focus();
          textarea.setSelectionRange(content.length, content.length);
        }
      });
    } catch (error) {
      pendingForkRef.current = null;
      addMessage({
        type: 'error',
        content: `编辑重跑失败：${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    }
  }, [sessionKey, setInput, textareaRef, addMessage]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleImageFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleImageFiles(imageFiles);
        }
      }
    },
    [handleImageFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
    },
    maxSize: 5 * 1024 * 1024,
    maxFiles: 5,
    onDrop: handleImageFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => {
      try {
        const savedSettings = safeLocalStorage.getItem('claude-settings');
        if (savedSettings) {
          return JSON.parse(savedSettings);
        }
      } catch (error) {
        console.error('Error loading tools settings:', error);
      }

      return {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      };
    };

    const toolsSettings = getToolsSettings();

    return {
      model: claudeModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    claudeModel,
    currentProviderEffort,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      event.preventDefault();
      const currentInput = inputValueRef.current;
      if (!currentInput.trim() || !selectedProject) {
        return;
      }

      // prism: attached documents ride along as tagged text blocks.
      const docsBlock = buildDocsBlock(attachedDocs);

      // A turn is already in flight: stash this message instead of sending it.
      // It's auto-flushed (re-running this same function) once the turn ends,
      // so it still goes through slash-command interception, image upload, etc.
      if (isLoading) {
        queuedDraftSessionRef.current = sessionKey;
        setQueuedDraft({
          content: currentInput + docsBlock,
          images: attachedImages,
          options: buildSendOptions(currentInput),
        });
        setAttachedDocs([]);
        setInput('');
        inputValueRef.current = '';
        setAttachedImages([]);
        setUploadingImages(new Map());
        setImageErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        // selectedProject is guaranteed by the guard at the top of handleSubmit.
        safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (commandInput.startsWith('/') || isHelpAlias) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = isHelpAlias
          ? '/help'
          : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        /**
         * 只有**服务端跑得动**的命令才在这里截胡。
         *
         * 原来的判断是 `type !== 'skill'` —— 和菜单里那处犯的是同一个错:
         * 除了技能之外全都送去 `/api/commands/execute`。CLI 自带命令
         * (`/compact`、`/clear`、`/init`…)在那个端点既没有 handler 也没有 path,
         * 于是一路撞到「Command path is required for custom commands」。
         *
         * ax 轮修了菜单那处,反而让这条路更容易走到:菜单现在会把 `/compact`
         * **稳稳地放进输入框**,用户再按一次回车发送 —— 正好落进这个截胡分支。
         * 两处必须用同一个判据。
         */
        if (matchedCommand && !isPromptCommand(matchedCommand)) {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedImages([]);
          setUploadingImages(new Map());
          setImageErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      const messageContent = currentInput + docsBlock;

      // Checked before the image upload and the session POST, not just before
      // the websocket send. Both of those are HTTP and can succeed while the
      // socket is down, which would leave the user an orphaned empty session
      // and uploaded attachments for a message that never went anywhere.
      if (!isConnected) {
        addMessage({
          type: 'error',
          content:
            'Not connected to the server, so this message was not sent. '
            + 'Your text is still in the composer — reconnection is automatic, '
            + 'so try again in a moment.',
          timestamp: new Date(),
        });
        return;
      }

      let uploadedImages: unknown[] = [];
      if (attachedImages.length > 0) {
        const formData = new FormData();
        attachedImages.forEach((file) => {
          formData.append('images', file);
        });

        try {
          const response = await authenticatedFetch('/api/assets/images', {
            method: 'POST',
            headers: {},
            body: formData,
          });

          if (!response.ok) {
            throw new Error('Failed to upload images');
          }

          const result = await response.json();
          uploadedImages = result.images;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Image upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload images: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, currentInput);

      // Prism edit-and-rerun: a pending fork forces a brand-new session that
      // branches off the parent's native conversation (truncated at the forked
      // message), so the original thread is preserved untouched.
      const forkInfo = pendingForkRef.current;
      pendingForkRef.current = null;

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = forkInfo ? null : (selectedSession?.id || currentSessionId || null);
      if (!targetSessionId) {
        try {
          const response = await authenticatedFetch('/api/providers/sessions', {
            method: 'POST',
            body: JSON.stringify({
              provider,
              projectPath: resolvedProjectPath,
            }),
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: sessionSummary,
        });
      }

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      //
      // Sent *before* the optimistic echo rather than after. Everything from
      // here to the end of this function is synchronous, so there is no
      // perceived-latency cost to the reorder, and it means a send that never
      // left the client cannot leave behind a user bubble, a spinner that
      // never stops, and an emptied composer — which is what happened when the
      // socket dropped between the connectivity check above and this line.
      const sent = sendMessage({
        type: 'chat.send',
        sessionId: targetSessionId,
        content: messageContent,
        options: {
          ...buildSendOptions(messageContent),
          images: uploadedImages,
          ...(forkInfo ? { forkFrom: forkInfo } : {}),
        },
      });

      if (!sent) {
        addMessage({
          type: 'error',
          content:
            'The connection dropped while sending, so this message was not '
            + 'delivered. Your text is still in the composer — try again once '
            + 'the connection is back.',
          timestamp: new Date(),
        });
        return;
      }

      // The optimistic echo must carry the SAME text that went over the wire,
      // not just what the user typed. The store dedupes a `local_*` user row
      // against its server-backed copy by exact trimmed content
      // (userTextFingerprint in stores/useSessionStore.ts); echoing the bare
      // input while the transcript records input + attachments made the two
      // fingerprints differ, so every attachment send rendered twice — once
      // clean, once with the raw attachment tail.
      const userMessage: ChatMessage = {
        type: 'user',
        content: messageContent,
        images: uploadedImages as any,
        timestamp: new Date(),
      };

      addMessage(userMessage);
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      setInput('');
      inputValueRef.current = '';
      resetCommandMenuState();
      setAttachedImages([]);
      setAttachedDocs([]);
      setUploadingImages(new Map());
      setImageErrors(new Map());
      setIsTextareaExpanded(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      safeLocalStorage.removeItem(`draft_input_${selectedProject.projectId}`);
    },
    [
      selectedSession,
      attachedImages,
      attachedDocs,
      buildSendOptions,
      currentSessionId,
      executeCommand,
      isConnected,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sessionKey,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
    ],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // Once the in-flight turn ends, replay the queued draft through the normal
  // submit path (slash commands, image upload, etc. all still apply).
  const wasLoadingRef = useRef(isLoading);
  const flushSessionKeyRef = useRef(sessionKey);
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoading;

    // A session switch changes which session `isLoading` describes, so this
    // transition says nothing about the queued draft's own session. Never
    // flush across it — the swap effect below replaces `queuedDraft` with the
    // new session's saved draft right after this.
    if (flushSessionKeyRef.current !== sessionKey) {
      flushSessionKeyRef.current = sessionKey;
      return;
    }

    if (isLoading || !queuedDraft) {
      return;
    }

    // Turn just ended in this session: flush immediately. Otherwise this is a
    // saved draft restored into an apparently idle session — hold it briefly
    // so the `chat_subscribed` ack can flip `isLoading` if a run is actually
    // still live (the cleanup below cancels the send in that case).
    const delay = wasLoading ? 0 : 750;
    const timer = setTimeout(() => {
      // The saved key is the claim ticket shared with the app-level auto-send
      // (which handles sessions that finish while not viewed). If it's gone,
      // the message was already dispatched — don't send it twice.
      if (sessionKey && !readQueuedMessage(sessionKey)) {
        setQueuedDraft(null);
        return;
      }
      setQueuedDraft(null);
      setInput(queuedDraft.content);
      inputValueRef.current = queuedDraft.content;
      setAttachedImages(queuedDraft.images);
      setTimeout(() => {
        handleSubmitRef.current?.(createFakeSubmitEvent());
      }, 0);
    }, delay);
    return () => clearTimeout(timer);
  }, [isLoading, queuedDraft, sessionKey, setInput]);

  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) {
      return;
    }
    setQueuedDraft(null);
    setInput(queuedDraft.content);
    inputValueRef.current = queuedDraft.content;
    setAttachedImages(queuedDraft.images);
    textareaRef.current?.focus();
  }, [queuedDraft]);

  const deleteQueuedDraft = useCallback(() => {
    setQueuedDraft(null);
  }, []);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const savedInput = safeLocalStorage.getItem(`draft_input_${selectedProjectId}`) || '';
    setInput((previous) => {
      const next = previous === savedInput ? previous : savedInput;
      inputValueRef.current = next;
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    if (input !== '') {
      safeLocalStorage.setItem(`draft_input_${selectedProjectId}`, input);
    } else {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [input, selectedProjectId]);

  // Persist the queued draft under its session's key. Must be defined BEFORE
  // the swap effect below: on a session switch there is one commit where
  // `sessionKey` already points at the new session while `queuedDraft` (and
  // the owner ref) still describe the old one — the ref mismatch makes this
  // effect skip that commit instead of writing/clearing across sessions.
  useEffect(() => {
    if (!sessionKey || queuedDraftSessionRef.current !== sessionKey) {
      return;
    }
    if (queuedDraft?.content) {
      writeQueuedMessage(sessionKey, { content: queuedDraft.content, options: queuedDraft.options });
    } else {
      clearQueuedMessage(sessionKey);
    }
  }, [queuedDraft, sessionKey]);

  // Switching sessions swaps in that session's queued draft (image
  // attachments can't survive a reload, so only text and options restore).
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDraft(null);
      return;
    }
    setQueuedDraft(restoreQueuedDraft(sessionKey));
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      // 「允许并记住」必须落到 localStorage 的 claude-settings 里:服务端虽然会把
      // 这条规则记进当前 runtime,但下一条消息的 chat.send 会用这里读出的列表
      // **整体覆盖**运行时设置 —— 不落盘的话,"记住"只活到下一条消息之前。
      // 落盘后与设置页「权限」里的 Allow rule 完全同一份数据,那里可见可删。
      if (decision?.allow && typeof decision.rememberEntry === 'string' && decision.rememberEntry) {
        try {
          const raw = safeLocalStorage.getItem('claude-settings');
          const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          const allowed = Array.isArray(parsed.allowedTools)
            ? (parsed.allowedTools as unknown[]).filter((entry): entry is string => typeof entry === 'string')
            : [];
          if (!allowed.includes(decision.rememberEntry)) {
            allowed.push(decision.rememberEntry);
          }
          const disallowed = Array.isArray(parsed.disallowedTools)
            ? (parsed.disallowedTools as unknown[]).filter(
                (entry): entry is string => typeof entry === 'string' && entry !== decision.rememberEntry,
              )
            : [];
          safeLocalStorage.setItem(
            'claude-settings',
            JSON.stringify({ ...parsed, allowedTools: allowed, disallowedTools: disallowed }),
          );
        } catch (error) {
          console.error('Failed to persist remembered permission rule:', error);
        }
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  return {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    attachedDocs,
    removeAttachedDoc,
    handleDocFiles,
    handleAnyFiles,
    attachDocFromUrl,
    parsingDocs: parsingDocsCount > 0,
    docUploadProgress,
    startEditRerun,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker: open,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    showModelsModal,
  };
}
