import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';
import {
  initialWindowAfterLoadAll,
  revealBatch,
  visibleCountForTarget,
} from '../utils/messageWindow';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';

import { normalizedToChatMessages } from './useChatMessages';

import { emitToast } from '@/shared/view/ui/toastBus';

const MESSAGES_PER_PAGE = 20;
/**
 * 自动补页的上限与判定余量。
 *
 * 上限存在的意义是"取不满就停手",不是"取够就行" —— 30 轮 × 20 条 = 600 条,
 * 正常会话早就撑满视口了;真撑不满(整段都是被折叠的工具调用)也不能无限取下去,
 * 到顶就把「加载全部」浮层亮出来(surfaceLoadAllIfStuck),给个不靠滚动的出口。
 */
const AUTO_FILL_MAX_ROUNDS = 30;
const AUTO_FILL_SLACK_PX = 8;
/** 撞上"别人正在取下一页"时最多空转多少帧,超了就让位给用户。 */
const AUTO_FILL_MAX_WAITS = 60;
/** 判定"真的能滚了"之前,等布局落定的时间。 */
const AUTO_FILL_SETTLE_MS = 180;
const INITIAL_VISIBLE_MESSAGES = 100;
/**
 * dl:首屏分帧。切进长会话先只渲染尾部这批(秒开),随后一个 idle 回调把窗口
 * 放大到 INITIAL_VISIBLE_MESSAGES —— 增长发生在视口**上方**,跟底/守位控制器
 * 都吃得住,用户看不到任何跳动,只是"再往上翻已经有了"。
 */
const PHASE1_VISIBLE_MESSAGES = 30;
/** 离底部多近算"在底部"。和 isNearBottom 用同一个口径。 */
const FOLLOW_BOTTOM_SLACK_PX = 50;
/** 常量空数组:每次返回新的 `[]` 会让下游 useMemo 每轮都失效。 */
const EMPTY_STORE_MESSAGES: NormalizedMessage[] = [];

interface UseChatSessionStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isConnected: boolean;
  sendMessage: (message: unknown) => boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Highest live seq observed per session; sent as `lastSeq` on subscribe. */
  /** 每条会话的补发游标:记住它属于哪一轮,轮次一换就从头算。 */
  lastSeqRef: MutableRefObject<Map<string, { runId: string | null; seq: number }>>;
  sessionStore: SessionStore;
}


/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isInteractivePrompt) {
    return { ...base, kind: 'interactive_prompt', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its images immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * 只要会话在跑就允许中止 —— **故意不看 `canInterrupt`**。
 *
 * 自动压缩那条状态发的是 `canInterrupt: false`,而停止按钮只按 isLoading 渲染。
 * 两者一叠加,就出现了"按钮可见、可点、按下去什么都不发生、也没有任何反馈"。
 * 服务端 `handleChatAbort` 从不看这个字段,自动压缩那段还专门写了"压缩期间落地
 * 的中止要取消整个 run" —— 能力一直都在,只是被前端锁在门外。
 *
 * 立成规矩:界面任何时候都不允许进入一个没有出口的状态。
 */
export function canAbortActivity(activity: { canInterrupt?: boolean } | null): boolean {
  return activity !== null;
}

/**
 * 这个阶段中止会**连带丢掉刚发出的那条消息**。
 *
 * 压缩是在把用户消息推给 CLI **之前**做的,此时中止会走 `finishAborted()`,
 * 那条消息根本没被递交就没了;服务端还会 `dropPendingSend(sessionId, 'aborted')`。
 * 用户有权在按下去之前知道这件事,否则只会看到消息凭空消失。
 * `canInterrupt` 现在的唯一用途就是标出这类阶段。
 */
export function abortDiscardsPendingSend(activity: { canInterrupt?: boolean } | null): boolean {
  return activity !== null && activity.canInterrupt === false;
}


export function useChatSessionState({
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
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  // 补页彻底放弃、容器又滚不动时置真:此时「加载全部」浮层要**常驻**(不自动淡出),
  // 否则一个卡住的用户会眼睁睁看着唯一出口在 2.5 秒后消失。
  const [loadAllStuck, setLoadAllStuck] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wasNearTopRef = useRef(false);
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingSessionRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const scrollAnchorRef = useRef<{
    element: HTMLElement;
    /** 从**末尾**倒数第几行。前插不改变这个值,重挂载也不影响 —— 元素引用失效时靠它找回。 */
    indexFromEnd: number;
    /** 锚点顶边相对滚动容器顶部的偏移。 */
    offset: number;
    /** 记录这一刻的 scrollTop —— 下一次用它判断"是不是用户自己滚了"。 */
    scrollTop: number;
  } | null>(null);
  /** 前插内容前,让调用方声明「这一次的位移不是用户造成的」。 */
  const holdAnchorRef = useRef(false);
  /** 是否处于跟底模式。直接由滚动事件写,不经过 state —— state 落后一次 commit。 */
  const followBottomRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> AppContent -> MainContent -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    resetStreamingState();
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setLoadAllStuck(false);
    setViewHiddenCount(0);
    setSearchTarget(null);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    lastLoadedSessionKeyRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, onSessionIdle, resetStreamingState]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;
  /** 给搜索定位的重试循环看的"现在在看哪条会话"—— 换会话后旧循环要自行退出。 */
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null;
  /**
   * 只要在跑就能中止 —— **不看 `canInterrupt`**。
   *
   * 之前这里是 `isProcessing && sessionActivity.canInterrupt`,而自动压缩那条
   * 状态发的是 `canInterrupt: false`。后果是:停止按钮照常渲染(它只看 isLoading)、
   * 照常能点,`handleAbortSession` 第一行却直接 return —— **按钮可见、可点、
   * 什么都不做,也没有任何反馈**。而服务端 `handleChatAbort` 压根不看这个字段,
   * 自动压缩那段还专门写了"压缩期间落地的中止要取消整个 run"。
   * 也就是说服务端的中止逻辑是完整的,只是被前端锁在门外。
   *
   * 界面任何时候都不该进入一个没有出口的状态,所以这个闸门整个去掉。
   * `canInterrupt` 保留,但只用来提示**中止的代价**(见 abortDiscardsPending)。
   */
  const canAbortSession = canAbortActivity(sessionActivity);
  const abortDiscardsPending = abortDiscardsPendingSend(sessionActivity);

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Tell the store which session we're viewing so it only re-renders for this one
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionId !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionId;
    sessionStore.setActiveSession(activeSessionId);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : EMPTY_STORE_MESSAGES;
  /**
   * 正在打字的正文。它**不在** `storeMessages` 里(见 useSessionStore 的
   * `streamingText`),所以列表那条 useMemo 链在流式期间引用不变、整体跳过。
   */
  const streamingText = sessionStore.getStreamingText(activeSessionId);

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    /**
     * dv:上界从 `<` 放宽到 `<=`。
     *
     * `viewHiddenCount === all.length` 表示"回退到首条之前",本该一条都不显示;
     * 严格小于时这一支不成立,直接落到 `return all` —— **一条都不隐藏**,
     * 用户看到的是列表纹丝不动,像回退按钮失灵。
     */
    if (viewHiddenCount > 0 && viewHiddenCount <= all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [storeMessages, viewHiddenCount, pendingUserMessage]);

  // 搜索跳转要在 await 之后读**最新**的消息数组算窗口大小 —— 那时闭包里的
  // `chatMessages` 还是发起那一帧的旧值(新拉回来的整段历史不在里面)。
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    // 先砍窗口再滚:反过来的话滚动发生在旧 DOM 上,随后删掉顶部消息、
    // scrollHeight 缩水,浏览器再钳一次 scrollTop —— 白滚一次还多跳一下。
    // 砍完窗口这次 commit 会走控制器的跟底分支,不需要在这里手动滚。
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
      return;
    }
    scrollToBottom();
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;
      // 接上加载指示。此前 `setIsLoadingMoreMessages` 在整个 src/ 里只出现在
      // 声明处 —— 也就是说"正在加载更早的消息"永远不渲染,向上翻页零反馈,
      // 而这个恒 false 的值还占着几个依赖数组和判空,读代码会以为有保护。
      setIsLoadingMoreMessages(true);

      try {
        const slot = await sessionStore.fetchMore(selectedSession.id, {
          limit: MESSAGES_PER_PAGE,
        });
        if (!slot) {
          // fetchMore 现在会在失败时返回 null(以前是原样返回旧 slot,于是断网
          // 被当成"加载成功、只是没有新内容",这条会话从此不再自动跟底)。
          // 说一声再退出 —— 静默失败比失败本身更难查。
          emitToast({ message: '加载更早的消息失败,请稍后重试。', variant: 'error' });
          return false;
        }
        if (slot.serverMessages.length === 0) {
          if (!slot.hasMore) {
            setHasMoreMessages(false);
            allMessagesLoadedRef.current = true;
            setAllMessagesLoaded(true);
            if (loadAllOverlayTimerRef.current) {
              clearTimeout(loadAllOverlayTimerRef.current);
              loadAllOverlayTimerRef.current = null;
            }
            setShowLoadAllOverlay(false);
            setLoadAllStuck(false);
          }
          return false;
        }

        // 前插:声明这次位移不是用户造成的,控制器按上一帧的锚把视口校回原位。
        holdAnchorRef.current = true;
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        setVisibleMessageCount((prev) => prev + MESSAGES_PER_PAGE);
        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
          if (loadAllOverlayTimerRef.current) {
            clearTimeout(loadAllOverlayTimerRef.current);
            loadAllOverlayTimerRef.current = null;
          }
          setShowLoadAllOverlay(false);
          setLoadAllStuck(false);
        }
        return true;
      } finally {
        isLoadingMoreRef.current = false;
        setIsLoadingMoreMessages(false);
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  /**
   * 先把视口填满 —— 不然「向上滚动以加载更多」是一句做不到的指令。
   *
   * 加载更多**只由滚动事件驱动**。首屏取一页,但工具行会被合并成一条总览,
   * 一页 20 条最后可能只渲染出两三个 DOM 行 —— 撑不满容器就没有溢出,没有溢出
   * 就没有滚动条,没有滚动条就永远不会触发滚动事件,于是再也不会去取下一页。
   *
   * 实测过一个 694 条消息的会话:`scrollHeight === clientHeight === 712`,
   * 提示写着「显示 11 / 694 条消息 向上滚动以加载更多」,而**页面根本滚不动**,
   * 剩下 683 条永远加载不出来。这不是慢,是死锁。
   *
   * 所以每次内容变化后检查一次:还能往上取、但容器已经滚不动了,就自动再取一页,
   * 直到真的出现溢出(把方向盘交回给用户)或者取完为止。
   *
   * `autoFillRoundsRef` 是防跑飞的闸:万一某一页新增的消息一个 DOM 行都没多出来
   * (整页都是被折叠的工具调用),这个循环会一直"还是滚不动"。上限之内取不满,
   * 就停下把决定权交给用户 —— 他还有「加载全部」那条路。
   */
  const autoFillRoundsRef = useRef(0);
  const autoFillBusyRef = useRef(false);
  /** 循环认的"我还该为哪个会话干活";换会话或卸载时置空,循环自己看着退出。 */
  const autoFillSessionRef = useRef<string | null>(null);
  /** 内容缩回去、又变回滚不动时,靠它把循环重新叫起来。 */
  const [autoFillTick, setAutoFillTick] = useState(0);
  /**
   * 循环里不能闭包捕获 `loadOlderMessages` —— 它每次渲染都是新函数,
   * 捕获到的那个会连着一份过期的 `hasMoreMessages`。用 ref 取最新的那一个。
   */
  const loadOlderMessagesRef = useRef(loadOlderMessages);
  loadOlderMessagesRef.current = loadOlderMessages;

  const canScrollUp = useCallback(() => {
    const container = scrollContainerRef.current;
    return !!container && container.scrollHeight > container.clientHeight + AUTO_FILL_SLACK_PX;
  }, []);

  /**
   * 补页放弃时的兜底出口。
   *
   * 极端情形:视口很大、整段又都是被折叠的工具行,30 轮补页(600 条)仍撑不满
   * 容器 → 永远不出滚动条 → 永远不触发 scroll → 那条只在滚到顶时才冒出来的
   * 「加载全部」浮层也永远不出现,而「向上滚动以加载更多」提示又不可点。用户
   * 被彻底卡住,只能靠缩小窗口自救。所以补页一旦放弃、而容器仍滚不动、且还没
   * 取完,就主动把「加载全部」浮层亮出来 —— 给一个**不依赖滚动**的入口。
   */
  const surfaceLoadAllIfStuck = useCallback(() => {
    if (allMessagesLoadedRef.current) return;
    if (canScrollUp()) return;
    if (!scrollContainerRef.current) return;
    setShowLoadAllOverlay(true);
    setLoadAllStuck(true);
  }, [canScrollUp]);

  useEffect(() => {
    autoFillRoundsRef.current = 0;
    autoFillSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => () => {
    autoFillSessionRef.current = null;
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    if (isLoadingSessionMessages || autoFillBusyRef.current) return;
    if (!hasMoreMessages || allMessagesLoadedRef.current) return;

    /**
     * 循环由这里自己拿着,**不靠 effect 重入,也不被依赖变化打断**。
     *
     * 靠重入走不通:`sessionStore.fetchMore` 在 `return` 之前就 `notify()`,
     * React 立刻重渲染、effect 重入 —— 而那一刻上一轮的 `isLoadingMoreRef`
     * 还锁着,`loadOlderMessages` 直接空转返回,补一轮就停死。
     *
     * 靠 cleanup 里的 `cancelled` 收尾同样走不通,而且更隐蔽:取完一页后
     * `loadOlderMessages` 的身份变了,effect 先跑 cleanup(把循环判死),再重跑;
     * 重跑那一刻旧循环还停在 `await` 里没走到 `finally`,`autoFillBusyRef`
     * 仍是 true,新的一轮直接返回。两边互相让路,结果还是补一轮就停死
     * (实测:92 → 113 条之后再不动,等 32 秒也一样)。
     *
     * 所以退出条件只认会话:只要还停在同一个会话上,这个循环就一直是它的主人。
     */
    const sessionAtStart = activeSessionId;
    autoFillBusyRef.current = true;

    /** 等两帧,让新内容真的完成布局 —— 立刻量到的还是旧高度。 */
    const afterLayout = () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const settle = () => new Promise<void>((resolve) => {
      setTimeout(resolve, AUTO_FILL_SETTLE_MS);
    });

    void (async () => {
      try {
        let waits = 0;
        while (autoFillSessionRef.current === sessionAtStart) {
          if (!scrollContainerRef.current) return;

          /**
           * 「能滚了」得站得住脚才算数。补页过程中容器会短暂地高出来一点点
           * (加载提示、滚动位置恢复、markdown 二次排版都会),量到那一帧就收手,
           * 等它缩回去就又滚不动了 —— 实测量到 706 / 695 判定收工,
           * 落定后是 712 / 712,页面照样是死的。所以量到溢出先等一下再量一次,
           * 两次都站得住才真收手。
           */
          if (canScrollUp()) {
            await settle();
            if (autoFillSessionRef.current !== sessionAtStart) return;
            if (canScrollUp()) return;
          }

          if (autoFillRoundsRef.current >= AUTO_FILL_MAX_ROUNDS) { surfaceLoadAllIfStuck(); return; }
          if (allMessagesLoadedRef.current) return;

          /**
           * `isLoadingMoreRef` 是和用户滚动共用的一把锁 —— 补页途中恢复滚动位置
           * 会带出 scroll 事件,`handleScroll` 同样会去取下一页。撞上锁的时候
           * `loadOlderMessages` 只会返回 false,而那是"有人正在取",
           * 不是"没得取了" —— 当成后者就等于提前收工。
           * (实测:补到第 8 轮撞锁,循环就此停死,页面停在 92 / 360 条还是滚不动。)
           */
          if (isLoadingMoreRef.current) {
            waits += 1;
            if (waits > AUTO_FILL_MAX_WAITS) { surfaceLoadAllIfStuck(); return; }
            await afterLayout();
            continue;
          }
          waits = 0;

          autoFillRoundsRef.current += 1;
          const container = scrollContainerRef.current;
          if (!container) return;
          if (!(await loadOlderMessagesRef.current(container))) { surfaceLoadAllIfStuck(); return; }
          await afterLayout();
        }
      } finally {
        autoFillBusyRef.current = false;
      }
    })();
  }, [activeSessionId, autoFillTick, canScrollUp, hasMoreMessages, isLoadingSessionMessages, surfaceLoadAllIfStuck]);

  /**
   * 循环收工之后内容还可能再缩回去(工具行折叠、图片没占到位、窗口变大),
   * 那时又变成「有更多、但滚不动」。每次内容变化后落定再看一眼,
   * 还是滚不动就把循环重新叫起来 —— 轮次上限不跟着重置,所以不会没完没了。
   */
  useEffect(() => {
    if (isLoadingSessionMessages || !hasMoreMessages || allMessagesLoadedRef.current) return;
    const timer = setTimeout(() => {
      if (autoFillBusyRef.current || allMessagesLoadedRef.current) return;
      if (canScrollUp()) return;
      if (autoFillRoundsRef.current >= AUTO_FILL_MAX_ROUNDS) { surfaceLoadAllIfStuck(); return; }
      setAutoFillTick((n) => n + 1);
    }, AUTO_FILL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [canScrollUp, chatMessages.length, hasMoreMessages, isLoadingSessionMessages, surfaceLoadAllIfStuck]);

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);
    // 跟不跟底立刻定下来。**不能等 state** —— 流式期间每 ~100ms 一次 commit,
    // 用户刚滚上去而状态还没提交,那一帧就会拿着旧的 false 把视口钉回底部。
    followBottomRef.current = nearBottom;
    // 这里**不再取锚**:原来每个滚动事件都 querySelectorAll + 逐条 rect,
    // 拖动时 60~120Hz,几百条消息在 DOM 里就是滚不动。取锚交给控制器,
    // 它每次 commit 只做一次二分。

    const scrolledNearTop = container.scrollTop < 100;

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
      if (!wasNearTopRef.current) {
        wasNearTopRef.current = true;
        if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);

        setShowLoadAllOverlay(true);
        loadAllOverlayTimerRef.current = setTimeout(() => {
          setShowLoadAllOverlay(false);
          loadAllOverlayTimerRef.current = null;
        }, 2500);
      }
    } else if (!scrolledNearTop) {
      wasNearTopRef.current = false;
    }

    /**
     * 到顶就取下一页。
     *
     * 这里原来还有一把 `topLoadLockRef`:取过一页就锁上,**只有 scrollTop
     * 重新超过 20/100 才解锁**。而取完一页要靠滚动补偿把视口放回原处,
     * 补偿之后 scrollTop 落在哪儿是不定的 —— 一旦落在 20 以内,这把锁就
     * 再也解不开了。表现就是"向上滑没反应,必须先向下滑一下再向上滑,
     * 而且不一定成功"。
     *
     * 而它本来就是多余的:`loadOlderMessages` 开头已经有
     * `isLoadingMoreRef.current || isLoadingMoreMessages` 的重入保护,
     * 取完之后如果人还在顶上,再取一页正是应该的行为。
     */
    if (!allMessagesLoadedRef.current && scrolledNearTop) {
      await loadOlderMessages(container);
    }
  }, [hasMoreMessages, isNearBottom, loadOlderMessages]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    if (!searchScrollActiveRef.current) {
      setVisibleMessageCount(PHASE1_VISIBLE_MESSAGES);
    }
    wasNearTopRef.current = false;
    setIsUserScrolledUp(false);
    // 换会话:锚点和跟底状态都要重置,否则上一条会话的锚会被
    // "倒数第几行"恢复到新会话的列表里,把视口钉在一个毫无关系的位置。
    scrollAnchorRef.current = null;
    holdAnchorRef.current = false;
    followBottomRef.current = true;
    // dk:搜索定位的接力棒也要放下。此前换会话不清这两样,后果有两个:
    //  1. `searchScrollActiveRef` 挂着 true → 滚动控制器整段停摆(不跟底、不守位);
    //  2. 上一条会话的 findAndScroll 重试定时器还在跑,拿旧目标在**新会话**的
    //     DOM 里按"最接近的时间戳"乱找一个元素滚过去。
    searchScrollActiveRef.current = false;
    setSearchTarget(null);
  }, [selectedProject?.projectId, selectedSession?.id]);

  // Main session loading effect — store-based
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      if (currentSessionId && processingSessionsRef.current?.has(currentSessionId)) {
        return;
      }

      resetStreamingState();
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const subscribeToSelectedSession = () => {
      const sent = sendMessage({
        type: 'chat.subscribe',
        sessions: [{
          sessionId: selectedSessionId,
          lastSeq: lastSeqRef.current.get(selectedSessionId)?.seq ?? 0,
          lastRunId: lastSeqRef.current.get(selectedSessionId)?.runId ?? null,
        }],
      });
      // Only record the send time if the frame went out. Recording it for a
      // subscribe that never left the client would leave the ack handler
      // waiting on a reply nobody is going to send, so the processing
      // indicator would never reconcile. `isConnected` is in this effect's
      // deps, so the reconnect re-runs it and subscribes for real.
      if (sent) {
        statusCheckSentAtRef.current.set(selectedSessionId, Date.now());
      }
    };

    // Skip if already loaded and fresh
    if (lastLoadedSessionKeyRef.current === sessionKey && sessionStore.has(selectedSessionId) && !sessionStore.isStale(selectedSessionId)) {
      subscribeToSelectedSession();
      return;
    }

    // 切会话时**不清**流式缓冲。缓冲(accumulatedStreamRef / streamTimerRef)按
    // 会话分桶,各刷各的 store —— 之前这里 resetStreamingState() 是无差别全清,把
    // 后台还在流式的会话(比如 A 正在回答时切去 B)的累积文本一起截断了。切回
    // A 只剩碎片。全清只该发生在整体卸载 / 新建会话(那两处仍调用)。
    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(PHASE1_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setViewHiddenCount(0);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    setCurrentSessionId(selectedSessionId);

    // Subscribe to the session's live run (if any): the ack reconciles the
    // processing indicator, re-attaches a mid-flight stream to this socket,
    // and replays any live events missed since `lastSeq`. Recording the send
    // time lets the ack handler discard idle acks that a newer request has
    // since outdated.
    subscribeToSelectedSession();

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: MESSAGES_PER_PAGE,
      offset: 0,
    }).then(slot => {
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      setIsLoadingSessionMessages(false);
    });
  }, [
    resetStreamingState,
    selectedProject,
    selectedSession?.id,
    sendMessage,
    statusCheckSentAtRef,
    lastSeqRef,
    isConnected,
    sessionStore,
  ]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isProcessing) {
          // 刷新完不再自己排一发跟底:那个 200ms 定时器**没有 cleanup**,
          // 用户在这 200ms 内滚上去照样被拽回底部。跟底交给滚动控制器 ——
          // 它每次 commit 都跑,而且用户一滚就立刻交出控制权。
          await sessionStore.refreshFromServer(selectedSession.id);
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    isNearBottom,
    scrollToBottom,
    selectedProject,
    selectedSession,
    sessionStore,
    isProcessing,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
          try {
            // Load all messages into the store for search navigation
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              limit: null,
              offset: 0,
            });
            if (slot) {
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.total;
              setVisibleMessageCount((prev) =>
                visibleCountForTarget(chatMessagesRef.current, target, prev),
              );
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      // 只放开到**刚好盖住目标**的那一段,而不是整段进 DOM。定位不到时
      // visibleCountForTarget 会退回全长 —— 搜索跳转不能因为省 DOM 而跳不到。
      setVisibleMessageCount((prev) => visibleCountForTarget(chatMessagesRef.current, target, prev));

      const sessionAtStart = activeSessionIdRef.current;
      const findAndScroll = (retriesLeft: number) => {
        // 换会话了:这根接力棒作废。旧目标在新会话的 DOM 里按"最接近的时间戳"
        // 总能"找到"点什么 —— 那是往错误的地方滚。
        if (activeSessionIdRef.current !== sessionAtStart) {
          searchScrollActiveRef.current = false;
          return;
        }
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();
          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) { targetElement = el; break; }
            }
          }
        }

        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;
          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) { closestDiff = diff; targetElement = el; }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          searchScrollActiveRef.current = false;
        } else if (retriesLeft > 0) {
          setTimeout(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          searchScrollActiveRef.current = false;
        }
      };

      setTimeout(() => findAndScroll(15), 150);
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedProject || !selectedSession?.id) {
      setTokenBudget(null);
      return;
    }
    const fetchInitialTokenUsage = async () => {
      try {
        // The backend resolves the provider from the indexed session row.
        const url = `/api/projects/${selectedProject.projectId}/sessions/${selectedSession.id}/token-usage`;
        const response = await authenticatedFetch(url);
        if (response.ok) {
          setTokenBudget(await response.json());
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [selectedProject, selectedSession?.id]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  /**
   * dl:首屏第二帧 —— 主线程闲下来后把窗口从 PHASE1 放大到 INITIAL。
   * 增长的行出现在视口上方:跟底时底部纹丝不动;用户已上翻时先交锚
   * (holdAnchor),控制器按锚守位。搜索定位期间不插手,免得改到它刚算好的窗口。
   */
  useEffect(() => {
    if (isLoadingSessionMessages || !activeSessionId) return;
    if (searchScrollActiveRef.current) return;
    if (visibleMessageCount >= INITIAL_VISIBLE_MESSAGES) return;
    if (chatMessages.length <= visibleMessageCount) return; // 没有被窗口藏起来的行

    const grow = () => {
      holdAnchorRef.current = true;
      setVisibleMessageCount((prev) => Math.max(prev, INITIAL_VISIBLE_MESSAGES));
    };

    const idleWindow = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof idleWindow.requestIdleCallback === 'function') {
      const id = idleWindow.requestIdleCallback(grow, { timeout: 2000 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(grow, 400);
    return () => clearTimeout(timer);
  }, [activeSessionId, chatMessages.length, isLoadingSessionMessages, visibleMessageCount]);


  /**
   * 锚点:视口顶部那条消息 + 它距容器顶的偏移。
   *
   * **按元素锚,不按高度差锚。** 高度差那套(`newHeight - oldHeight`)只在
   * "一次 commit 里高度就到位"时成立;而这里的内容是分批落地的 ——
   * 代码高亮、mermaid、KaTeX 都在之后的帧里才撑开。前插 200 条时实测:
   * commit 那一刻只长了 6179px,随后又长了 15000+px,按高度差补的那一下
   * 只补了零头,用户照样被甩走。
   *
   * 浏览器原生的 `overflow-anchor` 本来能兜住,但**程序化写过 scrollTop 之后
   * 它会被抑制** —— 而守位本身就要写 scrollTop,自相矛盾。所以自己盯着一个
   * 真实元素,每次 commit 校一次,直到高度稳定。
   */
  const captureAnchor = useCallback((container: HTMLDivElement, rows: NodeListOf<HTMLElement>) => {
    if (rows.length === 0) {
      scrollAnchorRef.current = null;
      return;
    }
    // **二分**找视口顶部那条,不逐条 getBoundingClientRect。
    // 原来是线性扫 + 每条一次 rect —— 505 条消息在 DOM 里时,每个滚动事件都要
    // 做一遍强制布局,而拖动时滚动事件是 60~120Hz。那就是"滚不动"的直接原因。
    // offsetTop 在第一次刷新布局之后是缓存读,二分只要 ~9 次。
    const scrollTop = container.scrollTop;
    let lo = 0;
    let hi = rows.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const row = rows[mid];
      if (row.offsetTop + row.offsetHeight > scrollTop + 8) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    scrollAnchorRef.current = {
      element: rows[found],
      indexFromEnd: rows.length - 1 - found,
      offset: rows[found].offsetTop - scrollTop,
      scrollTop,
    };
  }, []);

  /**
   * 滚动控制器 —— **全局唯一**写 `scrollTop` 的地方。
   *
   * 以前这件事散在四个 effect 加一个 60 帧 rAF 循环里,互相踩:
   *
   * - 记录"变化前高度"的那个 effect **没有依赖数组**,每次渲染都跑,而且声明在
   *   跟底 effect **之前** —— 它先把基准刷成本次 commit **之后**的高度,
   *   跟底 effect 再去算 `heightDiff` 恒等于 0。「用户上翻时保持阅读位置」
   *   那段补偿代码**从来没生效过**。
   * - layout effect 先消费并清空 `pendingScrollRestoreRef`,passive effect 里
   *   那句 `|| pendingScrollRestoreRef.current` 守卫因此永远读到 null ——
   *   每次翻页都排一发 50ms 跟底,靠竞态侥幸取消。主线程忙一点就取消不掉,
   *   这就是"有时候翻页后突然弹到底、有时候又不弹"。
   * - 首屏跟底那个 rAF 循环逐帧无条件写 `scrollTop`,最长一秒 —— 这一秒里
   *   用户的滚轮被逐帧夺回。
   *
   * 现在合成一个 **layout effect**(绘制前写,不会有中间帧被看见),没有依赖数组
   * 所以每次 commit 都跑。只有两种常态:**跟底**(用户在底部)和**守位**
   * (用户上翻在读,盯着锚点元素校正)。首屏不再特殊对待 —— 刚进会话
   * `isUserScrolledUp` 本来就是 false,跟底模式自然把它钉在底部,而且用户
   * 一滚就立刻交出控制权。
   */
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // 搜索定位期间完全不插手 —— 平滑滚动还在跑,谁碰谁打断。
    if (searchScrollActiveRef.current) return;

    const rows = container.querySelectorAll<HTMLElement>('.chat-message');
    const anchor = scrollAnchorRef.current;
    const hold = holdAnchorRef.current;
    holdAnchorRef.current = false;

    /**
     * 用户自己动过没有?
     *
     * 判据是「容器现在的 scrollTop,和我们上次离开时留下的那个值,一不一样」。
     * 不一样就只可能是用户 —— 这时候**绝不能纠正**,否则就是跟用户抢方向盘:
     * 他往上滚一点、控制器把他拽回锚点,表现就是"滚不动、那几行固定在那里"。
     * 前插内容(翻页 / 看更早)会先置 `holdAnchorRef`,那种位移不算用户动的。
     */
    const userMoved = !hold && anchor !== null && Math.abs(container.scrollTop - anchor.scrollTop) > 1;
    if (userMoved) {
      followBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < FOLLOW_BOTTOM_SLACK_PX;
    }

    if (followBottomRef.current && rows.length > 0) {
      // 跟底。写在 layout 阶段,绘制前完成 —— 不会出现"先画在上面再跳下去"。
      container.scrollTop = container.scrollHeight;
    } else if (!userMoved && anchor) {
      // 守位:位移只可能来自 DOM 变化,把锚点校回它原来的偏移。
      // 元素可能被重挂载(前插一批会让列表整体重排),**倒数第几行**这个坐标
      // 前插不会改变,拿它把锚找回来。
      const row = anchor.element.isConnected
        ? anchor.element
        : rows[rows.length - 1 - anchor.indexFromEnd];
      if (row) {
        const target = row.offsetTop - anchor.offset;
        if (Math.abs(target - container.scrollTop) >= 1) {
          container.scrollTop = Math.max(0, target);
        }
      }
    }

    // 决策之后才重新取锚 —— 这一句必须留在最后。
    captureAnchor(container, rows);
  });

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  const loadAllMessages = useCallback(async () => {
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);
    setLoadAllStuck(false);
    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }

    const container = scrollContainerRef.current;

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
      });

      // du:换会话防护必须读 **ref**。原来比的是 `currentSessionId !==
      // requestSessionId` —— 两个值都在这次调用的闭包里冻结着且恒相等,
      // await 期间真的切走了也拦不住:A 的响应会把 hasMore=false /
      // allMessagesLoaded=true / A 的 total 全写进 B 的视图,B 只剩首页,
      // 「看更早 / 加载全部」双双消失,分页彻底死掉。
      if (activeSessionIdRef.current !== requestSessionId) {
        // 切走了:这次"加载全部"作废,把本地标记退回去,免得回到 A 时它以为
        // 已经全量在手(那会让「看更早」永久失效)。
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
        return;
      }

      if (slot) {
        if (container) {
          holdAnchorRef.current = true;
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.total;
        // 「加载全部」= 把整段历史**拉到本地**,不等于一次性全部进 DOM。先显示一
        // 批,剩下的交给「看更早的」/「全部展开」。
        setVisibleMessageCount(initialWindowAfterLoadAll);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          loadAllFinishedTimerRef.current = null;
        }, 2500);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
    // currentSessionId 不再是依赖:换会话判定改读 activeSessionIdRef(见上)。
  }, [selectedSession, selectedProject, isLoadingAllMessages, sessionStore]);

  /**
   * 前插内容之前先记锚点。
   *
   * 「看更早的」一次在**视口上方**插进 200 条,而 `chatMessages.length` 并没有变
   * —— 以前没有任何 effect 会因此触发,scrollTop 原地不动,用户瞬间被甩到几千
   * 像素之外。窗口类操作必须自己交锚点给控制器。
   */
  const anchorBeforeReveal = useCallback(() => { holdAnchorRef.current = true; }, []);

  const loadEarlierMessages = useCallback(() => {
    anchorBeforeReveal();
    setVisibleMessageCount(revealBatch);
  }, [anchorBeforeReveal]);

  /**
   * 「全部展开」:整段进 DOM 的**唯一**入口,而且要用户自己点。
   *
   * 上面那行「显示最近 N 条(共 M 条)」已经把代价摆在眼前了,想要 Ctrl+F 全文的
   * 人还是能拿到,只是不再由「加载全部」和搜索跳转顺手替他决定。
   */
  const expandAllMessages = useCallback(() => {
    anchorBeforeReveal();
    setVisibleMessageCount(Number.POSITIVE_INFINITY);
  }, [anchorBeforeReveal]);

  return {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
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
    loadAllMessages,
    expandAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    loadAllStuck,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
  };
}
