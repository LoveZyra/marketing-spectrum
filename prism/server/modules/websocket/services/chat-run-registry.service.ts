import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { currentHolder } from '@/modules/websocket/services/conversation-ownership.service.js';
import { projectVisibilityInput, projectsDb, sessionsDb } from '@/modules/database/index.js';
// 同 sessions-watcher:走 barrel 会成环,叶子直取。
import { generateDisplayName } from '@/shared/project-display-name.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/shared/websocket-state.js';
import { canViewerSeeProject } from '@/shared/project-visibility.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('ws');
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
  /**
   * 这一轮的唯一标识,补发的正确性靠它。
   *
   * `lastSeq` 每轮从 0 重新开始,而客户端的游标按会话保存。没有 runId 的话,
   * 第 1 轮跑到 seq=40、第 2 轮在 seq=20 断线重连,客户端带着 40 来要补发,
   * `seq > 40` 一条都匹配不上 —— 第 2 轮已经发生的内容全部丢失,而且整轮游标
   * 都不会推进,此后每次重连都命中同一个空洞。
   * 有了 runId,客户端带的游标属于哪一轮就是明确的:不是这一轮就从头补。
   */
  runId: string;
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
  /**
   * 这一轮是 CLI 自己发起的、Prism 只是在旁边接住(观测回合,见 observed-run.service)。
   *
   * 子代理的后台完成通知、会话内定时任务(CronCreate)触发时,CLI 用自己的
   * 消息队列注入一条 user 帧、模型接着回复,这一整轮不是 Prism 发起的。
   * 观测回合与真回合的唯一区别是可被抢占:用户真发消息时不排队、不等它 —— 见 `startRun`。
   */
  observed: boolean;
  /**
   * 这一轮是被中止收尾的吗(时间戳,null = 正常收尾)。
   *
   * complete 之后要不要继续收帧全看它:中止 → 一律不收;正常 → 只收收尾摘要。
   * 见 `decorateAndRecordEvent`。
   */
  abortedAt: number | null;
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
 * 5 分钟保留期,峰值可以到几百 MB。`history-cache.ts` 按字节预算的理由在这里同样成立。
 *
 * 按字节丢弃是安全的:`replayEvents` 本来就有"缓冲被截断则客户端回落 REST"的
 * 语义,而 REST 永远是权威来源。
 */
const MAX_BUFFERED_BYTES_PER_RUN = 8 * 1024 * 1024;

/**
 * 一条事件的近似字节数。
 *
 * 不能只数 `content` 与 `toolResult.content`,缓冲里的大头在别的字段上:
 *   - `toolInput` —— Write / Edit 工具带的是整份文件正文;
 *   - `toolResult.toolUseResult`、`subagentTools` —— 子代理那一整棵过程;
 *   - `changed_files` 的 `files[]`(每条带 diff)、`images`。
 * 漏数它们的话 8 MB 的字节上限几乎触不到,一轮里几十上百次大文件 Write(代码生成类任务的常态)
 * 就能在一条 run 上挂几百 MB。
 *
 * 这几个字段用 JSON.stringify 计:它们都是 `unknown`(见 shared/types.ts),形状由 provider 决定,
 * 逐字段累加等于在这里复刻一份 provider 的数据结构,迟早与真实形状漂开、让预算悄悄失准。
 * 代价是每条事件多一次序列化(每回合几十到几百次,不在热循环里);stringify 失败(循环引用)
 * 时回落到 256,不会让一条畸形事件打断整轮。
 */
function approximateEventBytes(event: NormalizedMessage): number {
  const content = typeof event.content === 'string' ? event.content.length : 0;
  const toolResult = typeof event.toolResult?.content === 'string' ? event.toolResult.content.length : 0;

  let heavy = 0;
  for (const value of [
    event.toolInput,
    event.toolResult?.toolUseResult,
    (event as { toolUseResult?: unknown }).toolUseResult,
    (event as { subagentTools?: unknown }).subagentTools,
    (event as { files?: unknown }).files,
    event.images,
  ]) {
    if (value == null) continue;
    try {
      heavy += JSON.stringify(value)?.length ?? 0;
    } catch {
      heavy += 256; // 循环引用之类:给个下限,别让预算算崩
    }
  }

  return content + toolResult + heavy + 256;
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

  // Scoped, not fanned out: this payload carries the project's name and path,
  // so it only goes to sockets that may see the project (the same rule the
  // HTTP list applies); otherwise a colleague's project would flash into
  // someone else's sidebar mid-session.
  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) return;
    if (!canViewerSeeProject({
      ...projectVisibilityInput(project, projectPath ?? null),
      viewerUserId: client.prismUserId,
      viewerUsername: client.prismUsername,
    })) return;

    client.send(payload);
  });
}

/**
 * 保留期到点后清掉已完成的 run。定时器要认 run,不认会话 id:同一会话 5 分钟内跑完两轮
 * (排队续发、连续对话)时,只按会话 id 查会让 R1 的定时器提前删掉已完成的 R2。
 */
function evictRunLater(run: ChatRun): void {
  const timer = setTimeout(() => {
    if (runs.get(run.appSessionId) === run && run.status === 'completed') {
      runs.delete(run.appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * 正常收尾之后仍然允许通过的帧。
 *
 * 都是回合级摘要,由网关这一侧在回合函数返回之后才算得出来,天然晚于
 * `complete`;而且每轮至多一条,不会像正文那样源源不断。
 * 正文类(`text` / `thinking` / `tool_use` / `tool_result` / `stream_*`)
 * 一律不在此列 —— 那些在 complete 之后出现,只可能是上一个 epoch 的残余。
 */
const POST_COMPLETE_KINDS = new Set(['changed_files', 'token_budget', 'context_usage']);

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

  /**
   * complete 之后还能不能发,取决于这一轮是怎么结束的:
   *   - 中止收尾 → 后面什么都不收:用户按了停止,前端已停了转圈,在途的 `tool_result` /
   *     `stream_delta` 不能再让正文继续长;
   *   - 正常收尾 → 只收一小撮明确的收尾摘要(见 POST_COMPLETE_KINDS),正文类一律拒绝。
   *     `queryClaudeSDK` 是"回合函数自己发 complete → 返回 → 外层再算 `changedFilesSince`
   *     并发 `changed_files`",这张「本轮改动的文件」卡天然晚于 complete;用 Bash / 脚本
   *     写文件时它是唯一的线索。
   */
  if (run.status === 'completed') {
    if (run.abortedAt !== null || !POST_COMPLETE_KINDS.has(String(message.kind))) {
      return null;
    }
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
    runId: run.runId,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    // 记下是不是中止收尾 —— 后面那道"还收不收帧"的闸按它分流。
    if ((message as { aborted?: boolean }).aborted) run.abortedAt = Date.now();
    evictRunLater(run);
  }

  // 审批帧不进重放缓冲。
  //
  // 待批审批的权威来源是 `chat_subscribed.pendingPermissions`(前端是整体替换)。
  // 若审批帧也躺在缓冲里,订阅时的顺序就是"先给权威列表、紧接着重放又逐条推回去" ——
  // 已经点过"允许"的框会重新弹出来,而它们对应的 resolver 早就没了,点也点不掉。
  // 回合中途刷新页面(游标清零)必然触发这一幕。
  const isPermissionFrame = message.kind === 'permission_request' || message.kind === 'permission_cancelled';
  if (!isPermissionFrame) {
    run.events.push(outbound);
    run.bufferedBytes += approximateEventBytes(outbound);
  }

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

  /**
   * 先落库、成功了再改内存。
   *
   * 反过来写的话,落库抛异常时内存里已经认了这个 provider id,而 sessions 表
   * 里还是空 —— 本轮后续的续跑/中止都按内存那份走,可刷新页面、换标签页、
   * 重启进程之后全都查不到这段映射:这段对话再也 resume 不回去,历史(在
   * transcript 那侧)等于失联。落库失败就保持原状,下一帧还会再来一次。
   */
  try {
    /**
     * 被守卫拒绝也算"没落库"。
     *
     * `assignProviderSessionId` 的跨项目守卫是返回 false 而不是抛异常,落不进 catch,
     * 所以要按返回值分流:没落库就什么都不改 —— 不认领、不广播。运行时下一次报同一个 id 时
     * 还会再来一次(`run.providerSessionId` 没变,那道相等早退拦不住),真的是跨项目冒领
     * 就会再被拒一次,日志里有据可查。中止那条路对 claude 有"按 runId 兜底"的第二段,
     * 不依赖这个映射。
     */
    if (!sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId)) {
      log.warn('[ChatRunRegistry] provider 会话映射被数据库守卫拒绝,本轮不认领这个 id', {
        appSessionId: run.appSessionId,
        providerSessionId,
      });
      return;
    }
    run.providerSessionId = providerSessionId;
    void broadcastCanonicalSessionUpsert(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      log.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * 一轮真的开跑之后要做的事(目前是把在看的 socket 接进推流集合)。
 *
 * 由 `chat-websocket.service` 在模块初始化时注册 —— 反过来 import 会让注册表
 * 依赖网关层,而 `sessionViewers` 与可见性判据本来就住在那边。
 */
let runStartedHook: ((appSessionId: string) => void) | null = null;

export function setRunStartedHook(hook: ((appSessionId: string) => void) | null): void {
  runStartedHook = hook;
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
   * 让侧栏知道"这条会话(重新)出现了" —— 从最近删除恢复之后用。
   * 走的是 run 收尾时那条现成的按可见范围广播的路,不另写一份。
   */
  announceSessionUpsert(appSessionId: string): Promise<void> {
    return broadcastCanonicalSessionUpsert(appSessionId);
  },

  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    /** null = 还没有浏览器在看(外部 API 触发的回合),之后由 `attachConnection` 接上。 */
    connection: RealtimeClientConnection | null;
    userId: string | number | null;
    /** false = 本轮不落显示日志(已有会话的 seed 失败,见 ChatSessionWriter)。 */
    persistDisplayLog?: boolean;
    /** 观测回合 —— CLI 自己发起的那一轮,Prism 只是接住(见 ChatRun.observed)。 */
    observed?: boolean;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      /**
       * 观测回合永远不许挡住用户。
       *
       * 让它像真回合那样把用户的发送顶成"已排队",等于给"卡死"开了一个新入口:
       * 那一轮的 `result` 只要不来(CLI 侧异常、注入轮被吃掉),这条会话就永久忙,
       * 而队列的出口是"上一轮跑完" —— 永远不会到。运行时那一侧也不拦:CLI 自发回合期间
       * `runtime.turn` 是 null,`runPersistentTurn` 照常开跑。
       *
       * 让路的方式是把它当场收尾(而不是丢着不管):订阅的浏览器会收到 complete,
       * 转圈停下来,不会留一个永远转着的幽灵回合。
       */
      if (existing.observed && !input.observed) {
        log.info(`[chat-run] 观测回合让位给用户发送:${input.appSessionId}`);
        existing.writer.sendComplete({ exitCode: 0 });
      } else {
        return null;
      }
    }

    /**
     * 终端接管着这段对话时,谁都不许开跑。
     *
     * 否则定时任务、外部 Agent API 这类调用点会在终端接管期间起一个 CLI resume 同一份
     * transcript,两个进程往同一个 jsonl 里追加,两条历史交错谁也修不回来。
     * 判据放在 `startRun` 而不是各个调用点:这里是"一轮要开跑了"的唯一入口,
     * 写在调用点上迟早有新的调用点漏掉。
     */
    const holder = currentHolder(input.appSessionId);
    if (holder) {
      log.warn(
        `[chat-run] 拒绝开跑:${input.appSessionId} 正被终端接管`
        + `${holder.username ? `(${holder.username})` : ''}`,
      );
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      runId: `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      events: [],
      bufferedBytes: 0,
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
      abortedAt: null,
      observed: input.observed === true,
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
      persistDisplayLog: input.persistDisplayLog,
    });

    runs.set(input.appSessionId, run);
    /**
     * 每一轮开跑都要把"正在看这条会话的人"接进推流集合(经 runStartedHook)。
     *
     * 定时任务、外部 Agent API 这类调用点传的是 `connection: null`;不接的话,定时任务在
     * 一条用户正开着的会话上跑起来时,那个浏览器一帧都收不到(没有转圈、没有停止按钮),
     * 而服务端正在这条会话名下改文件、跑命令。放在 `startRun` 里的理由同上:
     * 它是"一轮开跑了"的唯一入口。
     */
    runStartedHook?.(input.appSessionId);
    return run;
  },

  /**
   * `startRun` 返回 null 有两种原因(有回合在跑 / 终端接管中),调用方用这里问出是哪一种,
   * 好给出对的提示:终端接管时该做的是关掉那个终端,而不是等回合跑完。
   *
   * 判据顺序必须和 `startRun` 完全一致(先看在跑的回合,再看接管),否则两处
   * 会给出不同的说法。两者都是同步的,调用方拿到 null 后紧接着问,中间不可能
   * 插进别的状态变化。
   */
  explainRunRefusal(appSessionId: string): {
    code: 'BUSY' | 'HELD_BY_SHELL' | 'UNKNOWN';
    holder: string | null;
    message: string;
  } {
    const existing = runs.get(appSessionId);
    if (existing && existing.status === 'running') {
      return { code: 'BUSY', holder: null, message: '这条会话正有回合在跑' };
    }
    const holder = currentHolder(appSessionId);
    if (holder) {
      const who = holder.username ? `(${holder.username})` : '';
      return {
        code: 'HELD_BY_SHELL',
        holder: holder.username ?? null,
        message: `这条会话正被终端接管${who},要等那个终端关掉才能开跑`,
      };
    }
    return { code: 'UNKNOWN', holder: null, message: '这条会话现在不能开跑' };
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
   * may be writing to). Runs do not capture a cwd themselves, so the working
   * directory is resolved lazily here from the sessions table (`project_path`), which this module
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
   * 加入,不是替换:多个标签页(或公开项目里的多个人)同时订阅时谁都不会把流抢走,
   * 审批帧也能送到每一个在看的人(见 ChatSessionWriter 的 `connections`)。
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
   * 把一帧作为当前这一轮的实时事件推给所有查看者:编号、进重放缓冲、发给订阅者,不落显示日志。
   *
   * 给调用方已经自己写进显示日志的帧用(chat 网关的用户行,见 ChatSessionWriter.sendWithoutPersist)。
   * 这条会话没有在跑的回合时什么都不做,返回 false。
   */
  broadcastWithoutPersist(appSessionId: string, message: NormalizedMessage): boolean {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') return false;
    run.writer.sendWithoutPersist(message);
    return true;
  },

  /** 当前(或刚结束)那一轮的 id;没有 run 时为 null。 */
  currentRunId(appSessionId: string): string | null {
    return runs.get(appSessionId)?.runId ?? null;
  },

  /**
   * 重放缓冲里还剩的最早那个 seq。
   *
   * 缓冲会按条数 / 字节被裁剪,而重放从缓冲现有的第一条开始发:被裁掉的恰好是开头一段时,
   * 客户端的跳号检测看到的是"连续的",那段内容会静默丢失。报出这个水位,客户端拿它和
   * 自己的 `lastSeq` 一比就知道要不要直接回落 REST。
   */
  earliestBufferedSeq(appSessionId: string): number | null {
    const run = runs.get(appSessionId);
    if (!run || run.events.length === 0) return null;
    const first = run.events[0];
    return typeof first.seq === 'number' ? first.seq : null;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay
   * (the whole buffer when the client's cursor belongs to another run).
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number, clientRunId?: string | null): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) return [];
    // 客户端明确说了它的游标属于另一轮 → 从头补。
    // seq 每轮从 0 重来,拿上一轮的游标去过滤这一轮,只会把这一轮整段滤掉。
    //
    // 没带 runId 的只按 seq 过滤:可能是不带 runId 的客户端,或者它本来就还没有
    // 游标(此时 afterSeq 也是 0,从哪算都一样)。这里不能一律从头补 ——
    // 带着有效游标来的客户端会被再灌一遍已经收过的 stream_delta。
    const differentRun = typeof clientRunId === 'string' && clientRunId !== '' && clientRunId !== run.runId;
    const from = differentRun ? 0 : afterSeq;
    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > from);
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
