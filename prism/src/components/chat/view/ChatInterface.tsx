import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import PermissionContext from '../../../contexts/PermissionContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { ChatInterfaceProps, ChatMessage } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionStore } from '../../../stores/useSessionStore';
import { extractSessionChecklist } from '../utils/taskChecklist';
import { extractSessionOutputs } from '../utils/sessionOutputs';
import { turnOutputsFromServer } from '../utils/turnOutputs';
import { changedFilesToMessages } from '../utils/workFrames';
import { useSessionWorkFrames } from '../hooks/useSessionWorkFrames';
import {
  EMPTY_SERVER_QUEUE,
  queuedForSession,
  reduceServerQueue,
  type ServerQueueMap,
} from '../utils/serverQueue';
import { carryDraftKey, type SessionRemovedInfo } from '../utils/sessionRemoved';
import { safeLocalStorage } from '../utils/chatStorage';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatFindBar from './subcomponents/ChatFindBar';
import ChatComposer from './subcomponents/ChatComposer';
import ChangedFilesCard from './subcomponents/ChangedFilesCard';
import type { ChangedFilesState, ChangedFileEntry } from './subcomponents/ChangedFilesCard';
import CheckpointHistoryPanel from './subcomponents/CheckpointHistoryPanel';
import ChatWorkPanel from './subcomponents/ChatWorkPanel';
import SessionRemovedNotice from './subcomponents/SessionRemovedNotice';
/**
 * G3:斜杠命令的结果弹窗(/models、/cost 这类)带着模型卡片、实测按钮、一整套
 * 表格渲染,而它只在用户真的敲了斜杠命令时才出现 —— 打包进聊天主块等于让每个人
 * 在首屏为一个多数会话里根本不会打开的弹窗付费。
 */
const CommandResultModal = lazy(() => import('./subcomponents/CommandResultModal'));

function ChatInterface({
  selectedProject,
  selectedSession,
  isConnected,
  sendMessage,
  onFileOpen,
  isEditorOpen = false,
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
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  // 流式缓冲与定时器都**按会话分桶**。此前是单个共享缓冲 + 单个定时器,
  // 两条 run 同时向本浏览器推流时 token 会交错进同一个缓冲,当前会话气泡
  // 就会短暂显示另一段对话的字(complete 后才自愈)。分桶后各刷各的。
  const streamTimerRef = useRef<Map<string, number>>(new Map());
  const accumulatedStreamRef = useRef<Map<string, string>>(new Map());
  // prism: latest post-turn changed-files summary (git checkpoint feature).
  const [changedFiles, setChangedFiles] = useState<ChangedFilesState | null>(null);
  // Prism: checkpoint history drawer visibility.
  const [showCheckpoints, setShowCheckpoints] = useState(false);
  // F1:会话内查找条(Ctrl+F)。
  const [findBarOpen, setFindBarOpen] = useState(false);
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, { runId: string | null; seq: number }>());
  /**
   * fj:重连补订要读"哪些会话在跑",但这个值不该让 `handleWebSocketReconnect`
   * 每轮换一次身份(它是 WebSocketContext 的 onReconnect 依赖)。
   */
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  /**
   * 清流式缓冲。**不传 sessionId 就是全清** —— 只有整体卸载才该那样。
   *
   * fj:此前只有全清一种。而 `updateStreaming` 是**整体替换**语义,它依赖累积
   * 缓冲一直是"从头到现在的全文";缓冲被清空后,后台会话的下一批 delta 从空串
   * 开始累积,`stream_end` 时那一小段残片就被当成完整回答提交进 realtime。
   *
   * 触发路径很日常:A 正在流式输出时点侧栏的**项目行**(或「新建会话」、
   * 或删掉当前查看的另一条会话)—— 都会让 `selectedSession` 变 null,走进
   * `useChatSessionState` 那个通用分支。同一文件的注释早就写明"全清只该发生在
   * 整体卸载 / 新建会话",但那个调用点并不是新建会话。
   *
   * 切回 A 看到的是一条**残缺的**助手气泡;而服务端那份完整的随后又被拉回来,
   * 两份并排,且因为正文不一致,`pruneRealtimeSupersededByServer` 也清不掉它。
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
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    // fi:用 markSessionEstablished 而不是裸 setCurrentSessionId —— 要记下
    // "这个 id 是本视图建立的",路由跟上之前才有资格撑着正文(见 useChatSessionState)。
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
   * gk:「这条会话已被删除」态,按会话分键。
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
     * 要带走的可能是两段:输入框里正在打的,和**切态时排队卡上那条**
     * (回合跑着时回车排进去的那句;切态会把它从盘上清掉,所以由 info 带过来)。
     * 两段都有就都带上 —— 丢掉任何一段都是"我明明打了字"。
     */
    const parts = [viewedRemovedInfo?.queuedText ?? '', input].map((part) => part.trim()).filter(Boolean);
    const draft = parts.join('\n\n');
    const key = carryDraftKey(selectedProject.projectId);
    if (draft && key) safeLocalStorage.setItem(key, draft);
    onStartNewSession(selectedProject);
  }, [input, onStartNewSession, selectedProject, viewedRemovedInfo?.queuedText]);

  // On WebSocket reconnect, re-fetch the current session's messages from the
  // server so missed streaming events are shown, then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await sessionStore.refreshFromServer(selectedSession.id);

    /**
     * fj:补订**所有本客户端知道在跑的会话**,不只是当前查看的那条。
     *
     * 服务端的推流集合是按 socket 记的(`sessionViewers`,socket 一关就摘除),
     * 所以新 socket 对后台正在跑的会话**不再是 viewer** —— 那条会话的实时帧从此
     * 收不到,一直到用户切进去时主 effect 才重新订阅并靠 `lastSeq` 补发。
     * 表现是"在跑但没输出"(转圈全靠 5 秒轮询撑着)。
     *
     * `chat.subscribe` 的 `sessions` 本来就是数组,一并带上即可。
     */
    const targets = new Map<string, { sessionId: string; lastSeq: number; lastRunId: string | null }>();
    const track = (sessionId: string) => {
      if (!sessionId || targets.has(sessionId)) return;
      targets.set(sessionId, {
        sessionId,
        lastSeq: lastSeqRef.current.get(sessionId)?.seq ?? 0,
        lastRunId: lastSeqRef.current.get(sessionId)?.runId ?? null,
      });
    };
    track(selectedSession.id);
    for (const sessionId of processingSessionsRef.current?.keys() ?? []) track(sessionId);

    /**
     * fj:只在**确认送达**之后才记发送时刻。
     *
     * `statusCheckSentAtRef` 的用途是"丢弃比这次请求更早的 idle ack";无条件记
     * 就等于在等一个不会来的 ack。同一件事在 `useChatSessionState` 里专门写了
     * `if (sent)` 并附了注释,这里破坏了同一个不变量 —— 而且这行在
     * `await refreshFromServer` 之后执行,那段 await 期间 socket 完全可能又断了。
     */
    const sent = sendMessage({ type: 'chat.subscribe', sessions: [...targets.values()] });
    if (sent) {
      const now = Date.now();
      for (const sessionId of targets.keys()) statusCheckSentAtRef.current.set(sessionId, now);
    }
  }, [selectedProject, selectedSession, sendMessage, sessionStore]);

  // dr:实时 changed_files 帧转的伪 Write 消息(本轮 Bash/python 写盘的文件
  // 即刻进工作面板,不等落库基线 refetch)。会话切换清空;刷新后由基线接管。
  const [liveChangedMessages, setLiveChangedMessages] = useState<ChatMessage[]>([]);

  // prism: reset the changed-files card when switching conversations.
  useEffect(() => {
    setChangedFiles(null);
    setLiveChangedMessages([]);
    // fj:依赖要含 currentSessionId —— 新会话页上 `selectedSession?.id` 恒为
    // undefined,只靠它这个 effect 永远不会重跑。
  }, [selectedSession?.id, currentSessionId]);

  const handleChangedFiles = useCallback((payload: { sessionId: string | null; checkpointId: string | null; files: unknown[]; truncated?: boolean; cwd?: string | null }) => {
    const activeId = selectedSession?.id || currentSessionId || null;
    /**
     * fj:归属不明或不匹配**一律丢弃**。
     *
     * 原来是 `payload.sessionId && activeId && payload.sessionId !== activeId` ——
     * `activeId` 为 null(新会话页)时整个条件短路成假,**帧被放行**。于是停在
     * 空白的新会话页上,后台某条会话跑完一轮,这里就冒出「本轮改动的文件」卡片,
     * 右侧工作面板的产出里列着另一条对话写的文件,点进去还能直接打开。
     * 而下面那个清空 effect 只依赖 `selectedSession?.id`(此时恒为 undefined),
     * 也不会把它清掉。
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
   * F7:服务端排队中的那条消息(每会话至多一条)。
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
    /**
     * B4:取消的是**正在看的**这条会话的排队,不是"状态里存着的那条"。
     *
     * 原来读的是 `serverQueued.sessionId` —— 卡片渲染出来之后、点下去之前
     * 若有一帧别的会话的 queued 落地,状态就换成了那一条,这一点取消的是
     * 另一条会话排队中的消息。
     */
    if (!viewedSessionId) return;
    sendMessage({ type: 'chat.cancel-queued', sessionId: viewedSessionId });
  }, [viewedSessionId, sendMessage]);

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
    onSendAcked: handleSendAcked,
    // 排队被中止带走时,正文退回输入框(只在当前正看着这条会话、且输入框为空时)。
    onServerQueueReturned: (sid, content) =>
      sid === (selectedSession?.id ?? currentSessionId) && restoreQueuedContent(content),
    onSessionRemoved: handleSessionRemoved,
    onSessionRestored: handleSessionRestored,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      // 这个监听挂在 document 的 capture 阶段、且注册得早,所以它比弹层/面板自己
      // 的 Esc(冒泡阶段)先跑,`defaultPrevented` 这时还是 false —— 于是在"Skip·Esc"
      // 的问答面板里、或 /models 这类弹窗里按 Esc,会直接把整轮 run 中止掉。
      // 有它们在场就放行,让各自的 Esc 生效,不抢。查找条同理。
      if (document.querySelector('[role="dialog"], [data-interactive-prompt="true"], [data-find-bar-open="true"]')) {
        return;
      }

      // gq:**行内改名的输入框同理,但判据是事件源不是"在不在场"。**
      // 侧栏改项目名/会话名、文件树改文件名时按 Esc,本意是"取消这次改名";
      // 而它们既不是 dialog 也没有遮罩,上面那条拦不住 —— 于是一边取消了改名,
      // 一边把正在跑的那一轮也中止了(`canAbortSession` 为真时必然发生)。
      // 用 closest 而不是 querySelector:别的地方开着改名框,不该影响你在
      // 输入框外按 Esc 中止本轮。
      const from = event.target as HTMLElement | null;
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
  }, [canAbortSession, handleAbortSession]);

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

  // ChatComposer 做了 memo,下面这些原本写成内联箭头/内联表达式的 props 得
  // 收敛成稳定引用,否则每次流式 tick 都会击穿浅比较,memo 白做。
  const handleRemoveImage = useCallback((index: number) => {
    setAttachedImages((previous) => previous.filter((_, currentIndex) => currentIndex !== index));
  }, [setAttachedImages]);

  const handleSelectEffort = useCallback((nextEffort: string) => {
    setStoredProviderEffort(provider, nextEffort);
  }, [setStoredProviderEffort, provider]);

  const handleShowCheckpoints = useCallback(() => setShowCheckpoints(true), []);

  const activeModelReal = useMemo(() => {
    // 优先级:新鲜的实测(端到端真相)> 配置映射(读 settings,随改随新)。
    // 实测过期时不用它 —— 但配置映射恰恰在这时是新值,正好补位。
    const alias = activeSessionModel ?? claudeModel;
    const probed = modelMappingsStale ? null : (modelMappings[alias]?.actualModel ?? null);
    return probed ?? modelConfigMappings[alias]?.configuredModel ?? null;
  }, [activeSessionModel, claudeModel, modelMappingsStale, modelMappings, modelConfigMappings]);

  const effectiveFrequentCommands = useMemo(
    () => (commandQuery ? [] : frequentCommands),
    [commandQuery, frequentCommands],
  );

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  // do/dq:右侧工作面板的数据。基线 = 服务端从**全量历史**滤出的工具帧
  // (修长会话刷新后首屏只有尾 20 条、清单与产出凭空变少的问题);实时增量 =
  // 已加载消息窗口。两段直接拼接 —— 折叠函数对重放幂等,重叠段不会算错。
  const {
    baseMessages: workBaseMessages,
    revertedPaths: workRevertedPaths,
    turnOutputs: serverTurnOutputsRaw,
    truncated: workHistoryTruncated,
    refresh: refreshWorkFrames,
  } = useSessionWorkFrames(
    selectedSession?.id || currentSessionId || null,
    isProcessing,
  );
  /**
   * ej:对话正文下面那张「产出」卡的数据,来自**服务端按全量历史算好的**回合
   * 映射(不是从当前消息窗口现推)。展示名要项目根,所以在这里落地成卡片形状。
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
  const latestTodos = useMemo(() => extractSessionChecklist(workMessages), [workMessages]);
  // dt:折叠完再按"已回滚"集合做减法 —— 窗口里的旧 Write 帧会把已回滚的
  // 文件加回来,基线单删不够;回滚后重写的文件不在集合里,照常显示。
  const sessionOutputs = useMemo(() => {
    const outputs = extractSessionOutputs(workMessages);
    return workRevertedPaths.size > 0
      ? outputs.filter((file) => !workRevertedPaths.has(file.path))
      : outputs;
  }, [workMessages, workRevertedPaths]);

  if (!selectedProject) {
    // This used to be a four-way ternary over `provider`. Claude is the only
    // provider left, so the label is a single lookup.
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
   * 首页空态判定。ef 曾用它把输入框搬进空态(composerSlot);ex 还原版式后
   * 输入框始终在消息流下方,这里只剩下"给滚动容器铺点阵画布 + 居中"这一个用途。
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
      pendingPermissionRequests={pendingPermissionRequests}
      handlePermissionDecision={handlePermissionDecision}
      handleGrantToolPermission={handleGrantToolPermission}
      isLoading={isProcessing}
      onAbortSession={handleAbortSession}
      abortDiscardsPending={abortDiscardsPending}
      activeModel={activeSessionModel ?? claudeModel}
      activeModelReal={activeModelReal}
      permissionMode={permissionMode}
      onSelectMode={selectPermissionMode}
      availablePermissionModes={availablePermissionModes}
      effort={currentProviderEffort}
      availableEffortOptions={currentProviderEffortOptions}
      onSelectEffort={handleSelectEffort}
      onShowModelPicker={showModelsModal}
      onShowCheckpoints={handleShowCheckpoints}
      onToggleCommandMenu={handleToggleCommandMenu}
      onSubmit={handleSubmit}
      isDragActive={isDragActive}
      queuedDraft={queuedDraft}
      onEditQueuedDraft={editQueuedDraft}
      onDeleteQueuedDraft={deleteQueuedDraft}
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
      {/* do:对话区分两栏 —— 左边消息流 + 输入框,右边 Cowork 式工作面板
          (上任务清单、下产出文件)。面板两块都空时自己不渲染,布局即回到单栏。 */}
      <div className="flex h-full min-h-0">
      {/* dy:正文自己的下限 —— 低于这个数输入框就没法用了。
          这 280 和 EditorSidebar 的 MIN_CHAT_BODY_WIDTH 是**同一个数**,必须
          一起改:那边按它给预览栏发宽度,这边是硬约束。以前这里是 min-w-0,
          预览栏一开正文就被压到 0(输入框塌成一条竖着堆芯片的窄条)。 */}
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
                // dt:回滚/还原落了 files_reverted 反向帧 —— 重拉基线,
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
          onClose={() => setShowCheckpoints(false)}
          onReverted={() => {
            const activeId = selectedSession?.id || currentSessionId;
            if (activeId) void sessionStore.refreshFromServer(activeId);
            // dt:历史抽屉回滚同样落了反向帧 —— 面板一并对齐。
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
        onSelectProviderModel={selectProviderModel}
      />
      </Suspense>
      )}
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
