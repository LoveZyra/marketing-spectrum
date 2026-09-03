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

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatFindBar from './subcomponents/ChatFindBar';
import ChatComposer from './subcomponents/ChatComposer';
import ChangedFilesCard from './subcomponents/ChangedFilesCard';
import type { ChangedFilesState, ChangedFileEntry } from './subcomponents/ChangedFilesCard';
import CheckpointHistoryPanel from './subcomponents/CheckpointHistoryPanel';
import ChatWorkPanel from './subcomponents/ChatWorkPanel';
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
  recentSessions,
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

  const resetStreamingState = useCallback(() => {
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
    setCurrentSessionId,
    isLoadingSessionMessages,
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
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

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

  // On WebSocket reconnect, re-fetch the current session's messages from the
  // server so missed streaming events are shown, then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await sessionStore.refreshFromServer(selectedSession.id);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id)?.seq ?? 0,
        lastRunId: lastSeqRef.current.get(selectedSession.id)?.runId ?? null,
      }],
    });
  }, [selectedProject, selectedSession, sendMessage, sessionStore]);

  // dr:实时 changed_files 帧转的伪 Write 消息(本轮 Bash/python 写盘的文件
  // 即刻进工作面板,不等落库基线 refetch)。会话切换清空;刷新后由基线接管。
  const [liveChangedMessages, setLiveChangedMessages] = useState<ChatMessage[]>([]);

  // prism: reset the changed-files card when switching conversations.
  useEffect(() => {
    setChangedFiles(null);
    setLiveChangedMessages([]);
  }, [selectedSession?.id]);

  const handleChangedFiles = useCallback((payload: { sessionId: string | null; checkpointId: string | null; files: unknown[]; truncated?: boolean; cwd?: string | null }) => {
    const activeId = selectedSession?.id || currentSessionId || null;
    if (payload.sessionId && activeId && payload.sessionId !== activeId) return;
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
  const [serverQueued, setServerQueued] = useState<{ sessionId: string; preview: string; enqueuedAt: string } | null>(null);

  const handleServerQueueChange = useCallback(
    (sessionId: string, queued: { preview: string; enqueuedAt: string } | null) => {
      setServerQueued(queued ? { sessionId, ...queued } : (current) => (current?.sessionId === sessionId ? null : current));
    },
    [],
  );

  const handleCancelServerQueued = useCallback(() => {
    const target = serverQueued?.sessionId;
    if (!target) return;
    sendMessage({ type: 'chat.cancel-queued', sessionId: target });
  }, [serverQueued?.sessionId, sendMessage]);

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
    // 排队被中止带走时,正文退回输入框(只在当前正看着这条会话、且输入框为空时)。
    onServerQueueReturned: (sid, content) =>
      sid === (selectedSession?.id ?? currentSessionId) && restoreQueuedContent(content),
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
   * ef:首页空态时输入框搬到问候语下面(ChatEmptyState 的 composerSlot),
   * 不再钉在底部;其余时候仍在消息流下方。同一个元素、两个位置 —— 切换时会重挂,
   * 输入内容在 state 里,不丢。
   */
  const isHome =
    chatMessages.length === 0
    && !selectedSession
    && !currentSessionId
    && !isLoadingSessionMessages
    && !isProcessing;

  const composerElement = (
    <ChatComposer
      serverQueued={serverQueued && serverQueued.sessionId === (selectedSession?.id ?? currentSessionId) ? serverQueued : null}
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
      docUploadProgress={docUploadProgress}
      showFileDropdown={showFileDropdown}
      filteredFiles={filteredFiles}
      selectedFileIndex={selectedFileIndex}
      onSelectFile={selectFile}
      filteredCommands={filteredCommands}
      selectedCommandIndex={selectedCommandIndex}
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
          onRetryLastTurn={handleRetryLastTurn}
          isHome={isHome}
          composerSlot={isHome ? composerElement : null}
          recentSessions={recentSessions}
          onOpenSession={onNavigateToSession}
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

          {!isHome && composerElement}
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
        onSelectProviderModel={selectProviderModel}
      />
      </Suspense>
      )}
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
