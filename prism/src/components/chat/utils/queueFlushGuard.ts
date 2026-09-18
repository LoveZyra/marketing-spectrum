/**
 * gk:排队冲队的几条判据,抽成纯函数好钉住。
 *
 * 2026-09-15 测试环境的现场:取消了排队卡那条照样发出去了;正常发的一句变成排队;
 * 同一句话的气泡出现了四次,回复到达后多出来的又消失(服务端只收下一条,其余按
 * 幂等键判成 duplicate;多出来的三个是**本地乐观回声**,刷新后被服务端那份去重掉)。
 *
 * 症状指向三个共同的病根,这里各给一条判据:
 *   1. **取消不是权威的**:`deleteQueuedDraft` 只清内存,盘上那份靠落盘 effect 下一拍才清 ——
 *      冲队定时器 / 另一个标签页 / 换会话恢复 都可能在这一拍之前把它读回来。
 *      → 取消当场清盘,并把这条幂等键记成"已作废",恢复与冲队两处都拒绝它。
 *   2. **冲队的锁不覆盖"发完清盘"**:`runExclusive` 的回调是同步返回的,投递与清盘在锁
 *      释放之后才发生;这段窗口里第二个冲队(isLoading / isConnected 再翻一次)照样
 *      认领得到盘上那份 → 同一条命令再投一次。→ 认领到的记录必须与内存里要投的是**同一条**
 *      (`shouldDispatchClaimed`),锁里 await 投递直到清盘。
 *   3. **同一个幂等键的回声只画一次**:重投(断线重连、duplicate ACK)是设计允许的,
 *      但气泡不该跟着重投一次画一次。
 */

export type ClaimedRecordLike = { clientMessageId?: string } | null;

/**
 * 认领到的盘上记录,能不能拿来投递内存里这条命令。
 *
 * - 没认领到 → 键已经没了(发过 / 取消过)或别的标签页抢走 → 不投,内存那条作废;
 * - 认领到的记录带幂等键、且和内存那条**不是同一条** → 盘上已经换成另一条(别的标签页
 *   排的新消息、或换会话前的旧记录)→ 不投内存这条,由调用方按盘上那份重新装载;
 * - 老记录没有幂等键 → 只能信内存那条(与 fz 之前一致)。
 */
export function shouldDispatchClaimed(
  claimed: ClaimedRecordLike,
  pendingClientMessageId: string,
  retired: ReadonlySet<string>,
): 'dispatch' | 'drop' | 'resync' {
  if (!claimed) return 'drop';
  // 先判"是不是同一条":盘上已经是另一条时,内存这条无论作没作废都不该投,按盘上重装。
  if (claimed.clientMessageId && claimed.clientMessageId !== pendingClientMessageId) return 'resync';
  if (retired.has(pendingClientMessageId)) return 'drop';
  return 'dispatch';
}

/**
 * 换会话 / 首次挂载时从盘上恢复的那条,该不该装进内存。
 * 这个标签页已经发过(dispatched)或已经取消过(retired)的一律不装,并且把盘清掉。
 */
export function shouldRestoreStored(
  storedClientMessageId: string | undefined,
  dispatched: ReadonlySet<string>,
  retired: ReadonlySet<string>,
): boolean {
  if (!storedClientMessageId) return true;
  return !dispatched.has(storedClientMessageId) && !retired.has(storedClientMessageId);
}

/**
 * 另一个标签页改了盘上这条会话的排队记录(storage 事件),内存里那条该怎么办。
 *
 * - 记录被删(newValue 为空)且内存里正是同一条在等着发 → 别人取消或发出去了,这边也撤;
 * - 记录换成了另一条幂等键 → 内存这条已经过时,按盘上那份重装;
 * - 其余(同一条被别人盖了认领戳)→ 不动。
 */
export function reconcileWithStorageEvent(
  memoryClientMessageId: string | null,
  memoryPending: boolean,
  newValueClientMessageId: string | null | undefined,
  removed: boolean,
): 'drop' | 'resync' | 'keep' {
  if (!memoryPending || !memoryClientMessageId) return 'keep';
  if (removed) return 'drop';
  if (newValueClientMessageId && newValueClientMessageId !== memoryClientMessageId) return 'resync';
  return 'keep';
}

/** 同一个幂等键只画一次乐观回声。返回 true = 这次该画。 */
export function shouldEchoOnce(echoed: Set<string>, clientMessageId: string): boolean {
  if (echoed.has(clientMessageId)) return false;
  echoed.add(clientMessageId);
  return true;
}

/** 同一条命令在一个窗口内最多自动投递几次 —— 超过就停下来交给用户,别无限重投。 */
export const FLUSH_MAX_ATTEMPTS = 5;
export const FLUSH_ATTEMPT_WINDOW_MS = 60_000;

/**
 * 记一次自动投递,返回这次还允不允许。按幂等键计数(换了一条从 1 数),窗口过了从 1 数。
 * 与 useQueuedMessageAutoSend 的 autoSendAttemptAllowed 同一套口径 —— 那边管后台会话,
 * 这边管正在看的这条;此前这条路**没有上限**。
 */
export function flushAttemptAllowed(
  attempts: Map<string, { count: number; firstAt: number }>,
  clientMessageId: string,
  now: number,
  max: number = FLUSH_MAX_ATTEMPTS,
  windowMs: number = FLUSH_ATTEMPT_WINDOW_MS,
): boolean {
  const entry = attempts.get(clientMessageId);
  if (!entry || now - entry.firstAt > windowMs) {
    attempts.set(clientMessageId, { count: 1, firstAt: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}
