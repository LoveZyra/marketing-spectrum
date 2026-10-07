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

import { serverNow } from './serverClock';

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
  // 后台任务进展。故意不落库(每几秒一条),只走直播,见 server/shared/types.ts
  | 'task_progress'
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
  /**
   * 这条 error 是前端就地插的本地提示,不是这一轮的结果。
   *
   * 附件太大、文档解析失败、抓网页失败……与正在跑的那一轮毫无关系;`endsTurnForOutputs` 靠它放行,
   * 不把它当回合结束。这个字段要跟着走完全程:`chatMessageToNormalized` 的 error 分支和
   * `convertMessage` 都得保留它,丢在任何一段,拖个大附件就会把正在跑的清单折掉。
   */
  isLocalNotice?: boolean;
  /**
   * 用户这条的幂等键。本地回声带着它;服务端落库的用户行(和作为实时帧推来的同一行)也带着,
   * 前提是发送时带了 —— 定时任务、外部 API 写的行没有。本地回声与服务端那份按它配对
   * (见 claimRealtimeUserEchoes),合流消息的「撤回」也按它认气泡。
   */
  clientMessageId?: string;
  /** 合流消息没执行就被撤掉了(服务端落库时标的)。 */
  withdrawn?: boolean;
  /** 插话(合流进正在跑的这一轮),不是回合边界。服务端落库时标;本地回声在 ACK 带 mergedUuid 时补标。 */
  interjection?: boolean;
  /** 本地回声:发出时回合还在跑(进度区数回合用,见 ChatMessage.sentDuringTurn)。 */
  sentDuringTurn?: boolean;
  /**
   * 本地回声:打戳时这个标签页还没收到过带服务器时间的控制帧,时间戳是浏览器时间,
   * 浏览器表不准时可能差出几分钟。退回同文 + 时间窗配对时,只有这种回声才按宽的时钟偏差容忍
   * (见 claimRealtimeUserEchoes)。服务端来的行和校正过的回声都不带它。
   */
  clockUnsynced?: boolean;
  /** 这一轮推进 CLI 时带的 uuid(服务端落库的用户行才有);非 git 目录按它撤销这一轮之后的文件改动。 */
  turnUuid?: string;
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
  /**
   * 后台任务。`toolId` 就是那次 Task/Agent 调用的 `tool_use_id`,也就是子代理卡的身份;
   * 前端据此把进展与汇报归到卡上(见 useChatMessages)。
   */
  taskId?: string;
  taskProgress?: {
    toolUses?: number;
    totalTokens?: number;
    durationMs?: number;
    lastToolName?: string;
    subagentType?: string;
  };
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
   * 它不在 `realtimeMessages` 里,也不参与合并排序。放进列表的话,每 100ms 一次 flush
   * 都要全量重排、去重、重建全部 React element;它的时间戳还会被重锚到"现在",
   * 同期到达的工具行会在它上下来回换位,肉眼看到的就是"抖"。
   *
   * 时序上它天然可以独立:`stream_end` 在下一批工具行之前就到并提交,所以
   * 任意时刻最多只有一个活跃流式块,而且它一定在末尾,没必要参与排序。
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

export function createEmptySlot(): SessionSlot {
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
 * 同文 + 时间窗配对的窗口:服务端那份晚于本地回声多久以内还算它的回声。
 *
 * 只用于服务端行不带 `clientMessageId` 的情况(升级前写的老行、定时任务和外部 API 写的行),
 * 带键的行按键精确配对,见 `claimRealtimeUserEchoes`。
 */
const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
/**
 * 服务端那份早于本地回声时允许的时钟偏差,分两档。
 *
 * 服务端落库的时刻不早于用户发出的时刻,所以同一块表下服务端那份只会更晚。会更早,只因为
 * 回声的时间戳来自另一块表。回声按服务器时钟校正过(`serverNow()`,见 stores/serverClock)时,
 * 剩下的误差只有几秒,留 10 秒就够;再放宽的话,几分钟前同文的那一句(「继续」「好」)
 * 会把刚发的这一句认领掉,这一轮整轮看不到自己的提问。
 *
 * 打戳时还没有时钟样本的回声(`clockUnsynced`)用的是浏览器时间。客户端表快一些
 * (手动设过时间、虚机 / 手机 NTP 没同步)就会判成两条:用户自己发的话渲染两遍、页内无法自愈,
 * 回合序号还会整体错位,连锁污染 thinking / 正文的去重。所以这种回声与上面的窗口对称,两侧都容忍几分钟。
 */
const LOCAL_USER_DEDUPE_SYNCED_SKEW_MS = 10 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 5 * 60 * 1000;

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

function isUserTextRow(m: NormalizedMessage): boolean {
  return m.kind === 'text' && m.role === 'user';
}

/**
 * 本地回声 ↔ 服务端用户行的配对:返回已被服务端那份认领了的实时用户行的 id。
 *
 * 发送时前端先画一条乐观回声,服务端落库的那一行带着同一个 `clientMessageId`
 * (同一行作为实时帧推来时也带着)。判据:
 *   - 服务端行带着同一个键:就是它的回声,正文不必逐字相同(服务端那份可能带着附件块);
 *   - 服务端行带着别的键:一定不是,哪怕同文、同一秒;
 *   - 服务端行没有键(升级前写的老行、定时任务和外部 API 写的行):退回同文 + 时间窗,
 *     服务端那份早于回声的容忍度见 `LOCAL_USER_DEDUPE_SYNCED_SKEW_MS`。
 * 一条服务端行最多认领一条实时行:先按键配对,剩下的再按时间先后与无键行逐条配对。
 * 只靠同文 + 宽时间窗、又不限一对一的话,两分钟前那句「继续」会把刚发的这句也认领掉,
 * 这一轮整轮看不到自己的提问,回合序号也会把两轮并成一轮。
 *
 * `computeMerged`、`pruneRealtimeSupersededByServer` 与回合序号用的都是这一份判据。
 */
function claimRealtimeUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
  serverIds: ReadonlySet<string>,
): Set<string> {
  const claimed = new Set<string>();
  const candidates = realtimeMessages.filter((m) => isUserTextRow(m) && !serverIds.has(m.id));
  if (candidates.length === 0) return claimed;

  const keyed = new Map<string, NormalizedMessage>();
  const unkeyedByText = new Map<string, NormalizedMessage[]>();
  for (const serverMessage of serverMessages) {
    if (!isUserTextRow(serverMessage)) continue;
    if (serverMessage.clientMessageId) {
      if (!keyed.has(serverMessage.clientMessageId)) keyed.set(serverMessage.clientMessageId, serverMessage);
      continue;
    }
    const text = userTextFingerprint(serverMessage);
    if (!text) continue;
    const list = unkeyedByText.get(text);
    if (list) list.push(serverMessage);
    else unkeyedByText.set(text, [serverMessage]);
  }

  const used = new Set<NormalizedMessage>();
  const unmatched: NormalizedMessage[] = [];
  for (const candidate of candidates) {
    const echo = candidate.clientMessageId ? keyed.get(candidate.clientMessageId) : undefined;
    if (echo && !used.has(echo)) {
      used.add(echo);
      claimed.add(candidate.id);
    } else {
      unmatched.push(candidate);
    }
  }

  if (unkeyedByText.size === 0) return claimed;
  unmatched.sort(compareMessagesChronologically);
  for (const candidate of unmatched) {
    const text = userTextFingerprint(candidate);
    const localTime = readMessageTime(candidate);
    if (!text || localTime === null) continue;
    const skew = candidate.clockUnsynced ? LOCAL_USER_DEDUPE_CLOCK_SKEW_MS : LOCAL_USER_DEDUPE_SYNCED_SKEW_MS;
    const echo = unkeyedByText.get(text)?.find((serverMessage) => {
      if (used.has(serverMessage)) return false;
      const serverTime = readMessageTime(serverMessage);
      return (
        serverTime !== null
        && serverTime >= localTime - skew
        && serverTime - localTime <= LOCAL_USER_DEDUPE_WINDOW_MS
      );
    });
    if (echo) {
      used.add(echo);
      claimed.add(candidate.id);
    }
  }
  return claimed;
}

function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

/** 这个数组已经按时间排好了吗 —— 一趟线性扫描。 */
function isChronological(list: readonly NormalizedMessage[]): boolean {
  for (let i = 1; i < list.length; i += 1) {
    if (compareMessagesChronologically(list[i - 1], list[i]) > 0) return false;
  }
  return true;
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
   * 预先排好的合并视图。不传就地排一次,但热路径上必须传:这个函数会对每一条
   * realtime 行调用一次,而排序的是 server + realtime 全量(40 条 realtime × 3000 条 server
   * 约 75 ms,realtime 上限是 500 条)。
   */
  presortedMerged?: NormalizedMessage[],
  /** 已被服务端那份认领的实时用户行(见 claimRealtimeUserEchoes)。热路径上同样预先算好传进来。 */
  claimedEchoes?: ReadonlySet<string>,
): number {
  const messageTime = readMessageTime(message);
  let userCount = 0;
  const serverIds = new Set(serverMessages.map((serverMessage) => serverMessage.id));
  const claimed = claimedEchoes ?? claimRealtimeUserEchoes(serverMessages, realtimeMessages, serverIds);

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
      /**
       * 同一条用户消息只算一次。
       *
       * 合并视图里同一句话常常有两份:实时那份和服务端落库那份。`computeMerged` 的去重是
       * 渲染时做的,而这里数的是原始合并数组;多算的话,按"同一轮同文"判定的 thinking /
       * 助手正文去重就会漏删(序号对不上)或跨回合误删。
       *
       * 判据是"这条是不是服务端那份"(id 是否出现在服务端快照里),不是"id 像不像 `local_`":
       * 队列续发、回放补帧以及任何由服务端帧构造出的实时用户行都不是 `local_` 形状。
       *
       * 回声判定复用 `claimRealtimeUserEchoes`(按幂等键、一对一),所以刚发的「继续」不会被上一轮
       * 那句同文消息认领(纯比正文会让第二轮的序号少算一,thinking 去重整体错位一个回合)。
       */
      if (serverIds.has(candidate.id)) {
        userCount++;
      } else if (!claimed.has(candidate.id)) {
        userCount++;
      }
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
  // thinking 行也走同一套"同一轮里服务端有没有同文"判定,只是 kind 不同。
  kind: 'text' | 'thinking' = 'text',
  claimedEchoes?: ReadonlySet<string>,
): boolean {
  const assistantText = (message.content || '').trim();
  if (!assistantText) {
    return false;
  }

  const turnOrdinal = getUserTurnOrdinalBefore(message, serverMessages, realtimeMessages, presortedMerged, claimedEchoes);
  const turnRange = findServerTurnRangeByOrdinal(serverMessages, turnOrdinal);
  if (!turnRange) {
    return false;
  }

  return serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .some((serverMessage) =>
      serverMessage.kind === kind
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
export function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  // 回声配对一次算完(一对一,不能逐条各判各的),下面的用户行与回合序号都用它。
  const claimed = claimRealtimeUserEchoes(serverMessages, realtimeMessages, serverIds);

  // 合并视图只排一次,传给下面每一次判定复用;每条 realtime 行各排一遍全量是
  // O(R × (S+R) log(S+R)),40 × 3000 就要约 75 ms,而 realtime 上限 500 条。
  // 只在真会用到时才排:纯 user 行的分支根本不需要。
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

    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages, mergedView(), 'text', claimed)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages, mergedView(), 'text', claimed)) {
        return false;
      }
      return true;
    }

    // 本地回声与其他实时用户行同一个判据(按幂等键、一对一)
    if (message.kind === 'text' && message.role === 'user') {
      return !claimed.has(message.id);
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    /*
     * tool_result 与 thinking 也要有清理规则,不能落到下面的 `return true`:id 和服务端那份
     * 对不上时(服务端补了 id、或前端那份是本地合成的),它们会永远留在 realtime 里,
     * 和服务端那份并排渲染成两份,只有 F5 能清掉。
     *
     * 判据和邻居对齐:tool_result 按 toolId(与 tool_use 同源);thinking 按"同一轮里服务端有同文"
     * (与助手正文同一套)。都只在服务端确实有对应行时才清,还没落库的照旧留着;
     * 这条边界不能动,否则回合进行中正文会闪空。
     */
    if (message.kind === 'tool_result' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_result' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    if (message.kind === 'thinking') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages, mergedView(), 'thinking', claimed)) {
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
  // 服务端那份已经在的用户行(按幂等键配对,无键时退回同文 + 时间窗,一对一)不再画第二个气泡;
  // 判据与 pruneRealtimeSupersededByServer 是同一份。
  const claimed = claimRealtimeUserEchoes(server, realtime, serverIds);
  const extra = realtime.filter((message) => !serverIds.has(message.id) && !claimed.has(message.id));

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

/**
 * realtime 行的上限。提交流式正文和逐条追加共用同一个口径。
 *
 * 超出时从最早的行裁起,但用户行留着。长回合(几百次工具调用、带子代理)会在回合进行中把 realtime
 * 撑过上限,而回合进行中没有服务端刷新,裁掉的本轮提问在 complete 之前补不回来,上翻看到的是
 * "上一轮回答 → 本轮第 N 个工具"。一轮只有一条用户行,留着它们几乎不占名额;
 * 只在除了用户行再没有可裁的时候,才裁最早的用户行。
 */
function capRealtime(rows: NormalizedMessage[]): NormalizedMessage[] {
  let overflow = rows.length - MAX_REALTIME_MESSAGES;
  if (overflow <= 0) return rows;
  const kept: NormalizedMessage[] = [];
  for (const row of rows) {
    if (overflow > 0 && !isUserTextRow(row)) {
      overflow -= 1;
      continue;
    }
    kept.push(row);
  }
  return overflow > 0 ? kept.slice(overflow) : kept;
}

/**
 * 槽位 LRU 上限与保护窗。
 *
 * 原设计是"切会话不清、旧数据全留"—— 换回上一个会话零等待。但槽位从不
 * 淘汰意味着逛几十个长会话后内存只涨不落(每个槽位攥着全量消息数组和它们
 * 的 merged 副本)。折中:保留最近用过的 N 个,其余在切会话这个自然
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

/**
 * 流式正文提交进列表时打的时间戳。
 *
 * 它要和前后的工具行(服务器时间)按时间戳混排,所以优先用触发提交的那一帧自己带的服务器时间;
 * 帧上没有(或解析不了)时用"浏览器时间 + 服务器时钟偏差"(见 serverClock)。直接用浏览器时间的话,
 * 浏览器表不准时这段正文会和它前后的工具行换位。
 */
export function streamCommitTimestamp(serverTimestamp: unknown, localNow: number = Date.now()): string {
  if (typeof serverTimestamp === 'string' && Number.isFinite(Date.parse(serverTimestamp))) {
    return new Date(Date.parse(serverTimestamp)).toISOString();
  }
  return new Date(serverNow(localNow)).toISOString();
}

/** 本地乐观回声(`local_*` 的用户行)带的幂等键;不是本地回声返回 null。 */
function localEchoKey(m: NormalizedMessage): string | null {
  return isUserTextRow(m) && m.id.startsWith('local_') && m.clientMessageId ? m.clientMessageId : null;
}

/** 服务端来的用户行(实时帧)带的幂等键;本地回声、没带键的行返回 null。 */
function serverUserKey(m: NormalizedMessage): string | null {
  return isUserTextRow(m) && !m.id.startsWith('local_') && m.clientMessageId ? m.clientMessageId : null;
}

/**
 * 实时行按 id 落位:同一个 id 再来一次是覆盖,不是追加。
 *
 * 同一个事件会来第二次:
 *   - 断线重连按游标补发,而游标只为部分 kind 推进(审批帧故意不推),
 *     补发窗口会盖住一些已经收到的帧;
 *   - 订阅重叠(旧 socket 还没关、新 socket 已经补发)时整段重放;
 *   - seq 跳号触发的 REST 补拉与随后的实时帧,在服务端行落库前是两份。
 * 直接追加的话,同一个工具调用、同一段 thinking 会并排出现两次,
 * 要等服务端接管后 `pruneRealtimeSupersededByServer` 才整体剪掉。
 *
 * 覆盖而不是丢弃:后到的那份通常更完整(工具调用补上了结果、流式块补上了尾巴)。
 * 位置保持第一次出现的位置,否则一条早先的工具行会被重排到末尾,屏幕上的顺序会跳。
 *
 * 用户消息的实时帧(服务端落库那一行同时推给所有查看者)与本地回声按幂等键对上:
 * 帧到时原位替换掉同键的本地回声(id 换成服务端的,之后服务端快照里同 id 的行按上面的规则接管);
 * 帧先到、回声后到时回声不再追加。发起端因此不会出现两份。
 */
export function upsertRealtimeRows(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
  sessionId: string,
): NormalizedMessage[] {
  if (incoming.length === 0) return existing;

  const normalized = incoming.map((msg) => (
    msg.sessionId === sessionId ? msg : { ...msg, sessionId }
  ));

  const indexById = new Map<string, number>();
  const echoIndexByKey = new Map<string, number>();
  const serverUserKeys = new Set<string>();
  const remember = (msg: NormalizedMessage, index: number) => {
    const echoKey = localEchoKey(msg);
    if (echoKey) echoIndexByKey.set(echoKey, index);
    const userKey = serverUserKey(msg);
    if (userKey) serverUserKeys.add(userKey);
  };
  for (let i = 0; i < existing.length; i++) {
    indexById.set(existing[i].id, i);
    remember(existing[i], i);
  }

  const next = existing.slice();
  for (const msg of normalized) {
    const at = indexById.get(msg.id);
    if (at !== undefined) {
      next[at] = msg;
      continue;
    }
    const echoKey = localEchoKey(msg);
    if (echoKey && serverUserKeys.has(echoKey)) continue;
    const userKey = serverUserKey(msg);
    const echoAt = userKey ? echoIndexByKey.get(userKey) : undefined;
    if (userKey && echoAt !== undefined) {
      indexById.delete(next[echoAt].id);
      echoIndexByKey.delete(userKey);
      indexById.set(msg.id, echoAt);
      next[echoAt] = msg;
      serverUserKeys.add(userKey);
      continue;
    }
    indexById.set(msg.id, next.length);
    remember(msg, next.length);
    next.push(msg);
  }

  return capRealtime(next);
}

/**
 * 从实时行里撤掉某条没发出去的本地回声(服务端排队后被中止 / 撤销 / 过期的那条)。
 *
 * 只撤 `local_*` 的回声:这条从没落库,服务端那份永远不会来替掉它,不撤的话它像"已发送"一样
 * 一直留到 F5,用户把退回的正文再发一遍时还会并排出现两条。返回被撤掉的那行(调用方要它的正文)。
 */
export function withoutLocalEcho(
  rows: NormalizedMessage[],
  clientMessageId: string,
): { rows: NormalizedMessage[]; removed: NormalizedMessage | null } {
  const index = rows.findIndex((row) => localEchoKey(row) === clientMessageId);
  if (index < 0) return { rows, removed: null };
  return { rows: [...rows.slice(0, index), ...rows.slice(index + 1)], removed: rows[index] };
}

export type SnapshotMode = 'replace' | 'prepend';

/**
 * 服务端快照落地的唯一入口(`applyServerSnapshot`)。
 *
 * 首屏(`fetchFromServer`)、刷新(`refreshFromServer`)、补页(`fetchMore`)、搜索定位
 * 四条路径都走这里:怎么合并、剪实时行、游标怎么推只有一份规则,差别只在 `mode` 这一个参数。
 * 各写一遍的话,每加一条规则都得记得改四处,迟早漏掉一处。
 */
export function applyServerSnapshot(
  slot: SessionSlot,
  data: { messages?: NormalizedMessage[]; total?: number; hasMore?: boolean; tokenUsage?: unknown },
  opts: { mode: SnapshotMode; offsetBase?: number },
): void {
  const incoming: NormalizedMessage[] = data.messages || [];

  if (opts.mode === 'prepend') {
    /**
     * 补页是前插。去重按 id:流式期间新行不断落盘、`total` 在涨,而补页按
     * "已加载条数"算 offset 从尾部取页,这一页可能与已加载窗口重叠。
     */
    const existingIds = new Set(
      slot.serverMessages.map((m) => m.id).filter((id): id is string => typeof id === 'string'),
    );
    const freshOlder = incoming.filter((m) => typeof m.id !== 'string' || !existingIds.has(m.id));
    const prepended = [...freshOlder, ...slot.serverMessages];
    /**
     * 前插之后要确认它真的是"更早的"。
     *
     * 服务端的 `offset` 是尾部偏移。回合跑着、`total` 在涨,而这期间没有任何整体刷新落地
     * (`complete` 还没到;`externalMessageUpdate` 在 `isProcessing` 时刻意跳过 refresh;seq 没跳号)
     * 时上翻一页,服务端按新的 total 算窗口,取回的那一页尾部可能落在已有窗口之后:
     * 那几行比手里所有行都新,却不在 `existingIds` 里,会被当成"更早的一页"塞到数组最前面。
     * 这条落地路径紧接着会 prune 掉它们的实时副本,`computeMerged` 随后走"realtime 为空就
     * 原样返回 server"的快路径、不排序,本轮最新的几条就会跳到 transcript 最顶端。
     *
     * 只在真的乱了的时候排一次:绝大多数补页都是纯粹的更早页,`isChronological`
     * 一趟线性扫描就结束,不额外付 O(n log n)。
     */
    slot.serverMessages = isChronological(prepended)
      ? prepended
      : [...prepended].sort(compareMessagesChronologically);
    // 游标按"服务端这一页返回了多少条"推进(不是去重后的条数)——
    // 它对应服务端的分页位置,与本地去重无关。
    slot.offset = slot.offset + incoming.length;
    if (typeof data.total === 'number') slot.total = data.total;
    slot.hasMore = Boolean(data.hasMore);
  } else {
    slot.serverMessages = incoming;
    /**
     * 游标必须跟着窗口一起改写。
     *
     * `limit` 是在 await 之前按当时的 loadedCount 算的,而这中间用户可能
     * 刚上翻了一页。刷新随后落地把窗口换回尾部 20 条,如果把 offset 留在 40,
     * 下一次「看更早」按 offset=40 去取,服务端的尾部偏移语义直接跳过
     * 倒数 20~40 那一段,20 条消息永久缺失且毫无提示。
     */
    slot.offset = (opts.offsetBase ?? 0) + incoming.length;
    slot.total = data.total ?? incoming.length;
    slot.hasMore = Boolean(data.hasMore);
  }

  /**
   * 四条路径都剪实时行。
   *
   * `computeMerged` 对服务端行只按 id 去重,而实时帧的 id 是服务端现生成的、REST 历史的 id
   * 来自 jsonl 的 uuid,两边永远对不上。真正按 toolId / 同轮同文去重的规则全在
   * `pruneRealtimeSupersededByServer` 里。
   *
   * 前插之后同样要剪:补页带回来的正是"更早那一段"的服务端行,而实时里可能还留着它们的副本
   * (后台跑完、没被 refresh 剪过的那一轮)。按合并后的完整已加载快照剪,不是只按这一页,
   * 否则会把尚未落盘的实时行误删。
   */
  slot.realtimeMessages = pruneRealtimeSupersededByServer(
    slot.serverMessages,
    slot.realtimeMessages,
  );

  if (data.tokenUsage) slot.tokenUsage = data.tokenUsage;
  slot.fetchedAt = Date.now();
  recomputeMergedIfNeeded(slot);
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

      /**
       * A later-started fetch already applied: this response is stale.
       *
       * 返回 null 而不是 slot,让调用方能区分"被丢弃"与"成功",否则调用方会把别人落地的窗口
       * 当成自己这次的结果。比如搜索跳转发起的 `limit:null` 全量拉取被一次普通刷新挤掉后,
       * 调用方照样执行 `setAllMessagesLoaded(true)` / `hasMore=false` / `offset=slot.total`,
       * 界面认定"全部已加载",上翻分页从此关死。
       */
      if (fetchTicket <= slot._appliedFetchSeq) {
        return null;
      }
      slot._appliedFetchSeq = fetchTicket;

      /** 首屏 / 搜索定位统一走 `applyServerSnapshot`(mode='replace'),规则只有一份。 */
      applyServerSnapshot(slot, data, { mode: 'replace', offsetBase: opts.offset ?? 0 });
      slot.status = 'idle';

      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
      // Don't clobber a newer fetch's result with a stale failure.
      if (fetchTicket > slot._appliedFetchSeq) {
        slot.status = 'error';
        notify(sessionId);
      }
      /**
       * 失败也返回 null,与上面"被更新的请求顶替了"那条一致。
       *
       * 调用方只判 `if (slot)` 就照着它写 `hasMore` / `total`;失败时 slot 还是初始值
       * (`hasMore=false`、`total=0`),返回它的话,一次网络失败就和"加载完了,没有更多"一模一样:
       * 「加载更多 / 看更早 / 加载全部」三个入口一起消失,而实际上一条历史都没拉到。
       */
      return null;
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
      /*
        404 = 这条会话已经不在了(被别处永久删除),是"没有更多历史可加载",不是加载失败:
        落下 hasMore、当"到头了"返回。不要抛错或返回 null,否则控制台多一条 `HTTP 404` 噪声,
        自动补页还会把它当失败一直重试。
      */
      if (response.status === 404) {
        slot.hasMore = false;
        notify(sessionId);
        return slot;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;

      // A full fetch/refresh replaced serverMessages while this page was in
      // flight — prepending onto the new array would duplicate or misorder.
      if (fetchTicket <= slot._appliedFetchSeq) {
        return slot;
      }
      slot._appliedFetchSeq = fetchTicket;

      /**
       * 补页走 `applyServerSnapshot`(mode='prepend'),同样会剪实时行:后台跑完的那一轮留在
       * realtime 里,上翻把它对应的服务端行取回来之后,不剪的话两份会一直并排渲染到 F5。
       */
      applyServerSnapshot(slot, data, { mode: 'prepend' });
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      // 失败必须能被调用方区分,所以返回 null:slot 的 `serverMessages.length` 是累计条数,
      // 不能拿来判断这次成没成。把断网 / 500 当成加载成功,pendingScrollRestore 会挂上却永远
      // 清不掉,会话从此不再自动跟底,自动补页还会连打 30 次请求且一声不吭。
      return null;
    }
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    slot.realtimeMessages = upsertRealtimeRows(slot.realtimeMessages, [msg], sessionId);
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * 一轮结束:回合在跑时发出、又没被合流的本地回声(被服务端排到后面的那条)从这里起就是
   * 下一轮的开头了,摘掉 `sentDuringTurn`,进度区照常把它算成新回合。不等服务端那份落库行替掉它:
   * 收尾时的刷新可能抢在服务端落库之前,那样这条标记会一直挂到下一轮结束。
   */
  const clearSentDuringTurn = useCallback((sessionId: string) => {
    const slot = getSlot(sessionId);
    let changed = false;
    const next = slot.realtimeMessages.map((row) => {
      if (!row.sentDuringTurn || row.interjection) return row;
      changed = true;
      const { sentDuringTurn: _cleared, ...rest } = row;
      void _cleared;
      return rest;
    });
    if (!changed) return;
    slot.realtimeMessages = next;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * ACK 说这条被合流进了正在跑的那一轮:给本地回声补上 `interjection`(时间轴不把它当回合边界)。
   */
  const markInterjection = useCallback((sessionId: string, clientMessageId: string) => {
    const slot = getSlot(sessionId);
    let changed = false;
    const next = slot.realtimeMessages.map((row) => {
      if (row.clientMessageId !== clientMessageId || row.interjection) return row;
      changed = true;
      return { ...row, interjection: true };
    });
    if (!changed) return;
    slot.realtimeMessages = next;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * 服务端说这条没有发出去(排队后被中止 / 撤销 / 过期,准备期被停止):把它的本地回声撤掉。
   * 返回被撤掉的那行(没有就是 null),调用方据此决定提示里要不要抄原文。
   */
  const dropUnsentEcho = useCallback((sessionId: string, clientMessageId: string): NormalizedMessage | null => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return null;
    const { rows, removed } = withoutLocalEcho(slot.realtimeMessages, clientMessageId);
    if (!removed) return null;
    slot.realtimeMessages = rows;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
    return removed;
  }, [notify]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    slot.realtimeMessages = upsertRealtimeRows(slot.realtimeMessages, msgs, sessionId);
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
      // 这个刷新每轮对话结束都会触发(complete 事件)。不带 limit 的话,三千轮的会话每轮都要
      // 回传几十 MB,服务端光 JSON.stringify 就阻塞事件循环约 190ms,那段时间所有用户的请求一起排队。
      //
      // 服务端 `sliceTailPage` 的语义正是"取末尾 N 条",所以传当前已加载条数就得到同一个窗口,
      // 体积只有几百 KB。初次打开会话仍走 fetchFromServer 的分页路径。
      const loadedCount = slot.serverMessages.length;
      const limit = Math.max(loadedCount, MESSAGES_PER_PAGE);
      const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=0`;
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;

      /**
       * 这份快照比手里的窄,就别落地。
       *
       * `limit` 是在 `await` 之前按当时的条数冻结的。用户滚到顶等答案时上翻一页(+20 条),
       * 几十毫秒后 `complete` 触发这次刷新,它的 limit 还是旧的那个数。补页先落地(220 条),
       * 刷新后落地:票更大所以能通过下面那道检查,整份替换成尾部 200 条,刚翻出来的 20 条
       * 原地消失,守位锚点跟着失效、视口再跳一次。
       *
       * 票据只能回答"谁更晚发起",回答不了"谁覆盖得更全",而这里票更新的那个请求恰恰是按
       * 更小的窗口构造的,所以票据之外再加这一条。丢掉即可:下一轮 complete 还会再刷,那时 limit 是新的。
       */
      if (slot.serverMessages.length > limit) {
        return;
      }

      // A later-started fetch already applied: applying this stale transcript
      // would erase rows the user has already seen (and re-prune realtime
      // rows against an outdated snapshot).
      if (fetchTicket <= slot._appliedFetchSeq) {
        return;
      }
      slot._appliedFetchSeq = fetchTicket;

      /** 刷新走 `applyServerSnapshot`(mode='replace',offsetBase=0);游标改写与实时行剪除的规则见那里。 */
      applyServerSnapshot(slot, data, { mode: 'replace' });
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
   * 流式正文更新。只动 `streamingText`,不碰列表、不重排。
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
   * 流式结束:把这段正文一次性提交进列表。
   *
   * id 在这一刻铸定,此后再也不变:列表里的 key 一变,React 就会卸载重建整条最终回答,
   * markdown 全量重解析、代码块重走 Suspense、mermaid 重新 import、KaTeX 重排,
   * 高度先塌后涨,每轮答完都会猛跳一次。
   *
   * `serverTimestamp` 是触发提交的那一帧(stream_end / complete)上的服务器时间,
   * 时间戳取法见 `streamCommitTimestamp`。
   */
  const finalizeStreaming = useCallback((sessionId: string, serverTimestamp?: unknown) => {
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
      timestamp: streamCommitTimestamp(serverTimestamp),
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
    markInterjection,
    clearSentDuringTurn,
    dropUnsentEcho,
  }), [
    getSlot, has, getStreamingText, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer, markInterjection, clearSentDuringTurn, dropUnsentEcho,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, getMessages, getSessionSlot,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
