/**
 * 归档保留期清扫。
 *
 * 归档是"软删除":会话从活跃列表消失但行还在,随时可以恢复。好处是误删可挽回,
 * 代价是它永远不会自己消失 —— 一年下来归档里几千条,库越来越大,而没有
 * 任何人会去手动清。
 *
 * `PRISM_ARCHIVE_RETENTION_DAYS` 给一个保留期,超期的归档会话按永久删除处理
 * (由调用方注入的 deleteSession 执行,会话进最近删除,之后由回收站清扫器真删)。
 * 默认 0 = 关闭:删用户的东西必须是部署方的显式决定。
 *
 * 到期起点取归档时间与最后活动时间中较晚的那个(判据在 `sessionsDb.getExpiredArchivedSessions`):
 * 刚归档的旧会话也至少留满保留期 —— 先归档、留个后悔期是常见用法,只看最后活动时间的话,
 * 归档一批两个月没动过的会话,下一轮清扫就全进了最近删除;归档前还在聊的会话按最后活动算。
 * 不看创建时间:一段两年前开始、上周还在聊的会话不该因为"创建得早"被清掉。
 */

import { sessionsDb } from '@/modules/database/index.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('providers');

/** 每轮最多删多少:首次开启时归档里可能有几千条,不要一口气占住事件循环。 */
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
  /*
   * cutoff 下推到 SQL,不要"取一页回来再过滤":归档列表按 updated_at 倒序(最新在前),
   * 而超期的恰恰是最旧的那些。最新一页都还在保留期内时,先取页再过滤会一条都删不到,
   * 而且没有任何日志提示(`removed > 0` 才打日志)。
   */
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return sessionsDb.getExpiredArchivedSessions(cutoff, limit);
}

type SweepDependencies = {
  /** 永久删除一条会话(连同 transcript 进最近删除)。注入以避免与 sessions.service 相互 import。 */
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
    log.info(`[archive] 清理了 ${removed} 条超过 ${retentionDays} 天的归档会话`);
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
