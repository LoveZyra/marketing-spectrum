import type { NormalizedMessage } from '@/shared/types.js';

export type CachedHistory = {
  /** Full normalized history, oldest first. Never a page. */
  messages: NormalizedMessage[];
  /** Message count excluding `tool_result` records, matching FetchHistoryResult.total. */
  total: number;
};

type CacheEntry = CachedHistory & {
  /** Identity of the transcript this was normalized from. */
  fingerprint: string;
  /** Source transcript size, used for the eviction budget. */
  bytes: number;
};

/** 32 MiB of source transcript held across all entries. See the class docblock. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * LRU cache of fully-normalized Claude session history.
 *
 * fetchHistory always loads the *entire* transcript, even when the caller asked
 * for a 50-message page, because `total` has to count frontend-normalized
 * messages rather than raw JSONL records. Normalizing means a line-by-line read
 * of the session file plus a readdir and a full parse of every referenced
 * subagent transcript. Paging backwards through a long conversation therefore
 * redid all of that work on every request, scaling with transcript length
 * exactly where the user is most likely to have a long one.
 *
 * Two properties keep this from becoming the memory leak it looks like:
 *
 * 1. Entries are budgeted, not counted. A count-based cap sounds equivalent but
 *    is not: transcripts range from a few KB to tens of MB, so "keep 5" means
 *    anywhere from 50 KB to 500 MB of retained objects. The budget is measured
 *    in *source* bytes as a stable proxy — the normalized objects are larger, so
 *    the real ceiling is a multiple of DEFAULT_MAX_BYTES, which is why the
 *    default is set well below what the process can afford.
 *
 * 2. A transcript larger than the whole budget is never cached at all, rather
 *    than being cached after evicting everything else. One 40 MB session must
 *    not flush the working set of every other open conversation.
 *
 * Entries are keyed by transcript identity (mtime + size), so an append by a
 * running session invalidates on the next read instead of serving a truncated
 * history. Stale entries are dropped on the miss rather than left to age out —
 * a superseded fingerprint can never become valid again.
 *
 * Cached messages are handed out by reference and must be treated as read-only;
 * sessions.service.ts shallow-copies each message before remapping sessionId,
 * which is what makes that safe today.
 */
export class FetchHistoryCache {
  private readonly maxBytes: number;
  /** Insertion order doubles as LRU order: reads re-insert at the tail. */
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  /**
   * 单个条目的上限,默认是总预算的 1/4。
   *
   * 原来只有总预算这一道闸:一个 24 MB 的会话能独占 3/4 的额度,把其他所有人的
   * 条目挤出去。单人使用时无所谓,多用户下这是缓存抖动 —— 一个人打开长会话,
   * 其余人的历史全部变冷。超过这个尺寸的会话干脆不缓存,让它每次都冷读,
   * 好过让它把别人的都赶走。
   */
  private readonly maxEntryBytes: number;

  constructor(options: { maxBytes?: number; maxEntryBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    // 默认不额外限制:类的通用契约仍然是"只受总预算约束"。是否要给单条目再加
    // 一道闸是部署策略,由构造点决定(见 claude-sessions.provider.ts)。
    this.maxEntryBytes = options.maxEntryBytes ?? this.maxBytes;
  }

  get(key: string, fingerprint: string): CachedHistory | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    if (entry.fingerprint !== fingerprint) {
      this.delete(key);
      return null;
    }

    // Re-insert to move this key to the tail of the eviction order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { messages: entry.messages, total: entry.total };
  }

  set(key: string, fingerprint: string, bytes: number, value: CachedHistory): void {
    this.delete(key);

    if (bytes > this.maxEntryBytes) {
      return;
    }

    while (this.totalBytes + bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.delete(oldestKey);
    }

    this.entries.set(key, { fingerprint, bytes, messages: value.messages, total: value.total });
    this.totalBytes += bytes;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Entry count. Exposed for tests and diagnostics. */
  get size(): number {
    return this.entries.size;
  }

  /** Source bytes currently charged against the budget. Exposed for tests. */
  get bytes(): number {
    return this.totalBytes;
  }
}
