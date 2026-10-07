import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import PermissionContext from '../../../contexts/PermissionContext';
import MergedMessagesContext, { type MergedMessageState, type MergedMessagesContextValue } from '../../../contexts/MergedMessagesContext';
import { authenticatedFetch } from '../../../utils/api';
import { emitToast } from '../../../shared/view/ui/toastBus';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { SettingsMainTab } from '../../settings/types/types';
import type { ChatInterfaceProps, ChatMessage } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionStore } from '../../../stores/useSessionStore';
import { extractSessionChecklistWithTurn } from '../utils/taskChecklist';
import { extractSessionOutputs } from '../utils/sessionOutputs';
import { turnOutputsFromServer } from '../utils/turnOutputs';
import { changedFilesToMessages } from '../utils/workFrames';
import { useSessionWorkFrames } from '../hooks/useSessionWorkFrames';
import { useMessageFeedback } from '../hooks/useMessageFeedback';
import {
  EMPTY_SERVER_QUEUE,
  queuedForSession,
  reduceServerQueue,
  type ServerQueueMap,
} from '../utils/serverQueue';
import { carryDraftKey, type SessionRemovedInfo } from '../utils/sessionRemoved';
import { resubscribeAfterReconnect } from '../utils/reconnectSubscribe';
import { resolveAliasReal } from '../utils/modelAliasReal';
import { safeLocalStorage } from '../utils/chatStorage';
import { fileRewindTurns } from '../utils/fileRewind';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatFindBar from './subcomponents/ChatFindBar';
import ChatComposer from './subcomponents/ChatComposer';
import ChangedFilesCard from './subcomponents/ChangedFilesCard';
import type { ChangedFilesState, ChangedFileEntry } from './subcomponents/ChangedFilesCard';
import CheckpointHistoryPanel from './subcomponents/CheckpointHistoryPanel';
import ChatWorkPanel from './subcomponents/ChatWorkPanel';
import SessionRemovedNotice from './subcomponents/SessionRemovedNotice';
/**
 * 斜杠命令的结果弹窗(/models、/cost 这类)带着模型卡片、实测按钮和整套表格渲染,
 * 只在用户敲了斜杠命令时才出现,所以懒加载,不进聊天主包、不拖慢首屏。
 */
const CommandResultModal = lazy(() => import('./subcomponents/CommandResultModal'));

/** 设置页「模型网关」标签(SETTINGS_MAIN_TABS 里那一项;用类型钉住,改名会编译失败)。 */
const GATEWAY_SETTINGS_TAB: SettingsMainTab = 'gateways';

function ChatInterface({
  selectedProject,
  selectedSession,
  isConnected,
  sendMessage,
  onFileOpen,
  isEditorOpen = false,
  isActive = true,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onStartNewSession,
}: ChatInterfaceProps) {
  const { subscribe, wasSentHere } = useWebSocket();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  // 流式缓冲与定时器按会话分桶:多条 run 可能同时向本浏览器推流,共用一个缓冲会让
  // token 交错,当前会话的气泡里短暂出现另一段对话的字。
  const streamTimerRef = useRef<Map<string, number>>(new Map());
  const accumulatedStreamRef = useRef<Map<string, string>>(new Map());
  // Latest post-turn changed-files summary (from the turn's git checkpoint).
  const [changedFiles, setChangedFiles] = useState<ChangedFilesState | null>(null);
  // Checkpoint history drawer.
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  // 会话内查找条(Ctrl+F)。
  const [findBarOpen, setFindBarOpen] = useState(false);
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, { runId: string | null; seq: number }>());
  /**
   * 重连补订要读"哪些会话在跑",但这个值不该让 `handleWebSocketReconnect`
   * 每次都换身份(它是 WebSocketContext 的 onReconnect 依赖),所以经 ref 读。
   */
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  /**
   * 清流式缓冲。传 sessionId 只清那一条;不传是全清,只该在整体卸载时调用。
   *
   * 缓冲的生命周期由流自己管(`stream_end` / `complete` 各自删掉自己的桶,见
   * useChatRealtimeHandlers),切换视图不清。`updateStreaming` 是整体替换语义,依赖累积缓冲
   * 一直是"从头到现在的全文":流没结束就清掉,后续 delta 从空串累积,`stream_end` 时残片
   * 被当成完整回答提交,与随后拉回的服务端完整版并排,`pruneRealtimeSupersededByServer` 也清不掉。
   */
  const resetStreamingState = useCallback((sessionId?: string | null) => {
    if (sessionId) {
      const timer = streamTimerRef.current.get(sessionId);
      if (timer) clearTimeout(timer);
      streamTimerRef.current.delete(sessionId);
      accumulatedStreamRef.current.delete(sessionId);
      return;
    }
    for (const timer of streamTimerRef.current.values()) clearTimeout(timer);
    streamTimerRef.current.clear();
    accumulatedStreamRef.current.clear();
  }, []);

  const {
    provider,
    claudeModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    selectPermissionMode,
    availablePermissionModes,
    activeSessionModel,
    modelMappings,
    modelMappingsStale,
    modelConfigMappings,
    refreshModelMappings,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsRefreshing,
    hardRefreshProviderModels,
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    abortDiscardsPending,
    currentSessionId,
    markSessionEstablished,
    isLoadingSessionMessages,
    chatViewState,
    retryLoadSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    streamingText,
    loadEarlierMessages,
    expandAllMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    loadAllStuck,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    isConnected,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    // 用 markSessionEstablished 而不是裸 setCurrentSessionId:要记下"这个 id 是本视图建立的",
    // 路由跟上之前才有资格撑着正文(见 useChatSessionState)。
    markSessionEstablished(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [markSessionEstablished, onSessionEstablished, onNavigateToSession]);

  // 当前会话里用户已发消息的正文(旧→新),经 ref 惰性取值 —— 给 composer 的
  // ↑ 键历史回填与"失败重试"用,引用恒定不随流式 tick 换。
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;
  const getUserMessageHistory = useCallback(() => (
    chatMessagesRef.current
      .filter((message) => message.type === 'user'
        && typeof message.content === 'string'
        && message.content.trim().length > 0)
      .map((message) => String(message.content))
  ), []);

  const {
    input,
    setInput,
    resendUserMessage,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
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
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    attachedDocs,
    removeAttachedDoc,
    handleAttachFiles,
    attachDocFromUrl,
    parsingDocs,
    isSubmitting,
    docUploadProgress,
    startEditRerun,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    sendQueuedNow,
    handleSendAcked,
    restoreQueuedContent,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    commandModalPayload,
    closeCommandModal,
    showModelsModal,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    claudeModel,
    currentProviderEffort,
    isLoading: isProcessing,
    canAbortSession,
    tokenBudget,
    isConnected,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
    getUserMessageHistory,
  });

  // 失败一键重试:找最近一条用户消息按原文重发(在跑/断网都会自动入队)。
  const handleRetryLastTurn = useCallback(() => {
    const messages = chatMessagesRef.current;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.type === 'user' && typeof message.content === 'string' && message.content.trim()) {
        resendUserMessage(message.content);
        return;
      }
    }
  }, [resendUserMessage]);

  /**
   * 「这条会话已被删除」态,按会话分键。
   *
   * 两条路进来:服务端推的 `session_removed`(别处永久删除)、`chat.send` 撞到
   * `SESSION_NOT_FOUND`(页面开着的时候行没了)。恢复后的 `session_upserted` 撤掉它。
   * 处于这个态的会话:输入框换成说明卡、错误行不给「重发」、「新建会话继续」把草稿带走。
   */
  const [removedSessions, setRemovedSessions] = useState<Map<string, SessionRemovedInfo>>(() => new Map());
  const handleSessionRemoved = useCallback((sessionId: string, info: SessionRemovedInfo) => {
    setRemovedSessions((current) => {
      const next = new Map(current);
      next.set(sessionId, info);
      return next;
    });
  }, []);
  const handleSessionRestored = useCallback((sessionId: string) => {
    setRemovedSessions((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  }, []);
  const viewedRemovedInfo = (() => {
    const id = selectedSession?.id ?? currentSessionId ?? null;
    return id ? removedSessions.get(id) ?? null : null;
  })();

  /**
   * 「新建会话继续」:没发出去的那段话先写进新建会话页的草稿键(项目键),
   * 再让应用切到新建会话 —— composer 的换草稿 effect 会从那个键把它恢复到输入框。
   */
  const handleStartNewSessionFromRemoved = useCallback(() => {
    if (!selectedProject || !onStartNewSession) return;
    /**
     * 要带走的可能是两段:输入框里正在打的,和切态时排队卡上那条
     * (回合跑着时回车排进去的那句;切态会把它从盘上清掉,所以由 info 带过来)。
     * 两段都有就都带上,丢掉任何一段都是"我明明打了字"。
     */
    const parts = [viewedRemovedInfo?.queuedText ?? '', input].map((part) => part.trim()).filter(Boolean);
    const draft = parts.join('\n\n');
    const key = carryDraftKey(selectedProject.projectId);
    if (draft && key) safeLocalStorage.setItem(key, draft);
    onStartNewSession(selectedProject);
  }, [input, onStartNewSession, selectedProject, viewedRemovedInfo?.queuedText]);

  // On WebSocket reconnect, re-subscribe every session this client knows is
  // running (plus the one being viewed) — the `chat_subscribed` ack restores
  // or clears the activity indicator, replays missed live events, and
  // re-attaches a still-running stream to this socket — then re-fetch the
  // viewed session's messages so missed streaming events are shown.
  // 顺序与补订范围见 resubscribeAfterReconnect:停在项目首页 / 新会话页时也要补订后台在跑的会话。
  const handleWebSocketReconnect = useCallback(() => resubscribeAfterReconnect({
    viewedSessionId: selectedSession?.id ?? currentSessionId ?? null,
    processingSessionIds: processingSessionsRef.current?.keys() ?? [],
    cursorOf: (sessionId) => lastSeqRef.current.get(sessionId),
    sendMessage,
    markSubscribed: (sessionId, at) => statusCheckSentAtRef.current.set(sessionId, at),
    refresh: (sessionId) => sessionStore.refreshFromServer(sessionId),
  }), [currentSessionId, selectedSession?.id, sendMessage, sessionStore]);

  // 实时 changed_files 帧转成的伪 Write 消息:本轮 Bash / python 写盘的文件即刻进工作面板,
  // 不等落库基线 refetch。会话切换清空;刷新后由基线接管。
  const [liveChangedMessages, setLiveChangedMessages] = useState<ChatMessage[]>([]);

  // Reset the changed-files card and the live frames when switching conversations.
  useEffect(() => {
    setChangedFiles(null);
    setLiveChangedMessages([]);
    // 依赖要含 currentSessionId:新会话页上 `selectedSession?.id` 恒为 undefined,
    // 只靠它这个 effect 永远不会重跑。
  }, [selectedSession?.id, currentSessionId]);

  const handleChangedFiles = useCallback((payload: { sessionId: string | null; checkpointId: string | null; files: unknown[]; truncated?: boolean; cwd?: string | null }) => {
    const activeId = selectedSession?.id || currentSessionId || null;
    /**
     * 归属不明或不匹配的帧一律丢弃,包括 activeId 为 null(新会话页)的情况:
     * 否则停在空白新会话页上时,后台别的会话跑完一轮,这里就会冒出「本轮改动的文件」卡,
     * 工作面板的产出里列着另一条对话写的文件。
     */
    if (!activeId || (payload.sessionId && payload.sessionId !== activeId)) return;
    setChangedFiles({
      checkpointId: payload.checkpointId,
      files: payload.files as ChangedFileEntry[],
      truncated: payload.truncated,
    });
    const converted = changedFilesToMessages(payload.cwd, payload.files);
    if (converted.length > 0) {
      setLiveChangedMessages((current) => [...current, ...converted]);
    }
  }, [selectedSession?.id, currentSessionId]);

  /**
   * 服务端排队中的那条消息(每会话至多一条,按会话分键,见 utils/serverQueue)。
   *
   * 与 composer 自己那份浏览器内排队是两回事:这一份存在服务端,刷新页面、
   * 换设备、关掉标签页之后都还在,所以只能由服务端的帧驱动,不能靠本地推断。
   */
  const [serverQueue, setServerQueue] = useState<ServerQueueMap>(EMPTY_SERVER_QUEUE);

  const handleServerQueueChange = useCallback(
    (sessionId: string, queued: { preview: string; enqueuedAt: string; redacted?: boolean } | null) => {
      setServerQueue((current) => reduceServerQueue(current, sessionId, queued));
    },
    [],
  );

  const viewedSessionId = selectedSession?.id ?? currentSessionId ?? null;
  const serverQueued = queuedForSession(serverQueue, viewedSessionId);

  const handleCancelServerQueued = useCallback(() => {
    // 取消的是正在看的这条会话的排队,按 viewedSessionId 发。
    if (!viewedSessionId) return;
    sendMessage({ type: 'chat.cancel-queued', sessionId: viewedSessionId });
  }, [viewedSessionId, sendMessage]);

  /**
   * 插话(合流进 CLI 队列的消息)的状态,按 clientMessageId 记。
   * ACK 带着 mergedUuid 时记 pending(气泡上「模型读到前可撤回」);送达就删;撤回记 withdrawn(气泡置灰)。
   */
  const [mergedMessages, setMergedMessages] = useState<Map<string, { sessionId: string; mergedUuid: string; state: MergedMessageState }>>(() => new Map());
  const handleSendAckedWithMerge = useCallback((ackSessionId: string, clientMessageId: string, mergedUuid?: string | null) => {
    handleSendAcked(ackSessionId, clientMessageId);
    if (!mergedUuid) return;
    // 合流进了正在跑的这一轮:本地回声不是回合边界,时间轴 / 产出卡不能在这里把这一轮切断。
    sessionStore.markInterjection(ackSessionId, clientMessageId);
    setMergedMessages((current) => {
      const next = new Map(current);
      next.set(clientMessageId, { sessionId: ackSessionId, mergedUuid, state: 'pending' });
      // 只留最近的几十条 —— 这份状态只服务于"还撤不撤得回",老的早就有结果了
      while (next.size > 50) next.delete(next.keys().next().value as string);
      return next;
    });
  }, [handleSendAcked, sessionStore]);
  const handleMergedOutcome = useCallback((sessionId: string, outcome: { type: 'withdrawn' | 'delivered'; mergedUuids: string[]; clientMessageIds: string[] }) => {
    setMergedMessages((current) => {
      let changed = false;
      const next = new Map(current);
      for (const [clientMessageId, entry] of current) {
        if (entry.sessionId !== sessionId) continue;
        if (!outcome.clientMessageIds.includes(clientMessageId) && !outcome.mergedUuids.includes(entry.mergedUuid)) continue;
        changed = true;
        if (outcome.type === 'withdrawn') next.set(clientMessageId, { ...entry, state: 'withdrawn' });
        else next.delete(clientMessageId);
      }
      return changed ? next : current;
    });
  }, []);
  const mergedMessagesValue = useMemo<MergedMessagesContextValue>(() => ({
    stateFor: (clientMessageId) => (clientMessageId ? mergedMessages.get(clientMessageId)?.state : undefined),
    withdraw: (clientMessageId) => {
      const entry = mergedMessages.get(clientMessageId);
      if (!entry || entry.state !== 'pending') return;
      sendMessage({ type: 'chat.cancel-queued', sessionId: entry.sessionId, mergedUuid: entry.mergedUuid });
    },
  }), [mergedMessages, sendMessage]);

  /**
   * 后台任务条:服务端每次推的 `background_tasks` 都是全量,按会话整体替换。
   */
  const [backgroundTasksBySession, setBackgroundTasksBySession] = useState<Record<string, Array<{ taskId: string; taskType: string; description: string }>>>({});
  const handleBackgroundTasks = useCallback((sessionId: string, tasks: Array<{ taskId: string; taskType: string; description: string }>) => {
    setBackgroundTasksBySession((current) => {
      if (tasks.length === 0 && !current[sessionId]) return current;
      const next = { ...current };
      if (tasks.length === 0) delete next[sessionId];
      else next[sessionId] = tasks;
      return next;
    });
  }, []);
  const viewedBackgroundTasks = viewedSessionId ? backgroundTasksBySession[viewedSessionId] ?? null : null;
  const handleStopBackgroundTask = useCallback(async (taskId: string) => {
    if (!viewedSessionId) return;
    try {
      const response = await authenticatedFetch(
        `/api/providers/claude/sessions/${encodeURIComponent(viewedSessionId)}/runtime/tasks/${encodeURIComponent(taskId)}/stop`,
        { method: 'POST' },
      );
      const body = (await response.json().catch(() => ({}))) as { stopped?: boolean; reason?: string };
      if (!body.stopped) emitToast({ message: t('backgroundTasks.stopFailed', { reason: body.reason ?? `HTTP ${response.status}` }) });
    } catch (error) {
      emitToast({ message: t('backgroundTasks.stopFailed', { reason: error instanceof Error ? error.message : String(error) }) });
    }
  }, [viewedSessionId, t]);
  /**
   * 「转到后台」只对前台子代理出现。
   *
   * 无头模式下 CLI 的 `backgroundTasks()` 对前台子代理立刻生效:Agent 调用当场返回
   * "Async agent launched",这一轮接着往下走;对前台 Bash 只登记成后台任务(task_started),
   * 工具调用照样等到命令跑完才返回,按钮出在 Bash 上点了也没用。所以只在有前台子代理在跑时给,
   * 并按它的 tool_use id 定点转(不顺带把同时在跑的 Bash 也登记成后台)。
   */
  const foregroundSubagentId = useMemo(() => {
    if (!isProcessing) return null;
    for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
      const message = chatMessages[index];
      // 只看这一轮:被停掉的子代理永远拿不到 toolResult,扫全量会让之后每一轮都冒出这个按钮。
      if (message?.type === 'user' && !message.interjection) break;
      if (!message?.isToolUse || (message.toolName !== 'Agent' && message.toolName !== 'Task') || message.toolResult) continue;
      const input = (message.toolInput && typeof message.toolInput === 'object' ? message.toolInput : {}) as { run_in_background?: unknown };
      if (input.run_in_background === true) continue;
      // 网关转发的模型 tool_use id 不一定是 toolu_ 开头;child_ 是前端给子代理内部行编的号,不是真 id
      if (typeof message.toolId === 'string' && message.toolId && !message.toolId.startsWith('child_')) return message.toolId;
    }
    return null;
  }, [chatMessages, isProcessing]);
  const handleBackgroundForeground = useCallback(async () => {
    if (!viewedSessionId || !foregroundSubagentId) return;
    try {
      const response = await authenticatedFetch(
        `/api/providers/claude/sessions/${encodeURIComponent(viewedSessionId)}/runtime/background`,
        { method: 'POST', body: JSON.stringify({ toolUseId: foregroundSubagentId }) },
      );
      const body = (await response.json().catch(() => ({}))) as { backgrounded?: boolean; reason?: string };
      if (!body.backgrounded) {
        emitToast({ message: body.reason === 'no_match' ? t('backgroundTasks.nothingToBackground') : t('backgroundTasks.backgroundFailed', { reason: body.reason ?? `HTTP ${response.status}` }) });
      }
    } catch (error) {
      emitToast({ message: t('backgroundTasks.backgroundFailed', { reason: error instanceof Error ? error.message : String(error) }) });
    }
  }, [viewedSessionId, foregroundSubagentId, t]);

  useChatRealtimeHandlers({
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
    onChangedFiles: handleChangedFiles,
    onServerQueueChange: handleServerQueueChange,
    onSendAcked: handleSendAckedWithMerge,
    onMergedOutcome: handleMergedOutcome,
    onBackgroundTasks: handleBackgroundTasks,
    // 排队被中止带走时,正文退回输入框(只在当前正看着这条会话、且输入框为空时)。
    onServerQueueReturned: (sid, content) =>
      sid === (selectedSession?.id ?? currentSessionId) && restoreQueuedContent(content),
    // 退回的正文只给发出这条消息的标签页(见 planQueueCancelled)
    wasSentHere,
    onSessionRemoved: handleSessionRemoved,
    onSessionRestored: handleSessionRestored,
  });

  /**
   * 全局 Esc 的根容器,用来判断"聊天页签此刻看得见"。
   * ChatInterface 在 Shell / 文件 / 任务页签下只是 `hidden`,不卸载,监听器还挂着。
   */
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 不是当前页签就不挂监听 —— 在终端里用 vim / less、在编辑器里关搜索框按 Esc,
    // 都不该中止聊天里正在跑的那一轮。
    if (!canAbortSession || !isActive) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }
      // 中文输入法按 Esc 是"取消候选",不是"停止回合"。
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      // 容器不可见(页签切走、布局把它藏起来)时不处理。
      const root = rootRef.current;
      if (root && root.getClientRects().length === 0) {
        return;
      }
      // 事件源在终端 / 代码编辑器里:那两处的 Esc 各有各的语义(vim、关搜索框)。
      const from = event.target as HTMLElement | null;
      if (from?.closest?.('.xterm, .cm-editor')) {
        return;
      }

      // 这个监听挂在 document 的 capture 阶段,比弹层 / 面板自己的 Esc(冒泡阶段)先跑,
      // `defaultPrevented` 这时还是 false。所以对话框、问答面板、查找条、斜杠菜单 / @ 下拉
      // (role=listbox / menu)在场时直接放行,让它们各自的 Esc 生效。
      if (document.querySelector('[role="dialog"], [data-interactive-prompt="true"], [data-find-bar-open="true"], [role="listbox"], [role="menu"]')) {
        return;
      }

      // 行内改名框(侧栏改项目名 / 会话名、文件树改文件名)同样放行,但判据是事件源:
      // 那里按 Esc 是取消改名,它们既不是 dialog 也没有遮罩,上一条拦不住。
      // 用 closest 而不是 querySelector:别处开着改名框,不该影响在框外按 Esc 中止本轮。
      if (from?.closest?.('[data-inline-rename="true"]')) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isActive]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  // Ctrl/Cmd+F 打开会话内查找条。编辑器(CodeMirror 自带搜索)与终端里不抢。
  useEffect(() => {
    const handleFindShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'f' && event.key !== 'F') return;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.cm-editor, .xterm')) return;
      event.preventDefault();
      setFindBarOpen(true);
    };
    document.addEventListener('keydown', handleFindShortcut, { capture: true });
    return () => document.removeEventListener('keydown', handleFindShortcut, { capture: true });
  }, []);

  // 切会话关掉查找条(命中都是旧会话的 DOM,留着只会误导)。
  useEffect(() => {
    setFindBarOpen(false);
  }, [selectedSession?.id]);

  const closeFindBar = useCallback(() => setFindBarOpen(false), []);

  // 消息流变化信号:开着查找条时驱动重扫。条数 + 末条正文长度 —— 翻页、
  // 新消息、纯文本流式增长都会让它变。
  const findContentVersion = useMemo(() => {
    const last = chatMessages[chatMessages.length - 1];
    const tailLength = typeof last?.content === 'string' ? last.content.length : 0;
    return chatMessages.length * 100000 + tailLength;
  }, [chatMessages]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // ChatComposer 做了 memo,下面这些 props 要收敛成稳定引用(不能写成内联箭头 / 内联表达式),
  // 否则每次流式 tick 都会击穿浅比较。
  const handleRemoveImage = useCallback((index: number) => {
    setAttachedImages((previous) => previous.filter((_, currentIndex) => currentIndex !== index));
  }, [setAttachedImages]);

  const handleSelectEffort = useCallback((nextEffort: string) => {
    setStoredProviderEffort(provider, nextEffort);
  }, [setStoredProviderEffort, provider]);

  const handleShowCheckpoints = useCallback(() => setShowCheckpoints(true), []);

  /**
   * 当前模型在目录里的那一条(输入框 chip 显示它的名字与厂商图标)。
   * 别名组的条目也在 OPTIONS 里,但没有厂商,chip 仍走下面的"别名 → 真实模型"。
   */
  const activeModelOption = useMemo(() => {
    const value = activeSessionModel ?? claudeModel;
    return providerModelCatalog.claude?.OPTIONS.find((option) => option.value === value) ?? null;
  }, [activeSessionModel, claudeModel, providerModelCatalog]);
  const activeModelLabel = activeModelOption?.group === 'catalog' ? (activeModelOption.label || null) : null;
  const activeModelVendor = activeModelOption?.group === 'catalog' ? (activeModelOption.vendor ?? null) : null;
  const contextUsedTokens = useMemo(() => {
    const used = Number((tokenBudget as { used?: unknown } | null)?.used);
    return Number.isFinite(used) && used > 0 ? used : null;
  }, [tokenBudget]);

  // 别名此刻实际打到哪个模型(新鲜实测 > 配置映射),判据见 resolveAliasReal。
  const aliasSources = useMemo(
    () => ({ probed: modelMappings, configured: modelConfigMappings, stale: modelMappingsStale }),
    [modelMappings, modelConfigMappings, modelMappingsStale],
  );
  const activeModelReal = useMemo(
    () => resolveAliasReal(activeSessionModel ?? claudeModel, aliasSources),
    [activeSessionModel, claudeModel, aliasSources],
  );

  /** 下拉里别名行的「→ 真实模型」,与芯片同一套判据。 */
  const modelAliasTargets = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const option of providerModelCatalog.claude?.OPTIONS ?? []) {
      if (option.group === 'catalog') continue;
      out[option.value] = resolveAliasReal(option.value, aliasSources);
    }
    return out;
  }, [providerModelCatalog, aliasSources]);

  const pickerSessionId = currentSessionId || selectedSession?.id || null;
  const handleSelectModelFromDropdown = useCallback(
    (model: string) => selectProviderModel('claude', model, pickerSessionId),
    [selectProviderModel, pickerSessionId],
  );
  /**
   * 模型菜单 / `/models` 里不能用的模型旁的「去填 key」:打开 设置 → 模型网关。
   * 走 AppContent 的 openSettings(tab)(命令面板、代码编辑器开指定标签也是这条路);没有设置入口就不出这个链接。
   */
  const handleOpenGatewaySettings = useMemo(
    () => (onShowSettings ? () => onShowSettings(GATEWAY_SETTINGS_TAB) : undefined),
    [onShowSettings],
  );

  const effectiveFrequentCommands = useMemo(
    () => (commandQuery ? [] : frequentCommands),
    [commandQuery, frequentCommands],
  );

  // The activity indicator yields while a permission request is pending: the composer's
  // approval banner is the status then.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  // 右侧工作面板的数据。基线 = 服务端从全量历史滤出的工具帧(长会话刷新后首屏只加载尾部一段,
  // 只靠消息窗口的话清单与产出会凭空变少);实时增量 = 已加载的消息窗口。
  // 两段直接拼接:折叠函数对重放幂等,重叠段不会算错。
  const {
    baseMessages: workBaseMessages,
    revertedPaths: workRevertedPaths,
    turnOutputs: serverTurnOutputsRaw,
    truncated: workHistoryTruncated,
    skillSurveys,
    refresh: refreshWorkFrames,
  } = useSessionWorkFrames(
    selectedSession?.id || currentSessionId || null,
    isProcessing,
  );
  // 当前用户对本会话各条回答的反馈(赞 / 踩与效果调查卡);切换会话时整表重拉。
  const {
    byMessageId: feedbackByMessageId,
    submit: submitFeedback,
    remove: removeFeedback,
  } = useMessageFeedback(selectedSession?.id || currentSessionId || null);
  /**
   * 对话正文下面那张「产出」卡的数据,来自服务端按全量历史算好的回合映射
   * (不是从当前消息窗口现推)。展示名要项目根,所以在这里落地成卡片形状。
   */
  const serverTurnOutputs = useMemo(
    () => turnOutputsFromServer(serverTurnOutputsRaw, selectedProject?.fullPath || selectedProject?.path),
    [serverTurnOutputsRaw, selectedProject?.fullPath, selectedProject?.path],
  );
  const workMessages = useMemo(
    () => (workBaseMessages.length > 0 || liveChangedMessages.length > 0
      ? [...workBaseMessages, ...chatMessages, ...liveChangedMessages]
      : chatMessages),
    [workBaseMessages, chatMessages, liveChangedMessages],
  );
  const sessionChecklist = useMemo(() => extractSessionChecklistWithTurn(workMessages), [workMessages]);
  const latestTodos = sessionChecklist.items;
  // 折叠完再按"已回滚"集合做减法:窗口里的旧 Write 帧会把已回滚的文件加回来,
  // 只删基线不够;回滚后重写的文件不在集合里,照常显示。
  const sessionOutputs = useMemo(() => {
    const outputs = extractSessionOutputs(workMessages);
    return workRevertedPaths.size > 0
      ? outputs.filter((file) => !workRevertedPaths.has(file.path))
      : outputs;
  }, [workMessages, workRevertedPaths]);

  if (!selectedProject) {
    const selectedProviderLabel = t('messageTypes.claude');

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  /**
   * 首页空态判定:只用于给滚动容器铺点阵画布并居中(输入框始终在消息流下方)。
   */
  const isHome =
    chatMessages.length === 0
    && !selectedSession
    && !currentSessionId
    && !isLoadingSessionMessages
    && !isProcessing;

  const composerElement = (
    <ChatComposer
      serverQueued={serverQueued}
      onCancelServerQueued={handleCancelServerQueued}
      backgroundTasks={viewedBackgroundTasks}
      onStopBackgroundTask={handleStopBackgroundTask}
      onBackgroundForeground={foregroundSubagentId ? handleBackgroundForeground : undefined}
      pendingPermissionRequests={pendingPermissionRequests}
      handlePermissionDecision={handlePermissionDecision}
      handleGrantToolPermission={handleGrantToolPermission}
      isLoading={isProcessing}
      onAbortSession={handleAbortSession}
      abortDiscardsPending={abortDiscardsPending}
      activeModel={activeSessionModel ?? claudeModel}
      activeModelReal={activeModelReal}
      activeModelLabel={activeModelLabel}
      activeModelVendor={activeModelVendor}
      permissionMode={permissionMode}
      onSelectMode={selectPermissionMode}
      availablePermissionModes={availablePermissionModes}
      effort={currentProviderEffort}
      availableEffortOptions={currentProviderEffortOptions}
      onSelectEffort={handleSelectEffort}
      onShowModelPicker={showModelsModal}
      modelOptions={providerModelCatalog.claude?.OPTIONS}
      onSelectModel={handleSelectModelFromDropdown}
      onOpenGatewaySettings={handleOpenGatewaySettings}
      contextUsedTokens={contextUsedTokens}
      modelAliasTargets={modelAliasTargets}
      onShowCheckpoints={handleShowCheckpoints}
      onToggleCommandMenu={handleToggleCommandMenu}
      onSubmit={handleSubmit}
      isDragActive={isDragActive}
      queuedDraft={queuedDraft}
      onEditQueuedDraft={editQueuedDraft}
      onDeleteQueuedDraft={deleteQueuedDraft}
      onSendQueuedNow={sendQueuedNow}
      attachedImages={attachedImages}
      onRemoveImage={handleRemoveImage}
      uploadingImages={uploadingImages}
      imageErrors={imageErrors}
      attachedDocs={attachedDocs}
      onRemoveDoc={removeAttachedDoc}
      onAttachFiles={handleAttachFiles}
      onAttachUrl={attachDocFromUrl}
      parsingDocs={parsingDocs}
      isSubmitting={isSubmitting}
      docUploadProgress={docUploadProgress}
      showFileDropdown={showFileDropdown}
      filteredFiles={filteredFiles}
      selectedFileIndex={selectedFileIndex}
      onSelectFile={selectFile}
      filteredCommands={filteredCommands}
      selectedCommandIndex={selectedCommandIndex}
      hoveredCommandIndex={hoveredCommandIndex}
      onCommandSelect={handleCommandSelect}
      onCloseCommandMenu={resetCommandMenuState}
      isCommandMenuOpen={showCommandMenu}
      frequentCommands={effectiveFrequentCommands}
      getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
      getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
      openImagePicker={openImagePicker}
      inputHighlightRef={inputHighlightRef}
      renderInputWithMentions={renderInputWithMentions}
      textareaRef={textareaRef}
      input={input}
      onInputChange={handleInputChange}
      onTextareaClick={handleTextareaClick}
      onTextareaKeyDown={handleKeyDown}
      onTextareaPaste={handlePaste}
      onTextareaScrollSync={syncInputOverlayScroll}
      onTextareaInput={handleTextareaInput}
      onInputFocusChange={handleInputFocusChange}
      placeholder={t('input.placeholder', {
        provider: t('messageTypes.claude'),
      })}
      isTextareaExpanded={isTextareaExpanded}
      sendByCtrlEnter={sendByCtrlEnter}
    />
  );

  return (
    <PermissionContext.Provider value={permissionContextValue}>
    <MergedMessagesContext.Provider value={mergedMessagesValue}>
      {/* 对话区分两栏:左边消息流 + 输入框,右边工作面板(上任务清单、下产出文件)。
          面板两块都空时自己不渲染,布局即回到单栏。 */}
      <div ref={rootRef} className="flex h-full min-h-0">
      {/* 正文宽度下限,低于它输入框就没法用了。这 280 和 EditorSidebar 的 MIN_CHAT_BODY_WIDTH
          是同一个数,必须一起改:那边按它给预览栏分宽度,这边是硬约束。不设下限的话,
          预览栏一开正文就被压到 0。 */}
      <div className="flex h-full min-h-0 min-w-[280px] flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ChatFindBar
            open={findBarOpen}
            onClose={closeFindBar}
            scrollContainerRef={scrollContainerRef}
            contentVersion={findContentVersion}
          />
          <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          chatViewState={chatViewState}
          onRetryLoadMessages={retryLoadSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          streamingText={streamingText}
          activity={hasActivityIndicator ? sessionActivity : null}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          expandAllMessages={expandAllMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          loadAllStuck={loadAllStuck}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          onEditRerun={startEditRerun}
          onRetryLastTurn={viewedRemovedInfo ? undefined : handleRetryLastTurn}
          isHome={isHome}
          serverTurnOutputs={serverTurnOutputs}
          skillSurveys={skillSurveys}
          feedbackByMessageId={feedbackByMessageId}
          onFeedbackSubmit={submitFeedback}
          onFeedbackRemove={removeFeedback}
          />
        </div>

        <div className="relative flex-shrink-0">
          {/* 左右内边距与 `chat-composer-shell` 一致 —— 面板自己负责居中收窄,
              这一层负责在窄屏下和输入框留一样的边距,两条边界才真的对得上。 */}
          {changedFiles && changedFiles.files.length > 0 && (
            <div className="px-2 sm:px-4 md:px-4">
            <ChangedFilesCard
              state={changedFiles}
              isProcessing={isProcessing}
              onDismiss={() => setChangedFiles(null)}
              onReverted={() => {
                const activeId = selectedSession?.id || currentSessionId;
                if (activeId) void sessionStore.refreshFromServer(activeId);
                // 回滚 / 还原落了 files_reverted 反向帧:重拉基线,
                // 产出面板立刻与磁盘对齐(已回滚文件撤下)。
                refreshWorkFrames();
              }}
            />
            </div>
          )}
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          {viewedRemovedInfo ? (
            <SessionRemovedNotice
              info={viewedRemovedInfo}
              // 排队卡上那条也算"还没发出去的字"——「新建会话继续」两段都带走。
              pendingDraft={[viewedRemovedInfo.queuedText ?? '', input].filter((part) => part.trim()).join('\n\n')}
              onStartNewSession={selectedProject && onStartNewSession ? handleStartNewSessionFromRemoved : null}
            />
          ) : composerElement}
        </div>
      </div>

      <ChatWorkPanel
        todos={latestTodos}
        checklistTurn={sessionChecklist.currentTurn}
        outputs={sessionOutputs}
        historyTruncated={workHistoryTruncated}
        previewOpen={isEditorOpen}
        isProcessing={isProcessing}
        projectId={selectedProject?.projectId ?? null}
        projectPath={selectedProject?.fullPath || selectedProject?.path || null}
        sessionId={selectedSession?.id || currentSessionId || null}
        onFileOpen={onFileOpen}
      />
      </div>

      {showCheckpoints && (
        <CheckpointHistoryPanel
          sessionId={selectedSession?.id || currentSessionId || null}
          isProcessing={isProcessing}
          fileTurns={fileRewindTurns(sessionStore.getMessages(selectedSession?.id || currentSessionId || ''))}
          onClose={() => setShowCheckpoints(false)}
          onReverted={() => {
            const activeId = selectedSession?.id || currentSessionId;
            if (activeId) void sessionStore.refreshFromServer(activeId);
            // 历史抽屉的回滚同样落了反向帧,面板一并对齐。
            refreshWorkFrames();
          }}
        />
      )}

      <QuickSettingsPanel />

      {/* payload 为空时连模块都不拉 —— 懒加载的意义就在这一行。 */}
      {commandModalPayload && (
      <Suspense fallback={null}>
      <CommandResultModal
        payload={commandModalPayload}
        onClose={() => {
          closeCommandModal();
          // 关弹窗时刷一遍映射 —— 用户刚在弹窗里点过「实测真实模型」的话,
          // 输入框上的 chip 立刻就能显示实测到的真实模型名,不用刷新页面。
          void refreshModelMappings();
        }}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        activeModelAlias={activeSessionModel ?? claudeModel}
        contextUsedTokens={contextUsedTokens}
        onSelectProviderModel={selectProviderModel}
        onOpenKeySettings={handleOpenGatewaySettings}
      />
      </Suspense>
      )}
    </MergedMessagesContext.Provider>
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
