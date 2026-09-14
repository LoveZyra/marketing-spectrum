import type { ClaudeSettings } from '../types/types';

import {
  canClaim,
  claimHeldBy,
  makeTabId,
  withoutClaim,
  type QueueClaimFields,
} from './queueClaim';

export const CLAUDE_SETTINGS_KEY = 'claude-settings';

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old drafts');

        /**
         * fj:配额兜底**只清草稿**,绝不碰 `queued_message_*`。
         *
         * 那不是缓存,是**还没发出去、正等着自动重发的消息**。原来两类一起删,
         * 于是任意一次写入撞上配额,所有会话里排队的消息就静默消失 ——
         * `useQueuedMessageAutoSend` 与输入框的 flush 都读不到键,用户既不会
         * 收到提示,也不会看到那条消息发出去。
         *
         * 而且草稿键本身**只增不减**(会话删除时没有任何清理调用点),
         * 所以配额撞线是迟早的事,不是异常路径。清的时候按 key 顺序删一半,
         * 不是全删 —— 用户当前正在打的那条草稿也在这堆里。
         */
        const draftKeys = Object.keys(localStorage).filter((k) => k.startsWith('draft_input_'));
        // 保守起见留下最后写入的那一批(key 顺序不保证时间序,但删一半足够腾地方)
        const toDrop = draftKeys.slice(0, Math.max(1, Math.ceil(draftKeys.length / 2)));
        toDrop.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch {
          // 还是不够 —— 这时才把剩下的草稿也清掉,但排队消息仍然留着。
          draftKeys.forEach((k) => localStorage.removeItem(k));
          try {
            localStorage.setItem(key, value);
          } catch (retryError) {
            console.error('Failed to save to localStorage even after cleanup:', retryError);
          }
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

/**
 * Composer options captured when a message is queued, so the message can be
 * sent later with the exact settings (model, permission mode, tools) the
 * session's composer had at queue time — even from outside the composer,
 * e.g. the app-level auto-send that fires while another session is viewed.
 */
export type QueuedSendOptions = Record<string, unknown>;

/**
 * 盘上那份排队记录。
 *
 * fz:类型补齐 —— `toStoredCommand` 写进去的字段在这里一个都没有,于是读回来
 * 的那份被 `as StoredSendCommand` 强转着用,类型系统对"读少了几项"一言不发
 * (`readQueuedMessage` 削字段那个 bug 因此躲了很久)。这些字段是可选的:
 * 老记录、以及只存了正文的历史格式都没有。
 */
export type StoredQueuedMessage = QueueClaimFields & {
  content: string;
  options?: QueuedSendOptions;
  /** F09 幂等键 —— 服务端据此去重并回 ACK。老记录没有。 */
  clientMessageId?: string;
  /** 图片描述符(纯 JSON,能跨刷新)。 */
  images?: unknown[];
  /** 提交时有几张图 —— 与 `images.length` 对不上就说明附件丢了(F12)。 */
  imageCount?: number;
  namingText?: string;
  forkFrom?: unknown;
  hiddenContext?: string | null;
};

/**
 * 本标签页的 id。同一个标签页里的两个认领方(输入框 flush 和 app 级自动发送)
 * 共用它 —— 它们靠"清键"就能互相避让,要互斥的是**别的标签页**。
 */
export const QUEUE_TAB_ID = makeTabId();

export const queuedMessageKey = (sessionId: string) => `queued_message_${sessionId}`;

/**
 * Reads a session's queued message. Understands both the JSON
 * `{ content, options }` format and the legacy raw-text format.
 */
export function readQueuedMessage(sessionId: string): StoredQueuedMessage | null {
  const raw = safeLocalStorage.getItem(queuedMessageKey(sessionId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as StoredQueuedMessage).content === 'string') {
      /**
       * fz:**保留未知字段。**
       *
       * 这里原来是解构出四个字段再**新建一个对象**返回,于是
       * `toStoredCommand` 写进去的 `clientMessageId / images / imageCount /
       * namingText / forkFrom / hiddenContext` 在读回来的路上全被扔掉 ——
       * 而唯一的读者把返回值 `as StoredSendCommand` 用。后果三条,每条都是
       * 被专门修过的老病:
       *
       * 1. `imageCount` 没了 → `attachmentsLost` 恒为 false →
       *    `needs_attachment` 一次都触发不了 → 冲队把一条引用了不存在图片的话
       *    直接发给模型(F12 原样复活);
       * 2. `clientMessageId` 没了 → fr 那条"这个标签页发过的命令不许回到待发"
       *    的兜底判据恒为 undefined,分支永不进入;
       * 3. `forkFrom` / `hiddenContext` 没了 → 排队的「编辑重跑」刷新后变成在
       *    当前会话里续跑,而不是分叉。
       *
       * 而 `claimQueuedMessageAs` 认领时会把这份读结果原样写回盘上 ——
       * **认领动作把盘上那份永久削平**,这是"同一条记录两个写者"的另一半。
       *
       * 单测之所以全绿:它拿 `toStoredCommand(...)` 的返回值直接喂
       * `fromStoredCommand`,**中间没走 localStorage**。所以这次补的回归测试
       * 必须真的走一遍存储。
       */
      const stored = parsed as StoredQueuedMessage;
      return stored.content.trim() ? { ...stored } : null;
    }
  } catch {
    // Legacy format: the raw draft text itself.
  }

  return raw.trim() ? { content: raw } : null;
}

export function writeQueuedMessage(sessionId: string, message: StoredQueuedMessage): void {
  safeLocalStorage.setItem(queuedMessageKey(sessionId), JSON.stringify(message));
}

export function clearQueuedMessage(sessionId: string): void {
  safeLocalStorage.removeItem(queuedMessageKey(sessionId));
}

/**
 * 认领一条排队消息:盖上本标签页的戳,再**回读一次**确认戳还是自己的。
 *
 * 返回 null 有三种情况:没有排队记录、别的标签页刚认领过且还没过期、或者回读发现
 * 戳被别人盖掉了(同 tick 竞争,后写的赢)。三种都表示"这条不该由我发"。
 *
 * `tabId` 参数是为了能在测试里模拟两个标签页;生产调用走 `QUEUE_TAB_ID`。
 */
export function claimQueuedMessageAs(
  sessionId: string,
  tabId: string,
  now: number = Date.now(),
): StoredQueuedMessage | null {
  const entry = readQueuedMessage(sessionId);
  if (!entry || !canClaim(entry, tabId, now)) {
    return null;
  }

  writeQueuedMessage(sessionId, { ...entry, claimedBy: tabId, claimedAt: now });

  const confirmed = readQueuedMessage(sessionId);
  return confirmed && claimHeldBy(confirmed, tabId) ? confirmed : null;
}

export function claimQueuedMessage(
  sessionId: string,
  now: number = Date.now(),
): StoredQueuedMessage | null {
  return claimQueuedMessageAs(sessionId, QUEUE_TAB_ID, now);
}

/**
 * 认领之后没发出去(比如 socket 没开),把自己的戳摘掉,让别的标签页/下一轮能接
 * 手 —— 不然要白等一个 TTL。别人的戳不动。
 */
export function releaseQueuedMessageAs(sessionId: string, tabId: string): void {
  const entry = readQueuedMessage(sessionId);
  if (!claimHeldBy(entry, tabId)) {
    return;
  }
  writeQueuedMessage(sessionId, withoutClaim(entry as StoredQueuedMessage));
}

export function releaseQueuedMessage(sessionId: string): void {
  releaseQueuedMessageAs(sessionId, QUEUE_TAB_ID);
}

export function getClaudeSettings(): ClaudeSettings {
  const raw = safeLocalStorage.getItem(CLAUDE_SETTINGS_KEY);
  if (!raw) {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      skipPermissions: Boolean(parsed.skipPermissions),
      projectSortOrder: parsed.projectSortOrder || 'name',
    };
  } catch {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }
}
