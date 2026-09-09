/**
 * 用量与费用台账。
 *
 * 审计报告把这条列在功能项第 4 位,并单独加了一句:**这一步不做,这个产品永远
 * 答不出"值不值"**。`total_cost_usd` 一直流到前端了,但只活在浏览器内存里,
 * 终点是 `/cost` 弹窗的一行 —— 刷新就没,换台机器就没。
 */

import { getConnection } from '@/modules/database/connection.js';
import { cachedPrepare } from '@/modules/database/prepared-cache.js';
import { createLogger } from '@/shared/logger.js';

const log = createLogger('usage');

export type UsageSource = 'chat' | 'compact' | 'task' | 'api';

export type UsageRecordInput = {
  sessionId?: string | null;
  projectPath?: string | null;
  userId?: number | null;
  username?: string | null;
  provider: string;
  model?: string | null;
  source?: UsageSource;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * SDK 的 `total_cost_usd` —— 注意它是**会话累计**,不是这一轮的钱。
   * 这里会自己换算成增量,调用方原样传就行。
   */
  costUsdCumulative?: number;
  durationMs?: number | null;
};

export type UsageRecordRow = {
  id: number;
  session_id: string | null;
  project_path: string | null;
  user_id: number | null;
  username: string | null;
  provider: string;
  model: string | null;
  source: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  cost_usd_cumulative: number;
  duration_ms: number | null;
  created_at: string;
};

export type UsageSummaryRow = {
  key: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
};

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * 把 SDK 的**会话累计**费用换算成这一轮的增量。
 *
 * ## 这是整个功能里最容易做错的一处
 *
 * `total_cost_usd` 是会话累计值(前端也是当"最新值覆盖"用的,不是累加)。
 * 一轮一行地把它存进来再 `SUM()`,就是把第 N 轮的账算 N 遍 —— 十轮对话的账单
 * 会变成真实值的五倍多,而且**看起来完全正常**(数字是递增的、量级也对),
 * 只有拿去和账单核对时才会发现。
 *
 * ## 计数器重置怎么办
 *
 * 会话被 resume 到一个新 runtime 时,累计值可能从头开始。判据只能是"比上一次小":
 *
 * - `current >= previous` → 正常递增,增量 = 差值;
 * - `current < previous`  → 计数器重置了,`current` 本身就是这一轮(新一段)的花费。
 *
 * 第二种情况**不能钳成 0** —— 那会把重置之后的所有花费全部丢掉,账目单调偏小
 * 且没人看得出来。宁可在极端情况下多算一点,也不要静默少算。
 */
export const deriveCostDelta = (cumulative: number, previousCumulative: number): number => {
  const current = num(cumulative);
  const previous = num(previousCumulative);
  if (current === 0) return 0;
  return current >= previous ? current - previous : current;
};

export const usageRecordsDb = {
  /**
   * 记一轮。**永远不抛** —— 记账失败不该让用户的对话失败。
   *
   * 这条是刻意的:台账是旁路数据,而它的写入点在对话的收尾路径上。
   * 一次磁盘满或者一次 SQLITE_BUSY 就让整轮对话报错,代价远大于丢一行账。
   * 失败时打一行 error,人能从日志里看出账缺了。
   */
  record(input: UsageRecordInput): void {
    try {
      const db = getConnection();
      const sessionId = input.sessionId ?? null;

      // 同一会话上一次的累计值 —— 增量就是拿它比出来的
      const previous = sessionId
        ? (cachedPrepare(db,
            'SELECT cost_usd_cumulative AS c FROM usage_records WHERE session_id = ? ORDER BY id DESC LIMIT 1',
          ).get(sessionId) as { c: number } | undefined)
        : undefined;

      const cumulative = num(input.costUsdCumulative);
      const delta = deriveCostDelta(cumulative, previous?.c ?? 0);

      cachedPrepare(db, `
        INSERT INTO usage_records (
          session_id, project_path, user_id, username, provider, model, source,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd, cost_usd_cumulative, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        input.projectPath ?? null,
        input.userId ?? null,
        input.username ?? null,
        input.provider,
        input.model ?? null,
        input.source ?? 'chat',
        num(input.inputTokens),
        num(input.outputTokens),
        num(input.cacheReadTokens),
        num(input.cacheCreationTokens),
        delta,
        cumulative,
        input.durationMs ?? null,
      );
    } catch (error) {
      log.error('记一条用量失败(不影响对话):', (error as Error)?.message ?? error);
    }
  },

  /**
   * 明细分页。
   *
   * `userId` 不为 null 时只返回那个人的行 —— 和审计日志一样,这是**可见范围**
   * 不是筛选条件:费用行带着 project_path 和 model,不设防的话任何账号都能
   * 摸清别人在做什么项目。路由层负责决定传不传。
   */
  list(limit = 50, offset = 0, userId: number | null = null, sinceDays: number | null = null): UsageRecordRow[] {
    const db = getConnection();
    const safeLimit = Math.min(Math.max(1, limit), 500);
    const safeOffset = Math.max(0, offset);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (userId !== null) { clauses.push('user_id = ?'); params.push(userId); }
    if (sinceDays !== null && sinceDays > 0) {
      clauses.push("created_at >= datetime('now', ?)");
      params.push(`-${Math.floor(sinceDays)} days`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return cachedPrepare(db,
      `SELECT * FROM usage_records${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...params, safeLimit, safeOffset) as UsageRecordRow[];
  },

  count(userId: number | null = null, sinceDays: number | null = null): number {
    const db = getConnection();
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (userId !== null) { clauses.push('user_id = ?'); params.push(userId); }
    if (sinceDays !== null && sinceDays > 0) {
      clauses.push("created_at >= datetime('now', ?)");
      params.push(`-${Math.floor(sinceDays)} days`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const row = cachedPrepare(db, `SELECT COUNT(*) AS count FROM usage_records${where}`)
      .get(...params) as { count: number };
    return Number(row?.count) || 0;
  },

  /**
   * 按某个维度汇总。`groupBy` 只接受白名单里的列名 —— 它直接拼进 SQL,
   * 不能让调用方递任意字符串进来。
   */
  summarize(
    groupBy: 'username' | 'project_path' | 'model' | 'source' | 'day',
    userId: number | null = null,
    sinceDays: number | null = 30,
    limit = 50,
  ): UsageSummaryRow[] {
    const db = getConnection();
    const expression = groupBy === 'day'
      ? "date(created_at)"
      : groupBy;
    // 白名单已经在类型上收死,这里再挡一道:类型只在编译期,这条在运行期。
    if (!['username', 'project_path', 'model', 'source', 'day'].includes(groupBy)) {
      throw new Error(`unsupported groupBy: ${groupBy}`);
    }

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (userId !== null) { clauses.push('user_id = ?'); params.push(userId); }
    if (sinceDays !== null && sinceDays > 0) {
      clauses.push("created_at >= datetime('now', ?)");
      params.push(`-${Math.floor(sinceDays)} days`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';

    return cachedPrepare(db, `
      SELECT COALESCE(${expression}, '(未知)') AS key,
             COUNT(*) AS runs,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cache_creation_tokens) AS cache_creation_tokens,
             SUM(cost_usd) AS cost_usd
      FROM usage_records${where}
      GROUP BY ${expression}
      ORDER BY cost_usd DESC, runs DESC
      LIMIT ?
    `).all(...params, Math.min(Math.max(1, limit), 200)) as UsageSummaryRow[];
  },

  /** 一个会话花了多少 —— 会话详情里那一行。 */
  totalsForSession(sessionId: string): UsageSummaryRow | null {
    const db = getConnection();
    const row = cachedPrepare(db, `
      SELECT ? AS key, COUNT(*) AS runs,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cache_creation_tokens) AS cache_creation_tokens,
             SUM(cost_usd) AS cost_usd
      FROM usage_records WHERE session_id = ?
    `).get(sessionId, sessionId) as UsageSummaryRow | undefined;
    return row && row.runs > 0 ? row : null;
  },
};
