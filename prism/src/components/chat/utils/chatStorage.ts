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
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        const draftKeys = keys.filter((k) => k.startsWith('draft_input_') || k.startsWith('queued_message_'));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
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

export type StoredQueuedMessage = QueueClaimFields & {
  content: string;
  options?: QueuedSendOptions;
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
      const { content, options, claimedBy, claimedAt } = parsed as StoredQueuedMessage;
      return content.trim() ? { content, options, claimedBy, claimedAt } : null;
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
