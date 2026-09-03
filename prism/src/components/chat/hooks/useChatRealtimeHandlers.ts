import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { emitToast } from '../../../shared/view/ui/toastBus';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '../../../utils/notificationSound';
import type { MarkSessionIdle, MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import { isCompactionActivity } from '../utils/compactionProgress';
import { createDropWarner, learnRunSession, resolveEventSid } from '../utils/eventRouting';
import type { PendingPermissionRequest } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

/**
 * 这一帧该不该推进 `lastSeq`(重连/切回来时的补发游标)。
 *
 * 规则是"只为**留下来的**帧推进"。permission 那两种帧是唯一的例外,而这个例外
 * 不是洁癖:它们既不进 store(见 `shouldPersist`),又会在不属于当前所看会话时
 * 被直接丢弃 —— 却照样推进过游标。后果是一条**永远回不来**的审批请求:切回那个
 * 会话时 `chat.subscribe` 带的 `lastSeq` 已经越过它,`replayEvents` 不补发,
 * 而没有任何地方存过它。整页刷新反倒能救回来(游标随 ref 一起清零),页内切换永远不能。
 */
export const advancesReplayCursor = (kind: unknown): boolean =>
  kind !== 'permission_request' && kind !== 'permission_cancelled';

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

interface UseChatRealtimeHandlersArgs {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /** 每会话一个批处理定时器,键是 sessionId。 */
  streamTimerRef: MutableRefObject<Map<string, number>>;
  /** 每会话一段流式缓冲,键是 sessionId。 */
  accumulatedStreamRef: MutableRefObject<Map<string, string>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  /** 每条会话的补发游标:记住它属于哪一轮,轮次一换就从头算。 */
  lastSeqRef: MutableRefObject<Map<string, { runId: string | null; seq: number }>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  sessionStore: SessionStore;
  /** prism: a git checkpoint was captured before the turn started. */
  onCheckpointCreated?: (payload: { sessionId: string | null; checkpoint: Record<string, unknown> }) => void;
  /** prism: post-turn changed-files summary relative to the checkpoint. */
  onChangedFiles?: (payload: { sessionId: string | null; checkpointId: string | null; files: unknown[]; truncated?: boolean; cwd?: string | null }) => void;
  /**
   * F7:服务端排队状态变了(收下/撤销/续发)。
   *
   * 与 composer 自己那份浏览器内的排队是两回事:这一份**存在服务端**,所以
   * 刷新页面、换设备、甚至关掉标签页之后它都还在,也因此必须由服务端的帧来
   * 驱动显示,不能靠本地状态推断。
   */
  onServerQueueChange?: (sessionId: string, queued: { preview: string; enqueuedAt: string } | null) => void;
  /** 排队被中止带走时把正文退回输入框;回填成功返回 true(输入框非空时不覆盖)。 */
  onServerQueueReturned?: (sessionId: string, content: string) => boolean;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
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
  onWebSocketReconnect,
  sessionStore,
  onCheckpointCreated,
  onChangedFiles,
  onServerQueueChange,
  onServerQueueReturned,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  // dk:runId → sessionId 的归属映射与丢帧告警。effect 重跑(依赖变化)不清空 ——
  // 映射跨订阅有效,正跑着的回合换个渲染周期不该失忆。
  const runSessionMapRef = useRef(new Map<string, string>());
  const warnDroppedRef = useRef(createDropWarner());
  // dm:每会话上次因 seq 空洞触发 REST 补拉的时刻(节流用)。
  const gapRefreshAtRef = useRef(new Map<string, number>());
  /**
   * dv:**丢帧判定**专用的 seq 水位(与补发游标 `lastSeqRef` 分开)。
   *
   * 服务端给**每一帧**都分配 seq(含 permission),而 `advancesReplayCursor`
   * 故意不为审批帧推进补发游标 —— 于是紧随审批之后的那一帧必然满足
   * `seq > known.seq + 1`,被当成丢帧:每弹一次工具审批就误触发一次全量
   * `refreshFromServer`(5 秒节流也挡不住每次审批各来一发),重连重放时同样
   * 必中。水位分开之后,补发语义不变,而丢帧判定按真实序号走。
   */
  const gapSeqRef = useRef(new Map<string, { runId: string | null; seq: number }>());

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      /**
       * dk:归属改为「自带 sessionId → 按 runId 查映射 → 查不到就是 null」。
       * **不再兜底到"当前正在看的会话"** —— 那个兜底正是"别的会话的折叠时间轴
       * 钉在每个页面顶端、F5 才消失"的根因:后台回合的边角帧没带会话 id,
       * 全被记到你正看的页面头上,而服务端 transcript 不认它们,永远清不掉。
       * 归属不明的帧只当控制帧,该丢的丢并 warn;唯一例外是 protocol_error
       * (对本客户端刚发出的动作的直接回话),在它自己的分支里单独兜底。
       */
      learnRunSession(runSessionMapRef.current, msg);
      const sid = resolveEventSid(runSessionMapRef.current, msg);

      // 补发游标。**必须连 runId 一起记** —— seq 是每轮从 0 重新开始的,
      // 只记 seq 的话:第 1 轮跑到 40,第 2 轮在 20 处断线重连,带着 40 去要补发,
      // `seq > 40` 一条都匹配不上,第 2 轮已发生的内容全部丢失,而且整轮游标都
      // 不会推进 —— 此后每次重连都命中同一个空洞。轮次一换,游标从头算。
      // (dk 起 sid 一定是真实归属 —— 之前兜底到"正看的会话"时,后台帧会把
      // 别的会话的 runId+seq 写进当前会话的游标,补发从此对不上号。)
      if (sid && typeof msg.seq === 'number') {
        const runId = typeof msg.runId === 'string' ? msg.runId : null;

        // dm:seq 跳号 = 中间有帧没送到(重放缓冲被字节预算裁掉,或超窗断线)。
        // 此前这种丢失是**静默**的 —— 用户只是"感觉少了点什么"。REST 是权威
        // 来源,拉一次尾窗把窟窿补上,把"静默丢内容"变成"多一次刷新"。
        // 5 秒节流:一个洞后面往往跟着一串跳号帧,补一次就够。
        // dv:按**全部帧**的水位判定(审批帧也占号,见 gapSeqRef 的说明)。
        const seen = gapSeqRef.current.get(sid);
        const sameSeenRun = seen && seen.runId === runId;
        if (sameSeenRun && msg.seq > seen.seq + 1) {
          const lastRefreshAt = gapRefreshAtRef.current.get(sid) ?? 0;
          if (Date.now() - lastRefreshAt > 5_000) {
            gapRefreshAtRef.current.set(sid, Date.now());
            void sessionStore.refreshFromServer(sid);
          }
        }
        if (!sameSeenRun || msg.seq > seen.seq) {
          gapSeqRef.current.set(sid, { runId, seq: msg.seq });
        }

        // 补发游标:仍然只为**留下来的**帧推进(审批帧的例外见 advancesReplayCursor)。
        if (advancesReplayCursor(msg.kind)) {
          const known = lastSeqRef.current.get(sid);
          const sameRun = known && known.runId === runId;
          if (!sameRun || msg.seq > known.seq) {
            lastSeqRef.current.set(sid, { runId, seq: msg.seq });
          }
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          // F7:服务端排队状态随 ack 一起回来 —— 刷新后"有一条在等"这件事
          // 不能只活在发起它的那个标签页里。
          onServerQueueChange?.(
            sid,
            (msg.queued as { preview: string; enqueuedAt: string } | null) ?? null,
          );

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          // 直接回话类帧:没带会话 id 时归到正在看的会话**展示**是合理的 ——
          // 它就是对这个客户端刚发出的动作的回应。只用于展示,不进游标。
          const errorSid = sid || activeViewSessionId;
          if (errorSid) {
            // 多数 protocol_error 意味着这一轮压根没开起来(也就不会有 complete),
            // 所以要顺手把转圈停掉。**但有两个 code 恰恰相反**:
            //   QUEUE_FULL —— 是在 startRun 返回 null(回合正跑着)且已有排队时发的;
            //   SESSION_HELD_BY_SHELL —— 终端正接管着这段对话,回合也在跑。
            // 这两种情况下标成空闲,会让转圈消失、停止按钮跟着失效,而回合还在跑
            // (和 da 修掉的是同一类"界面进入了没有出口的状态")。
            const runStillAlive = msg.code === 'QUEUE_FULL' || msg.code === 'SESSION_HELD_BY_SHELL';
            if (!runStillAlive) {
              onSessionIdle?.(errorSid);
            }
            sessionStore.appendRealtime(errorSid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: errorSid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // F7:服务端排队(chat.send 撞上在跑的回合时收下的那一条)。
        case 'chat_queued': {
          if (!sid) return;
          onServerQueueChange?.(sid, {
            preview: String(msg.preview ?? ''),
            enqueuedAt: String(msg.enqueuedAt ?? new Date().toISOString()),
          });
          return;
        }

        case 'chat_queue_cancelled':
        case 'chat_queue_flushed': {
          if (!sid) return;
          onServerQueueChange?.(sid, null);
          // 被中止带走 / 过期作废的那条要说一声 —— 否则用户只会看到消息凭空消失。
          // 被中止带走的那条:正文退回输入框(见 dropPendingSend)。
          // 回填成功就不用再写那条"已取消"的提示了 —— 东西还在用户手上。
          if (
            msg.kind === 'chat_queue_cancelled'
            && msg.reason === 'aborted'
            && typeof msg.content === 'string'
            && msg.content
            && onServerQueueReturned?.(sid, msg.content)
          ) {
            return;
          }
          if (msg.kind === 'chat_queue_cancelled' && msg.reason !== 'cancelled') {
            sessionStore.appendRealtime(sid, {
              id: `queue_${msg.reason}_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: msg.reason === 'aborted'
                ? '排队中的那条消息随本轮中止一起取消了,没有发送。'
                : '排队中的那条消息等待超过 30 分钟,已作废,没有发送。',
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text) return;
        if (!sid) { warnDroppedRef.current(msg); return; }
        const buffers = accumulatedStreamRef.current;
        buffers.set(sid, (buffers.get(sid) || '') + text);
        const timers = streamTimerRef.current;
        if (!timers.has(sid)) {
          // 定时器与 provider 都按这个 sid 闭包捕获,刷的永远是这个会话自己的缓冲。
          const flushSid = sid;
          const flushProvider = provider;
          timers.set(flushSid, window.setTimeout(() => {
            timers.delete(flushSid);
            const buffered = accumulatedStreamRef.current.get(flushSid);
            if (buffered) sessionStore.updateStreaming(flushSid, buffered, flushProvider);
          }, 100));
        }
        // 不再对非活跃会话额外 appendRealtime 原始 delta:上面的 100ms 定时器
        // 会对**任意** sid(包括后台会话)调 updateStreaming,把累积文本写成一条
        // `__streaming_<sid>` 消息。再追加一份原始 delta,等于同一段内容存两份 ——
        // 切回该会话时就看到"碎片气泡 + 累积行"两套(fetch 不剪 realtime,碎片
        // 一直留到下次 refresh)。累积消息才是唯一正确表示。
        return;
      }

      if (msg.kind === 'stream_end') {
        if (sid) {
          const t = streamTimerRef.current.get(sid);
          if (t) { clearTimeout(t); streamTimerRef.current.delete(sid); }
          const buffered = accumulatedStreamRef.current.get(sid);
          if (buffered) sessionStore.updateStreaming(sid, buffered, provider);
          sessionStore.finalizeStreaming(sid);
          accumulatedStreamRef.current.delete(sid);
        }
        return;
      }

      // --- prism checkpoint events: UI state, not transcript rows ---
      if (msg.kind === 'checkpoint_created') {
        onCheckpointCreated?.({
          sessionId: sid || null,
          checkpoint: (msg.checkpoint as Record<string, unknown>) || {},
        });
        return;
      }

      if (msg.kind === 'changed_files') {
        onChangedFiles?.({
          sessionId: sid || null,
          checkpointId: typeof msg.checkpointId === 'string' ? msg.checkpointId : null,
          files: Array.isArray(msg.files) ? msg.files : [],
          truncated: Boolean(msg.truncated),
          // dr:工作面板要把 git 相对路径拼绝对,与落库基线同构。
          cwd: typeof msg.cwd === 'string' ? msg.cwd : null,
        });
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_cancelled';

      if (shouldPersist) {
        if (sid) {
          sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
        } else {
          // 归属不明:不落盘。落进"正看的会话"就是那批钉死的幽灵时间轴。
          warnDroppedRef.current(msg);
        }
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state
          if (sid) {
            const t = streamTimerRef.current.get(sid);
            if (t) { clearTimeout(t); streamTimerRef.current.delete(sid); }
            const buffered = accumulatedStreamRef.current.get(sid);
            if (buffered) {
              sessionStore.updateStreaming(sid, buffered, provider);
              sessionStore.finalizeStreaming(sid);
            }
            accumulatedStreamRef.current.delete(sid);
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void sessionStore.refreshFromServer(sid);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          // dn-B1:「常驻进程被回收」的通知。这个帧带的是 status/content 而不是
          // text,原来整条被静默丢弃 —— F14 的用户可见半边从没活过,用户只感到
          // "这条会话今天特别卡"。只对正在看的会话提示;后台会话下一条消息
          // 慢几秒本来也无从感知。
          if (msg.status === 'runtime_evicted') {
            if (sid && sid === activeViewSessionId && typeof msg.content === 'string' && msg.content) {
              emitToast({ message: msg.content });
            }
            break;
          }
          // dk:只有**正在看的这条会话**的用量帧才写进顶栏 —— 之前不看 sid,
          // 后台会话(定时任务、另一个标签页跑着的回合)的 token_budget 会把
          // 当前页面的用量芯片刷成别的会话的数字,来回跳。
          if (msg.text === 'token_budget' && msg.tokenBudget && sid && sid === activeViewSessionId) {
            // costUsd 只在 result 帧上出现;中途的 usage 帧没有它。整体替换会把
            // 已经拿到的费用抹掉,所以缺席时沿用上一次的值(F4)。
            setTokenBudget((previous: Record<string, unknown> | null) => {
              const next = msg.tokenBudget as Record<string, unknown>;
              const previousCost = previous && typeof previous === 'object' ? (previous as Record<string, unknown>).costUsd : undefined;
              return next.costUsd === undefined && previousCost !== undefined
                ? { ...next, costUsd: previousCost }
                : next;
            });
          } else if (msg.text === 'token_budget') {
            // dv:后台会话的用量帧走到这里(上面那支要求 sid === 正在看的会话)
            // —— 原来会落进下面的兜底,把 statusText 设成字面量 "token_budget",
            // 切进那条会话时活动指示器上明晃晃写着 "token_budget"。它不是状态
            // 文案,丢掉即可(顶栏数字本来就只认当前会话)。
            break;
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              statusKind: (msg.statusKind as 'compacting' | undefined) ?? null,
              // 压缩实况(阶段 / 心跳 / pre-post token / 耗时)。缺席时显式置 null,
              // 否则压缩结束后的普通状态帧会让上一条压缩状态一直挂着。
              compaction: isCompactionActivity(msg.compaction) ? msg.compaction : null,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
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
    onWebSocketReconnect,
    sessionStore,
    onCheckpointCreated,
    onChangedFiles,
    onServerQueueChange,
    onServerQueueReturned,
  ]);
}
