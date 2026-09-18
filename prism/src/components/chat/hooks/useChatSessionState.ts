import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStatus, SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';
import {
  EMPTY_SPOT_MEMORY,
  EMPTY_WINDOW_MEMORY,
  beginScrollRestore,
  initialWindowAfterLoadAll,
  isUserInitiatedScroll,
  recallSessionWindow,
  rememberReadingSpot,
  rememberSessionWindow,
  revealBatch,
  stepScrollRestore,
  visibleCountForTarget,
  type ScrollRestoreState,
  type SessionSpotMemory,
  type SessionWindowMemory,
} from '../utils/messageWindow';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';
import { shouldKeepOrphanedSessionView } from '../utils/sessionViewGuard';

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
  resetStreamingState: (sessionId?: string | null) => void;
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

export function chatMessageToNormalized(
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
    return {
      ...base,
      kind: 'error',
      content: msg.content || '',
      // ga:本地提示的标记要带过去(见 NormalizedMessage.isLocalNotice)。
      ...(msg.isLocalNotice ? { isLocalNotice: true } : {}),
    } as NormalizedMessage;
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
 * B3:**一条会话的正文此刻处于什么状态** —— 由槽位派生,不再由本地布尔量拼。
 *
 * 原来只有一个 `isLoadingSessionMessages`(视图级 `useState`),而"这条会话的
 * 历史到底加载到哪一步"是**每条会话各自**的事。两者不匹配的地方全是 bug:
 *
 *   - `unknown` 与 `empty` 分不开:槽位还没落地时 `chatMessages.length === 0`,
 *     渲染分支直接落到「起始卡片」——空会话与"还没开始加载"长得一模一样,
 *     切会话的第一帧因此闪一下起始卡片再变成加载中;
 *   - `error` 与 `empty` 也分不开:首屏拉取失败之后 loading 置回 false,
 *     于是一条 5000 条的会话渲染成"这里还没有消息,开始聊天吧" —— 用户没有
 *     任何线索知道那是一次网络失败,更没有重试入口;
 *   - 布尔量由 `await` 之后的落地代码写,每一处都得自带换会话守卫,而其中
 *     一处(离开会话到新会话页)当初就漏了,新会话页永久卡在「正在加载」。
 *
 * 派生之后这三件事都不成立:状态只有一个来源,而且天然按会话隔离。
 */
export type ChatViewState = 'unknown' | 'loading' | 'ready' | 'empty' | 'error';

export function deriveChatViewState(
  sessionId: string | null,
  slot: { status: SessionStatus; fetchedAt: number; merged: unknown[] } | undefined,
): ChatViewState {
  // 新会话页:没有会话,也就没有历史要等。
  if (!sessionId) return 'ready';
  if (!slot) return 'unknown';
  /**
   * `fetchedAt > 0` = **这条会话至少落地过一页**。此后不再回到 loading:
   * 刷新与补页都在已有内容之上进行,把整屏换成 shimmer 只会让人以为内容没了。
   */
  if (slot.fetchedAt > 0) return slot.merged.length === 0 ? 'empty' : 'ready';
  if (slot.status === 'error') return 'error';
  if (slot.status === 'loading') return 'loading';
  /**
   * 槽位建了但一页都还没拉过(实时帧先到、或 effect 还没跑)。算 `unknown` ——
   * 调用方按"还在等"渲染,而不是按"空的"。**空会话必须先落地过一页才算空。**
   */
  return 'unknown';
}

/**
 * 补一页更早的历史之后,这一页到底算什么。
 *
 * B2 把它单拎出来是因为原来的判据**测的是另一件事**:
 * `slot.serverMessages.length === 0` 是**累计**已加载条数,只有空会话才成立
 * —— 也就是说"这一页什么也没带回来"这个状态从来没被识别过。
 *
 * 而它是会发生的:流式期间新行不断落盘,补页按"已加载条数"算 offset 从尾部
 * 取页,取回来的这一页可能与已加载窗口完全重叠(去重后净增 0),服务端却仍然
 * 报 `hasMore: true`。此时若把它当成"加载成功",自动补页会认为自己在前进,
 * 一路打满 30 次请求、界面一动不动、一声不吭。
 *
 * 四种结局各自要做的事不同,所以分成四个名字而不是一个 boolean:
 *   - `failed`    请求失败(fetchMore 返回 null)→ 提示用户,别改任何分页状态
 *   - `exhausted` 一条没多,服务端也说没有了 → 收尾:「全部到手」
 *   - `stalled`   一条没多,服务端却说还有 → **不算成功**,停下,别再自动补
 *   - `loaded`    真的多出来了 → 前插、放开可见窗口
 */
export type OlderPageResult = 'failed' | 'exhausted' | 'stalled' | 'loaded';

export function classifyOlderPage(
  slot: { serverMessages: unknown[]; hasMore: boolean } | null | undefined,
  loadedBefore: number,
): OlderPageResult {
  if (!slot) return 'failed';
  const gained = slot.serverMessages.length - loadedBefore;
  if (gained > 0) return 'loaded';
  return slot.hasMore ? 'stalled' : 'exhausted';
}

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
  /**
   * fi:`currentSessionId` 是不是**本视图自己刚建立的**(新会话页上发第一条消息、
   * 会话网关分配了 id、路由还没跟上)。只有这种来源的 id,在 `selectedSession`
   * 为空时才允许继续撑着正文;从别的会话切走时留下的 id 一律不算。
   *
   * ## 这个 ref 存在的原因(线上截图)
   *
   * 正文渲染看的是 `activeSessionId = selectedSession?.id || currentSessionId`。
   * 下面那个 effect 在 `selectedSession` 变空时本该把 `currentSessionId` 清掉,
   * 但它有一条例外:"这条会话还在跑就别清"—— 本意是保护刚建的会话(路由跟上之前
   * 不能把正文清空)。可它的判据是**在不在跑**,不是**从哪来的**:
   *
   *   用户在会话 A 上(A 正在跑)→ 点项目行 / 切项目 → `handleProjectSelect`
   *   把 selectedSession 置空、navigate('/'),**但不 bump newSessionTrigger**
   *   → effect 进 `!selectedSession` 分支 → 例外看到 A 在跑 → 不清
   *   → 标题按 selectedSession 显示「新会话」,正文按 currentSessionId 继续渲染 A,
   *     而且随 A 的流式一直更新。
   *
   * 三个条件缺一不可(A 正在跑、从 A 切走、走的是不 bump trigger 的那条路),
   * 所以只有那个用户的浏览器里出现,root 新开页面看不到。判据换成"是不是本视图
   * 建立的",刚建的会话照旧保护,切走留下的残留一律清。
   */
  const establishedHereRef = useRef<string | null>(null);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
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
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  /**
   * 换会话时要把**离开那一刻**的窗口记下来,而 `visibleMessageCount` 是 state:
   * effect 闭包里那份是上一次 commit 的值。记账走 ref。
   */
  const visibleMessageCountRef = useRef(INITIAL_VISIBLE_MESSAGES);
  /** 按会话记住的渲染窗口(见 messageWindow.ts 里的 recallSessionWindow)。 */
  const sessionWindowMemoryRef = useRef<SessionWindowMemory>(EMPTY_WINDOW_MEMORY);
  /**
   * 按会话记住的**阅读位置**。与上面那张表分开:位置每次 commit 都在写,
   * 窗口只在离开那一刻写一次 —— 合成一张就是"同一条记录两个写者"。
   */
  const sessionSpotMemoryRef = useRef<SessionSpotMemory>(EMPTY_SPOT_MEMORY);
  /** 正在进行的位置恢复(等行落地);null = 没有要恢复的。 */
  const scrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  /** 等待恢复的这段时间里,用户自己滚过没有 —— 滚过就放弃恢复(见 stepScrollRestore)。 */
  const scrollRestoreUserMovedRef = useRef(false);
  /**
   * ga:控制器**自己**最后写进去的那个 scrollTop —— 写完立刻读回(浏览器会夹到
   * 合法区间,写进去的值和落定的值不一定一样)。
   *
   * fz 那条"等待恢复期间只要有滚动事件就是用户滚的"判据,理由写的是「恢复期间
   * 我们一个 scrollTop 都不写」—— **这句话是错的**:恢复挂在 `wait` 上时
   * `followBottom` 仍是 true,下面跟底那一句每次 commit 都在写。于是只要恢复
   * 需要等超过一帧,就必然被自己写出去的滚动事件掐死 —— 这个功能实际从未生效。
   *
   * 现在拿这个值当基准:滚动事件的落点跟它一致 = 那一下是我们自己写的。
   */
  const programmaticScrollTopRef = useRef<number | null>(null);
  /** ga:上一次 commit 时容器可见吗 —— 由不可见变可见的那一帧要特殊对待(见控制器)。 */
  const containerWasVisibleRef = useRef(true);
  /** 当前会话键 —— 恢复与记录都要比对它,免得把 A 的位置落到 B 身上。 */
  const viewSessionKeyRef = useRef<string>('');
  // 渲染期同步 —— 与 isProcessingRef 同一套写法。逐个 setter 旁边手动维护
  // 迟早会漏一处(allMessagesLoadedRef 就是那么维护的,已经有 12 个写点)。
  visibleMessageCountRef.current = visibleMessageCount;
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
  /** gi:「回到底部」点下去那一次 commit 的强制跟底(见控制器里的说明)。 */
  const forceFollowBottomOnceRef = useRef(false);
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * N05:**已经拉过首屏的会话集合**,不是"上一次拉的那一条"。
   *
   * 原来这里是单个 key,判据是"当前 key 与它相等"。A→B→A 时它已经是 B 的 key,
   * 于是回到 A 走了完整的重新加载分支:A 那 5000 条(用户刚点过「加载全部」)
   * 被一次 `limit=20` 的首屏拉取**整份换掉**,只剩最后 20 条。用户看到的是
   * "我刚加载的全部消息又没了"。
   *
   * 换成集合之后,回到 A 只要槽位还在且没过期就直接复用 —— 不重新拉页。
   * 集合本身不需要清理:短路条件里还有 `sessionStore.has(id)`,槽位被 LRU
   * 淘汰之后这里自然重新拉。
   */
  const loadedSessionKeysRef = useRef(new Set<string>());
  /** 上一次**看的**是哪条(与"拉过没有"是两回事:换会话要重置窗口,哪怕不用重拉)。 */
  const lastViewedSessionKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> AppContent -> MainContent -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  /**
   * fz:把**正要离开的那条会话**的窗口记下来。
   *
   * 保存原来只写在"会话 → 会话直切"那一条路上(判据是 `leavingKey`),而点项目行、
   * 点「新建会话」都会先提交一次 `selectedSession = null`、把 `leavingKey` 清成
   * null —— 那两条路一次都不保存。于是"A → 项目行 → A"回来时窗口砍回 30,
   * 而阅读位置表(每次 commit 都在写)还记着几百行之外的位置,两张表对不上,
   * 恢复只能等到宽限用完再放弃。
   *
   * 收成一个函数,三处调用(直切、回首页、新建会话)——
   * 这一轮的教训就是"同一件事写在一部分入口上"。
   */
  const rememberLeavingWindow = useCallback((leavingKey: string | null) => {
    if (!leavingKey) return;
    sessionWindowMemoryRef.current = rememberSessionWindow(
      sessionWindowMemoryRef.current,
      leavingKey,
      {
        visibleCount: visibleMessageCountRef.current,
        allLoaded: allMessagesLoadedRef.current,
      },
    );
  }, []);

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
    /**
     * fl:**离开视图不清任何流式缓冲。**
     *
     * fj 把无差别全清收窄成"只清这一条",但那一条正是**刚离开的、很可能还在
     * 后台跑的**会话 —— 于是问题反而更精准地打在了它身上:后续 delta 从空串
     * 重新累积,而 `updateStreaming` 是全文替换语义,`stream_end` 时那半截被
     * 当成完整回答提交;切回去看到的是一条残缺气泡,而服务端那份完整的随后
     * 又被拉回来,两份并存且内容不同,连 prune 都清不掉。
     *
     * 缓冲的生命周期本来就由流自己管:`stream_end` / `complete` 各自
     * `delete(sid)`(见 useChatRealtimeHandlers)。视图切换与它无关,
     * 全清只保留在整体卸载那一处。
     */
    setCurrentSessionId(null);
    establishedHereRef.current = null;
    setPendingUserMessage(null);
    
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
    loadedSessionKeysRef.current.clear();
    // fz:新建会话也是"离开当前这条" —— 窗口照记(见 rememberLeavingWindow)。
    rememberLeavingWindow(lastViewedSessionKeyRef.current);
    lastViewedSessionKeyRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
    // rememberLeavingWindow 是 useCallback([], …),引用恒定,进依赖不会让 effect 多跑。
  }, [newSessionTrigger, onSessionIdle, rememberLeavingWindow, resetStreamingState]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  /**
   * 新会话页上第一条消息发出、网关分配了 id 之后由 ChatInterface 调用。
   * 和裸 `setCurrentSessionId` 的区别只有一个:记下"这个 id 是本视图建立的",
   * 见 establishedHereRef。
   */
  const markSessionEstablished = useCallback((sessionId: string) => {
    establishedHereRef.current = sessionId;
    setCurrentSessionId(sessionId);
  }, []);

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  /**
   * B2:**分页状态不再镜像进本地 state,直接从槽位读。**
   *
   * 原来 `hasMoreMessages` / `totalMessages` 是两个 `useState`,由 11 处
   * `await` 之后的落地代码各自写一遍,每一处都得自带一句「期间会话切了没」
   * 的守卫 —— 少写一处,A 会话的 `hasMore=false` 就写进 B 的视图,B 的
   * 「看更早 / 加载全部」一起消失,而且**没有任何后续事件会把它改回来**
   * (fi 修过一次落地竞态、fj 又修过一次,都是同一个形状)。
   *
   * 槽位本来就是这两个值的唯一真相,而 `getMessages` 早就是这么读的
   * (见下面的 `storeMessages`)。改成派生之后:
   *   - 落地代码少 11 处写入,守卫漏写这件事从"可能"变成"不可能";
   *   - 切回一条读过的会话立刻知道还有没有更早的,不必等一次网络往返;
   *   - 未落地的会话没有槽位 → `false / 0`,与原来的初始值一致。
   *
   * `messagesOffsetRef` 同时删掉:它有 5 处写入、**零处读取**,
   * 真正的游标一直在 `slot.offset` 上(见 applyServerSnapshot)。
   */
  const viewSlot = activeSessionId ? sessionStore.getSessionSlot(activeSessionId) : undefined;
  const hasMoreMessages = viewSlot?.hasMore ?? false;
  const totalMessages = viewSlot?.total ?? 0;

  /**
   * B3:加载态同样派生。`unknown` 也算"在等" —— 槽位还没建起来的那一帧
   * 若按"空的"渲染,就会闪一下起始卡片。
   */
  const chatViewState = deriveChatViewState(activeSessionId, viewSlot);
  const isLoadingSessionMessages = chatViewState === 'loading' || chatViewState === 'unknown';
  /** 给搜索定位的重试循环看的"现在在看哪条会话"—— 换会话后旧循环要自行退出。 */
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  /** fj:同上 —— 主加载 effect 要读它,但它不该让 effect 重跑。 */
  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  /**
   * fj:`pendingUserMessage` 暂存时路由选中的是哪条会话(新会话页为 null)。
   * 冲队时靠它判归属 —— 否则那条消息会被灌进用户接下来打开的**任意**一条会话,
   * 而且 `kind: 'error'` 那种永远清不掉。
   */
  const pendingUserMessageOriginRef = useRef<string | null>(null);
  /** fl:暂存时所在的项目 —— 跨项目的 pending 一律不认(见 flush effect)。 */
  const pendingUserMessageProjectRef = useRef<string | null>(null);

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null;
  /**
   * fj:给那些"要读当前处理态、但不该因它重跑"的 effect 用。
   * 放依赖数组里会让 effect 每轮翻两次(开始一次、结束一次)。
   */
  const isProcessingRef = useRef(isProcessing);
  isProcessingRef.current = isProcessing;

  /**
   * fj:两个 effect 只该在 **id 变了**的时候重跑,但体内要用完整对象。
   * 对象走 ref、id 进依赖数组 —— 这是这里唯一能同时满足两件事的写法。
   */
  const selectedProjectRef = useRef(selectedProject);
  selectedProjectRef.current = selectedProject;
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
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

    /**
     * fj:只把它交给**本视图刚建立的那条会话**。
     *
     * `pendingUserMessage` 是"新会话页上还没有会话 id 时暂存的一条消息",而
     * 这个 effect 的唯一条件此前是"pending 非空 且 activeSessionId 非空" ——
     * **不记录它原本属于谁**,拿到什么 id 就往哪儿写;换会话的重置 effect 也不
     * 清它(只有显式新建那条清)。
     *
     * 于是:在新会话页上做任何会报错的事(拖一个超大的 PDF、抓一个抓不到的
     * URL、建会话失败),屏幕上出现红色错误行 —— 此时**不点新建**、直接在侧栏
     * 打开一条已有会话 B,那条错误行就被写进 B 的实时列表,还带着**原始时间戳**
     * 插在 B 历史的正中间。而 `pruneRealtimeSupersededByServer` 对 `kind: 'error'`
     * 没有任何规则(落到兜底 `return true`),**任何刷新都清不掉**。
     *
     * `establishedHereRef` 正是"这条 id 是本视图自己建立的"这个判据(fi 轮引入),
     * 这里复用它:对不上就把这条 pending 丢掉,而不是塞给一条无关的会话。
     */
    /**
     * fl:判据收紧成**只认"本视图亲手建立的那条 id"**。
     *
     * fj 留了一个 `|| establishedHereRef.current === null` 的兜底,本意是覆盖
     * "路由先于 markSessionEstablished 落地"的那一帧。但那个状态**恰恰就是**
     * 泄漏场景本身:新会话页上报了个错(从未创建过任何会话,所以
     * establishedHere 一直是 null)→ 直接在侧栏点开会话 B → 兜底放行 →
     * 那条错误行被写进 B。
     *
     * 而那一帧其实不存在:`markSessionEstablished` 同时设 ref 和
     * `currentSessionId`,路由的 `selectedSession` 是它触发导航之后才到的 ——
     * ref 一定先落。所以兜底可以直接去掉。
     *
     * 再加一道项目归属:跨项目的 pending 一律不认(新会话页在 P1 报的错,
     * 不该出现在 P2 的会话里)。null 表示"未知",不是通配。
     */
    const bornOnNewSessionPage = pendingUserMessageOriginRef.current === null;
    const sameProject = pendingUserMessageProjectRef.current === (selectedProjectRef.current?.projectId ?? null);
    const belongsHere = bornOnNewSessionPage
      && sameProject
      && establishedHereRef.current === activeSessionId;
    if (!belongsHere) {
      setPendingUserMessage(null);
      pendingUserMessageOriginRef.current = null;
      pendingUserMessageProjectRef.current = null;
      return;
    }

    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    pendingUserMessageOriginRef.current = null;
    pendingUserMessageProjectRef.current = null;
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
      // No session yet — show as pending until the backend creates one.
      // fj:同时记下"暂存时路由选中的是谁"(新会话页为 null)。冲队时据此判断
      // 这条 pending 到底属不属于当下这个视图,见 flush effect。
      pendingUserMessageOriginRef.current = selectedSessionRef.current?.id ?? null;
      pendingUserMessageProjectRef.current = selectedProjectRef.current?.projectId ?? null;
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
      /**
       * gh:**跟底分支要先打开。** 这个按钮只在用户滚上去时出现,而那一刻
       * `handleScroll` 已把 followBottomRef 置假;砍完窗口那次 commit 走的是守位分支
       * (把锚点校回原处)—— 第一次点什么都不动,第二次才有效。
       */
      followBottomRef.current = true;
      forceFollowBottomOnceRef.current = true;
      setIsUserScrolledUp(false);
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
      return;
    }
    scrollToBottom();
  }, [allMessagesLoaded, scrollToBottom]);

  /**
   * fz:**`allMessagesLoaded` 不许在槽位说"还有更早的"时留着为真。**
   *
   * 这个标记为真会让 `loadOlderMessages`、自动补页、「加载全部」浮层**全部**
   * 直接 return;而两条顶栏横幅是互斥条件(一条看 `hasMore && !allLoaded`,
   * 一条看 `!hasMore`)—— 两者同时为真时**一条都不显示**,用户手里既没有内容
   * 也没有入口,只能瞎点「回到底部」或者切走再切回来才能恢复。
   *
   * 这个组合有两条产生路径,一条急性一条慢性:
   *
   * - 急性:回到一条过期的会话,窗口按旧槽位恢复成"全量在手",紧接着重拉把
   *   正文换成尾部 20 条(上面 `willReuseSlot` 那处堵的就是它);
   * - 慢性:点过「加载全部」之后继续对话,每轮结束的刷新用的是**固定的旧条数**
   *   做窗口,而 `total` 在涨 → 服务端重新报 `hasMore: true`,最早的若干条被
   *   甩出窗口,而这个标记还是 true。
   *
   * 与其把两条路各堵一次,不如把不变式本身钉在这儿:**只要槽位说还有更早的,
   * 这个标记就必须是假的。** 谁把它弄成真的都一样。
   */
  useEffect(() => {
    if (hasMoreMessages && allMessagesLoaded) {
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [hasMoreMessages, allMessagesLoaded]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  /**
   * 「更早的全都在手里了」这一刻要做的事。
   *
   * 原来这六行在 `loadOlderMessages` 里出现两次(两个分支各抄一遍),
   * 而浮层定时器少清一次就会留下一个再也不会消失的「加载全部」浮层。
   */
  const markAllMessagesLoaded = useCallback(() => {
    allMessagesLoadedRef.current = true;
    setAllMessagesLoaded(true);
    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    setShowLoadAllOverlay(false);
    setLoadAllStuck(false);
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
        // 同首屏拉取:await 期间可能切走。这里写的是 hasMore / total /
        // allMessagesLoaded —— 全是分页状态,盖到另一条会话上就是把它的
        // 「看更早」按死。判据读 ref,闭包里的 id 恒等于自己、守不住东西。
        const olderRequestSessionId = selectedSession.id;
        /**
         * B2:**这一页到底多带回来几条** —— 判据是加载前后的差值,不是总条数。
         *
         * 原来这里判的是 `slot.serverMessages.length === 0`(**累计**已加载
         * 条数),那只有空会话才成立 —— 也就是说"这一页什么也没带回来"这件事
         * 从来没被识别过。而服务端在流式期间可能返回重叠的一页(去重后净增 0)
         * 却仍报 `hasMore: true`:此时返回 true 会让自动补页循环认为"还在
         * 前进",一路打满 30 次请求。
         */
        const loadedBefore = sessionStore.getSessionSlot(olderRequestSessionId)?.serverMessages.length ?? 0;
        const slot = await sessionStore.fetchMore(selectedSession.id, {
          limit: MESSAGES_PER_PAGE,
        });
        if (activeSessionIdRef.current !== olderRequestSessionId) return false;

        // `hasMore` / `total` 不再由这里写:它们直接派生自槽位(见上面的 viewSlot)。
        switch (classifyOlderPage(slot, loadedBefore)) {
          case 'failed':
            // fetchMore 失败时返回 null(以前是原样返回旧 slot,于是断网被当成
            // "加载成功、只是没有新内容",这条会话从此不再自动跟底)。
            // 说一声再退出 —— 静默失败比失败本身更难查。
            emitToast({ message: '加载更早的消息失败,请稍后重试。', variant: 'error' });
            return false;
          case 'exhausted':
            markAllMessagesLoaded();
            return false;
          case 'stalled':
            // 这一页与已加载窗口完全重叠。不算成功 —— 否则自动补页会一直转。
            return false;
          case 'loaded':
            // 前插:声明这次位移不是用户造成的,控制器按上一帧的锚把视口校回原位。
            holdAnchorRef.current = true;
            setVisibleMessageCount((prev) => prev + MESSAGES_PER_PAGE);
            if (!slot!.hasMore) markAllMessagesLoaded();
            return true;
        }
      } finally {
        isLoadingMoreRef.current = false;
        setIsLoadingMoreMessages(false);
      }
    },
    [hasMoreMessages, isLoadingMoreMessages, markAllMessagesLoaded, selectedProject, selectedSession, sessionStore],
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

  /**
   * 容器现在看得见吗 —— 聊天区在别的页签下是 `display:none` 但仍然挂着,
   * 那时所有尺寸都是 0。控制器与自动补页共用这一个判据(fz)。
   */
  const containerIsVisible = useCallback(() => {
    const container = scrollContainerRef.current;
    return Boolean(container) && !(container!.clientHeight === 0 && container!.scrollHeight === 0);
  }, []);

  const canScrollUp = useCallback(() => {
    const container = scrollContainerRef.current;
    /**
     * fz:**看不见的容器不能拿来判"还滚不动"。**
     *
     * `display:none` 时是 `0 > 8` = false =「还滚不动」,而这正是自动补页循环
     * **唯一的出口**("能滚了就把方向盘交回给用户")。在「文件 / 终端」页签上
     * 点侧栏里的会话时(那条路不切页签),补页就整段跑在一个不可见的容器上:
     * 30 轮请求全部打满、窗口涨到 600+、最后把「加载全部」浮层置成常驻不淡出。
     * 用户切回聊天看到的是一屏真实 DOM 加一个撤不掉的浮层。
     *
     * 看不见时一律报"能滚"(=不需要补页),等真的看得见了再说。
     */
    if (!containerIsVisible()) return true;
    return !!container && container.scrollHeight > container.clientHeight + AUTO_FILL_SLACK_PX;
  }, [containerIsVisible]);

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
    /**
     * ga:**看不见的容器上的滚动事件一律不算数。**
     *
     * 聊天区在别的页签下是 `display:none`(仍然挂着),此时 `scrollTop` /
     * `scrollHeight` / `clientHeight` 全是 0,这一整段拿 0 算出来的结论条条都错:
     * `isNearBottom()` 恒真 → 跟底被打开;`scrollTop < 100` 恒真 → 在用户完全
     * 看不见的地方一页页往前拉历史;顺带把待办的位置恢复判成"用户滚过了"。
     * 量一本合着的书,量出来永远是第 0 页,不能拿它去改笔记。
     */
    if (!containerIsVisible()) return;

    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);
    // 跟不跟底立刻定下来。**不能等 state** —— 流式期间每 ~100ms 一次 commit,
    // 用户刚滚上去而状态还没提交,那一帧就会拿着旧的 false 把视口钉回底部。
    followBottomRef.current = nearBottom;
    /**
     * 等待位置恢复的这段时间里,用户自己滚过没有。
     *
     * ga:判据由"有滚动事件就算用户滚的"改成"**落点跟我们自己写进去的那个值
     * 对不上**才算用户滚的"。恢复挂起期间控制器仍在跟底写 scrollTop(见
     * `programmaticScrollTopRef`),按旧判据等于每跟一次底就给自己判一次死刑。
     * 留 2px 余量:亚像素和浏览器的夹取会让读回值与写入值差一点点。
     */
    if (scrollRestoreRef.current
      && isUserInitiatedScroll(container.scrollTop, programmaticScrollTopRef.current)) {
      scrollRestoreUserMovedRef.current = true;
    }
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
  }, [containerIsVisible, hasMoreMessages, isNearBottom, loadOlderMessages]);

  /**
   * 换会话时重置滚动/分页状态。
   *
   * fj:`useLayoutEffect` —— 这一段必须在**浏览器绘制之前**跑完。
   *
   * 被动 effect 里跑的话,换会话之后的**第一次布局**用的还是上一条会话的锚点
   * (`scrollAnchorRef`)和跟底状态,滚动控制器(它是 layout 阶段的)会先按
   * 旧锚把视口钉到一个毫无关系的位置,下一帧才被这里清掉 —— 用户看到的是
   * 打开会话时先闪一下再跳回去。
   */
  useLayoutEffect(() => {
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

    /**
     * fx:**回到一条会话时,把离开时停的地方接回去。**
     *
     * 在这里武装(layout 阶段、换会话那一帧),而不是在下面那个被动的加载
     * effect 里 —— 滚动控制器也是 layout effect 且声明在本 effect 之后,
     * 同一次 commit 里它紧接着就跑;放到被动 effect 里会晚整整一帧,
     * 那一帧控制器已经按"跟底"把视口钉到底部了,随后再跳回去就是可见的抽搐。
     *
     * 这里只**记下要恢复什么**,一个 scrollTop 都不写:那个 effect 是全局
     * 唯一的写点,再多一个写者就是它注释里数落过的老毛病。
     */
    const viewKey = selectedSession?.id && selectedProject?.projectId
      ? `${selectedSession.id}:${selectedProject.projectId}`
      : '';
    viewSessionKeyRef.current = viewKey;
    scrollRestoreUserMovedRef.current = false;
    scrollRestoreRef.current = beginScrollRestore(viewKey, sessionSpotMemoryRef.current.get(viewKey));
  }, [selectedProject?.projectId, selectedSession?.id]);

  // Main session loading effect — store-based
  useEffect(() => {
    // fj:对象走 ref、只有 id 进依赖数组 —— 见 selectedProjectRef 的说明。
    const selectedSession = selectedSessionRef.current;
    const selectedProject = selectedProjectRef.current;
    const currentSessionId = currentSessionIdRef.current;
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      //
      // fi:多一道"必须是本视图自己建立的"。原来只看"在不在跑",于是从一条
      // 正在跑的会话切走(点项目行 / 切项目,那条路不 bump newSessionTrigger)
      // 也会走进这里,把别的会话的正文钉在「新会话」页面上。见 establishedHereRef。
      if (shouldKeepOrphanedSessionView({
        currentSessionId,
        establishedHere: establishedHereRef.current,
        isProcessing: Boolean(currentSessionId && processingSessionsRef.current?.has(currentSessionId)),
      })) {
        return;
      }
      establishedHereRef.current = null;

      // fl:同上 —— 离开视图不清流式缓冲,那条会话可能还在后台跑。
      /**
       * B3:这里原来要显式把加载标志放下 —— fj 修过一次(漏掉它时新会话页
       * 永久卡在「正在加载会话消息…」)。现在标志由槽位派生,而新会话页
       * 没有 activeSessionId,`deriveChatViewState` 直接给 'ready',
       * **这个漏点从此不可能再出现**。
       */
      setCurrentSessionId(null);
      setTokenBudget(null);
      // fz:回首页 / 点项目行同样是"离开当前这条",窗口照记。
      rememberLeavingWindow(lastViewedSessionKeyRef.current);
      lastViewedSessionKeyRef.current = null;
      return;
    }

    // fj:对象走 ref,只有 id 进依赖数组(见 selectedProjectRef 的说明)。
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

    /**
     * 换会话就重置窗口 —— **哪怕不需要重新拉页**。
     *
     * 这一段原来在短路**之后**,也就是只有"要重新拉"的时候才跑。改成集合判定
     * 之后回到旧会话不再重拉,可见窗口/「加载全部」这些视图状态却还留着上一条
     * 会话的值:回到 A 会按 B 剩下的那点条数渲染。它们是**视图**状态,归属于
     * "现在在看哪条",与"拉没拉过"无关,所以判据换成 lastViewedSessionKey。
     */
    if (lastViewedSessionKeyRef.current !== sessionKey) {
      /**
       * fv:**离开之前先把这条会话的窗口记下来。**
       *
       * 之前这里是无条件砍回首屏 —— 在 A 里点过「加载全部」、又「看更早」翻上去
       * 几百条,切到 B 再切回 A,那几次翻页的结果全部作废。窗口是视图状态,
       * 但它**属于哪条会话**是明确的,没有理由一切走就扔。
       */
      const leavingKey = lastViewedSessionKeyRef.current;
      rememberLeavingWindow(leavingKey);
      lastViewedSessionKeyRef.current = sessionKey;

      // 换会话时清掉上一条的用量(顶栏数字不能挂着别人的)。
      if (currentSessionId !== null && currentSessionId !== selectedSessionId) {
        setTokenBudget(null);
      }
      setCurrentSessionId(selectedSessionId);
      // 路由已经给出正式的 selectedSession —— 不管是刚建的那条跟上了,还是用户
      // 切去了别的会话,"本视图建立的临时 id"这个保护都该结束。
      establishedHereRef.current = null;

      /**
       * 恢复窗口。**两条不变式都收在 `recallSessionWindow` 里**,尤其是
       * "`allLoaded` 只在手里现在还是全量时才恢复" —— 照记忆无脑恢复会把
       * 「看更早」永久按死(判据与它为什么这么写,见那个函数的注释)。
       */
      const incomingSlot = sessionStore.getSessionSlot(selectedSessionId);
      /**
       * fz:**槽位马上要被换掉的话,它现在说什么都不算数。**
       *
       * `recallSessionWindow` 的那条不变式("allLoaded 只在手里现在还是全量时
       * 才恢复")本身是对的,单测也钉住了 —— 但这里**喂给它的是重拉之前的槽位**。
       * 它的注释点名要挡的三种情况里,"槽位被淘汰"挡住了(无槽位 → hasMore
       * 兜底为 true),**"槽位过期"这一种恰好挡不住**:过期判断在下面几行,
       * 在它之后。
       *
       * 于是:在长会话里点过「加载全部」→ 切走待 30 秒以上 → 切回来,
       * `allLoaded` 按旧槽位恢复成 true,紧接着重拉把正文换成尾部 20 条、
       * `hasMore` 变回 true。两条横幅是互斥条件,一个被 allLoaded 挡住、
       * 一个被 hasMore 挡住,**同时消失**;`loadOlderMessages` / 自动补页 /
       * 「加载全部」浮层又全都在 `if (allMessagesLoadedRef.current) return`
       * 上直接退出 —— 4980 条取不回来,而且屏幕上一个入口都没有。
       *
       * 判据要读"落地之后的槽位"。这里先算出"这一次到底复不复用槽位",
       * 不复用就当作"还有更早的",让 recall 自己把 allLoaded 降级。
       */
      const willReuseSlot = loadedSessionKeysRef.current.has(sessionKey)
        && sessionStore.has(selectedSessionId)
        && !sessionStore.isStale(selectedSessionId);
      const recalled = recallSessionWindow({
        memo: sessionWindowMemoryRef.current.get(sessionKey),
        // 用 `merged`(server + realtime)—— `chatMessages` 就是从它派生的,
        // 拿 serverMessages 会把上限压小,恢复出来的窗口比离开时窄一截。
        loadedCount: incomingSlot?.merged.length ?? 0,
        hasMore: willReuseSlot ? (incomingSlot?.hasMore ?? true) : true,
        total: incomingSlot?.total ?? 0,
        phase1: PHASE1_VISIBLE_MESSAGES,
      });
      setVisibleMessageCount(recalled.visibleCount);
      visibleMessageCountRef.current = recalled.visibleCount;
      setAllMessagesLoaded(recalled.allLoaded);
      allMessagesLoadedRef.current = recalled.allLoaded;
      setIsLoadingAllMessages(false);
      setLoadAllJustFinished(false);
      setShowLoadAllOverlay(false);
      setViewHiddenCount(0);
      wasNearTopRef.current = false;
      if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
      if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
    }

    // 已经拉过首屏、槽位还在、也没过期 → 复用,不重拉(N05)。
    // fz:判据与上面那句 `willReuseSlot` **必须是同一句** —— 分成两处写就是
    // 下一次"一处改了另一处没跟上"。这里重算一次而不是提到 if 外面,是因为
    // 上面那段只在换会话那一拍进得去。
    if (loadedSessionKeysRef.current.has(sessionKey) && sessionStore.has(selectedSessionId) && !sessionStore.isStale(selectedSessionId)) {
      subscribeToSelectedSession();
      return;
    }

    // 切会话时**不清**流式缓冲。缓冲(accumulatedStreamRef / streamTimerRef)按
    // 会话分桶,各刷各的 store —— 之前这里 resetStreamingState() 是无差别全清,把
    // 后台还在流式的会话(比如 A 正在回答时切去 B)的累积文本一起截断了。切回
    // A 只剩碎片。全清只该发生在整体卸载 / 新建会话(那两处仍调用)。
    //
    // N05:`setCurrentSessionId` / `setTokenBudget` / `establishedHereRef` 这三样
    // 挪到了上面那个"换会话"分支里 —— 它们随**看的是哪条**变,而这里(短路之后)
    // 只剩"要重新拉一页"这一件事。原地留着会让 A→B→A 的复用路径不更新它们。

    // Subscribe to the session's live run (if any): the ack reconciles the
    // processing indicator, re-attaches a mid-flight stream to this socket,
    // and replays any live events missed since `lastSeq`. Recording the send
    // time lets the ack handler discard idle acks that a newer request has
    // since outdated.
    subscribeToSelectedSession();

    loadedSessionKeysRef.current.add(sessionKey);

    // Fetch from server → store updates → chatMessages re-derives automatically
    // (加载态也一起派生:`fetchFromServer` 把槽位置为 loading,见 deriveChatViewState)
    /**
     * 首屏消息拉取。**必须带换会话守卫** —— 同一个文件里的 `loadAllMessages` 有
     * (第 910 行,还写了注释),`loadOlderMessages` 和这里都漏了。
     *
     * 没有它的后果:点开 5000 条的老会话 A(慢)→ 一秒内改点 30 条的 B(快)→
     * B 先落地 → A 的响应**盖上去**。若 A 的 `hasMore === false`,B 的
     * 「加载更多 / 看更早 / 加载全部」三个入口一起消失,B 永久只能看最后 20 条,
     * 直到 30 秒后重新切进来才自愈。
     *
     * 判据读 ref 而不是闭包里的 `selectedSessionId` —— 后者是发起时的值,
     * 恒等于自己,守不住任何东西。
     */
    const requestSessionId = selectedSessionId;
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: MESSAGES_PER_PAGE,
      offset: 0,
    }).then(slot => {
      if (activeSessionIdRef.current !== requestSessionId) {
        // 切走了:这份分页信息属于另一条会话,一个字段都不许写。
        // loading 标志也不动 —— 那是新会话自己那次拉取在管的。
        return;
      }
      if (slot) {
        if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
      }
    }).catch(() => {
      // 加载态与失败态都记在槽位上(status='error'),这里不再有本地标志要放下。
    });
  }, [
    // 引用恒定的 useCallback([], …) —— 进依赖不会让这个 effect 多跑一次。
    rememberLeavingWindow,
    resetStreamingState,
    /**
     * fj:依赖是 **projectId**,不是 `selectedProject` 对象。
     *
     * `useProjectsState` 在每条 `session_upserted` 上都会 `setSelectedProject(...)`
     * 返回新对象(watcher 合并窗口 500ms),于是项目里任何一条会话写盘,这个
     * effect 就重跑一次。而短路条件里的 `!isStale` 是 30 秒,长回合中
     * `externalMessageUpdate` 又刻意跳过 refresh(`isProcessing` 为真时) ——
     * `fetchedAt` 会真的老化过 30 秒。
     *
     * 于是落到下面那段**无条件重置**:可见窗口砍回 30 行、`allMessagesLoaded`
     * 清成 false、`fetchFromServer(limit:20, offset:0)` **整体替换** serverMessages。
     * 看着一条正在跑长回合的会话,**每 30 秒**正文缩水回最后 20 条、
     * 「加载全部」的结果被丢弃、滚动锚点被删掉、视口跳走。
     *
     * 同一文件的重置 effect 用的就是 `projectId`,这里是漏了。
     */
    selectedProject?.projectId,
    selectedSession?.id,
    sendMessage,
    statusCheckSentAtRef,
    lastSeqRef,
    isConnected,
    sessionStore,
  ]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    const currentSession = selectedSessionRef.current;
    if (!externalMessageUpdate || !currentSession || !selectedProjectRef.current) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        // fj:读 ref —— `isProcessing` 进依赖会让这个 effect 每轮翻两次。
        if (!isProcessingRef.current) {
          // 刷新完不再自己排一发跟底:那个 200ms 定时器**没有 cleanup**,
          // 用户在这 200ms 内滚上去照样被拽回底部。跟底交给滚动控制器 ——
          // 它每次 commit 都跑,而且用户一滚就立刻交出控制权。
          await sessionStore.refreshFromServer(currentSession.id);
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    /**
     * fj:同样收敛到 id。
     *
     * 依赖里放 `selectedSession` / `selectedProject` 两个对象 + `isProcessing`,
     * 等于"同项目任何会话每有动静就整窗 `refreshFromServer` 一次" ——
     * 用户点过「加载全部」的长会话每次就是几十 MB 的响应,而
     * `refreshFromServer` 的注释描述的正是要避免的这件事。
     *
     * `isNearBottom` / `scrollToBottom` 也不该在这里:effect 体内根本没用它们
     * (跟底早就交给滚动控制器了,见上面的注释)。
     */
    selectedProject?.projectId,
    selectedSession?.id,
    sessionStore,
    isProcessingRef,
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
        /**
         * F31:**搜索定位这条路也要有换会话守卫。**
         *
         * 同一个文件里 `loadAllMessages`、首屏拉取、`loadOlderMessages` 都有,
         * 唯独这里没有 —— 而它恰恰是最慢的那一条(`limit: null` = 整份
         * transcript)。切走之后落地的后果比别处更重:
         *   - `setAllMessagesLoaded(true)` 写到**新会话**头上,它的
         *     「看更早 / 加载全部」从此全部消失;
         *   - 可见条数按 `chatMessagesRef.current`(已经是新会话的正文)算,
         *     却是为旧会话的搜索目标算的,窗口停在一个毫无意义的位置。
         */
        const requestSessionId = selectedSession.id;
        try {
          // Load all messages into the store for search navigation
          const slot = await sessionStore.fetchFromServer(requestSessionId, {
            limit: null,
            offset: 0,
          });
          if (activeSessionIdRef.current !== requestSessionId) return;
          if (slot) {
            setVisibleMessageCount((prev) =>
              visibleCountForTarget(chatMessagesRef.current, target, prev),
            );
            setAllMessagesLoaded(true);
            allMessagesLoadedRef.current = true;
            await new Promise(resolve => setTimeout(resolve, 300));
            // 这 300ms 里同样可能切走 —— 下面的放开窗口与滚动都不该再执行。
            if (activeSessionIdRef.current !== requestSessionId) return;
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
  const tokenUsageProjectId = selectedProject?.projectId ?? null;
  const tokenUsageSessionId = selectedSession?.id ?? null;
  useEffect(() => {
    if (!tokenUsageProjectId || !tokenUsageSessionId) {
      setTokenBudget(null);
      return;
    }
    /**
     * F31:**这条也要有换会话守卫。**
     *
     * 顶栏那枚用量芯片有两个来源:实时的 `token_budget` 帧(dk 那轮已经加了
     * `sid === 正在看的会话` 的判据)和这次 REST 拉取 —— 而这一条一直没有。
     * 切走之后落地的两种后果都真实可见:
     *   - 成功:A 的用量数字写进 B 的顶栏,直到 B 下一帧用量才纠正;
     *   - 失败/404:`setTokenBudget(null)` 把 B **刚刚**由实时帧填好的数字抹掉。
     *
     * 依赖同时从 `selectedProject` 对象换成 `projectId`:那个对象在
     * `session_upserted` 上每次都是新的(见主加载 effect 的同一处说明),
     * 于是项目里任何一条会话写盘都会让这个请求重发一次。
     */
    const requestSessionId = tokenUsageSessionId;
    const fetchInitialTokenUsage = async () => {
      try {
        // The backend resolves the provider from the indexed session row.
        const url = `/api/projects/${tokenUsageProjectId}/sessions/${requestSessionId}/token-usage`;
        const response = await authenticatedFetch(url);
        if (activeSessionIdRef.current !== requestSessionId) return;
        if (response.ok) {
          const usage = await response.json();
          if (activeSessionIdRef.current !== requestSessionId) return;
          setTokenBudget(usage);
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [tokenUsageProjectId, tokenUsageSessionId]);

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

    /**
     * fz:**容器不可见就一步都别走。**
     *
     * 聊天区在别的页签下是 `display:none` 但**仍然挂着**(MainContent 有意为之:
     * 它是默认页签,保持挂载才能不丢状态),而这个 effect 没有依赖数组,照跑。
     * 此时容器和每一行的尺寸**全是 0**,于是:
     *
     * - `userMoved` 判成真 → 跟底被算成 true;
     * - `captureAnchor` 的二分对每一行都为假 → 锚点落在第 0 行、偏移 0;
     * - fx 新增的那段还照着把它**记进阅读位置表** —— 记成 `null`
     *   ("回来跟底"),这条会话辛苦记了一路的位置当场作废。
     *
     * 也就是说:只要用户在别的页签待过,这条会话的位置恢复就永远不会生效。
     * 量一本合着的书,量出来永远是第 0 页,不能拿它去改笔记。
     */
    if (!containerIsVisible()) {
      containerWasVisibleRef.current = false;
      return;
    }
    /**
     * ga:**由不可见变回可见的那一帧,不能把它读成"用户滚过"。**
     *
     * `display:none` 期间浏览器把 `scrollTop` 归零(有些浏览器恢复显示时也不还原),
     * 于是回来的第一次 commit 上:`scrollTop`(0)和锚点记的那个值对不上 →
     * `userMoved` 判真 → 守位分支被跳过、跟底按"现在在顶上"算成 false。
     * 表现就是从「文件 / 终端」页签切回聊天,视口钉在最上面,而且**再也不跟底**:
     * 新消息在下面刷,屏幕不动。
     *
     * 借 `holdAnchorRef` 那条既有的语义:这一下位移不是用户造成的,按锚点校回去。
     * 顺带把两笔隐藏期间可能被污染的账清掉。
     *
     * (补页循环也要在这时候被重新叫起来 —— 那件事交给下面那个 ResizeObserver,
     * 不放在这里:这个 effect 没有依赖数组,在里面调 setState 就是一条没有护栏的
     * 更新链。)
     */
    const becameVisible = !containerWasVisibleRef.current;
    containerWasVisibleRef.current = true;
    if (becameVisible) {
      holdAnchorRef.current = true;
      scrollRestoreUserMovedRef.current = false;
      programmaticScrollTopRef.current = null;
    }

    /**
     * 搜索定位期间完全不插手 —— 平滑滚动还在跑,谁碰谁打断。
     *
     * fz:**顺手把待办的位置恢复也丢掉。** 这句早退在恢复分支之前,于是
     * `stepScrollRestore` 一次都不被调用,两个刹车形同虚设 —— 一份 `wait`
     * 状态能无限期挂着,等搜索定位一放手就落地,把视口从刚滚过去的命中项上
     * 拽回"上次读到的地方",高亮闪在屏幕外。
     *
     * 判据不是"把刹车挪到前面",而是**谁的意图更强**:用户刚点了一条搜索结果,
     * 那就是他现在要去的地方,"上次读到哪儿"这时候不该再有发言权。
     */
    if (searchScrollActiveRef.current) {
      scrollRestoreRef.current = null;
      return;
    }

    /**
     * ga:**锚点只认顶层行。**
     *
     * `.chat-message` 会同时选中活动时间轴**展开区里嵌套**的那些 MessageComponent
     * —— 展开一条工具行就多出一个,"倒数第几行"当场错位;流式气泡和运行指示器
     * 也一样(它们出没得比谁都勤)。顶层行都带 `data-row-key`,那两类不带,
     * 于是这一句同时解决了三个错位来源。
     *
     * 跟底与守位仍然看整段高度,不受这个筛选影响。
     */
    const rows = container.querySelectorAll<HTMLElement>('.chat-message[data-row-key]');
    const rowKeyAt = (index: number) => rows[index]?.dataset.rowKey;

    /**
     * fx:会话位置恢复 —— **把记下的位置变成一个锚点**,交给下面的守位分支。
     *
     * 行是分批落地的(首屏 30 → 100,数据可能还在重拉),所以落不下去时要等;
     * 但不能无限等 —— 一直挂着 `followBottom = false`,回到一条正在跑的会话
     * 就不跟底了,新内容在下面刷而视口不动,那比不恢复还糟。两个刹车都在
     * `stepScrollRestore` 里(总 commit 上限 + 行数不再增长后的宽限)。
     *
     * 等待期间**什么都不改**:`followBottom` 保持换会话时的 true,视口先待在
     * 底部,能落下去了再一次到位 —— 好过先钉到顶部再往下跳。
     */
    if (scrollRestoreRef.current) {
      const step = stepScrollRestore(
        scrollRestoreRef.current,
        viewSessionKeyRef.current,
        rows.length,
        {
          // 等待期间用户自己滚过了 → 放弃(判据与它为什么必须有,见那个函数)。
          userMoved: scrollRestoreUserMovedRef.current,
          rowKeyAt,
        },
      );
      if (step.action === 'apply') {
        const row = rows[step.rowIndex];
        if (row) {
          scrollAnchorRef.current = {
            element: row,
            indexFromEnd: rows.length - 1 - step.rowIndex,
            offset: step.offset,
            // 用**当前**的 scrollTop:下面的 userMoved 拿它比对,
            // 写成别的值会被判成"用户自己动过"而放弃守位。
            scrollTop: container.scrollTop,
          };
          followBottomRef.current = false;
        }
        scrollRestoreRef.current = null;
      } else if (step.action === 'wait') {
        scrollRestoreRef.current = step.next;
      } else {
        scrollRestoreRef.current = null;
      }
    }

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
    /**
     * gi 自查:「回到底部」按钮点下去那一次 commit 要**无条件跟底**。
     *
     * 锚点只在 commit 时刷新,用户连续上滚之后它是旧的 → 这一次 `userMoved` 必然为真 →
     * 上面刚置的 followBottomRef 被这里按"离底部远"重新算成假 → 不滚。而按钮已经隐藏
     * (isUserScrolledUp 置假),第二次点的机会也没了。一次性的强制标记优先于 userMoved。
     */
    if (forceFollowBottomOnceRef.current) {
      forceFollowBottomOnceRef.current = false;
      followBottomRef.current = true;
    } else if (userMoved) {
      followBottomRef.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < FOLLOW_BOTTOM_SLACK_PX;
    }

    if (followBottomRef.current && rows.length > 0) {
      // 跟底。写在 layout 阶段,绘制前完成 —— 不会出现"先画在上面再跳下去"。
      container.scrollTop = container.scrollHeight;
      // ga:写完读回来记账 —— 浏览器会夹到合法区间,写进去的值不一定就是落定的值。
      // 随之而来的滚动事件靠它认出"这一下是我们自己写的"(见 programmaticScrollTopRef)。
      programmaticScrollTopRef.current = container.scrollTop;
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
          // ga:同上 —— 守位这一下也是程序化滚动,要记账。
          programmaticScrollTopRef.current = container.scrollTop;
        }
      }
    }

    // 决策之后才重新取锚 —— 这一句必须留在最后。
    captureAnchor(container, rows);

    /**
     * fx:顺手记下"人现在停在哪儿",供下次回到这条会话时接回去。
     *
     * 跟底时记 `null` —— 那是"回来直接跟底"的意思,不是"没记过"。
     * 恢复还在进行时**不记**:那会拿恢复前的位置把要恢复的目标覆盖掉。
     */
    if (!scrollRestoreRef.current && viewSessionKeyRef.current && rows.length > 0) {
      const captured = scrollAnchorRef.current;
      sessionSpotMemoryRef.current = rememberReadingSpot(
        sessionSpotMemoryRef.current,
        viewSessionKeyRef.current,
        followBottomRef.current || !captured
          ? null
          : {
            // ga:记那一行自己的标识 —— 回来时按它精确找回(见 resolveReadingSpot)。
            rowKey: captured.element.dataset.rowKey,
            indexFromEnd: captured.indexFromEnd,
            offset: captured.offset,
          },
      );
    }
  });

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  /**
   * ga:**容器重新看得见(或者变大了)的时候,把自动补页叫回来。**
   *
   * fz 给 `canScrollUp` 加了"看不见就报能滚"(为了挡住在隐藏容器上空跑 30 轮
   * 补页),但**没有配套的重新唤起**:那个循环的依赖里没有任何随页签变化的量。
   * 于是在「文件」页签里点开一条 694 条消息的会话(这条路不切页签),补页隔着
   * "关着的卷帘门"量了一下什么也量不到,当成"货架已满"收工;切回聊天时首屏
   * 十来行、不溢出 → 没有滚动条 → 永远不触发 scroll → `loadOlderMessages` 没人
   * 调,而带按钮的横幅条件是 `!hasMoreMessages` 也不显示。**用户没有任何出口**,
   * 只能切走再切回来自救。
   *
   * 这里用 `ResizeObserver` 而不是在滚动控制器里 `setAutoFillTick`:那个 effect
   * 没有依赖数组,在里面调 setState 就是一条没有护栏的更新链(eslint 也会这么说)。
   * 尺寸事件是这件事本来的形状 —— `display:none` 的容器量出来是 0×0,恢复显示
   * 时浏览器会派发一次;窗口被拉大同样派发,而那也是一种"货架突然不满了"。
   *
   * 只在**由 0 变非 0** 时叫一次,所以不会自己咬自己的尾巴。
   */
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (typeof ResizeObserver === 'undefined') return;
    let wasEmpty = container.clientHeight === 0 && container.scrollHeight === 0;
    const observer = new ResizeObserver(() => {
      const isEmpty = container.clientHeight === 0 && container.scrollHeight === 0;
      const cameBack = wasEmpty && !isEmpty;
      wasEmpty = isEmpty;
      if (!cameBack) return;
      if (allMessagesLoadedRef.current) return;
      setAutoFillTick((n) => n + 1);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  /**
   * B3:首屏拉取失败之后的重试入口。
   *
   * 在此之前失败是**没有出口**的:loading 置回 false、正文空着,渲染分支
   * 落到「起始卡片」—— 界面告诉用户"这条会话还没有消息",而实际上只是那一次
   * 请求挂了。用户唯一的办法是切走再切回来(而且得等 30 秒的 isStale 窗口)。
   *
   * 立成规矩:界面任何时候都不允许进入一个没有出口的状态(同 canAbortSession)。
   */
  const retryLoadSessionMessages = useCallback(() => {
    const requestSessionId = activeSessionIdRef.current;
    if (!requestSessionId) return;
    void sessionStore.fetchFromServer(requestSessionId, {
      limit: MESSAGES_PER_PAGE,
      offset: 0,
    }).then((slot) => {
      if (activeSessionIdRef.current !== requestSessionId) return;
      if (slot?.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
    }).catch(() => {
      // 失败态已经记在槽位上(status='error'),重试入口照旧渲染。
    });
  }, [sessionStore]);

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
