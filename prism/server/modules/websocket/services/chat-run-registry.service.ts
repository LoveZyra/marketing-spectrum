import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { canViewerSeeProject } from '@/shared/project-visibility.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  /** `events` 的近似字节数,用于字节预算裁剪。 */
  bufferedBytes: number;
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest events are dropped —
 * a reconnecting client whose `lastSeq` predates the buffer falls back to a
 * REST history refresh, which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * 缓冲的字节预算,比条数更能反映真实占用。
 *
 * 缓冲里放的是完整 `NormalizedMessage`,包含 `tool_result` 的整段内容 —— 读一个
 * 大文件就是几百 KB 一条。5000 条 × 平均 10 KB = 50 MB/run,乘上并发 run 数和
 * 5 分钟保留期,峰值可以到几百 MB。同一个仓库的 `history-cache.ts` 用的正是字节
 * 预算,并写了很长的理由说明为什么按条数不对 —— 那套论证在这里同样成立。
 *
 * 按字节丢弃是安全的:`replayEvents` 本来就有"缓冲被截断则客户端回落 REST"的
 * 语义,而 REST 永远是权威来源。
 */
const MAX_BUFFERED_BYTES_PER_RUN = 8 * 1024 * 1024;

/** 一条事件的近似字节数。只数字符串内容,足够做预算控制。 */
function approximateEventBytes(event: NormalizedMessage): number {
  const content = typeof event.content === 'string' ? event.content.length : 0;
  const toolResult = typeof event.toolResult?.content === 'string' ? event.toolResult.content.length : 0;
  return content + toolResult + 256;
}

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

async function broadcastCanonicalSessionUpsert(appSessionId: string): Promise<void> {
  const row = sessionsDb.getSessionById(appSessionId);
  if (!row || row.isArchived) {
    return;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  const payload = JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });

  // Scoped, not fanned out. This payload carries the project's name and path;
  // sending it to every open socket is how a colleague's project used to
  // appear in someone else's sidebar mid-session and vanish again on refresh
  // (the HTTP list was filtered, this was not).
  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) return;
    if (!canViewerSeeProject({
      ownerUserId: project?.owner_user_id ?? null,
      viewerUserId: client.prismUserId,
      viewerUsername: client.prismUsername,
    })) return;

    client.send(payload);
  });
}

function evictRunLater(appSessionId: string): void {
  const timer = setTimeout(() => {
    const run = runs.get(appSessionId);
    if (run && run.status === 'completed') {
      runs.delete(appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    evictRunLater(run.appSessionId);
  }

  run.events.push(outbound);
  run.bufferedBytes += approximateEventBytes(outbound);

  // 条数和字节两个上限,谁先到按谁裁。一次裁一批而不是逐条 shift:
  // `splice(0, 1)` 在 5000 元素的数组上是一次 O(n) 的内存搬移。
  const overCount = run.events.length > MAX_BUFFERED_EVENTS_PER_RUN;
  const overBytes = run.bufferedBytes > MAX_BUFFERED_BYTES_PER_RUN;
  if (overCount || overBytes) {
    const dropCount = overCount
      ? run.events.length - MAX_BUFFERED_EVENTS_PER_RUN
      : Math.max(1, Math.ceil(run.events.length / 4));
    const dropped = run.events.splice(0, dropCount);
    for (const event of dropped) {
      run.bufferedBytes -= approximateEventBytes(event);
    }
    if (run.bufferedBytes < 0) {
      run.bufferedBytes = 0;
    }
  }

  return outbound;
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    connection: RealtimeClientConnection;
    userId: string | number | null;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      events: [],
      bufferedBytes: 0,
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    runs.set(input.appSessionId, run);
    return run;
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
      }));
  },

  /**
   * Cwd-aware view of the running runs, for cross-feature directory guards
   * (e.g. git-checkpoint restore refuses to rewrite a directory any live run
   * may be writing to). Runs are registered by the chat websocket handler and
   * do not capture a cwd themselves, so the working directory is resolved
   * lazily here from the sessions table (`project_path`), which this module
   * already treats as the source of truth for session rows. `cwd` is null
   * when the session row is missing or has no project path.
   */
  getActiveRunsInfo(): Array<{
    sessionId: string;
    providerSessionId: string | null;
    cwd: string | null;
  }> {
    const infos: Array<{ sessionId: string; providerSessionId: string | null; cwd: string | null }> = [];
    for (const run of runs.values()) {
      if (run.status !== 'running') continue;
      let cwd: string | null = null;
      try {
        cwd = sessionsDb.getSessionById(run.appSessionId)?.project_path ?? null;
      } catch {
        cwd = null;
      }
      infos.push({
        sessionId: run.appSessionId,
        providerSessionId: run.providerSessionId,
        cwd,
      });
    }
    return infos;
  },

  /**
   * 把一个 socket 加进这条 run 的订阅者集合。
   *
   * 页面刷新后新 socket 订阅上来就能接着收还在跑的流,对所有 provider 都一样。
   *
   * **加入,不是替换。**原来这里是 `updateWebSocket`,一次单持有者赋值 ——
   * 谁最后订阅流就归谁,原来那个标签页从此收不到任何东西,一直转圈到刷新。
   * 同一个人开两个标签页就会踩到,公开项目里换成另一个人也一样。而且它对审批
   * 请求同样生效:审批帧发到了抢走流的那个浏览器,那边如果没在看这个会话,
   * 前端还会再把它丢一次 —— 两边都看不见,原用户只等到一句超时。
   *
   * 谁有资格进这个集合由调用方判断(`assertSocketMaySeeSession`),这里不做鉴权。
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.addConnection(connection);
    return true;
  },

  /**
   * 一个 socket 断开时,把它从所有还活着的 run 上摘掉。
   *
   * 不调也不会漏(`forward` 会顺手清理已关闭的连接),但主动摘掉可以让
   * `liveConnectionCount()` 立刻反映现实 —— 审批投递可达性判断读的就是它。
   */
  detachConnection(connection: RealtimeClientConnection): void {
    for (const run of runs.values()) {
      run.writer.removeConnection(connection);
    }
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Test-only escape hatch: clears every tracked run.
   */
  clearAll(): void {
    runs.clear();
  },
};
