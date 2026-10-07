/**
 * 这个标签页发出过哪些 `chat.send`(按幂等键记),给 WebSocketContext 的 `wasSentHere` 用。
 *
 * 服务端有些帧会把某条消息的正文带回来(排队被中止时退回的那段),同一个人开着的别的标签页
 * 也会收到;只有真正发出这条消息的标签页才该把正文填回输入框。
 *
 * 另存一份到 sessionStorage:它按标签页隔离、刷新不丢。只记在内存的话,发完刷新一下,
 * 这个标签页就不再认得自己排进去的那条,被中止时正文回不到输入框里。
 */

/** 记多少个最近发出的幂等键。判据只关心最近这些条,超了丢最旧的。 */
const MAX_SENT_CLIENT_MESSAGE_IDS = 400;

/** sessionStorage 里那份的键。 */
export const SENT_CLIENT_MESSAGE_IDS_STORAGE_KEY = 'prism:sentClientMessageIds';

/** 一帧出站消息若是 `chat.send`,取出它的幂等键;不是或没带就返回 null。 */
export function chatSendClientMessageId(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const frame = message as { type?: unknown; clientMessageId?: unknown };
  if (frame.type !== 'chat.send') return null;
  return typeof frame.clientMessageId === 'string' && frame.clientMessageId ? frame.clientMessageId : null;
}

/** 记下一个发出去的幂等键并封顶(Set 的插入序就是时间序,超了从最旧的删)。 */
export function rememberSentClientMessageId(
  ids: Set<string>,
  clientMessageId: string,
  max: number = MAX_SENT_CLIENT_MESSAGE_IDS,
): void {
  ids.delete(clientMessageId);
  ids.add(clientMessageId);
  for (const id of ids) {
    if (ids.size <= max) break;
    ids.delete(id);
  }
}

type TabStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** 本标签页的 sessionStorage;拿不到(隐私模式、被禁用、不在浏览器里)时返回 null。 */
function tabStorage(): TabStorage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function loadIds(storage: TabStorage | null, max: number): Set<string> {
  const ids = new Set<string>();
  try {
    const raw = storage?.getItem(SENT_CLIENT_MESSAGE_IDS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const id of parsed) {
        if (typeof id === 'string' && id) rememberSentClientMessageId(ids, id, max);
      }
    }
  } catch {
    // 读不出来(存储不可用、内容坏了)就从空集开始,只影响刷新之前发的那几条
  }
  return ids;
}

export interface SentClientMessageIds {
  /** 一帧真的送出去之后调用:是 `chat.send` 就记下它的幂等键。 */
  noteSent(message: unknown): void;
  has(clientMessageId: string): boolean;
}

/**
 * 本标签页的已发送幂等键:内存里一份,sessionStorage 里一份。
 * 存储不可用、写满了,都退回只记在内存,不影响发送本身。
 */
export function createSentClientMessageIds(
  storage: TabStorage | null = tabStorage(),
  max: number = MAX_SENT_CLIENT_MESSAGE_IDS,
): SentClientMessageIds {
  const ids = loadIds(storage, max);
  return {
    noteSent(message) {
      const clientMessageId = chatSendClientMessageId(message);
      if (!clientMessageId) return;
      rememberSentClientMessageId(ids, clientMessageId, max);
      try {
        storage?.setItem(SENT_CLIENT_MESSAGE_IDS_STORAGE_KEY, JSON.stringify([...ids]));
      } catch {
        // 存不进去(配额、隐私模式)就只留在内存
      }
    },
    has: (clientMessageId) => ids.has(clientMessageId),
  };
}
