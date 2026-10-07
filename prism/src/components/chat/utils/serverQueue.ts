import { composerText } from './composerText';

/**
 * 服务端排队卡片的状态,按会话存,不是全视图一份。
 *
 * 这份排队存在服务端(刷新页面、换设备、关标签页之后都还在),只能由服务端的帧驱动;
 * 而帧是所有已订阅会话一起来的:`chat_status` ack 每条会话各回一份、`chat_queued`
 * 在哪条会话撞上在跑的回合就从哪条发。全视图只存一份的话:
 *
 *   - 后到的会话会把先前那条挤掉:A 有一条在排队时 B 的 ack 到达,切回 A 时卡片不见了,
 *     而服务端那条消息还在队列里;
 *   - 取消可能取消错会话:卡片渲染之后、用户点下去之前若有别的会话的 queued 落地,
 *     用户看着 A 的卡片,取消掉的却是 B 的。
 *
 * 按会话存,每条会话的排队互不干扰,取消按会话 id 取。
 */
export interface ServerQueuedMessage {
  preview: string;
  enqueuedAt: string;
  /** 不是自己排的 —— 服务端把正文脱敏了,界面显示占位而不是把空串当"没正文"。 */
  redacted?: boolean;
}

export type ServerQueueMap = ReadonlyMap<string, ServerQueuedMessage>;

export const EMPTY_SERVER_QUEUE: ServerQueueMap = new Map();

/**
 * 落一帧排队状态。
 *
 * 没有变化时返回原来那个 Map(引用相等):`chat_status` ack 在正常空闲时
 * 也会带 `queued: null` 回来,一秒可能好几帧;每帧都造新 Map 会让整个聊天视图
 * 白重渲染一次。
 */
export function reduceServerQueue(
  current: ServerQueueMap,
  sessionId: string,
  queued: ServerQueuedMessage | null,
): ServerQueueMap {
  const existing = current.get(sessionId);

  if (!queued) {
    if (!existing) return current;
    const next = new Map(current);
    next.delete(sessionId);
    return next;
  }

  if (
    existing
    && existing.preview === queued.preview
    && existing.enqueuedAt === queued.enqueuedAt
    && Boolean(existing.redacted) === Boolean(queued.redacted)
  ) {
    return current;
  }

  const next = new Map(current);
  next.set(sessionId, { preview: queued.preview, enqueuedAt: queued.enqueuedAt, redacted: Boolean(queued.redacted) });
  return next;
}

/** 正在看的这条会话有没有排队中的消息。没有选中会话时恒为 null。 */
export function queuedForSession(
  queue: ServerQueueMap,
  sessionId: string | null,
): ServerQueuedMessage | null {
  if (!sessionId) return null;
  return queue.get(sessionId) ?? null;
}

/**
 * `chat_queue_cancelled` 帧上的正文怎么用,以及要撤掉哪条本地回声。
 *
 * 服务端只把退回的正文发给排这条消息的那个人(他的所有连接),别人的连接拿到的帧不带正文。
 * 同一个人开着的几个标签页里:
 *   - 真正发出这条消息的标签页才把正文填回输入框(`refill`):别的标签页的输入框里可能正打着别的话;
 *   - 提示里照样抄上原文(`original`),哪个标签页都一样。刷新过的那个标签页已经不记得发过它,
 *     本地那份也早在 ACK 时清掉了,不抄的话这段话就从界面上彻底消失。
 * 帧带着 `clientMessageId` 时按"这个标签页发过它没有"判回不回填;不带键的老帧照旧,有正文就回填。
 *
 * 带键的帧同时指明了哪条消息没有发出去:它的本地回声(只在发出它的那个标签页里有)要撤掉,
 * 否则它像"已发送"一样一直留在对话里。
 */
export function planQueueCancelled(
  frame: { content?: unknown; clientMessageId?: unknown },
  wasSentHere: (clientMessageId: string) => boolean,
): { refill: string; original: string; dropEchoOf: string | null } {
  const content = typeof frame.content === 'string' ? frame.content : '';
  const clientMessageId = typeof frame.clientMessageId === 'string' && frame.clientMessageId
    ? frame.clientMessageId
    : null;
  if (!clientMessageId) return { refill: content, original: content, dropEchoOf: null };
  return { refill: wasSentHere(clientMessageId) ? content : '', original: content, dropEchoOf: clientMessageId };
}

/**
 * 一条排队消息被丢弃时,要不要在对话里留一句话,留什么。文案必须按实际发生的事写。
 *
 * 回填输入框的前提是"正在看这条会话"且"输入框是空的",而这条帧最常见的触发场景
 * (用户切走了、或正在打别的字)两个前提都不成立;本地那份在第一次 ACK 时就已清掉,
 * 服务端那份刚被丢弃,所以不能笼统地说"已退回输入框"。
 *
 *  - 真的退回输入框了 → 不用提示,东西在用户手上;
 *  - 没退回去 → 说清楚没发出去,并把原文抄进提示里,退不回去至少能复制回来;
 *  - 用户自己撤销的(cancelled)→ 他知道自己干了什么,不用提示。
 */
export function describeDroppedQueueMessage(
  reason: string,
  content: string | null | undefined,
  returnedToComposer: boolean,
): string | null {
  if (returnedToComposer) return null;
  if (!reason || reason === 'cancelled') return null;

  const headline = reason === 'aborted'
    ? composerText('queueDroppedAborted', '排队中的那条消息随本轮中止一起取消了,没有发送。')
    : reason === 'undeliverable'
      ? composerText('queueDroppedUndeliverable', '排队中的那条消息没能发出去(这条会话的状态在等待期间变了)。')
      : composerText('queueDroppedExpired', '排队中的那条消息等待超过 30 分钟,已作废,没有发送。');

  const original = typeof content === 'string' ? content.trim() : '';
  if (!original) return headline;
  const quoted = original.split('\n').map((line) => `> ${line}`).join('\n');
  return `${headline}\n\n${composerText('queueDroppedOriginal', '原文(可复制)——')}\n\n${quoted}`;
}
