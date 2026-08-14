import {
  WS_CONNECTING_STATE,
  WS_OPEN_STATE,
} from '@/modules/websocket/services/websocket-state.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';
import { createCompleteMessage, readObjectRecord } from '@/shared/utils.js';

type ChatSessionWriterOptions = {
  connection: RealtimeClientConnection;
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
    this.connections.add(options.connection);
    this.userId = options.userId;
    this.providerSessionId = options.providerSessionId;
  }

  send(data: unknown): void {
    const record = readObjectRecord(data);
    if (!record || typeof record.kind !== 'string') {
      // Provider runtimes only emit kind-based normalized messages. Anything
      // else indicates a programming error; drop it rather than leaking an
      // un-remapped payload to the client.
      console.error('[ChatSessionWriter] Dropping non-normalized outbound payload', data);
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
    const payload = JSON.stringify(message);
    let delivered = 0;

    for (const connection of this.connections) {
      if (connection.readyState !== WS_OPEN_STATE) {
        // CLOSED / CLOSING 的连接不会再回来了 —— 重连的是一个新 socket。
        if (connection.readyState !== WS_CONNECTING_STATE) this.connections.delete(connection);
        continue;
      }
      try {
        connection.send(payload);
        delivered += 1;
      } catch (error) {
        console.warn('[ChatSessionWriter] send failed, dropping connection:', error);
        this.connections.delete(connection);
      }
    }

    return delivered;
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
