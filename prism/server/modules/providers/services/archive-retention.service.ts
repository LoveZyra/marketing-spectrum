/**
 * 归档保留期清扫(F8)。
 *
 * 归档是"软删除":会话从活跃列表消失但行还在,随时可以恢复。好处是误删可挽回,
 * 代价是**它永远不会自己消失** —— 一年下来回收站里几千条,库越来越大,而没有
 * 任何人会去手动清。
 *
 * `PRISM_ARCHIVE_RETENTION_DAYS` 给一个保留期,超期的归档会话被永久删除
 * (连同它的 transcript 文件与显示日志)。**默认 0 = 关闭** —— 这是不可逆操作,
 * 不能因为升级了一版就悄悄开始删用户的东西。要开是部署方的显式决定。
 *
 * 清扫按**更新时间**算,不是创建时间:一段两年前开始、上周还在聊的会话不该因为
 * "创建得早"被清掉。
 */

import { sessionsDb } from '@/modules/database/index.js';

/** 每轮最多删多少 —— 首次开启时回收站里可能有几千条,不要一口气占住事件循环。 */
const SWEEP_BATCH = 200;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 保留天数。0 或未配置 = 不清扫(默认)。 */
export function getArchiveRetentionDays(): number {
  const parsed = Number.parseInt(process.env.PRISM_ARCHIVE_RETENTION_DAYS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 找出该清的归档会话 id。纯查询,不删任何东西 —— 单测钉判据。
 */
export function findExpiredArchivedSessions(retentionDays: number, limit = SWEEP_BATCH): string[] {
  if (retentionDays <= 0) return [];
  // scope=all:清扫是系统行为,不属于任何访问者,不能按谁的可见性过滤。
  const page = sessionsDb.getArchivedSessionsPage({ kind: 'all' }, limit, 0);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  return page.rows
    .filter((row) => {
      const stamp = Date.parse(row.updated_at ?? row.created_at ?? '');
      return Number.isFinite(stamp) && stamp < cutoff;
    })
    .map((row) => row.session_id);
}

type SweepDependencies = {
  /** 永久删除一条会话(连同 transcript)。注入以避免与 sessions.service 相互 import。 */
  deleteSession: (sessionId: string) => Promise<unknown>;
};

export async function sweepExpiredArchives(dependencies: SweepDependencies): Promise<number> {
  const retentionDays = getArchiveRetentionDays();
  if (retentionDays <= 0) return 0;

  const expired = findExpiredArchivedSessions(retentionDays);
  let removed = 0;
  for (const sessionId of expired) {
    try {
      await dependencies.deleteSession(sessionId);
      removed += 1;
    } catch {
      // 单条失败不该拦住其余;下一轮还会再碰到它。
    }
  }
  if (removed > 0) {
    console.log(`[archive] 清理了 ${removed} 条超过 ${retentionDays} 天的归档会话`);
  }
  return removed;
}

/** 启动时跑一次(停机期间积压的最多),之后每 6 小时一轮。 */
export function startArchiveRetentionSweeper(dependencies: SweepDependencies): NodeJS.Timeout | null {
  if (getArchiveRetentionDays() <= 0) return null;

  void sweepExpiredArchives(dependencies).catch(() => {});
  const timer = setInterval(() => { void sweepExpiredArchives(dependencies).catch(() => {}); }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}
