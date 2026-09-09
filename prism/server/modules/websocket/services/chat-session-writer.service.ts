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
   * 起这条 run 的那个 socket。**可以是 null** —— 外部 API 触发的回合一开始
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
   * du:这一轮的出站帧要不要落显示日志。默认要。
   *
   * 唯一置 false 的场合:老会话的历史**没能抄进日志**(seed 失败)。那时候
   * 往日志里写哪怕一行,`fetchHistory` 都会立刻改判日志为权威,几百条历史
   * 从界面消失且不可恢复。宁可这一轮不留日志(照样正常推流、transcript
   * 那条老路还在),等下一轮 seed 重试成功再开始记。
   */
  persistDisplayLog?: boolean;
};

/**
 * Gateway writer handed to provider runtimes instead of a raw websocket writer.
 *
 * It exposes the exact same surface as `WebSocketWriter` (`send`,
 * `setSessionId`, `getSessionId`, `updateWebSocket`, `userId`,
 * `isWebSocketWriter`) so the provider runtime (`claude-sdk.js`) needs zero
 * changes — but everything that flows through it is translated from the
 * provider's world into the app's protocol:
 *
 * - `session_created` events are swallowed and turned into a provider-id
 *   mapping; the frontend never learns provider-native ids.
 * - every other event gets `sessionId` remapped to the app session id and a
 *   per-run `seq` assigned before being forwarded.
 * - `setSessionId(...)` calls (used by runtimes to label captured ids) are
 *   intercepted and recorded as the provider-id mapping as well.
 */
/** fj:可见性复检的缓存窗口。撤权最多再多收这么久的帧(此前是整整一轮)。 */
const VISIBILITY_CACHE_MS = 2000;

/** fj:单个订阅者的出站积压上限。超过就摘掉,让它重连走补发。 */
const MAX_OUTBOUND_BUFFER_BYTES = 8 * 1024 * 1024;

export class ChatSessionWriter {
  userId: string | number | null;
  /**
   * Some runtimes feature-detect their writer with this flag; keep it so the
   * gateway writer is a drop-in replacement for `WebSocketWriter`.
   */
  isWebSocketWriter = true;

  /**
   * 每一个订阅着这条 run 的 socket。
   *
   * 原来这里是单个 `ws`,`updateWebSocket` 直接覆盖 —— **谁最后订阅,流就归谁**。
   * 于是同一个人开第二个标签页(或者公开项目里另一个人打开同一会话)就把流抢走了,
   * 原来那个标签页从此一个字节都收不到,转圈到刷新为止。
   *
   * 更隐蔽的后果在审批上:审批请求也走这条路。抢走流的那个浏览器如果没在看这个
   * 会话,前端那道 `sid === activeViewSessionId` 会把它丢掉 —— **两边都没人看见**,
   * 用户这边只等到一句超时。
   *
   * 改成集合之后语义变成"广播给所有订阅者"。谁该进这个集合由调用方的可见性检查
   * 决定(`assertSocketMaySeeSession`),这里只负责发。
   */
  private readonly connections = new Set<RealtimeClientConnection>();

  /**
   * fj:每帧可见性复检的结果缓存(见 canDeliverToConnection)。
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
   * **加入,不是替换** —— 见 `connections` 上的说明。刷新页面时旧 socket 已经
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
   * 广播给所有还开着的订阅者,返回**真正送出去了几份**。
   *
   * 返回值不是装饰。原来这里是 `if (readyState === OPEN) send()`,不满足就
   * 静默返回 —— 调用方拿不到任何信号。审批请求正是从这条路发出去的:发完就
   * 开始等,而"到底有没有送到"无人知晓。掉线时那一帧进了黑洞,系统却照样
   * 在计时,时间一到就替一个从没看见过它的用户按下了拒绝。
   *
   * 顺手清掉已经关闭的 socket:刷新页面留下的旧连接没人会来摘,靠这里回收。
   */
  private forward(message: NormalizedMessage): number {
    /**
     * 落一份「给人看的对话日志」。
     *
     * 这里是所有出站消息的唯一收口:`decorateAndRecordEvent` 已经把 `sessionId`
     * 换成了**应用侧**的 id,provider 的原生 id 到不了这一步 —— 正好和
     * `fetchHistory` 的键对齐。
     *
     * 写在投递**之前**、且不看有没有 socket 在连:用户关掉标签页,回合照跑,
     * 日志照记。这一点是它比"前端 store"更可靠的地方。
     */
    // du:seed 失败的那一轮整轮不落日志(见 persistDisplayLog 的说明)。
    if (this.options.persistDisplayLog !== false
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
       * fj:每帧复检可见性。
       *
       * 进这个集合时是过了检查的,但**进来之后整轮都不再复检** —— 于是 A 撤销
       * 共享后,B 会继续完整收完这一轮剩下的全部内容:工具参数、`tool_result`
       * 正文(含被读文件的内容)、`changed_files` 的 diff、审批请求。一轮可以跑
       * 几十分钟。
       *
       * `attachSessionViewers` 早就是每轮重判、`broadcastToSessionViewers` 更是
       * 每帧重判,唯独 run 的**主内容流**漏了 —— 而它恰恰是内容最多的那条。
       *
       * 成本靠 2 秒 TTL 的结果缓存摊平(见 canDeliverToConnection)。
       */
      if (sessionId && !this.canDeliverToConnection(connection, sessionId)) {
        this.connections.delete(connection);
        continue;
      }
      /**
       * fj:背压闸。
       *
       * 出站帧此前只判 `readyState` 就 `send`,全仓一处 `bufferedAmount` 都没有;
       * 而 `tool_result` / `changed_files` 单帧可达几百 KB 到 MB 级。一个订阅者的
       * TCP 读端停住(手机切后台、网络劣化、代理挂起)但连接没断时,每一帧都在
       * Node 侧排队 —— 心跳兜得晚(ping 排在积压后面,要 30~60 秒才判死),
       * 也就是说单个卡住的订阅者最多能让服务端替它缓冲一整分钟的完整帧流。
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
   * 缓存 2 秒意味着撤权最多再多收两秒的帧,而那是可以接受的窗口
   * (对照:此前是**整整一轮**)。
   */
  private canDeliverToConnection(connection: RealtimeClientConnection, sessionId: string): boolean {
    /**
     * 没有身份戳的连接**不参与**这道复检。
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
