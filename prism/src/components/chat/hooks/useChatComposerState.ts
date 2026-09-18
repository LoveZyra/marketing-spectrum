import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import { schedulePushAccountSettings } from '../../../utils/accountSettings';
import { authenticatedFetch } from '../../../utils/api';
import { uploadFormDataWithProgress } from '../../../utils/uploadWithProgress';
import type { MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import { grantClaudeToolPermission } from '../utils/chatPermissions';
import {
  claimQueuedMessage,
  clearQueuedMessage,
  readQueuedMessage,
  releaseQueuedMessage,
  safeLocalStorage,
  writeQueuedMessage,
  type QueuedSendOptions,
} from '../utils/chatStorage';
import { queueLockName, runExclusive } from '../utils/queueClaim';
import { FLUSH_MAX_ATTEMPTS, flushAttemptAllowed, reconcileWithStorageEvent, shouldDispatchClaimed, shouldEchoOnce, shouldRestoreStored } from '../utils/queueFlushGuard';
import { queuedMessageKey } from '../utils/chatStorage';
import {
  freezeSendCommand,
  fromStoredCommand,
  isPendingSend,
  isSendable,
  reduceOutbox,
  restoredEntry,
  toStoredCommand,
  withSessionId,
  type OutboxEntry,
  type OutboxStatus,
  type SendCommand,
  type SendCommandImage,
  type StoredSendCommand,
  mayPersistQueuedCommand,
} from '../utils/sendCommand';
import type {
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  SessionEstablishedContext,
} from '../types/types';
import type { Project, ProjectSession, LLMProvider, ProviderModelsCacheInfo } from '../../../types/app';
import { escapeRegExp } from '../utils/chatFormatting';
import { buildDocsBlock, type AttachedDoc } from '../utils/attachmentPrompt';
import { draftStorageKey, mergeQueuedIntoInput } from '../utils/composerDrafts';
import { stepHistoryWalk, type HistoryWalkState } from '../utils/composerHistory';
import { describeSkillInvocationInput } from '../utils/skillNaming';

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

type LandPayload = {
  name?: string; text?: string; chars?: number; truncated?: boolean;
  /** ed:服务端落盘时顺带抽出的正文(见 documents.js extractLandedText)。 */
  extractedText?: string; extractedChars?: number; extractedTruncated?: boolean;
};

/**
 * 附件落盘要落到**会话所属项目**的 attachments/ 下,所以每条上传都得带上
 * projectId。分片上传特别注意:projectId 必须在 **start** 时就交给服务端 ——
 * complete 请求上没有它,现取会回落到全局目录,同一个功能的文件就落到两处去了。
 */
const attachmentQuery = (projectId?: string | null, sessionId?: string | null): string => {
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  if (sessionId) params.set('sessionId', sessionId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
};

const landFileInChunks = async (
  file: File,
  chunkBytes: number,
  onPercent: (percent: number) => void,
  projectId?: string | null,
  sessionId?: string | null,
): Promise<LandPayload> => {
  const started = await authenticatedFetch('/api/documents/land/start', {
    method: 'POST',
    body: JSON.stringify({ name: file.name, size: file.size, projectId, sessionId }),
  });
  const startPayload = await started.json().catch(() => ({}));
  if (!started.ok) {
    throw new Error(startPayload?.error || `上传没能开始(HTTP ${started.status})`);
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

import { emitToast } from '@/shared/view/ui/toastBus';

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
  /**
   * 当前会话里用户已发送消息的正文,按时间顺序(旧→新)。↑ 键历史回填用。
   * 通过函数惰性取值,避免把整个消息数组当依赖传进 composer。
   */
  getUserMessageHistory?: () => string[];
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
  /** 会话累计费用(美元),来自 SDK result 帧;拿不到时缺席。**只活在本次页面里。** */
  costUsd?: number;
  /**
   * fh:服务端台账(`usage_records`)里这条会话的累计花销。
   * 和上面那个 `costUsd` 并列而不是替代 —— 那个刷新就没,这个跨重启跨设备都在,
   * 口径也不同(那个是最后一个累计值,这个是历次回合的增量之和)。
   */
  ledger?: {
    runs?: number;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
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

/**
 * 这次提交结束时,**还该不该动这个输入框**。
 *
 * ## 事故(fl 引入,fn 继承)
 *
 * 判据原来是 `sessionKey === submitSessionKey`,而两者是**同一个闭包变量** ——
 * 恒等,这道守卫从来没生效过。fl 把它改成读 ref(`sessionKeyRef.current`),
 * 修好了"发送期间切走、清空了新会话输入框"那件事,**却把新会话这一支一起收窄掉了**:
 *
 *   新会话页 `submitSessionKey` 是 `null`(还没有会话),而这次发送**自己会创建**
 *   一条会话 —— `onSessionEstablished` 一调,`sessionKeyRef.current` 就变成新 id。
 *   收尾时 `id !== null`,守卫判定"用户切走了",**输入框不清**。
 *
 * 于是新会话的第一条消息发出去之后,那句话**还留在输入框里**。用户看到消息已经
 * 发出、输入框却没空,自然会再按一次回车 —— 这次撞上正在跑的回合,被收进排队;
 * 回合结束自动续发,发完输入框依然没清(同一个判据),再排一次……
 * **同一句话反复发送,停不下来**,而排队卡上永远显示着它。
 *
 * ## 判据
 *
 * "还是不是同一条会话"必须把**这次发送自己建立的那条**算进去。
 * 三种情况都成立:
 *   - 会话没变;
 *   - 从"新会话页"(null)变成了**这次发送创建的**那条;
 *   - 目标会话就是当前会话(路由先落地、id 后到的时序)。
 *
 * 只有"变成了**别的**会话"才是真的切走了。
 */
export function composerStillOwnedBySubmit(
  currentSessionKey: string | null,
  submitSessionKey: string | null,
  establishedSessionId: string | null,
): boolean {
  if (currentSessionKey === submitSessionKey) return true;
  // 新会话页发出的那一条:它自己把会话建起来了,输入框还是同一个。
  if (submitSessionKey === null && establishedSessionId !== null) {
    return currentSessionKey === establishedSessionId;
  }
  return false;
}

/**
 * F15:**只有属于这条会话的那一份才算数。**
 *
 * 两个"下一次发送要附带"的东西都可能是在别处装上的:
 *   - 分叉点(编辑重跑)要先走一次 `/api/claude/fork-point`,那期间用户完全
 *     可能切到别的会话去 —— 装上时的 composer 已经不是发起时那个了;
 *   - 隐藏上下文由一个**全局 window 事件**装上,压根没有会话概念。
 *
 * 归属对不上就当没有:否则下一次在另一条会话里发送,会从**别人的** provider
 * 会话分叉出去,或者把只该给这条会话看的技术细节送进另一段对话。
 *
 * 取不到时**不清空** —— 那一份还等着它自己的会话来取。
 */
export function takeIfOwned<T>(
  armed: { owner: string | null } & T | null,
  owner: string | null,
): { value: (Omit<{ owner: string | null } & T, 'owner'>) | null; consumed: boolean } {
  if (!armed || armed.owner !== owner) {
    return { value: null, consumed: false };
  }
  const { owner: _owner, ...rest } = armed;
  void _owner;
  return { value: rest as Omit<{ owner: string | null } & T, 'owner'>, consumed: true };
}

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

/**
 * gk:给那几个"记过哪些幂等键"的集合**封个顶**。
 *
 * 它们按 mount 活着,而这个页面挂着一整天很常见(每条消息一个幂等键)。判据只关心
 * "最近这些条",所以超了就丢最旧的 —— Set / Map 的插入序天然就是时间序。上限给得比
 * 任何真实会话的往返都宽,只为把"一天下来涨成几万个字符串"这件事封住。
 *
 * 写成模块级函数而不是 useCallback:它们不依赖组件里的任何东西,放进组件只会给
 * 四个 hook 的依赖数组添噪声。
 */
const MAX_TRACKED_IDS = 400;
const MAX_TRACKED_ATTEMPTS = 200;

function boundIdSet(ids: Set<string>, max: number = MAX_TRACKED_IDS): void {
  if (ids.size <= max) return;
  for (const id of ids) {
    if (ids.size <= max) break;
    ids.delete(id);
  }
}

function boundAttemptMap(
  attempts: Map<string, { count: number; firstAt: number }>,
  max: number = MAX_TRACKED_ATTEMPTS,
): void {
  if (attempts.size <= max) return;
  for (const key of attempts.keys()) {
    if (attempts.size <= max) break;
    attempts.delete(key);
  }
}

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
  getUserMessageHistory,
}: UseChatComposerStateArgs) {
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined') {
      // 草稿按会话分键(新建会话页退回项目键)—— 见 composerDrafts.ts。
      const key = draftStorageKey(selectedSession?.id || currentSessionId || null, selectedProject?.projectId);
      const saved = key ? safeLocalStorage.getItem(key) || '' : '';
      // cj 版遗留的带票据建任务话术不恢复(与下方换草稿 effect 同一条规则)。
      if (saved && /X-Prism-Task-Ticket|\/api\/tasks\/via-ticket/.test(saved)) {
        if (key) safeLocalStorage.removeItem(key);
        return '';
      }
      return saved;
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
  /**
   * Prism: pending fork descriptor for edit-and-rerun. When set, the next send
   * starts a brand-new session branched off the parent's native conversation.
   *
   * **A 组(F15):连"这是哪条会话的"一起记。**
   *
   * `startEditRerun` 在拿分叉点时要走一次网络(`/api/claude/fork-point`),而
   * 那期间用户完全可能切到别的会话去 —— 分叉点随后**装到新会话的输入框上**,
   * 下一次在那里发送就会从**另一条会话**的 provider 会话分叉出去。
   * 隐藏上下文更宽松:它由一个全局 window 事件设置,压根没有会话概念。
   *
   * 归属在冻结命令时比对(见 `takeIfOwned`),对不上就当没有。
   */
  const pendingForkRef = useRef<{ owner: string | null; providerSessionId: string; resumeSessionAt: string | null } | null>(null);
  // Prism(ck):随下一次发送附带的隐藏上下文(只给模型看,不进气泡/显示日志)。
  // 「让 Claude 创建定时任务」用它携带一次性票据与接口说明。构包时消费并清空;
  // 回合占线被排队(isLoading 早退)时 ref 原样保留,排队消息自动重发再消费。
  // 极端情况(掉线入队)隐藏块不随重发 —— 重新点一次入口即可。
  const pendingHiddenContextRef = useRef<{ owner: string | null; value: string } | null>(null);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  /**
   * fj:上传是异步的,回来时用户可能已经切走了 —— 结果必须比对归属再落地。
   *
   * ref 而不是闭包里的 `sessionKey`:上传函数是 `useCallback` 出去的,闭包里那个
   * 是**发起时**的值,恒等于自己,守不住任何东西。
   */
  const sessionKeyRef = useRef<string | null>(sessionKey);
  sessionKeyRef.current = sessionKey;

  /**
   * fj:提交重入闸。
   *
   * `handleSubmit` 里有两处 await(图片上传、建会话 POST),而清空输入框和
   * `onSessionProcessing`(它才让 `isLoading` 变真)都在 await **之后** ——
   * 等待期间输入框里还是原文、按钮 `disabled` 也只看 `!input.trim()`。
   * 于是"觉得没反应又按一次回车"会完整重跑一遍:图片重复上传、同一条消息发两遍;
   * 新会话的第一条更糟 —— **建出两个会话**,页面只跳到后一个,前一个在后台
   * 跑着一整轮(acceptEdits/bypassPermissions 档下会真的改文件),用户看不到它。
   */
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 输入草稿的当前存储键(会话优先,新建会话页退回项目键)。
  const activeDraftKey = draftStorageKey(sessionKey, selectedProjectId);
  // ↑/↓ 历史回看状态;打字/发送/切会话都会清掉它。
  const historyWalkRef = useRef<HistoryWalkState>(null);

  /**
   * A 组:排队的那条现在是一个 **outbox 条目**(冻结的命令 + 状态),
   * 不再是"正文 + File[] + options"三件套。
   *
   * 状态机在 `utils/sendCommand.ts`;这里只负责它与 React / localStorage 的接线。
   */
  /**
   * 初始一律为空 —— **从盘恢复只有一个入口**(下面那个换会话 effect,
   * 它在挂载时也会跑一次)。此前初始 state 也读一次盘,于是"从盘恢复"有两个
   * 入口、两套判据,而兜底不变式只加在其中一个上就等于没加。
   */
  const [outbox, setOutbox] = useState<OutboxEntry | null>(null);
  /**
   * **这个标签页已经投递出去的幂等键。**
   *
   * 整块排队逻辑的**兜底不变式**:一条命令一旦真的发出去过,就再也不许以任何
   * 路径回到"待发"。
   *
   * 为什么要一条兜底,而不是把每条路径都堵一遍 —— localStorage 那份状态有
   * **两个写者**:一个 effect(带会跳过的归属守卫)和四处直接调用,其中
   * `claimQueuedMessage` 认领时会把条目**连认领戳一起写回盘上**。只要清理那一侧
   * 在某个 commit 被守卫跳过,记录就留在盘上,之后任何一次恢复都会把它读回来:
   * **几轮之前那句话又变成一张排队卡,还会被自动续发再发一遍**
   * (线上实测:回答完第二条之后,第一条的「你好」重新排上了队)。
   *
   * 逐条堵路径这一轮试过两次,每次都只堵住一半。改成恢复时先问一句
   * "这条我发过没有" —— 路径再怎么变,这一条都成立。
   *
   * 只在内存里(按标签页):刷新之后不拦,那时盘上那份确实还没被这个标签页发过。
   */
  const dispatchedClientMessageIdsRef = useRef(new Set<string>());
  /**
   * gk:**这个标签页取消过的幂等键。**
   *
   * `deleteQueuedDraft` / `editQueuedDraft` / 停止时并回输入框 —— 三处都只清内存,盘上那份
   * 靠落盘 effect 的下一拍才清。这一拍里冲队定时器、另一个标签页、换会话恢复都可能把它
   * 读回来再发出去(2026-09-15 测试环境:取消了排队卡那条照样发了出去)。
   * 现在取消当场清盘,并把键记在这里:恢复与冲队两处都拒绝它。
   */
  const retiredClientMessageIdsRef = useRef(new Set<string>());
  /** gk:已经画过乐观回声的幂等键 —— 重投(断线重连 / duplicate ACK)不再多画一个气泡。 */
  const echoedClientMessageIdsRef = useRef(new Set<string>());
  /** gk:冲队对同一条命令的自动投递计数 —— 这条路此前没有上限。 */
  const flushAttemptsRef = useRef(new Map<string, { count: number; firstAt: number }>());

  /** 换会话恢复排队命令时要读它,但它不该让那个 effect 重跑。 */
  const selectedProjectIdRef = useRef(selectedProjectId ?? null);
  selectedProjectIdRef.current = selectedProjectId ?? null;
  /** fj:同步副本 —— 离线入队时要读当前有没有一条在排,而闭包里那个可能是旧的。 */
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  // Which session the in-memory outbox entry belongs to. On a session switch
  // there is one commit where `sessionKey` already points at the new session
  // while the entry still holds the old session's command; the persistence
  // effect must not write across that gap.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);
  /**
   * fz:恢复 effect **认领到哪条会话了**。落盘 effect 拿它当归属判据 ——
   * 换会话那一拍它还指着旧 key,落盘整段跳过,不会误清新会话盘上那份。
   * 初值刻意不是 `sessionKey`:首次挂载也必须等恢复先跑一遍。
   */
  const restoredForKeyRef = useRef<string | null>(null);
  /**
   * ga:哪条 `sending` 的命令**经历过一次断线**。
   *
   * 判据必须是"断过再连上",不能只看"现在连着" —— 后者在 `markCommandSent`
   * 刚把状态置成 `sending` 的那一拍就成立,于是刚发出去的命令会被立刻拨回待发
   * 再发一遍。记的是幂等键而不是布尔,免得张冠李戴到下一条命令头上。
   */
  const sendingSawDisconnectRef = useRef<string | null>(null);

  /**
   * 给排队卡片看的那一份(它只要正文和图片张数)。
   *
   * 顺带把 `status` / `error` 也带出去 —— 附件恢复不回来时卡片要能说明白
   * "为什么它没发出去",而不是一直挂在那儿看着像要发。
   */
  const queuedDraft = useMemo<(QueuedDraft & { imageCount: number; status: OutboxStatus; error: string | null }) | null>(() => {
    /**
     * **只有"还在等着发"的那条才显示排队卡。**
     *
     * 原来是"outbox 非空就渲染" —— 而 `markCommandSent` 之后条目停在 `sending`
     * 等 ACK,于是消息明明已经发出去了,卡片还挂着「已排队 · 本轮结束后自动发送」,
     * ACK 没到就永远不消失。判据与落盘那一处共用同一个函数(见 isPendingSend):
     * 那一处我先改了,这一处当时没跟着 —— 于是"刷新之后卡片消失"成了这个 bug
     * 的指纹(内存里还留着、盘上已经没有)。
     */
    if (!isPendingSend(outbox)) return null;
    if (!outbox) return null;
    return {
      content: outbox.command.text,
      images: [],
      imageCount: outbox.command.images.length,
      options: outbox.command.options,
      status: outbox.status,
      error: outbox.error,
    };
  }, [outbox]);

  /**
   * 入队:命令进 outbox,同时落盘(带幂等键与图片引用,所以能跨刷新)。
   *
   * 已经有一条在排时**接上去而不是覆盖掉**(fj 的取舍保留):服务端只收一条排队
   * 消息,前端这条通道也是一个槽位;覆盖会让断网期间连发的第一条静默消失。
   * 合并之后用的是**后一条**命令的 options 与幂等键 —— 它是用户最近一次的意图。
   */
  const enqueueCommand = useCallback((
    command: SendCommand,
    owner: string | null,
    initial?: { status: OutboxStatus; error: string },
  ) => {
    /**
     * **只和"还在等着发"的那条合并。**
     *
     * 合并的本意是:断网期间连发两条,后一条接在前一条后面,别把第一条挤掉。
     * 但如果 outbox 里留着的是一条**已经发出去、正在等 ACK**(`sending`)的命令,
     * 合并就等于把那句话**再发一遍** —— 它会作为新命令正文的前半段送出去。
     * 判据与排队卡、落盘共用同一个 `isPendingSend`。
     */
    const existing = isPendingSend(outboxRef.current) ? outboxRef.current : null;
    const sameSession = existing && queuedDraftSessionRef.current === owner;
    const merged = sameSession && existing.command.text.trim()
      ? freezeSendCommand({
        sessionKey: command.sessionKey,
        // gi 自查:并进去的两条里任一条带分叉点,合并结果也要另起一支(与提交那一刻同一条规则)
        sessionId: (command.forkFrom ?? existing.command.forkFrom) ? null : command.sessionId,
        projectId: command.projectId,
        clientMessageId: command.clientMessageId,
        text: `${existing.command.text}\n\n${command.text}`,
        namingText: existing.command.namingText || command.namingText,
        images: [...existing.command.images, ...command.images],
        options: command.options,
        forkFrom: command.forkFrom ?? existing.command.forkFrom,
        hiddenContext: command.hiddenContext ?? existing.command.hiddenContext,
      })
      : command;

    queuedDraftSessionRef.current = owner;
    /**
     * gh:**并进一条"等图片"的记录,结果仍然是"等图片"。**
     *
     * `isPendingSend` 把 needs_attachment 算作"还在等着发",合并本身没错;可合并结果
     * 此前无条件回到 queued —— A 组为 F12 加的"图丢了就停下等用户补"被静默解除,
     * 合并后的文本自动冲队发出,正是 F12 描述的"引用了不存在图片的话"。
     */
    const keepWaitingForAttachment = !initial && existing?.status === 'needs_attachment';
    const entry = initial
      ? { command: merged, status: initial.status, error: initial.error, attempts: 0 }
      : keepWaitingForAttachment
        ? { command: merged, status: 'needs_attachment' as const, error: existing!.error, attempts: 0 }
        : reduceOutbox(null, { type: 'enqueue', command: merged })!;
    outboxRef.current = entry;
    setOutbox(entry);
  }, []);

  /**
   * F09:服务端确认收下了。
   *
   * 只认**同一个 clientMessageId** —— 别的会话、别的命令的 ACK 不动这一条。
   * 到这一步才清掉落盘的排队记录(持久化 effect 会因为 outbox 变空而清)。
   */
  const handleSendAcked = useCallback((ackSessionId: string, clientMessageId: string) => {
    /**
     * fz:**清盘也要过同一道身份判断。**
     *
     * 这里原来对内存按 `clientMessageId` 判身份,对盘上却无条件
     * `clearQueuedMessage(ackSessionId)` —— 只看会话、不看是哪一条命令。
     * 而服务端确实会为同一个 `clientMessageId` 发**两次** accepted:
     * 排队收下时一次、回合结束续发真正跑起来时又一次。
     *
     * 于是:第一条被收进排队 → 前端标 acked;用户接着又打了一条 B 排进去;
     * 几分钟后续发成功,**旧命令的第二次 ACK** 到达 —— 内存守卫认出不是同一条、
     * 不动内存,可那句清盘照样把 **B** 从盘上删了。B 只剩内存一份,
     * 此后刷新 / 关标签页 / 切会话,它静默消失。
     *
     * 一个判据两处用:内存与盘上要么一起动,要么都不动。
     */
    /**
     * gk:身份判断改读 `outboxRef`(同步),不再靠 updater 里置的标志 ——
     * `setOutbox(updater)` 的 updater 在下一次渲染时才跑,紧跟其后的 `if (acknowledged)`
     * 永远读到 false,那句清盘从来没执行过(app 级处理器另有一份清理,所以没露馅)。
     */
    const current = outboxRef.current;
    const acknowledged = Boolean(current && current.command.clientMessageId === clientMessageId);
    if (acknowledged) {
      const next = reduceOutbox(current, { type: 'acked' });
      outboxRef.current = next;
      setOutbox(next);
    }
    /**
     * 已确认的那条不该再被别的标签页认领 —— 但**盘上现在躺的可能不是它**。
     *
     * 这句让 fz 那个坑原样复活了一半:内存判的是"我这条被确认了",盘上删的是
     * "这个会话的排队记录"。两个标签页开同一个会话时,B 排进去的新消息就躺在那个
     * 键上,而 A 这边旧命令的**第二次** accepted(排队收下一次、续发跑起来又一次)
     * 一到,就把 B 从盘上删掉;紧接着 storage 事件让 B 那边也把内存里那条撤掉 ——
     * 卡片凭空消失、正文不退回输入框、消息从没发出去。
     *
     * 所以清盘前回读一次:只有盘上确实是同一个幂等键才清。fz 的那句话仍然成立 ——
     * 一个判据两处用,内存与盘上要么一起动,要么都不动。
     */
    if (!acknowledged || !ackSessionId) return;
    const stored = readQueuedMessage(ackSessionId) as StoredSendCommand | null;
    if (!stored || !stored.clientMessageId || stored.clientMessageId === clientMessageId) {
      clearQueuedMessage(ackSessionId);
    }
  }, []);

  /** 投递成功:先记 sending/acked,再清掉落盘的排队记录。 */
  const markCommandSent = useCallback((command: SendCommand, owner: string | null) => {
    queuedDraftSessionRef.current = owner;

    /**
     * **发出去了就记下这个幂等键,并且当场把盘上那份清掉。**
     *
     * 清理原来只由持久化 effect 做,而那个 effect 带一道归属守卫
     * (`queuedDraftSessionRef.current !== sessionKey` 就跳过)—— 新会话的第一条
     * 正好会撞上它(提交时 owner 是 null、落地时 sessionKey 已经是新 id)。
     * 跳过一次,盘上那份就留下了,之后任何一次恢复都会把它读回来。
     *
     * 这里直接清,不依赖任何守卫;记 id 是第二道保险(见
     * `dispatchedClientMessageIdsRef`)。两道都不贵,而这块已经因为"只堵一半"
     * 出过三次事了。
     */
    dispatchedClientMessageIdsRef.current.add(command.clientMessageId);
    boundIdSet(dispatchedClientMessageIdsRef.current);
    /**
     * gi 自查:槽位里若是一条**等图片**的记录(needs_attachment),直接发出去的这条不占槽、
     * 不清盘 —— 否则那条连正文带盘上记录一起被抹掉。代价是这条直发消息没有 sending
     * 条目可供重连重投(与 gg 之前一致),换那条等图片的不丢。
     */
    const parked = outboxRef.current;
    if (parked && parked.status === 'needs_attachment' && parked.command.clientMessageId !== command.clientMessageId) {
      return;
    }
    const storageKey = owner || command.sessionKey || command.sessionId;
    if (storageKey) clearQueuedMessage(storageKey);
    /**
     * fz:**删掉了那句"顺手把当前在看的那条也清一遍"。**
     *
     * 它读的是 `sessionKeyRef.current`(此刻在看哪条),没有任何归属判断。
     * 而 `dispatchSendCommand` 在新会话/分叉时要 `await` 一次建会话请求,
     * 这段时间用户可以切走(`submittingRef` 只挡重复提交,不挡切会话)——
     * 请求回来时这句清的就是**别人**那条会话盘上的排队记录。
     *
     * 上面 `storageKey` 那句(owner → 命令自记的会话 → 命令的会话 id)本来就
     * 覆盖了这条命令所有可能的落键,再加一句"当前在看的"不解决任何问题,
     * 只是把一个跨会话误删的窗口敞开一次 HTTP 往返那么长。
     */
    /**
     * F09 的一半:这里记的是 `sending`,**不是 acked**。
     * 真正的 acked 由服务端的 `chat_ack`(带同一个 clientMessageId)翻转 ——
     * `socket.send` 返回 true 只代表本地没抛异常。
     */
    const entry = reduceOutbox(
      { command, status: 'queued', error: null, attempts: 0 },
      { type: 'sending' },
    )!;
    outboxRef.current = entry;
    setOutbox(entry);
  }, []);

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
              content: `提醒:${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\n路径:\`${data.path}\``,
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
          content: '命令已取消',
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
          content: `命令执行失败:${message}`,
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

  /**
   * dx:底栏的 token 用量芯片已移除,所以目前没有调用方 —— 保留这条入口是
   * 因为它和 showModelsModal 是同一形状的 API(走 executeCommand,与手敲
   * /cost 同一条路径),将来想把用量放回某处时直接接上即可。
   */
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
    hoveredCommandIndex,
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

        // 0 字节和超限是两回事,原来共用一句"超过 5MB",空文件会被报成超大。
        if (!file.size) {
          setImageErrors((previous) => {
            const next = new Map(previous);
            next.set(file.name || 'Unknown file', '这个文件是空的');
            return next;
          });
          return false;
        }
        if (file.size > 5 * 1024 * 1024) {
          setImageErrors((previous) => {
            const next = new Map(previous);
            next.set(file.name || 'Unknown file', '超过 5MB,图片最大 5MB');
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
      setAttachedImages((previous) => {
        const merged = [...previous, ...validFiles];
        if (merged.length > 5) {
          // 原来是默默 slice(0,5),多出来的图片凭空消失。
          emitToast({ message: `最多附 5 张图片,多出的 ${merged.length - 5} 张没有附上。`, variant: 'error' });
        }
        return merged.slice(0, 5);
      });
    }
  }, []);

  /**
   * prism: parse document files server-side (PDF/DOCX/PPTX/XLSX/CSV/…)
   * and attach the extracted text to the next send.
   */
  /**
   * fj:异步上传结果的**归属守卫**。
   *
   * 三个上传入口(选文件、拖拽、抓链接)都是 await 之后无条件
   * `setAttachedDocs([...previous, doc])`,没有任何会话/项目归属校验;而
   * `ChatInterface` 在 `MainContent` 上没有 `key`,切会话不会重挂载 —— 所以这些
   * setState 一定落在**新会话**的 composer 上。
   *
   * 后果不是"多一个 chip"那么轻:`/land` 回来的 `text` 是**旧项目** attachments
   * 目录下的磁盘路径,用户在新会话里一发送,提示词里就带着一条跨项目路径交给
   * 智能体去读 —— 这一层清理 effect 的注释里管它叫"一条跨项目的信息泄漏",
   * 而那个 effect 只在切会话的那一刻清一次,拦不住之后才回来的上传。
   */
  const isStillSameSession = useCallback(
    (owner: string | null) => sessionKeyRef.current === owner,
    [],
  );

  const handleDocFiles = useCallback(async (files: File[] | FileList) => {
    // fj:发起时的归属快照(见 isStillSameSession)。
    const uploadOwner = sessionKeyRef.current;
    const list = Array.from(files || []).slice(0, 5);
    for (const file of list) {
      if (!file || !file.size) continue;
      if (file.size > 20 * 1024 * 1024) {
        addMessage({
          type: 'error',
          isLocalNotice: true,
          content: `${file.name} 超过 20MB,文档解析放不下这么大的文件。`,
          timestamp: new Date(),
        });
        continue;
      }
      setParsingDocsCount((count) => count + 1);
      try {
        const formData = new FormData();
        formData.append('document', file);
        const response = await authenticatedFetch(
          `/api/documents/parse${attachmentQuery(selectedProjectId, currentSessionId)}`,
          { method: 'POST', headers: {}, body: formData },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error || `解析失败(HTTP ${response.status})`);
        }
        if (!isStillSameSession(uploadOwner)) return;
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
        // 服务端的报错里已经带了文件名,这里再拼一次就成了
        // 「Failed to parse document x.pdf: Failed to extract text from x.pdf: ...」——
        // 文件名两遍、failed 三遍,真正的原因被挤到最后。直接用服务端那句;
        // 只有拿不到具体原因时才自己兜一句带文件名的。
        const detail = error instanceof Error ? error.message : String(error);
        addMessage({
          type: 'error',
          isLocalNotice: true,
          content: detail && detail !== 'Failed to fetch'
            ? detail
            : `无法读取 ${file.name}`,
          timestamp: new Date(),
        });
      } finally {
        setParsingDocsCount((count) => Math.max(0, count - 1));
      }
    }
  }, [addMessage, selectedProjectId, currentSessionId, isStillSameSession]);

  /** prism: land any attached file to disk and attach its disk path (generic
   * attach-any-file button). Routes to /api/documents/land, which writes the
   * file to a non-served staging dir and returns the path in `text`; the path
   * then rides with the prompt so the agent can publish (/upload-html) or
   * analyze (Read) it based on the user's message. */
  const handleAnyFiles = useCallback(async (files: File[] | FileList) => {
    // fj:发起时的归属快照(见 isStillSameSession)。
    const uploadOwner = sessionKeyRef.current;
    const list = Array.from(files || []).slice(0, 5);
    for (const [index, file] of list.entries()) {
      if (!file || !file.size) continue;
      // Must stay in step with MAX_LAND_BYTES in server/routes/documents.js —
      // this check only exists to fail fast in the browser, and a client cap
      // above the server's would mean uploading for minutes just to be rejected.
      if (file.size > 500 * 1024 * 1024) {
        addMessage({
          type: 'error',
          isLocalNotice: true,
          content: `${file.name} 超过 500MB,单个附件最多 500MB。`,
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
          payload = await landFileInChunks(
            file, chunkBytes, reportPercent, selectedProjectId, currentSessionId,
          );
        } else {
          const formData = new FormData();
          formData.append('document', file);
          payload = await uploadFormDataWithProgress<LandPayload>(
            `/api/documents/land${attachmentQuery(selectedProjectId, currentSessionId)}`,
            formData, reportPercent,
          );
        }
        if (!isStillSameSession(uploadOwner)) return;
        setAttachedDocs((previous) => [...previous, {
          name: payload.name || file.name,
          text: payload.text || '',
          chars: payload.chars || (payload.text || '').length,
          truncated: Boolean(payload.truncated),
          source: 'file' as const,
          // /land: `text` is the staged disk path, so it rides with the prompt
          // as a bare line. ed: the server may also hand back extracted text for
          // document types — that part goes in an envelope (see buildDocsBlock).
          kind: 'path' as const,
          ...(payload.extractedText
            ? {
              extractedText: payload.extractedText,
              extractedChars: payload.extractedChars ?? payload.extractedText.length,
              extractedTruncated: Boolean(payload.extractedTruncated),
            }
            : {}),
        }].slice(0, 8));
      } catch (error) {
        addMessage({
          type: 'error',
          isLocalNotice: true,
          content: `${file.name} 上传失败:${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date(),
        });
      } finally {
        setParsingDocsCount((count) => Math.max(0, count - 1));
        setDocUploadProgress((current) => (current && current.fileName === file.name ? null : current));
      }
    }
  }, [addMessage, selectedProjectId, currentSessionId, isStillSameSession]);

  /** prism: fetch a public URL's readable text and attach it. */
  const attachDocFromUrl = useCallback(async (url: string) => {
    // fj:发起时的归属快照(见 isStillSameSession)。
    const uploadOwner = sessionKeyRef.current;
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
      if (!isStillSameSession(uploadOwner)) return;
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
        isLocalNotice: true,
        content: `抓取网页失败:${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    } finally {
      setParsingDocsCount((count) => Math.max(0, count - 1));
    }
  }, [addMessage, isStillSameSession]);

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
        // 拿分叉点走了一次网络,期间可能切了会话 —— 归属记的是**发起时**那条。
        owner: activeSessionId,
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
        isLocalNotice: true,
        content: `编辑重跑失败：${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date(),
      });
    }
  }, [sessionKey, setInput, textareaRef, addMessage]);

  /**
   * 粘贴或拖进来的文件,按类型分流。
   *
   * 图片走图片那条(会随消息以 image 块发给模型),其余任何类型走 land ——
   * 和回形针按钮完全一样。原先这里只认 `image/*`,粘一个 PDF 进来是
   * **静默无反应**:没有附件、没有报错、连一个请求都不发。能力本来就有,
   * 只是这两个入口没接上去。
   */
  const acceptDroppedFiles = useCallback((files: File[]) => {
    const incoming = files.filter((file) => file && file.size >= 0);
    if (incoming.length === 0) return;
    const images = incoming.filter((file) => (file.type || '').startsWith('image/'));
    const others = incoming.filter((file) => !(file.type || '').startsWith('image/'));
    if (images.length > 0) handleImageFiles(images);
    if (others.length > 0) void handleAnyFiles(others);
  }, [handleImageFiles, handleAnyFiles]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;

      // `items` 里既有文件也有文本片段;只挑 kind === 'file' 的。
      // 纯文本粘贴必须原样放过去 —— 拦下来就没法粘代码了。
      const fromItems = Array.from(clipboard.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));

      const files = fromItems.length > 0 ? fromItems : Array.from(clipboard.files || []);
      if (files.length === 0) return;

      // 有文件就别再把它的"文本表示"也插进输入框(某些系统会同时给一份路径字符串)。
      event.preventDefault();
      acceptDroppedFiles(files);
    },
    [acceptDroppedFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    // 不再限定 image/*:拖进来的任何类型都收,分流交给 acceptDroppedFiles。
    // 大小上限也不在这里卡 —— 图片 5MB、其他 500MB 是两套阈值,由各自那条路
    // 去判并给出对应的提示;在这里统一卡一个数只会让其中一边的提示是错的。
    // **不要在这里设 maxFiles。** react-dropzone 超过 maxFiles 时会把**全部**文件
    // 塞进 fileRejections 并清空 acceptedFiles —— 结果是"一次拖 6 个文件,
    // 什么都不发生",而且因为没配 onDropRejected,连一句提示都没有。
    // 数量上限交给 acceptDroppedFiles 去判(它会收下前 5 张并提示多出几张)。
    onDrop: acceptDroppedFiles,
    onDropRejected: (rejections) => {
      if (rejections.length === 0) return;
      emitToast({ message: `有 ${rejections.length} 个文件没能附上。`, variant: 'error' });
    },
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
      // do:技能调用当首条消息时,命名用「技能名:参数」而不是斜杠原文。
      sessionSummary: getNotificationSessionSummary(
        selectedSession,
        describeSkillInvocationInput(currentInput, slashCommands),
      ),
    };
  }, [
    claudeModel,
    currentProviderEffort,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
    slashCommands,
  ]);

  /**
   * A 组:提交之后的收尾 —— 清输入框、清附件、收起展开态。
   *
   * 抽出来是因为它原来在 `runSubmit` 里**一字不差地出现了四次**(排队分支、
   * 斜杠命令分支、离线分支、发送成功分支),而其中只有最后一处带着
   * "期间会话切了没"的守卫。fl 修过那一处(判据从闭包变量换成 ref),
   * 另外三处照旧 —— 也就是同一个 bug 还留着三份。
   *
   * `owner` 是**发起这次提交时**所在的会话键。等待期间用户切走了,composer
   * 已经属于另一条会话,一个字都不许动;而这条会话自己的草稿仍然要清
   * (它确实发出去了),所以 `activeDraftKey` 单独判。
   */
  const clearComposerAfterSubmit = useCallback((
    owner: string | null,
    draftKey: string | null,
    /** 这次发送自己建立的会话 id(新会话页的第一条)。见 composerStillOwnedBySubmit。 */
    establishedSessionId: string | null = null,
  ) => {
    if (composerStillOwnedBySubmit(sessionKeyRef.current, owner, establishedSessionId)) {
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
    }
    if (draftKey) {
      safeLocalStorage.removeItem(draftKey);
    }
  }, [resetCommandMenuState, setInput]);

  /**
   * A 组:**投递一条已经冻结的命令。**
   *
   * 这个函数**不读 composer 的任何东西** —— 正文、options、分叉点、隐藏上下文、
   * 图片全在 `command` 里。它是 F13 的修法:自动续发不再"把正文灌回输入框再走一遍
   * 提交",而是直接投递排队时冻结的那一份,用户正在打的字一个不动。
   *
   * 返回投递结果,由调用方决定 outbox 怎么流转。
   */
  const dispatchSendCommand = useCallback(async (
    command: SendCommand,
  ): Promise<
    | { ok: true; command: SendCommand; establishedSessionId: string | null }
    | { ok: false; reason: 'offline' | 'error'; message?: string }
  > => {
    let target = command;
    /** 这一次发送**自己创建**的会话 —— 收尾判归属时要认它(见 composerStillOwnedBySubmit)。 */
    let establishedSessionId: string | null = null;

    // 新会话在提交时还没有 id —— 服务端在这里分配,再补回命令里。
    if (!target.sessionId) {
      try {
        const response = await authenticatedFetch('/api/providers/sessions', {
          method: 'POST',
          body: JSON.stringify({
            provider,
            projectPath: selectedProject?.fullPath || selectedProject?.path || '',
          }),
        });
        if (!response.ok) {
          throw new Error(`Failed to create session (${response.status})`);
        }
        const body = await response.json();
        const newSessionId = body?.data?.sessionId || null;
        if (!newSessionId) {
          return { ok: false, reason: 'error', message: '新建会话失败:服务端没有返回会话号。' };
        }
        target = withSessionId(target, newSessionId);
        establishedSessionId = newSessionId;
        onSessionEstablished?.(newSessionId, {
          provider,
          project: selectedProject!,
          summary: (target.options.sessionSummary as string | null | undefined) ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Session creation failed:', error);
        return { ok: false, reason: 'error', message: `新建会话失败:${message}` };
      }
    }

    // One message shape for every provider. The backend resolves the provider,
    // project path, and provider-native resume id from the session row;
    // `options` only carries composer-level preferences.
    //
    // F09:带上 `clientMessageId` —— 服务端按它去重。重连之后重投的是**同一个
    // id**,所以"发出去了没有"这件事第一次有了权威答案(此前只有本地
    // `socket.send` 没抛异常这一个信号)。
    const sent = sendMessage({
      type: 'chat.send',
      sessionId: target.sessionId,
      clientMessageId: target.clientMessageId,
      content: target.text,
      options: {
        ...target.options,
        images: target.images,
        ...(target.forkFrom ? { forkFrom: target.forkFrom } : {}),
        ...(target.hiddenContext ? { hiddenContext: target.hiddenContext } : {}),
      },
    });

    if (!sent) {
      return { ok: false, reason: 'offline' };
    }

    // The optimistic echo must carry the SAME text that went over the wire,
    // not just what the user typed. The store dedupes a `local_*` user row
    // against its server-backed copy by exact trimmed content
    // (userTextFingerprint in stores/useSessionStore.ts); echoing the bare
    // input while the transcript records input + attachments made the two
    // fingerprints differ, so every attachment send rendered twice — once
    // clean, once with the raw attachment tail.
    /**
     * gk:**同一条命令只画一次回声。**
     *
     * 重投是设计允许的(断线重连拨回 queued、服务端按幂等键回 duplicate),但每投一次
     * 就 addMessage 一次,页面上就是同一句话叠四个气泡,直到刷新才被服务端那份去重掉
     * (2026-09-15 测试环境截图)。回声按幂等键去重,服务端那份仍照常盖掉它。
     */
    boundIdSet(echoedClientMessageIdsRef.current);
    if (shouldEchoOnce(echoedClientMessageIdsRef.current, target.clientMessageId)) {
      addMessage({
        type: 'user',
        content: target.text,
        images: target.images as never,
        timestamp: new Date(),
      });
    } else {
      console.warn(`[queue] 同一条命令再次投递(${target.clientMessageId}),不再重复画气泡`);
    }

    // Mark this request as processing in the per-session activity map (the
    // single source of truth the indicator derives from).
    onSessionProcessing?.(target.sessionId!, {
      statusText: null,
      canInterrupt: true,
    });

    setIsUserScrolledUp(false);
    setTimeout(() => scrollToBottom(), 100);

    return { ok: true, command: target, establishedSessionId };
  }, [
    addMessage,
    onSessionEstablished,
    onSessionProcessing,
    provider,
    scrollToBottom,
    selectedProject,
    sendMessage,
    setIsUserScrolledUp,
  ]);

  const dispatchSendCommandRef = useRef(dispatchSendCommand);
  dispatchSendCommandRef.current = dispatchSendCommand;

  const runSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      event.preventDefault();
      const currentInput = inputValueRef.current;
      /**
       * fj:只挂附件、不打字也该能发。
       *
       * 原来判据只有 `!currentInput.trim()`:粘一张截图或拖一个 PDF 进来直接
       * 按回车,按钮是灰的、回车毫无反应、也没有任何文案说明要先写字 ——
       * 用户只能猜。
       */
      const hasAttachments = attachedImages.length > 0 || attachedDocs.length > 0;
      if ((!currentInput.trim() && !hasAttachments) || !selectedProject) {
        return;
      }

      /**
       * fj:附件还在上传时不能发。
       *
       * 此前 `handleSubmit` 只读当前的 `attachedDocs`,全程不看 `parsingDocsCount`;
       * 而 `parsingDocs` 一路传到 `ChatComposer` **只用来画进度条**,发送按钮的
       * `disabled` 只有 `!input.trim()`。大文件走分片上传要几十秒到几分钟,于是
       * 消息**不带那个附件**就发出去了,附件随后挂到已清空的输入框上、跟着
       * **下一条**消息发出 —— 而用户以为"文件已经给它了"。
       */
      if (parsingDocsCount > 0) {
        emitToast({ message: '附件还在上传,等它传完再发送。', variant: 'error' });
        return;
      }

      /**
       * 发起这一次提交时**所在的会话**,以及它的草稿键。
       *
       * 下面有网络等待(上传附件、建会话),等待期间用户完全可能切到别的会话去。
       * 收尾那段用的是闭包里捕获的 setter,它们作用在**当前**这个 composer 上 ——
       * 也就是新会话的输入框。判据见 `clearComposerAfterSubmit`。
       */
      const submitSessionKey = sessionKey;
      const submitDraftKey = activeDraftKey;

      // prism: attached documents ride along as tagged text blocks.
      const docsBlock = buildDocsBlock(attachedDocs);

      /**
       * A 组:**先把图片传上去,再决定发还是排队。**
       *
       * 原来两个排队分支都在上传**之前**,于是排队记录里存的是 `File[]` ——
       * 而 `File` 进不了 localStorage。刷新之后 `restoreQueuedDraft` 直接
       * `images: []`,后台自动发送就把一条"引用了不存在图片"的话发了出去,
       * 用户毫不知情(F12)。
       *
       * 代价是被删掉的排队消息也会留下一次上传;换来的是排队消息的附件**真的
       * 能跨刷新活下来**。这个取舍很清楚:上传是可回收的,发错的消息不是。
       */
      let uploadedImages: SendCommandImage[] = [];
      if (attachedImages.length > 0) {
        const formData = new FormData();
        attachedImages.forEach((file) => {
          formData.append('images', file);
        });

        try {
          const response = await authenticatedFetch(
            `/api/assets/images${attachmentQuery(selectedProjectId, currentSessionId)}`,
            { method: 'POST', headers: {}, body: formData },
          );

          if (!response.ok) {
            throw new Error('图片上传失败');
          }

          const result = await response.json();
          uploadedImages = Array.isArray(result.images) ? result.images : [];
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Image upload failed:', error);
          addMessage({
            type: 'error',
            isLocalNotice: true,
            content: `图片上传失败:${message}`,
            timestamp: new Date(),
          });
          // 输入框与附件原样留着,用户改一改还能再发一次。
          return;
        }
      }

      /**
       * A 组:**这一次发送到此冻结。**
       *
       * 之后无论排队多久、用户在输入框里打了什么、切到了哪条会话,发出去的都是
       * 这一份。分叉点与隐藏上下文也在这里进命令(F15)—— 它们此前是全局 ref,
       * 不按会话隔离,而且在确认发出去之前就被消费掉。
       */
      const armedFork = takeIfOwned(pendingForkRef.current, submitSessionKey);
      const armedHiddenContext = takeIfOwned(pendingHiddenContextRef.current, submitSessionKey);

      const command = freezeSendCommand({
        sessionKey: submitSessionKey,
        sessionId: selectedSession?.id || currentSessionId || null,
        projectId: selectedProjectId ?? null,
        text: currentInput + docsBlock,
        // du:发送内容用含附件块的那份,但**命名**只能用 currentInput ——
        // 传含附件的那份,服务端会把会话名落成「总结一下 <attached-document …>」
        // 这种带标签尾巴的东西,还与前端乐观显示的名字不一致。
        namingText: currentInput,
        images: uploadedImages,
        options: buildSendOptions(currentInput),
        /**
         * F15:**只认属于这条会话的那一份。**
         *
         * 两个 ref 都可能是在别处装上的:分叉点要等一次网络才装(期间可能切走),
         * 隐藏上下文由全局 window 事件装(压根没有会话概念)。归属对不上就当没有 ——
         * 否则下一次在**另一条**会话里发送,会从别人的 provider 会话分叉出去。
         */
        forkFrom: armedFork.value,
        hiddenContext: armedHiddenContext.value?.value ?? null,
      });

      /**
       * 分叉点与隐藏上下文**冻结即让位**,但只是从"下一条普通消息"的视野里移走 ——
       * 它们已经在命令里了,发送失败也不会丢(重试发的是同一个命令)。
       *
       * fj 当初为了"建会话失败后再按一次回车仍然是分叉"把清除推迟到了发送之后;
       * 现在不需要那个补丁:那次重按走的是 outbox 的重试,用的还是这条命令。
       */
      // 取到了才清 —— 别人会话的那一份还等着它自己的会话来取。
      if (armedFork.consumed) pendingForkRef.current = null;
      if (armedHiddenContext.consumed) pendingHiddenContextRef.current = null;

      // 分叉强制新开一支:目标会话不能沿用当前这条。
      const dispatchable = command.forkFrom ? { ...command, sessionId: null } as SendCommand : command;

      // A turn is already in flight: queue the frozen command instead of sending.
      if (isLoading) {
        enqueueCommand(dispatchable, submitSessionKey);
        clearComposerAfterSubmit(submitSessionKey, submitDraftKey);
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
          clearComposerAfterSubmit(submitSessionKey, null);
          return;
        }
      }

      // Checked before the session POST, not just before the websocket send:
      // that POST is HTTP and can succeed while the socket is down, which would
      // leave the user an orphaned empty session for a message that never went
      // anywhere.
      //
      // 断网不再报错让用户自己重试:走排队通道(和"回合进行中"同一条路),
      // 排队卡立刻可见、可编辑可删除;连接恢复后自动投递。
      if (!isConnected) {
        enqueueCommand(dispatchable, submitSessionKey);
        clearComposerAfterSubmit(submitSessionKey, submitDraftKey);
        return;
      }

      /**
       * gh:**这条会话已经有一条在等(排队 / 等图片)时,新的一句并进去,由冲队按序发。**
       *
       * 直接发的话 `markCommandSent` 会用这一条整个覆盖 outbox 并清掉盘上记录 ——
       * 原来那条连正文一起消失,无提示。outbox 是单槽位,合并是它唯一不丢东西的路。
       */
      /**
       * gi 自查:只并进**冲队发得出去**的那条(queued)。并进 needs_attachment 的话,
       * 那条永远不会自动发(冲队只认 queued、retry 对它是空操作),用户之后每一次回车
       * 都被吞进去 —— 会话明明空闲,却一条都发不出。needs_attachment 照旧直接发
       * (markCommandSent 会绕开它,见那边)。
       */
      if (outboxRef.current?.status === 'queued' && queuedDraftSessionRef.current === submitSessionKey) {
        enqueueCommand(dispatchable, submitSessionKey);
        clearComposerAfterSubmit(submitSessionKey, submitDraftKey);
        return;
      }

      historyWalkRef.current = null;

      const result = await dispatchSendCommandRef.current(dispatchable);
      if (result.ok) {
        /**
         * 收尾放在投递**之后**:新会话是在投递里建起来的,而
         * `composerStillOwnedBySubmit` 需要知道"这一次发送建了哪条会话" ——
         * 提前清就拿不到它,那正是那个反复发送的循环的由来。
         */
        clearComposerAfterSubmit(submitSessionKey, submitDraftKey, result.establishedSessionId);
        markCommandSent(result.command, submitSessionKey);
        return;
      }

      // 没发出去:输入框留着原文,用户改一改还能再发(命令也留在 outbox 里)。

      if (result.reason === 'offline') {
        /**
         * 连通性检查之后、真正 send 之前的一瞬掉线:同样入队,恢复后自动发。
         *
         * ga:**收尾也要做。** 上面那条"检查之前就发现断网"的分支是
         * `enqueueCommand` + `clearComposerAfterSubmit` 两件都做;这一条只做了
         * 前一件 —— 于是同一句话**既进了队列,又留在输入框里**(草稿键也还在,
         * 刷新都活得下来)。网络恢复后队列自动发出,用户看着输入框里一模一样的
         * 字以为没发成功,再按一次回车 —— 同一句话发两遍,两个不同的幂等键,
         * 服务端认不出来,模型跑两轮、改两遍文件。
         *
         * 两条分支是同一件事的两种时机,收尾动作必须一样。
         */
        enqueueCommand(dispatchable, submitSessionKey);
        clearComposerAfterSubmit(submitSessionKey, submitDraftKey);
        return;
      }

      addMessage({ type: 'error', isLocalNotice: true, content: result.message ?? '发送失败', timestamp: new Date() });
      // 建会话失败:命令留在 outbox 里,用户可以重试(分叉点也还在命令里)。
      enqueueCommand(dispatchable, submitSessionKey, { status: 'failed', error: result.message ?? '发送失败' });
    },
    [
      selectedProjectId,
      selectedSession,
      activeDraftKey,
      attachedImages,
      attachedDocs,
      buildSendOptions,
      clearComposerAfterSubmit,
      currentSessionId,
      enqueueCommand,
      executeCommand,
      isConnected,
      isLoading,
      markCommandSent,
      selectedProject,
      sessionKey,
      addMessage,
      slashCommands,
      parsingDocsCount,
    ],
  );

  /**
   * fj:对外的提交入口 —— 重入闸包在最外层。
   *
   * 单独一层包装,而不是给 `runSubmit` 整个函数体套 try/finally:那要给三百多行
   * 重新缩进,改动面远大于修复本身,而每一行缩进变化都是一次 review 噪音。
   */
  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      if (submittingRef.current) {
        event.preventDefault();
        return;
      }
      submittingRef.current = true;
      setIsSubmitting(true);
      try {
        await runSubmit(event);
      } finally {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [runSubmit],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  /**
   * gk:一条**还没发出去的**排队命令被别处的动作挤掉时,把正文退回输入框。
   *
   * 用在跨标签页那两处(盘上换成了另一条 / 盘上那条被别人删了)。排队槽一个会话
   * 只有一个,两个标签页各排一句时后写的会覆盖先写的 —— 先写的那句若连提示都没有,
   * 用户看到的是"我明明排了一条,它自己没了",而这类现场事后根本查不出来。
   *
   * 输入框已经有字就并在后面(`mergeQueuedIntoInput`,与封顶那条路同一套)。
   * 图片退不回来(输入框那侧是 File[]),按「编辑排队草稿」的口径提示重新添加。
   *
   * **声明位置有讲究**:下面那个冲队 effect 的依赖数组在 render 期间就会读到它 ——
   * 声明放到 effect 之后会是 TDZ,整个输入框当场崩。
   */
  const returnQueuedTextToInput = useCallback((entry: OutboxEntry | null, reason: string) => {
    const text = entry?.command.text?.trim() ? entry.command.text : '';
    if (!text) return;
    const merged = mergeQueuedIntoInput(text, inputValueRef.current);
    setInput(merged);
    inputValueRef.current = merged;
    const images = entry?.command.images.length ?? 0;
    emitToast({
      message: reason + (images > 0 ? `排队时附带的 ${images} 张图片需要重新添加。` : ''),
      variant: 'error',
    });
  }, [setInput]);

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

    /**
     * ga:**`sending` 卡住的那条,重连之后要拨回 `queued` 重投。**
     *
     * `markCommandSent` 记的是 `sending`,并且**当场清盘**、输入框也已清空 ——
     * 真正的 `acked` 由服务端 `chat_ack` 翻转。可如果这一帧还没被服务端读到
     * 连接就断了(切网 / 合盖唤醒 / 代理超时),此后:盘上没记录、`sending`
     * 不落盘、排队卡不显示、冲队只认 `queued` —— **全仓库没有任何路径把它拨回去**。
     * 用户的气泡挂在那里,没有回答、没有报错、没有重试入口。
     *
     * 而落盘 effect 的注释写着"重投用的是内存里那份"、`canClearDraft` 写着
     * "断网重连后我们会带着同一个 clientMessageId 重投,服务端按它去重" ——
     * **那个重投在代码里不存在**,整套幂等键因此只在后台续发那条路上被用过。
     *
     * 现在补上:连接恢复的那一拍,把还停在 `sending` 的那条拨回待发。
     * 重投用的是**同一个幂等键**,服务端 `registerSend` 认得出来,
     * 真收到过的那条只会回一个 `duplicate` ACK,不会跑两遍。
     */
    if (outbox?.status === 'sending') {
      if (!isConnected) {
        // 这条还停在"已交出去、等 ACK",而连接断了 —— 记下来,回来要重投。
        sendingSawDisconnectRef.current = outbox.command.clientMessageId;
        return;
      }
      if (sendingSawDisconnectRef.current === outbox.command.clientMessageId) {
        sendingSawDisconnectRef.current = null;
        const revived = reduceOutbox(outbox, { type: 'retry' });
        outboxRef.current = revived;
        setOutbox(revived);
        return;
      }
      // 连接一直好着 —— 那就是正常在等 ACK,不许动它(动了就是刚发出去立刻再发一遍)。
      return;
    }
    sendingSawDisconnectRef.current = null;

    // 断网期间不冲队:投递只会再次入队(750ms 一圈的空转)。
    // isConnected 翻真时本 effect 会重跑,那时再发。
    //
    // A 组:附件恢复不回来的那条(`needs_attachment`)同样不发 —— 它在等用户
    // 重新添加图片,自动发出去的会是一条"引用了不存在图片"的话(F12)。
    if (isLoading || !isSendable(outbox) || !isConnected) {
      return;
    }
    const pending: OutboxEntry = outbox;

    // Turn just ended in this session: flush immediately. Otherwise this is a
    // saved draft restored into an apparently idle session — hold it briefly
    // so the `chat_subscribed` ack can flip `isLoading` if a run is actually
    // still live (the cleanup below cancels the send in that case).
    const delay = wasLoading ? 0 : 750;
    const timer = setTimeout(() => {
      const dispatch = () => {
        /**
         * A 组(F13):**投递排队时冻结的那条命令,不碰输入框。**
         *
         * 原来冲队是"把排队正文灌回输入框 → 再走一遍 handleSubmit"。而回合刚
         * 结束、输入框刚解锁,正是用户开始打下一句的那一刻 —— fj 为此把覆盖改成
         * 了"两段合起来发",但那只是止血:**用户正在写的下一句仍然会被连带发出去**,
         * 而且 options 是按当前输入框重建的,不是排队时那一份。
         *
         * 现在排队的是一个冻结的命令,直接投递它:输入框里的字一个不动。
         */
        const owner = queuedDraftSessionRef.current;
        /**
         * gk:**同一条命令的自动投递封顶。**
         *
         * 后台会话那条路(useQueuedMessageAutoSend)gh 就封了 3 次,这条路一直没有上限:
         * 任何一种"投出去又被拨回 queued"的时序(断线重连、别的标签页改盘、isLoading 抖动)
         * 都能让它无限重投。超过就停下来、说清楚,交给用户点重试。
         */
        boundAttemptMap(flushAttemptsRef.current);
        if (!flushAttemptAllowed(flushAttemptsRef.current, pending.command.clientMessageId, Date.now())) {
          console.warn(`[queue] 命令 ${pending.command.clientMessageId} 一分钟内自动投递已达 ${FLUSH_MAX_ATTEMPTS} 次,停止重投`);
          // 停下来,正文退回输入框(输入框有字就并在后面),发不发交回给用户。
          retiredClientMessageIdsRef.current.add(pending.command.clientMessageId);
          if (sessionKey) clearQueuedMessage(sessionKey);
          outboxRef.current = null;
          setOutbox(null);
          const merged = mergeQueuedIntoInput(pending.command.text, inputValueRef.current);
          setInput(merged);
          inputValueRef.current = merged;
          // 图片退不回来(输入框那侧要的是 File[],上传过的拿不回原文件)——
          // 与「编辑排队草稿」同一句提示。不说的话,用户会发出一条指着不存在的图片的消息。
          const abandonedImages = pending.command.images.length;
          emitToast({
            message: '这条消息连续多次投递都没有得到确认,已停止自动重发 —— 正文退回了输入框,确认后再发一次。'
              + (abandonedImages > 0 ? `排队时附带的 ${abandonedImages} 张图片需要重新添加。` : ''),
            variant: 'error',
          });
          return Promise.resolve();
        }
        /**
         * gi 自查:**投递之前就把它标成 sending。**
         *
         * 分叉命令的投递要先 POST 建会话(几百毫秒);这期间它还是 queued,用户此刻回车
         * 会把新的一句并进这条(见 handleSubmit 的合并分支),而 POST 回来后
         * markCommandSent 用旧命令整个覆盖 —— 新的一句消失。标成 sending 之后
         * isPendingSend 为假,新的一句走直发,两条都发得出去。失败路径照旧:
         * offline → retry 回 queued;error → failed。
         */
        setOutbox((current) => (
          current && current.command.clientMessageId === pending.command.clientMessageId
            ? reduceOutbox(current, { type: 'sending' })
            : current
        ));
        if (outboxRef.current?.command.clientMessageId === pending.command.clientMessageId) {
          outboxRef.current = reduceOutbox(outboxRef.current, { type: 'sending' });
        }
        return dispatchSendCommandRef.current(pending.command).then((result) => {
          if (result.ok) {
            markCommandSent(result.command, owner);
            return;
          }
          if (result.reason === 'offline') {
            // 认领之后没发出去:把戳摘掉,让下一轮/别的标签页能接手。
            if (sessionKey) releaseQueuedMessage(sessionKey);
            setOutbox((current) => reduceOutbox(current, { type: 'retry' }));
            return;
          }
          setOutbox((current) => reduceOutbox(current, { type: 'failed', error: result.message ?? '发送失败' }));
        }).catch((error) => {
          console.error('排队命令投递失败:', error);
          setOutbox((current) => reduceOutbox(current, { type: 'failed', error: '发送失败' }));
        });
      };

      // 没有会话键 = 还没落盘,没有别人能抢,直接发。
      if (!sessionKey) {
        void dispatch();
        return;
      }

      // The saved key is the claim ticket shared with the app-level auto-send
      // (which handles sessions that finish while not viewed). 认领不到 = 键已经
      // 没了(已经发过),或者**别的标签页**刚抢走 —— 都不能再发一次。
      /**
       * gk:**锁要盖住"投递 → 清盘"整段,认领到的必须是内存里要投的那一条。**
       *
       * 原来回调同步返回、投递是 fire-and-forget:锁释放时盘上那份还在(markCommandSent
       * 在投递的 .then 里才清),这段窗口里再来一次冲队照样认领得到 → 同一条命令再投一次。
       * 现在 await 到投递收尾;认领到的记录若与内存里这条不是同一个幂等键,说明盘上已经
       * 换了内容(别的标签页 / 旧会话),按盘上那份重装,不投内存这条。
       */
      void runExclusive(queueLockName(sessionKey), async () => {
        const claimed = claimQueuedMessage(sessionKey) as StoredSendCommand | null;
        const verdict = shouldDispatchClaimed(claimed, pending.command.clientMessageId, retiredClientMessageIdsRef.current);
        if (verdict === 'drop') {
          // 认领到了、但这条已被取消(同一个幂等键):盘上那份就是它,清掉。
          if (claimed) clearQueuedMessage(sessionKey);
          setOutbox(null);
          outboxRef.current = null;
          return;
        }
        if (verdict === 'resync') {
          releaseQueuedMessage(sessionKey);
          const next = restoredEntry(fromStoredCommand(claimed!, {
            sessionKey,
            sessionId: sessionKey,
            projectId: selectedProjectIdRef.current,
          }));
          // 内存这条被盘上那条挤掉了 —— 正文退回输入框,别静默丢掉用户写的字。
          returnQueuedTextToInput(pending, '另一个标签页排了新的消息 —— 这边排队的那条正文退回了输入框。');
          outboxRef.current = next;
          setOutbox(next);
          return;
        }
        await dispatch();
      }).catch((error) => {
        console.error('排队草稿发送失败:', error);
      });
    }, delay);
    return () => clearTimeout(timer);
    // returnQueuedTextToInput 的身份稳定(只依赖 setInput),列在这里只为过 exhaustive-deps。
  }, [isLoading, outbox, sessionKey, isConnected, markCommandSent, returnQueuedTextToInput]);

  /**
   * 「编辑」排队的那条:正文退回输入框,命令作废。
   *
   * 图片**不退回** —— 它们已经上传了,而输入框那侧的 `attachedImages` 是
   * `File[]`,拿不回原文件。正文退回、图片提示重新添加,比装作还在诚实。
   */
  /**
   * gk:取消 / 编辑 / 停止并回 —— 三处共用的"作废这条排队命令":
   * 当场清盘(不等落盘 effect 的下一拍)、摘掉认领戳、把幂等键记成已作废。
   */
  const retireQueuedCommand = useCallback((entry: OutboxEntry | null) => {
    if (!entry) return;
    retiredClientMessageIdsRef.current.add(entry.command.clientMessageId);
    boundIdSet(retiredClientMessageIdsRef.current);
    const key = queuedDraftSessionRef.current || entry.command.sessionKey || entry.command.sessionId;
    if (key) {
      const stored = readQueuedMessage(key);
      // 只清"就是这一条"的记录 —— 盘上若已换成别的(别的标签页排的),不动它。
      if (!stored?.clientMessageId || stored.clientMessageId === entry.command.clientMessageId) {
        clearQueuedMessage(key);
      }
    }
  }, []);

  const editQueuedDraft = useCallback(() => {
    const entry = outboxRef.current;
    if (!entry) {
      return;
    }
    retireQueuedCommand(entry);
    setOutbox(null);
    outboxRef.current = null;
    setInput(entry.command.text);
    inputValueRef.current = entry.command.text;
    if (entry.command.images.length > 0) {
      emitToast({ message: '排队时附带的图片需要重新添加。' });
    }
    textareaRef.current?.focus();
  }, [retireQueuedCommand, setInput]);

  const deleteQueuedDraft = useCallback(() => {
    retireQueuedCommand(outboxRef.current);
    setOutbox(null);
    outboxRef.current = null;
  }, [retireQueuedCommand]);

  /**
   * 服务端那份排队被中止带走了 —— 把正文退回输入框。
   *
   * 与本地 `queuedDraft` 走的是同一套语义(见 handleAbortSession):停止不替用户
   * 开跑下一段,但也不吞掉他打过的字。
   *
   * **只在输入框为空时回填** —— 用户可能在中止之后已经开始打别的了,
   * 覆盖他正在打的字比丢掉那条排队更糟。回填不了时调用方会退回原来那条提示,
   * 至少不会让消息看起来凭空消失。
   */
  const restoreQueuedContent = useCallback((content: string): boolean => {
    if (!content || inputValueRef.current.trim()) return false;
    setInput(content);
    inputValueRef.current = content;
    textareaRef.current?.focus();
    return true;
  }, []);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // 「让 Claude 创建定时任务」等入口的预填:切到聊天页后把整段话术塞进输入框。
  useEffect(() => {
    const onPrefill = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (typeof text !== 'string' || !text) return;
      historyWalkRef.current = null;
      setInput(text);
      inputValueRef.current = text;
      window.setTimeout(() => textareaRef.current?.focus(), 50);
    };
    window.addEventListener('prism:prefill-chat-input', onPrefill);
    return () => window.removeEventListener('prism:prefill-chat-input', onPrefill);
  }, []);

  // 「让 Claude 创建定时任务」等入口的**直发**:一句人话直接作为用户消息发出去
  // (像 Cowork 那样),技术细节(票据、接口用法)走 hiddenContext,页面上不出现。
  useEffect(() => {
    const onDirectSend = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; hiddenContext?: string }>).detail;
      const text = detail?.text;
      if (typeof text !== 'string' || !text.trim()) return;
      historyWalkRef.current = null;
      setInput(text);
      inputValueRef.current = text;
      pendingHiddenContextRef.current = typeof detail?.hiddenContext === 'string' && detail.hiddenContext
        // 事件是全局的,但上下文只对**触发它时所在的**会话有效。
        ? { owner: sessionKeyRef.current, value: detail.hiddenContext }
        : null;
      // 等切页/渲染落定再提交;submit 读的是 inputValueRef,不受 state 时序影响。
      window.setTimeout(() => {
        handleSubmitRef.current?.(createFakeSubmitEvent());
      }, 80);
    };
    window.addEventListener('prism:send-chat-message', onDirectSend);
    return () => window.removeEventListener('prism:send-chat-message', onDirectSend);
  }, []);

  // 输入草稿持久化,owner-ref 防跨会话串写(和下面 queuedDraft 的写法同款):
  // 切会话的那一个 commit 里,`activeDraftKey` 已指向新会话而 `input` 还是旧
  // 会话的文字 —— 持久化 effect 靠 ref 不相等跳过那一拍,换草稿 effect 随后
  // 更新 ref 并从新键恢复。持久化 effect 必须声明在换草稿 effect **之前**。
  const inputDraftKeyRef = useRef<string | null>(activeDraftKey);

  useEffect(() => {
    if (!activeDraftKey || inputDraftKeyRef.current !== activeDraftKey) {
      return;
    }
    if (input !== '') {
      safeLocalStorage.setItem(activeDraftKey, input);
    } else {
      safeLocalStorage.removeItem(activeDraftKey);
    }
    // dl:草稿进账号级同步(F11),停笔 8 秒推一次 —— 换台设备接着打。
    schedulePushAccountSettings();
  }, [input, activeDraftKey]);

  useEffect(() => {
    inputDraftKeyRef.current = activeDraftKey;
    historyWalkRef.current = null;
    let savedInput = (activeDraftKey ? safeLocalStorage.getItem(activeDraftKey) : null) || '';
    // ck:cj 版「让 Claude 创建定时任务」把整段带票据的 curl 话术预填进过输入框,
    // 没发送就会作为会话草稿存进 localStorage —— 升级后打开目标会话,这坨机器
    // 文本还会被恢复出来(用户反馈)。票据一次性且早已过期,识别到就直接丢弃。
    if (savedInput && /X-Prism-Task-Ticket|\/api\/tasks\/via-ticket/.test(savedInput)) {
      savedInput = '';
      if (activeDraftKey) safeLocalStorage.removeItem(activeDraftKey);
    }
    setInput((previous) => {
      const next = previous === savedInput ? previous : savedInput;
      inputValueRef.current = next;
      return next;
    });
  }, [activeDraftKey]);

  // Persist the queued draft under its session's key. Must be defined BEFORE
  // the swap effect below: on a session switch there is one commit where
  // `sessionKey` already points at the new session while `queuedDraft` (and
  // the owner ref) still describe the old one — the ref mismatch makes this
  // effect skip that commit instead of writing/clearing across sessions.
  useEffect(() => {
    if (!sessionKey) return;
    /**
     * 归属判据换成**条目自己记的那条会话**,不再用一个会漂的 ref。
     *
     * 原来是 `queuedDraftSessionRef.current !== sessionKey` 就整段跳过 ——
     * 它既挡住了"写到别的会话头上",也挡住了**该清没清**。新会话的第一条正好
     * 撞上:提交时 owner 是 null、落地时 sessionKey 已经是新 id,守卫一跳过,
     * 盘上那份就留下了。
     *
     * 命令里本来就带着 `sessionKey`(冻结时记的),用它判归属既准确又不会漂;
     * 而"没有条目"这种情况一律执行清理 —— 清一个本来就该空的键,没有风险。
     */
    /**
     * fz:**这一拍的账,得等恢复先认领这条会话。**
     *
     * 这个 effect 声明在恢复那个之前,依赖里都有 `sessionKey` —— 换会话那一拍
     * 它先跑,而此时 `sessionKey` 已经是**新**会话、`outbox` 还是旧会话的
     * (旧会话没排队时就是 `null`)。下面那句"没有条目就清理"于是清掉的是
     * **新会话**盘上那份 —— 紧接着恢复 effect 去读,读到空。
     *
     * 后果:排队消息**活不过一次刷新,也活不过切走再切回**;而且它把
     * A 组整套"跨刷新恢复 / 附件描述符 / needs_attachment"一起关掉了
     * (盘上那份根本不再被读回来 —— 这也是 fr 之后"重复发送"不再复现的真相)。
     *
     * fr 把守卫从 `queuedDraftSessionRef.current !== sessionKey`(整段跳过)
     * 换成 `outbox.command.sessionKey !== sessionKey`,守卫从"两条路都堵"
     * 退化成"只在有条目时堵一条" —— 又是只收窄了一半。
     *
     * 现在的判据是**恢复认领没认领这条会话**:换会话那一拍它还指着旧 key,
     * 整段跳过;恢复跑完把 key 记上,之后的每一拍照常写/清。既堵住了跨会话
     * 误清,也没有把"该清没清"那条路重新打开(同会话内的清理照旧发生)。
     */
    if (!mayPersistQueuedCommand(restoredForKeyRef.current, sessionKey, outbox?.command.sessionKey)) {
      return;
    }
    /**
     * **落盘的是"还没发出去的那条",不是"outbox 里有东西"。**
     *
     * `markCommandSent` 之后条目会停在 `sending` 等 ACK。如果这时候还写盘,
     * 而 ACK 因为任何原因没到(服务端是旧版本、帧丢了、页面在 ACK 之前被关掉),
     * 这条记录就永久留在 localStorage 里 —— 而"换会话"那个 effect 每次都会把它
     * 读回来并置成 `queued`,冲队随即又发一次。**同一句话反复发送,停不下来。**
     *
     * 判据收成一句:**只有还等着发的才落盘**(`queued`);附件缺失的那条也要留
     * (它在等用户补图,刷新之后卡片还得在)。`sending` / `acked` / `failed` 一律清 ——
     * 已经交出去的那条由 ACK 负责收尾,重投用的是内存里那份,不需要盘上这份。
     */
    const shouldPersist = isPendingSend(outbox) && Boolean(outbox?.command.text);

    if (shouldPersist && outbox) {
      /**
       * A 组(F12):落盘的是**整条命令** —— 幂等键、图片引用、options、
       * 分叉点、隐藏上下文都在里面。
       *
       * fj 那版只能存正文和 options:图片是 `File[]`,序列化不了。于是
       * "我排了一条带图的消息"会静默变成纯文本消息发出去,而 fj 的止血是
       * **在正文里补一行说明**——那行字会真的发给模型,读起来像用户自己写的。
       *
       * 现在图片在提交时就已经上传完了,存的是路径描述符(纯 JSON),
       * 刷新之后原样读回来还能用;真丢了(老记录 / 存坏了)就落到
       * `needs_attachment`,停下来等用户重新添加,而不是照发。
       */
      writeQueuedMessage(sessionKey, toStoredCommand(outbox.command));
    } else {
      clearQueuedMessage(sessionKey);
    }
  }, [outbox, sessionKey]);

  /**
   * 换会话(以及首次挂载)时装入这条会话盘上那份排队命令 —— **恢复的唯一入口**。
   */
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    restoredForKeyRef.current = sessionKey;
    if (!sessionKey) {
      setOutbox(null);
      outboxRef.current = null;
      return;
    }
    const stored = readQueuedMessage(sessionKey) as StoredSendCommand | null;

    // 兜底不变式:这个标签页已经发出去的命令,不许再回到待发(见上面的说明)。
    // gk:取消过的同样不许回来。
    if (!shouldRestoreStored(stored?.clientMessageId, dispatchedClientMessageIdsRef.current, retiredClientMessageIdsRef.current)) {
      clearQueuedMessage(sessionKey);
      setOutbox(null);
      outboxRef.current = null;
      return;
    }

    /**
     * gh:**正在等 ACK 的那条(sending)不能被盘上的空记录抹掉。**
     *
     * `sending` 从不落盘(重投用的是内存里那份),而这个 effect 对任何一次 sessionKey
     * 变化都无条件用盘上内容覆盖内存。新会话的第一条消息:`onSessionEstablished(N)`
     * 与 `markCommandSent` 同一批落地 → 下一次 commit sessionKey 变成 N → 读到空 →
     * outbox 置 null。这条消息若正好落进"写进发送缓冲但服务端没读到"的断线窗口,
     * ga 补的"重连后把 sending 拨回 queued 重投"就没有条目可拨。
     * 内存里那条属于这条会话、且盘上没有更新的记录时,留着它。
     */
    const inFlight = outboxRef.current;
    const inFlightBelongsHere = Boolean(
      inFlight && inFlight.status === 'sending'
      && (inFlight.command.sessionId === sessionKey || inFlight.command.sessionKey === sessionKey),
    );
    if (!stored && inFlightBelongsHere) {
      return;
    }

    const next = stored
      ? restoredEntry(fromStoredCommand(stored, {
        sessionKey,
        sessionId: sessionKey,
        projectId: selectedProjectIdRef.current,
      }))
      : null;
    setOutbox(next);
    outboxRef.current = next;
  }, [sessionKey]);

  /**
   * gk:**别的标签页动了盘上这条会话的排队记录 —— 这边跟着对齐。**
   *
   * 盘上那份是跨标签页共享的,而内存里每个标签页各有一份;此前没有任何同步:
   * A 标签页取消了,B 标签页内存里那条还在,B 的落盘 effect 下一次跑就把它**写回盘上**,
   * 随后无论哪边冲队都会把用户已经取消的那句话发出去。
   */
  useEffect(() => {
    if (!sessionKey || typeof window === 'undefined') return;
    const key = queuedMessageKey(sessionKey);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      const entry = outboxRef.current;
      let incomingId: string | null = null;
      if (event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue) as { clientMessageId?: unknown };
          incomingId = typeof parsed.clientMessageId === 'string' ? parsed.clientMessageId : null;
        } catch { /* 老格式或坏数据:当作没有幂等键 */ }
      }
      const verdict = reconcileWithStorageEvent(
        entry?.command.clientMessageId ?? null,
        isPendingSend(entry),
        incomingId,
        event.newValue === null,
      );
      if (verdict === 'keep') return;
      if (verdict === 'drop') {
        if (entry) retiredClientMessageIdsRef.current.add(entry.command.clientMessageId);
        // 别的标签页把它发了 / 取消了。正文退回输入框 —— 撤掉一条用户亲手排的消息而
        // 不留下那句话,是"我明明写了"这类投诉里最说不清的一种。
        returnQueuedTextToInput(entry, '这条排队消息已在另一个标签页被发出或取消 —— 正文退回了输入框。');
        outboxRef.current = null;
        setOutbox(null);
        return;
      }
      const stored = readQueuedMessage(sessionKey) as StoredSendCommand | null;
      const next = stored
        ? restoredEntry(fromStoredCommand(stored, { sessionKey, sessionId: sessionKey, projectId: selectedProjectIdRef.current }))
        : null;
      // 盘上换成了另一条:内存这条被挤掉了。它是这个标签页的用户刚打的,
      // 不能就这么没了(排队槽只有一个,先写的那句会被后写的覆盖)。
      returnQueuedTextToInput(entry, '另一个标签页排了新的消息 —— 这边排队的那条正文退回了输入框。');
      outboxRef.current = next;
      setOutbox(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [sessionKey, returnQueuedTextToInput]);

  /**
   * 换会话时把附件清掉。
   *
   * 文本草稿是**按会话存的**(`draftStorageKey(sessionKey, projectId)`),切过去会换成
   * 那条会话自己的。但 `attachedImages` / `attachedDocs` 是**跨会话共用的一份 state** ——
   * 在 A 里挂了三个文件、还没发,切到 B,那三个文件仍然挂在输入框上,下一次在 B 里
   * 发送就把它们一起发出去了。用户完全看不出这是 A 的东西。
   *
   * 更要紧的是**附件已经落盘在 A 的项目目录下**(见 attachment-storage:附件按
   * projectPath 归档并计入配额)。在 B 里发出去,提示词里就带着一条指向另一个项目的
   * 路径 —— 这违反了这个文件顶部立的不变量,也是一条跨项目的信息泄漏。
   *
   * 所以切会话就清空。不做"按会话保存附件"是有意的:文件对象活不过刷新,
   * 存了也只是半个功能,而半个功能比没有更让人困惑(草稿注释里已经解释过同一件事)。
   * 上传中的进度与错误一并清 —— 它们描述的是被丢弃的那批文件。
   */
  useEffect(() => {
    setAttachedImages([]);
    setAttachedDocs([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
    setDocUploadProgress(null);
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

      // 用户开始编辑,历史回看就此结束(改过的内容不再当历史看)。
      historyWalkRef.current = null;

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
      /**
       * fj:输入法组合期不让菜单/提及抢键。
       *
       * 这两个 handler 排在 `isComposing` 判据**之前**,而 ↑/↓ 历史回看
       * (第 1859 行)和发送(第 1885 行)都带了保护。中文/日文输入法按回车
       * 确认候选时,若命令菜单恰好开着且有高亮项,那一下回车就被截胡去插入命令了。
       */
      if (event.nativeEvent.isComposing) {
        return;
      }

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

      // ↑/↓ 历史回填(readline 风格):只在输入框为空时 ↑ 进入回看,回看中
      // ↑/↓ 前后翻,↓ 越过最新一条恢复空输入。有内容时不抢光标移动。
      if (
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
        && !showCommandMenu
        && !showFileDropdown
        && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
        && !event.nativeEvent.isComposing
      ) {
        const direction = event.key === 'ArrowUp' ? 'back' : 'forward';
        const step = stepHistoryWalk(
          historyWalkRef.current,
          direction,
          () => getUserMessageHistory?.() ?? [],
          inputValueRef.current,
        );
        historyWalkRef.current = step.state;
        if (step.input !== null) {
          event.preventDefault();
          setInput(step.input);
          inputValueRef.current = step.input;
          // 等回填渲染后把光标放到末尾(默认会停在开头)。
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el) {
              el.selectionStart = el.selectionEnd = el.value.length;
            }
          });
          return;
        }
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
      getUserMessageHistory,
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

    // 停止 = 刹车,不是"停这一条然后接着跑下一条"。
    //
    // 原来这里只发 abort:中止同样产生 `complete` → isLoading 由 true 变 false →
    // 下面那个 flush effect 以 `wasLoading ? 0 : 750` 的 0ms 立刻把排队那条**发出去**。
    // 于是用户会看到服务端广播的"排队那条已取消",同时一个新回合开跑 ——
    // 跳过权限档下这意味着刹车没刹住,agent 继续动文件。
    //
    // 也不能默默丢掉:排一条纠正再按停止,是引导 agent 最顺手的操作,
    // 丢了就得重敲。所以退回输入框 —— 不丢东西,也不会有任何东西自动开跑,
    // 要不要发交回给用户的下一次按键。
    if (queuedDraft) {
      // dn-B2:输入框已有内容时不覆盖 —— 合并(排队在前、正在打的在后)留在
      // 输入框;图片同样并起来。输入框为空时保持原行为(整条退回,含图片)。
      const current = inputValueRef.current;
      if (current.trim()) {
        const merged = mergeQueuedIntoInput(queuedDraft.content, current);
        const queuedImageCount = queuedDraft.imageCount;
        retireQueuedCommand(outboxRef.current);
        setOutbox(null);
        outboxRef.current = null;
        setInput(merged);
        inputValueRef.current = merged;
        // A 组:图片**不退回输入框** —— 它们在提交时就已经上传了,而输入框那侧
        // 是 `File[]`,原文件拿不回来。说一声比装作还挂着诚实。
        if (queuedImageCount > 0) {
          emitToast({ message: '排队时附带的图片需要重新添加。' });
        }
        textareaRef.current?.focus();
      } else {
        editQueuedDraft();
      }
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
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage, queuedDraft, editQueuedDraft, retireQueuedCommand]);

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

      // 逐条发,并记下哪些**真的发出去了**。断线瞬间点"允许/拒绝"时,
      // sendMessage 会返回 false(socket 没连上),但旧代码不看返回值就把请求
      // 从列表里抹掉 —— 弹窗消失、run 却仍挂着那条待批,要等重连 ack 才重新冒
      // 出来,中间一片空白。只移除确认送达的,发失败的留在原地并提示。
      const deliveredIds = validIds.filter((requestId) =>
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        }),
      );

      if (deliveredIds.length > 0) {
        setPendingPermissionRequests((previous) =>
          previous.filter((request) => !deliveredIds.includes(request.requestId)),
        );
      }

      if (deliveredIds.length < validIds.length) {
        addMessage({
          type: 'error',
          isLocalNotice: true,
          content: '连接已断开,授权未发送成功,请在恢复连接后重试。',
          timestamp: new Date(),
        });
      }
    },
    [sendMessage, setPendingPermissionRequests, addMessage],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  /**
   * 失败重试:把给定正文按正常提交路径重发。回合在跑会自动入队,断网也
   * 自动入队 —— 都不会丢。图片附件不随重试恢复(原 File 已不在)。
   */
  const resendUserMessage = useCallback((content: string) => {
    if (!String(content || '').trim()) {
      return;
    }
    // dn-B3:输入框里有未发送的字时不覆盖 —— 提示一句,让用户自己处理。
    // 静默吃掉正在打的内容,比"重试没反应"糟得多。
    if (inputValueRef.current.trim()) {
      emitToast({ message: '输入框里有未发送的内容 —— 先发送或清空它,再点重试。', variant: 'error' });
      return;
    }
    setInput(content);
    inputValueRef.current = content;
    setTimeout(() => {
      handleSubmitRef.current?.(createFakeSubmitEvent());
    }, 0);
  }, []);

  return {
    input,
    setInput,
    resendUserMessage,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    hoveredCommandIndex,
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
    // ed:「+」菜单第一项「添加附件」—— 与拖拽 / 粘贴同一条分流(图片给模型看,其它存进项目)。
    handleAttachFiles: acceptDroppedFiles,
    attachDocFromUrl,
    parsingDocs: parsingDocsCount > 0,
    // fj:提交在飞 —— 发送按钮据此变灰,是重入闸在界面上的那一半。
    isSubmitting,
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
    handleSendAcked,
    restoreQueuedContent,
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
