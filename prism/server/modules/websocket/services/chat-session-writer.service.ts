import {
  WS_CONNECTING_STATE,
  WS_OPEN_STATE,
} from '@/shared/websocket-state.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { createCompleteMessage, readObjectRecord } from '@/shared/utils.js';
import { canViewerSeeSession, sessionMessagesDb } from '@/modules/database/index.js';
import { readSocketViewer } from '@/shared/project-visibility.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('ws');

type ChatSessionWriterOptions = {
  /**
   * 起这条 run 的那个 socket。可以是 null —— 外部 API 触发的回合一开始
   * 一个浏览器都没有,人是拿着返回的 session id 去点链接的,晚几秒才接上来。
   * 那时走 `addConnection` 加进来,照样能看到后半段,再靠补发游标补前半段。
   */
  connection: RealtimeClientConnection | null;
  userId: string | number | null;
  provider: LLMProvider;
  /** Provider-native id when resuming an existing session, otherwise null. */
  providerSessionId: string | null;
  /**
   * Invoked the moment the provider runtime reveals its native session id
   * (either via `setSessionId` or a `session_created` event). The registry
   * persists the app-id-to-provider-id mapping from this callback.
   */
  onProviderSessionId: (providerSessionId: string) => void;
  /**
   * Remaps/sequences/buffers one outbound live event. Implemented by the chat
   * run registry; the writer never forwards a provider event untouched.
   * Returns `null` when the event must be dropped (duplicate terminal
   * `complete` after an abort already completed the run).
   */
  decorateOutboundEvent: (message: NormalizedMessage) => NormalizedMessage | null;
  /**
   * 这一轮的出站帧要不要落显示日志。默认要。
   *
   * 唯一置 false 的场合:已有会话的历史没能抄进日志(seed 失败)。那时候
   * 往日志里写哪怕一行,`fetchHistory` 都会立刻改判日志为权威,几百条历史
   * 从界面消失且不可恢复。宁可这一轮不留日志(照样正常推流,历史仍从
   * transcript 读),等下一轮 seed 重试成功再开始记。
   */
  persistDisplayLog?: boolean;
};

/** 可见性复检的缓存窗口:撤权之后最多再多收这么久的帧。 */
const VISIBILITY_CACHE_MS = 2000;

/** 单个订阅者的出站积压上限。超过就摘掉,让它重连走补发。 */
const MAX_OUTBOUND_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Gateway writer handed to provider runtimes instead of a raw websocket.
 *
 * Provider runtimes (`claude-sdk.js`) only use the writer surface (`send`,
 * `sendAndCountDelivered`, `setSessionId`, `getSessionId`, `userId`);
 * everything that flows through it is translated from the provider's world
 * into the app's protocol:
 *
 * - `session_created` events are swallowed and turned into a provider-id
 *   mapping; the frontend never learns provider-native ids.
 * - every other event gets `sessionId` remapped to the app session id and a
 *   per-run `seq` assigned before being forwarded.
 * - `setSessionId(...)` calls (used by runtimes to label captured ids) are
 *   intercepted and recorded as the provider-id mapping as well.
 */
export class ChatSessionWriter {
  userId: string | number | null;
  /**
   * Writer-type marker for runtimes that feature-detect their writer;
   * nothing in the repo reads it at present.
   */
  isWebSocketWriter = true;

  /**
   * 每一个订阅着这条 run 的 socket,出站帧广播给所有订阅者。
   *
   * 不能只认最后一个订阅者:同一个人开第二个标签页(或公开项目里另一个人打开同一会话)
   * 就会把流抢走,前一个标签页从此收不到;审批请求也走这条路,抢走流的浏览器若没在看
   * 这个会话,前端那道 `sid === activeViewSessionId` 会把它丢掉,两边都没人看见。
   *
   * 谁该进这个集合由调用方的可见性检查决定(`assertSocketMaySeeSession`),这里只负责发。
   */
  private readonly connections = new Set<RealtimeClientConnection>();

  /**
   * 每帧可见性复检的结果缓存(见 canDeliverToConnection)。
   *
   * WeakMap 按 socket 记:连接一断,条目跟着连接一起被回收,不需要额外清扫。
   */
  private readonly visibilityCache = new WeakMap<
    RealtimeClientConnection,
    { sessionId: string; visible: boolean; checkedAt: number }
  >();

  private readonly options: ChatSessionWriterOptions;
  /**
   * The provider-native session id as the runtime knows it. Kept locally
   * (besides the registry) because runtimes read it back via `getSessionId()`
   * to label their own outgoing events — those labels are remapped on send
   * anyway, but the runtime-visible value must stay provider-native.
   */
  private providerSessionId: string | null;

  constructor(options: ChatSessionWriterOptions) {
    this.options = options;
    // null 不能进集合:`forward` 会读每个连接的 readyState,塞个 null 进去
    // 等于给每一条出站消息埋一颗 TypeError。
    if (options.connection) this.connections.add(options.connection);
    this.userId = options.userId;
    this.providerSessionId = options.providerSessionId;
  }

  send(data: unknown): void {
    const record = readObjectRecord(data);
    if (!record || typeof record.kind !== 'string') {
      // Provider runtimes only emit kind-based normalized messages. Anything
      // else indicates a programming error; drop it rather than leaking an
      // un-remapped payload to the client.
      log.error('[ChatSessionWriter] Dropping non-normalized outbound payload', data);
      return;
    }

    const message = record as NormalizedMessage;

    if (message.kind === 'session_created') {
      const announcedId =
        typeof message.newSessionId === 'string' && message.newSessionId
          ? message.newSessionId
          : message.sessionId;
      if (announcedId) {
        this.captureProviderSessionId(announcedId);
      }
      // Swallowed on purpose: the frontend already has the stable app session
      // id, so there is no client-side handoff to perform anymore.
      return;
    }

    const outbound = this.options.decorateOutboundEvent(message);
    if (outbound) {
      this.forward(outbound);
    }
  }

  /**
   * Emits the synthetic terminal `complete` for runs that ended without one
   * (runtime crash before completing, or user abort).
   */
  sendComplete(opts: { exitCode: number; aborted?: boolean }): void {
    const message = createCompleteMessage({
      provider: this.options.provider,
      sessionId: this.providerSessionId,
      exitCode: opts.exitCode,
      aborted: opts.aborted,
    });
    const outbound = this.options.decorateOutboundEvent(message);
    if (outbound) {
      this.forward(outbound);
    }
  }

  /**
   * 把一个 socket 加进这条 run 的订阅者集合。
   *
   * 加入,不是替换 —— 见 `connections` 上的说明。刷新页面时旧 socket 已经
   * 关掉了,会在下一次 `forward` 时被顺手清掉,不需要调用方配对地摘除。
   */
  addConnection(connection: RealtimeClientConnection): void {
    if (connection) this.connections.add(connection);
  }

  /** socket 关闭时摘掉。不调也不会漏 —— `forward` 会清理已关闭的。 */
  removeConnection(connection: RealtimeClientConnection): void {
    this.connections.delete(connection);
  }

  /** 当前有多少个还开着的订阅者。给投递可达性判断用。 */
  liveConnectionCount(): number {
    let live = 0;
    for (const connection of this.connections) {
      if (connection.readyState === WS_OPEN_STATE) live += 1;
    }
    return live;
  }

  setSessionId(sessionId: string): void {
    this.captureProviderSessionId(sessionId);
  }

  getSessionId(): string | null {
    return this.providerSessionId;
  }

  private captureProviderSessionId(providerSessionId: string): void {
    if (!providerSessionId || this.providerSessionId === providerSessionId) {
      return;
    }

    this.providerSessionId = providerSessionId;
    this.options.onProviderSessionId(providerSessionId);
  }

  /**
   * 发一帧实时事件,但不落显示日志。返回送达了几个订阅者。
   *
   * 给调用方已经自己写进显示日志的那一行用:用户这条消息是入站的,由 chat 网关直接落库,
   * 再作为这一轮的实时帧推给所有查看者。照样经 `decorateOutboundEvent` 编号、进重放缓冲,
   * 中途订阅或重连的人也补得到;走 `send` 的话,同一行会在出站收口再写一次显示日志。
   */
  sendWithoutPersist(data: unknown): number {
    const record = readObjectRecord(data);
    if (!record || typeof record.kind !== 'string') return 0;
    const outbound = this.options.decorateOutboundEvent(record as NormalizedMessage);
    return outbound ? this.forward(outbound, { persist: false }) : 0;
  }

  /**
   * 广播给所有还开着的订阅者,返回真正送出去了几份。
   *
   * 审批请求从这条路发出,发完就开始计时,调用方必须知道到底有没有送到:
   * 否则掉线时那一帧进了黑洞,时间一到就替一个从没看见过它的用户按下了拒绝。
   *
   * 顺手清掉已经关闭的 socket:刷新页面留下的旧连接没人会来摘,靠这里回收。
   */
  private forward(message: NormalizedMessage, { persist = true }: { persist?: boolean } = {}): number {
    /**
     * 落一份「给人看的对话日志」。
     *
     * 这里是所有出站消息的唯一收口:`decorateAndRecordEvent` 已经把 `sessionId`
     * 换成了应用侧的 id,provider 的原生 id 到不了这一步 —— 正好和
     * `fetchHistory` 的键对齐。
     *
     * 写在投递之前、且不看有没有 socket 在连:用户关掉标签页,回合照跑,
     * 日志照记。这一点是它比"前端 store"更可靠的地方。
     */
    // seed 失败的那一轮整轮不落日志(见 persistDisplayLog 的说明);调用方已自己落过库的帧也不再写。
    if (persist && this.options.persistDisplayLog !== false
      && typeof message.sessionId === 'string' && message.sessionId) {
      sessionMessagesDb.append(message.sessionId, message);
    }

    const payload = JSON.stringify(message);
    let delivered = 0;
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';

    for (const connection of this.connections) {
      if (connection.readyState !== WS_OPEN_STATE) {
        // CLOSED / CLOSING 的连接不会再回来了 —— 重连的是一个新 socket。
        if (connection.readyState !== WS_CONNECTING_STATE) this.connections.delete(connection);
        continue;
      }
      /**
       * 每帧复检可见性。
       *
       * 进这个集合时过了检查,但一轮可以跑几十分钟:不复检的话,A 撤销共享后 B 仍会收完
       * 这一轮剩下的全部内容 —— 工具参数、`tool_result` 正文(含被读文件的内容)、
       * `changed_files` 的 diff、审批请求。与 `attachSessionViewers`(每轮重判)、
       * `broadcastToSessionViewers`(每帧重判)同一口径。
       *
       * 成本靠 2 秒 TTL 的结果缓存摊平(见 canDeliverToConnection)。
       */
      if (sessionId && !this.canDeliverToConnection(connection, sessionId)) {
        this.connections.delete(connection);
        continue;
      }
      /**
       * 背压闸。
       *
       * `tool_result` / `changed_files` 单帧可达几百 KB 到 MB 级。一个订阅者的
       * TCP 读端停住(手机切后台、网络劣化、代理挂起)但连接没断时,每一帧都在
       * Node 侧排队;心跳兜得晚(ping 排在积压后面,要 30~60 秒才判死),
       * 单个卡住的订阅者能让服务端替它缓冲一整分钟的完整帧流。
       *
       * 摘掉之后客户端重连,靠 `chat.subscribe` 的补发游标 + 前端的 seq 空洞检测
       * 回到正轨,语义上是安全的。
       */
      const buffered = (connection as { bufferedAmount?: number }).bufferedAmount ?? 0;
      if (buffered > MAX_OUTBOUND_BUFFER_BYTES) {
        log.warn(`[ChatSessionWriter] 订阅者积压 ${buffered} 字节,摘掉这条连接(重连后靠补发游标补齐)`);
        this.connections.delete(connection);
        try { (connection as { terminate?: () => void }).terminate?.(); } catch { /* best effort */ }
        continue;
      }
      try {
        connection.send(payload);
        delivered += 1;
      } catch (error) {
        log.warn('[ChatSessionWriter] send failed, dropping connection:', error);
        this.connections.delete(connection);
      }
    }

    return delivered;
  }

  /**
   * 这个连接现在还能看这条会话吗 —— 带 2 秒 TTL 的缓存。
   *
   * 不缓存的话,一条工具密集的回合里每帧每连接都要跑三次 SQLite 查询;
   * 缓存 2 秒意味着撤权最多再多收两秒的帧,这是可以接受的窗口。
   */
  private canDeliverToConnection(connection: RealtimeClientConnection, sessionId: string): boolean {
    /**
     * 没有身份戳的连接不参与这道复检。
     *
     * 浏览器过来的 chat socket 在握手完成时无条件盖戳(`handleChatConnection`),
     * 所以"没戳"只可能是服务端自己造的写入方 —— 外部 API 的无浏览器回合、
     * 定时任务那条 run。拿访问者可见性去判它们没有意义,判了只会把这类回合的
     * 输出整个掐掉。真正需要复检的那一群(真人开的标签页)一个都跑不掉。
     */
    const viewer = readSocketViewer(connection);
    if (viewer.userId === null || viewer.userId === undefined) return true;

    const now = Date.now();
    const cached = this.visibilityCache.get(connection);
    if (cached && cached.sessionId === sessionId && now - cached.checkedAt < VISIBILITY_CACHE_MS) {
      return cached.visible;
    }
    const visible = canViewerSeeSession(sessionId, viewer);
    this.visibilityCache.set(connection, { sessionId, visible, checkedAt: now });
    return visible;
  }

  /**
   * 发一条消息并回报送达了几个订阅者。
   *
   * 给审批请求这类"必须知道有没有人收到"的帧用 —— 普通的 `send()` 仍然是
   * 即发即忘,因为内容帧丢了会由补发游标兜底,而审批请求没有第二次机会。
   */
  sendAndCountDelivered(data: unknown): number {
    const record = readObjectRecord(data);
    if (!record || typeof record.kind !== 'string') return 0;
    const outbound = this.options.decorateOutboundEvent(record as NormalizedMessage);
    return outbound ? this.forward(outbound) : 0;
  }
}
