/**
 * 排队消息的**跨标签页互斥**。
 *
 * 排队的消息写在 localStorage 的 `queued_message_<sessionId>` 里,所以它能跨页面
 * 存活 —— 这本身是想要的。代价是有两个认领方:
 *   1. 输入框自己的 flush(当前打开的这个会话);
 *   2. `useQueuedMessageAutoSend`(你没在看、但刚跑完的那些会话)。
 *
 * 同一个标签页内它们不会撞车(自动发送跳过 `activeSessionId`)。跨标签页就没有
 * 这个保证了:两个标签页是两个独立的运行时,各有一份 processing 表,同一个会话
 * 跑完时可能各自读到同一份排队记录、各自发出去。服务端不判重 —— 收到的就是两条
 * 独立的 `chat.send`。
 *
 * 两层防护:
 *   - **Web Locks**(`navigator.locks`)可用时,整个「读 → 认领 → 发 → 清」在锁里
 *     跑,浏览器级互斥,窗口彻底关掉;
 *   - 没有 Web Locks 时退回**盖戳 + 回读**:写入自己的 tabId 后再读一次,只有读回
 *     来还是自己的戳才算认领成功(两边同 tick 都写过戳时,只有最后写进去的那个
 *     赢)。戳带过期时间,认领方崩了以后别人还能接手。
 */

/** 认领戳多久算过期。认领方发到一半崩了,别的标签页等这么久就能接手。 */
export const QUEUE_CLAIM_TTL_MS = 8_000;

export interface QueueClaimFields {
  /** 认领这条记录的标签页 id。 */
  claimedBy?: string;
  /** 认领时刻(epoch ms),用来判过期。 */
  claimedAt?: number;
}

/** 每个标签页一个 id。同一个标签页内的两个认领方共用它 —— 它们本来就不该互斥。 */
export function makeTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function queueLockName(sessionId: string): string {
  return `prism-queued-message:${sessionId}`;
}

/** 这条排队记录现在能不能被 `tabId` 认领。 */
export function canClaim(
  entry: QueueClaimFields | null | undefined,
  tabId: string,
  now: number,
  ttl: number = QUEUE_CLAIM_TTL_MS,
): boolean {
  if (!entry) return false;
  if (!entry.claimedBy) return true;
  // 自己的戳:续期,不是抢锁。
  if (entry.claimedBy === tabId) return true;
  const claimedAt = typeof entry.claimedAt === 'number' ? entry.claimedAt : 0;
  return now - claimedAt >= ttl;
}

/** 回读校验:这条记录现在盖的是不是 `tabId` 的戳。 */
export function claimHeldBy(entry: QueueClaimFields | null | undefined, tabId: string): boolean {
  return !!entry && entry.claimedBy === tabId;
}

/** 摘掉 `tabId` 自己的戳(别人的不动),让下一个认领方能接手。 */
export function withoutClaim<T extends QueueClaimFields>(entry: T): Omit<T, keyof QueueClaimFields> {
  const { claimedBy: _claimedBy, claimedAt: _claimedAt, ...rest } = entry;
  return rest;
}

export interface LockManagerLike {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
}

interface LockScope {
  navigator?: { locks?: unknown };
}

/** 拿到浏览器的 Web Locks;环境里没有(老浏览器、测试用的 node)就返回 null。 */
export function getLockManager(scope: unknown = globalThis): LockManagerLike | null {
  const locks = (scope as LockScope | undefined)?.navigator?.locks as LockManagerLike | undefined;
  return typeof locks?.request === 'function' ? locks : null;
}

/**
 * 有真锁就在锁里跑,没有就直接跑(靠盖戳兜底)。
 *
 * 故意不吞异常:`fn` 抛错时排队记录还在 localStorage 里,下一轮还能重来 ——
 * 在这里 catch 再重跑一次反而会发重。
 */
export async function runExclusive<T>(
  name: string,
  fn: () => T | Promise<T>,
  scope: unknown = globalThis,
): Promise<T> {
  const locks = getLockManager(scope);
  if (!locks) return await fn();
  return await locks.request(name, fn);
}
