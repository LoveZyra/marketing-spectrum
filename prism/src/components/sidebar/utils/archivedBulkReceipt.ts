/** 批量恢复 / 永久删除归档会话的回执(`POST /api/providers/sessions/bulk` 的 data)。 */
export type ArchivedBulkReceipt = {
  succeeded?: string[];
  skipped?: string[];
  failed?: string[];
};

export type ArchivedBulkShortfall = {
  requested: number;
  done: number;
  /** 看不见或无权操作,服务端静默跳过的条数。 */
  skipped: number;
  /** 处理时出错的条数;重试可能有用。 */
  failed: number;
};

/**
 * 实际处理的条数少于选中的条数时,给出缺口的账;全部处理了返回 null。
 *
 * 服务端逐条鉴权:看不见或无权操作的静默跳过(计入 skipped),出错的不中断其余(计入 failed)。
 * 少了的那几条要告诉用户,不能装作全成。回执里没有 skipped / failed 时,把差额都算作出错。
 */
export function summarizeArchivedBulkShortfall(
  requested: number,
  receipt: ArchivedBulkReceipt | undefined,
): ArchivedBulkShortfall | null {
  const done = receipt?.succeeded?.length ?? 0;
  if (done >= requested) return null;
  const skipped = receipt?.skipped?.length ?? 0;
  const failed = receipt?.failed?.length ?? Math.max(0, requested - done - skipped);
  return { requested, done, skipped, failed };
}
