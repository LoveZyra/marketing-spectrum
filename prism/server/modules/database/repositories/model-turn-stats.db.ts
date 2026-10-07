/**
 * 每模型的回合健康度 —— 首字延迟、失败率、失败原因。
 *
 * 多个网关模型并存时,"哪个模型工具调用不稳、哪个慢"不能只靠用户口头反馈。SDK 的 result 帧
 * 带着答案:`terminal_reason`(`api_error` / `malformed_tool_use_exhausted` / `prompt_too_long` …)
 * 与 `ttft_ms`(首字延迟)。每个用户回合记一行,设置 → 模型 里按模型汇总最近 N 天。
 *
 * 与用量台账分开记:台账只记有 token 的回合(空轮不记),而失败恰恰常是零 token 的 —— 混在一起
 * 失败率就被低估了。行很小,保留 30 天(写入时顺手清)。
 */

import { getConnection } from '@/modules/database/connection.js';
import { cachedPrepare } from '@/modules/database/prepared-cache.js';
import { createLogger } from '@/shared/logger.js';

const log = createLogger('model-stats');

const RETENTION_DAYS = 30;
const PRUNE_EVERY = 200;
let writesSincePrune = 0;

export type ModelTurnStatInput = {
  model: string;
  source?: string | null;
  isError: boolean;
  terminalReason?: string | null;
  ttftMs?: number | null;
  durationMs?: number | null;
};

export type ModelTurnSummary = {
  model: string;
  turns: number;
  errors: number;
  errorRate: number;
  /** 首字延迟中位数(ms);没有样本时 null。 */
  ttftP50Ms: number | null;
  ttftP90Ms: number | null;
  /** 失败原因 → 次数(只含失败回合),按次数倒序。 */
  reasons: Array<{ reason: string; count: number }>;
};

const finiteOrNull = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export const modelTurnStatsDb = {
  /** 记一行。永不抛 —— 统计失败不能把回合带崩。 */
  record(input: ModelTurnStatInput): void {
    const model = typeof input.model === 'string' ? input.model.trim().slice(0, 120) : '';
    if (!model) return;
    try {
      cachedPrepare(
        getConnection(),
        `INSERT INTO model_turn_stats (model, source, is_error, terminal_reason, ttft_ms, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        model,
        (input.source || 'chat').slice(0, 20),
        input.isError ? 1 : 0,
        input.terminalReason ? String(input.terminalReason).slice(0, 60) : null,
        finiteOrNull(input.ttftMs),
        finiteOrNull(input.durationMs),
      );
      writesSincePrune += 1;
      if (writesSincePrune >= PRUNE_EVERY) {
        writesSincePrune = 0;
        modelTurnStatsDb.prune();
      }
    } catch (error) {
      log.warn('[model-stats] record failed:', (error as Error)?.message || error);
    }
  },

  prune(days = RETENTION_DAYS): number {
    try {
      const result = getConnection()
        .prepare(`DELETE FROM model_turn_stats WHERE created_at < datetime('now', ?)`)
        .run(`-${Math.max(1, Math.floor(days))} days`);
      return result.changes;
    } catch (error) {
      log.warn('[model-stats] prune failed:', (error as Error)?.message || error);
      return 0;
    }
  },

  /** 最近 `days` 天按模型汇总(只算用户回合与定时 / API 回合;压缩等内部回合不记)。 */
  summarize(days = 7): ModelTurnSummary[] {
    try {
      const rows = getConnection()
        .prepare(
          `SELECT model, is_error, terminal_reason, ttft_ms FROM model_turn_stats
           WHERE created_at >= datetime('now', ?) ORDER BY id`,
        )
        .all(`-${Math.max(1, Math.min(30, Math.floor(days)))} days`) as Array<{
          model: string; is_error: number; terminal_reason: string | null; ttft_ms: number | null;
        }>;
      const byModel = new Map<string, { turns: number; errors: number; ttft: number[]; reasons: Map<string, number> }>();
      for (const row of rows) {
        const entry = byModel.get(row.model) ?? { turns: 0, errors: 0, ttft: [] as number[], reasons: new Map<string, number>() };
        entry.turns += 1;
        if (row.is_error) {
          entry.errors += 1;
          const reason = row.terminal_reason || 'unknown';
          entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
        }
        if (typeof row.ttft_ms === 'number' && row.ttft_ms >= 0) entry.ttft.push(row.ttft_ms);
        byModel.set(row.model, entry);
      }
      return [...byModel.entries()].map(([model, entry]) => {
        const sorted = entry.ttft.sort((left, right) => left - right);
        return {
          model,
          turns: entry.turns,
          errors: entry.errors,
          errorRate: entry.turns > 0 ? entry.errors / entry.turns : 0,
          ttftP50Ms: percentile(sorted, 50),
          ttftP90Ms: percentile(sorted, 90),
          reasons: [...entry.reasons.entries()]
            .map(([reason, count]) => ({ reason, count }))
            .sort((left, right) => right.count - left.count),
        };
      }).sort((left, right) => right.turns - left.turns);
    } catch (error) {
      log.warn('[model-stats] summarize failed:', (error as Error)?.message || error);
      return [];
    }
  },
};
