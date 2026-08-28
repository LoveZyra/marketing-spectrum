/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import type { LLMProvider } from '../types/app';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification'
  // prism additions: per-turn git checkpoints + changed-files summaries
  | 'checkpoint_created'
  | 'changed_files';

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;
  /**
   * Per-run monotonic sequence number assigned by the backend to live
   * websocket events. Used to compute `lastSeq` for `chat.subscribe` replay;
   * REST history messages do not carry it.
   */
  seq?: number;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: Array<{ path?: string; data?: string; name?: string }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  /**
   * 正在打字的那段助手正文。
   *
   * **它不在 `realtimeMessages` 里,也不参与合并排序。**以前它是列表里的一条
   * 普通消息,每 100ms 一次 flush 都要:重建数组 → Set → filter → concat →
   * **全量 sort** → dedupe → 重建全部 React element,整份 transcript 每秒十次;
   * 而且它的时间戳每次都被重锚到"现在",而排序键正是时间戳 —— 同期到达的
   * 工具行会在它上下来回换位,那就是肉眼看到的"抖"。
   *
   * 时序上它天然可以独立:`stream_end` 在下一批工具行之前就到并提交,所以
   * 任意时刻最多只有一个活跃流式块,而且它一定在末尾 —— 那就没必要参与排序。
   */
  streamingText: string | null;
  streamingProvider: LLMProvider | null;
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  /**
   * @internal Monotonic ticket per server fetch (fetch/refresh/fetchMore) and
   * the ticket of the last response applied. Concurrent fetches for the same
   * session can resolve out of order — e.g. the `complete` refresh racing the
   * watcher-triggered refresh right as a queued message is flushed — and a
   * stale response applied last would wind `serverMessages` back to a
   * transcript that no longer matches what the user already saw.
   */
  _fetchSeq: number;
  _appliedFetchSeq: number;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
  /**
   * 最近一次被访问(读或写)的时刻,LRU 淘汰按它排序。后台会话的实时帧
   * 也会刷新它 —— 正在跑的会话因此天然不会被淘汰。
   */
  lastTouchedAt: number;
}

const EMPTY: NormalizedMessage[] = [];

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    streamingText: null,
    streamingProvider: null,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    _fetchSeq: 0,
    _appliedFetchSeq: 0,
    lastTouchedAt: Date.now(),
  };
}

/**
 * Compute merged messages: server + realtime, deduped by id and adjacent
 * assistant echo (same trimmed text), so finalized stream rows do not stack
 * on top of the persisted copy before realtime is cleared.
 */
const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;

function userTextFingerprint(m: NormalizedMessage): string | null {
  if (m.kind !== 'text' || m.role !== 'user') return null;
  const t = (m.content || '').trim();
  return t.length > 0 ? t : null;
}

/**
 * 解析后的时间戳缓存。
 *
 * `compareMessagesChronologically` 每比较一次就调两次 `Date.parse`,而排序是
 * O(n log n) 次比较 —— 三千条消息约 3.5 万次比较 = 7 万次 Date.parse,每轮对话
 * 结束都要来一遍。消息对象本身是不可变的(store 里一律 spread 出新对象),
 * 所以按对象身份缓存是安全的;用 WeakMap,消息被回收时条目自动消失。
 */
const messageTimeCache = new WeakMap<NormalizedMessage, number | null>();

function readMessageTime(m: NormalizedMessage): number | null {
  const cached = messageTimeCache.get(m);
  if (cached !== undefined) {
    return cached;
  }
  const time = Date.parse(m.timestamp);
  const value = Number.isFinite(time) ? time : null;
  messageTimeCache.set(m, value);
  return value;
}

function hasServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
): boolean {
  const localText = userTextFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localText || localTime === null) {
    return false;
  }

  return serverMessages.some((serverMessage) => {
    if (userTextFingerprint(serverMessage) !== localText) {
      return false;
    }

    const serverTime = readMessageTime(serverMessage);
    return (
      serverTime !== null
      && serverTime >= localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      && serverTime - localTime <= LOCAL_USER_DEDUPE_WINDOW_MS
    );
  });
}

function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

/**
 * Count how many user turns precede `message` in a chronologically merged view
 * of server + realtime rows. Used to match a realtime row to the correct turn
 * on disk when several turns share identical assistant text.
 */
function getUserTurnOrdinalBefore(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  /**
   * 预先排好的合并视图。不传就地排一次(保持旧调用方可用),但热路径上必须传:
   * 这个函数会对**每一条** realtime 行调用一次,而排序的是 server+realtime 全量。
   * 实测 40 条 realtime × 3000 条 server = 75 ms,realtime 上限是 500 条。
   */
  presortedMerged?: NormalizedMessage[],
): number {
  const messageTime = readMessageTime(message);
  let userCount = 0;

  const merged = presortedMerged
    ?? [...serverMessages, ...realtimeMessages].sort(compareMessagesChronologically);

  for (const candidate of merged) {
    if (candidate.id === message.id) {
      break;
    }

    const candidateTime = readMessageTime(candidate);
    if (
      messageTime !== null
      && candidateTime !== null
      && candidateTime > messageTime
    ) {
      break;
    }

    if (candidate.kind === 'text' && candidate.role === 'user') {
      userCount++;
    }
  }

  return Math.max(0, userCount - 1);
}

function findServerTurnRangeByOrdinal(
  serverMessages: NormalizedMessage[],
  turnOrdinal: number,
): { start: number; end: number } | null {
  let userCount = -1;
  let start = -1;

  for (let index = 0; index < serverMessages.length; index++) {
    const message = serverMessages[index];
    if (message.kind === 'text' && message.role === 'user') {
      userCount++;
      if (userCount === turnOrdinal) {
        start = index;
        break;
      }
    }
  }

  if (start < 0) {
    return null;
  }

  let end = serverMessages.length;
  for (let index = start + 1; index < serverMessages.length; index++) {
    if (serverMessages[index].kind === 'text' && serverMessages[index].role === 'user') {
      end = index;
      break;
    }
  }

  return { start, end };
}

function isAssistantTextEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  presortedMerged?: NormalizedMessage[],
): boolean {
  const assistantText = (message.content || '').trim();
  if (!assistantText) {
    return false;
  }

  const turnOrdinal = getUserTurnOrdinalBefore(message, serverMessages, realtimeMessages, presortedMerged);
  const turnRange = findServerTurnRangeByOrdinal(serverMessages, turnOrdinal);
  if (!turnRange) {
    return false;
  }

  return serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .some((serverMessage) =>
      serverMessage.kind === 'text'
      && serverMessage.role === 'assistant'
      && (serverMessage.content || '').trim() === assistantText,
    );
}

/**
 * After `finalizeStreaming`, the client holds a synthetic assistant `text` row
 * while the sessions API soon returns the same reply with a different id.
 * Those sit back-to-back in merged order and look like duplicate bubbles until
 * `refreshFromServer` clears realtime. Collapse same-text assistant rows and
 * stream_placeholder → text when content matches.
 */
function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of merged) {
    const prev = out[out.length - 1];
    if (prev) {
      if (prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[out.length - 1] = m;
          continue;
        }
      }
      if (
        prev.kind === 'text'
        && m.kind === 'text'
        && prev.role === 'assistant'
        && m.role === 'assistant'
      ) {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) {
          continue;
        }
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * After a server refresh, drop only the realtime rows the persisted transcript
 * already owns. Anything not yet on disk (common right after `complete`, while
 * JSONL indexing lags) stays in `realtimeMessages` so the chat pane never
 * flashes the empty "Continue your conversation" state.
 */
function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));

  // 合并视图只排一次,传给下面每一次判定复用。之前是每条 realtime 行各排一遍
  // 全量 —— O(R × (S+R) log(S+R)),40×3000 实测 75 ms,而 realtime 上限 500 条。
  // 只在真的会用到它的时候才排:纯 user 行的分支根本不需要。
  let presortedMerged: NormalizedMessage[] | undefined;
  const mergedView = () => {
    if (!presortedMerged) {
      presortedMerged = [...serverMessages, ...realtimeMessages].sort(compareMessagesChronologically);
    }
    return presortedMerged;
  };

  return realtimeMessages.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }

    if (message.id.startsWith('local_') && hasServerEchoForLocalUser(message, serverMessages)) {
      return false;
    }

    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages, mergedView())) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages, mergedView())) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return !hasServerEchoForLocalUser(message, serverMessages);
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });
}

/**
 * 服务端历史 + 实时消息 → 屏幕上那一串。
 *
 * 导出是为了测试(G1):这段是聊天里最容易出"重影"和"顺序错乱"的地方,而它是
 * 纯函数 —— 直接钉行为比通过整个 store 间接验证便宜得多,也读得懂得多。
 * `planSlotEviction` 同理,已是同样的处理。
 */
export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }
  if (server.length === 0) {
    return dedupeAdjacentAssistantEchoes(realtime);
  }

  const serverIds = new Set(server.map((message) => message.id));
  const extra = realtime.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }
    // Optimistic user rows use `local_*` ids; once the same text exists on the
    // server-backed copy from the same send window, drop the realtime echo to
    // avoid duplicate bubbles without hiding repeated prompts from history.
    if (message.id.startsWith('local_')) {
      if (hasServerEchoForLocalUser(message, server)) {
        return false;
      }
    }
    return true;
  });

  if (extra.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }

  // Interleave by timestamp so live rows stay with their turn instead of
  // piling up at the bottom after every refresh.
  return dedupeAdjacentAssistantEchoes(
    [...server, ...extra].sort(compareMessagesChronologically),
  );
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

/** 与聊天面板的首屏分页大小一致 —— 刷新窗口不该小于它。 */
const MESSAGES_PER_PAGE = 20;

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

/** realtime 行的上限。提交流式正文和逐条追加共用同一个口径。 */
function capRealtime(rows: NormalizedMessage[]): NormalizedMessage[] {
  return rows.length > MAX_REALTIME_MESSAGES ? rows.slice(-MAX_REALTIME_MESSAGES) : rows;
}

/**
 * 槽位 LRU 上限与保护窗。
 *
 * 原设计是"切会话不清、旧数据全留"—— 换回上一个会话零等待。但槽位从不
 * 淘汰意味着逛几十个长会话后内存只涨不落(每个槽位攥着全量消息数组和它们
 * 的 merged 副本)。折中:保留最近用过的 N 个,其余在**切会话**这个自然
 * 边界上丢弃 —— 被丢的会话再次打开时走正常的首屏拉取,和冷启动一个体验。
 * 60 秒保护窗兜住"正在后台跑着流"的会话:实时帧会刷新 lastTouchedAt,
 * 只要还有动静就不会进候选。
 */
const MAX_SESSION_SLOTS = 12;
const SLOT_EVICTION_MIN_IDLE_MS = 60_000;

/**
 * 纯函数:算出该淘汰哪些会话槽位。当前会话永不淘汰;60 秒内被碰过的不淘汰;
 * 其余按最久未用先走,留到不超过 max 为止。
 */
export function planSlotEviction(
  entries: Array<{ sessionId: string; lastTouchedAt: number }>,
  activeSessionId: string | null,
  now: number,
  max: number = MAX_SESSION_SLOTS,
  minIdleMs: number = SLOT_EVICTION_MIN_IDLE_MS,
): string[] {
  if (entries.length <= max) return [];
  const candidates = entries
    .filter((entry) => entry.sessionId !== activeSessionId && now - entry.lastTouchedAt >= minIdleMs)
    .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt);
  const overflow = entries.length - max;
  return candidates.slice(0, overflow).map((entry) => entry.sessionId);
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes.
  // Session ids are stable for the whole conversation lifetime (the backend
  // allocates them before the first send), so slots are keyed directly with
  // no alias/redirect indirection.
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
    // 切会话是淘汰的自然边界:此刻丢掉最久未用的槽位,当前会话与仍在
    // 后台推流的会话(60 秒保护窗)都不在候选里。
    const store = storeRef.current;
    if (sessionId) {
      const slot = store.get(sessionId);
      if (slot) slot.lastTouchedAt = Date.now();
    }
    const entries = Array.from(store, ([id, slot]) => ({ sessionId: id, lastTouchedAt: slot.lastTouchedAt }));
    for (const evictId of planSlotEviction(entries, sessionId, Date.now())) {
      store.delete(evictId);
    }
  }, []);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
    }
    const slot = store.get(sessionId)!;
    slot.lastTouchedAt = Date.now();
    return slot;
  }, []);

  const has = useCallback((sessionId: string) => {
    return storeRef.current.has(sessionId);
  }, []);

  /**
   * Fetch messages from the provider sessions endpoint and populate serverMessages.
   *
   * Provider and project metadata are resolved server-side from `sessionId`.
   * The endpoint returns the standard `{ success, data }` envelope.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number | null;
      offset?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    const fetchTicket = ++slot._fetchSeq;
    slot.status = 'loading';
    notify(sessionId);

    try {
      const params = new URLSearchParams();
      if (opts.limit !== null && opts.limit !== undefined) {
        params.append('limit', String(opts.limit));
        params.append('offset', String(opts.offset ?? 0));
      }

      const qs = params.toString();
      const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.json();
      const data = body?.data ?? body;
      const messages: NormalizedMessage[] = data.messages || [];

      // A later-started fetch already applied: this response is stale.
      if (fetchTicket <= slot._appliedFetchSeq) {
        return slot;
      }
      slot._appliedFetchSeq = fetchTicket;

      slot.serverMessages = messages;
      slot.total = data.total ?? messages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = (opts.offset ?? 0) + messages.length;
      slot.fetchedAt = Date.now();
      slot.status = 'idle';
      recomputeMergedIfNeeded(slot);
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }

      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
      // Don't clobber a newer fetch's result with a stale failure.
      if (fetchTicket > slot._appliedFetchSeq) {
        slot.status = 'error';
        notify(sessionId);
      }
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    if (!slot.hasMore) return slot;

    const fetchTicket = ++slot._fetchSeq;
    const params = new URLSearchParams();
    const limit = opts.limit ?? 20;
    params.append('limit', String(limit));
    params.append('offset', String(slot.offset));

    const qs = params.toString();
    const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;
      const olderMessages: NormalizedMessage[] = data.messages || [];

      // A full fetch/refresh replaced serverMessages while this page was in
      // flight — prepending onto the new array would duplicate or misorder.
      if (fetchTicket <= slot._appliedFetchSeq) {
        return slot;
      }
      slot._appliedFetchSeq = fetchTicket;

      // Prepend older messages (they're earlier in the conversation).
      //
      // 去重:流式期间新行不断落盘,total 在涨,而 fetchMore 是按"已加载条数"
      // 算 offset 从尾部取页 —— 这一页可能和已加载窗口重叠,直接 prepend 会出现
      // 重复消息。按 id 过滤掉已在 serverMessages 里的,再拼接。
      const existingIds = new Set(
        slot.serverMessages.map((m) => m.id).filter((id): id is string => typeof id === 'string'),
      );
      const freshOlder = olderMessages.filter(
        (m) => typeof m.id !== 'string' || !existingIds.has(m.id),
      );
      slot.serverMessages = [...freshOlder, ...slot.serverMessages];
      slot.hasMore = Boolean(data.hasMore);
      // offset 仍按"这一页服务端返回了多少条"推进(而非去重后的条数)——
      // 它对应服务端的分页游标位置,和本地去重无关。
      slot.offset = slot.offset + olderMessages.length;
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      // 失败必须**能被调用方区分**。原来是原样返回 slot,而调用方判成功看的是
      // `serverMessages.length === 0`(那是累计条数,不是"这次新增几条")——
      // 于是断网/500 被当成加载成功:pendingScrollRestore 被挂上却永远清不掉,
      // 这条会话从此不再自动跟底;自动补页还会连打 30 次请求且一声不吭。
      return null;
    }
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    const normalizedMessage =
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId };
    let updated = [...slot.realtimeMessages, normalizedMessage];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    const normalizedMessages = msgs.map((msg) =>
      msg.sessionId === sessionId
        ? msg
        : { ...msg, sessionId },
    );
    let updated = [...slot.realtimeMessages, ...normalizedMessages];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Re-fetch serverMessages from the provider sessions endpoint.
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
  ) => {
    const slot = getSlot(sessionId);
    const fetchTicket = ++slot._fetchSeq;
    try {
      // 只要回已经在手里的那个窗口,不要整份 transcript。
      //
      // 这个刷新每轮对话结束都会触发(complete 事件),而原来的请求不带 limit,
      // 于是三千轮的会话每轮都回传 42 MB,服务端光 JSON.stringify 就阻塞事件
      // 循环 190ms —— 单线程,那段时间所有用户的请求一起排队。
      //
      // 服务端 `sliceTailPage` 的语义正是"取末尾 N 条",所以传当前已加载条数
      // 就得到同一个窗口,内容不变、体积回到几百 KB。初次打开会话仍走
      // fetchFromServer 的分页路径,不受影响。
      const loadedCount = slot.serverMessages.length;
      const limit = Math.max(loadedCount, MESSAGES_PER_PAGE);
      const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=0`;
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;

      // A later-started fetch already applied: applying this stale transcript
      // would erase rows the user has already seen (and re-prune realtime
      // rows against an outdated snapshot).
      if (fetchTicket <= slot._appliedFetchSeq) {
        return;
      }
      slot._appliedFetchSeq = fetchTicket;

      slot.serverMessages = data.messages || [];
      slot.total = data.total ?? slot.serverMessages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.fetchedAt = Date.now();
      // Only drop realtime rows the server transcript now owns. A blind clear
      // here caused the chat pane to flash "Continue your conversation" after
      // `complete` while JSONL / provider_session_id indexing was still behind.
      slot.realtimeMessages = pruneRealtimeSupersededByServer(
        slot.serverMessages,
        slot.realtimeMessages,
      );
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  }, [getSlot, notify]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const slot = getSlot(sessionId);
    slot.status = status;
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  /**
   * 流式正文更新。**只动 `streamingText`,不碰列表、不重排。**
   *
   * 关键在于 `slot.merged` 的引用保持不变 —— 下游 `normalizedToChatMessages`、
   * 分组、key 表全是挂在它上面的 useMemo,引用不变它们就整体跳过。
   * 一次 flush 从"重排整份 transcript + 重建全部 React element"降到
   * "只重渲染那一个气泡"。
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const slot = getSlot(sessionId);
    if (slot.streamingText === accumulatedText && slot.streamingProvider === msgProvider) return;
    slot.streamingText = accumulatedText;
    slot.streamingProvider = msgProvider;
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  /**
   * 流式结束:把这段正文**一次性**提交进列表。
   *
   * id 在这一刻铸定,此后再也不变 —— 以前是"流式期间用 `__streaming_<sid>`、
   * 收尾换成随机新 id",key 一变 React 就卸载重建整条最终回答:markdown 全量
   * 重解析、代码块重走 Suspense、mermaid 重新 import、KaTeX 重排,高度先塌后涨。
   * 那就是每轮"答完猛跳一次"的来源。
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const text = slot.streamingText;
    slot.streamingText = null;
    if (!text) {
      notify(sessionId);
      return;
    }
    const committed: NormalizedMessage = {
      id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      timestamp: new Date().toISOString(),
      provider: slot.streamingProvider ?? 'claude',
      kind: 'text',
      role: 'assistant',
      content: text,
    };
    slot.realtimeMessages = capRealtime([...slot.realtimeMessages, committed]);
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [notify]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (slot) {
      slot.realtimeMessages = [];
      slot.streamingText = null;
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.merged ?? [];
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, []);

  /** 当前正在打字的正文(没有就是 null)。渲染在列表尾部,不进列表。 */
  const getStreamingText = useCallback((sessionId: string | null): string | null => (
    sessionId ? storeRef.current.get(sessionId)?.streamingText ?? null : null
  ), []);

  return useMemo(() => ({
    getSlot,
    has,
    getStreamingText,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    refreshFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    getMessages,
    getSessionSlot,
  }), [
    getSlot, has, getStreamingText, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, getMessages, getSessionSlot,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
