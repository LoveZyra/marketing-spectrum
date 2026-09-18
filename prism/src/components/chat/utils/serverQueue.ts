/**
 * B4:服务端排队卡片的状态 —— **按会话存**,不是全视图一份。
 *
 * 这份排队存在服务端(刷新页面、换设备、关标签页之后都还在),所以只能由
 * 服务端的帧驱动。而帧是**所有已订阅会话**的帧一起来的:`chat_status` ack
 * 每条会话各回一份、`chat_queued` 在哪条会话撞上在跑的回合就从哪条发。
 *
 * 原来它是一个 `{sessionId, preview, enqueuedAt} | null`,于是:
 *
 *   - **后来的会话会把先前那条挤掉。** A 有一条在排队,此时 B 的 ack 到达 ——
 *     状态被整个换成 B 的。切回 A 时卡片不见了,而服务端那条消息**还在队列里**,
 *     要等下一次 ack 才会重新出现;
 *   - **取消可能取消错会话。** 取消按钮读的是状态里的 `sessionId`,不是正在看的
 *     那条。卡片渲染出来之后、用户点下去之前若有一帧别的会话的 queued 落地,
 *     这一点就取消了**另一条会话**排队中的消息 —— 用户看着 A 的卡片,消失的是 B 的。
 *
 * 按会话存之后两件事都不成立:每条会话的排队互不干扰,取消按会话 id 取。
 */
export interface ServerQueuedMessage {
  preview: string;
  enqueuedAt: string;
  /** gi:不是自己排的 —— 服务端把正文脱敏了,界面显示占位而不是把空串当"没正文"。 */
  redacted?: boolean;
}

export type ServerQueueMap = ReadonlyMap<string, ServerQueuedMessage>;

export const EMPTY_SERVER_QUEUE: ServerQueueMap = new Map();

/**
 * 落一帧排队状态。
 *
 * **没有变化时返回原来那个 Map**(引用相等)。`chat_status` ack 在正常空闲时
 * 也会带 `queued: null` 回来,一秒可能好几帧;每帧都造新 Map 会让整个聊天视图
 * 白重渲染一次。原来那个 `useState` 的 null 分支正是为此写成
 * `current => current.sessionId === sid ? null : current`,这个性质要保住。
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
 * 一条排队消息被丢弃时,要不要在对话里留一句话,留什么。
 *
 * ga:**文案必须按实际发生的事写。**
 *
 * fz 给 `undeliverable` 写的提示是"……正文已退回输入框",而回填的前提是
 * "你正在看这条会话"**且**"输入框是空的" —— 恰恰这条帧最常见的触发场景
 * (用户切走了、或者正在打别的字)两个前提都不成立。于是提示说"东西还在你
 * 手上",他去输入框找,什么都没有:本地那份在第一次 ACK 时就清掉了,服务端
 * 那份刚被丢弃,那段话真的没了。
 *
 * 前台贴了张告示:"您寄存的包裹送不出去,**已经放回您的储物柜了**。"
 * 你打开储物柜,空的 —— 因为放回去的前提是柜子当时空着。
 *
 * 所以:
 *  - 真的退回输入框了 → **一句话都不用说**,东西在用户手上;
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
    ? '排队中的那条消息随本轮中止一起取消了,没有发送。'
    : reason === 'undeliverable'
      ? '排队中的那条消息没能发出去(这条会话的状态在等待期间变了)。'
      : '排队中的那条消息等待超过 30 分钟,已作废,没有发送。';

  const original = typeof content === 'string' ? content.trim() : '';
  if (!original) return headline;
  const quoted = original.split('\n').map((line) => `> ${line}`).join('\n');
  return `${headline}\n\n原文(可复制)——\n\n${quoted}`;
}
