import { getConnection } from '@/modules/database/connection.js';

/**
 * he:技能优化的夜训计划(表结构与语义见 `schema.ts` 的 `SKILLWHET_NIGHTLY_PLAN_TABLE_SCHEMA_SQL`)。
 *
 * 一行一个 skill。纳入 / 移出 / 改时窗预算是 root 的动作(路由里判);其余字段只由调度器写。
 * 时间一律存 ISO UTC(`2026-09-24T02:00:00Z`),`last_night` 是服务器本地日历日(时窗开始那天)。
 */
export type NightlyResult =
  | 'running' | 'improved' | 'unchanged' | 'no_candidate' | 'budget'
  | 'skipped_no_new_tasks' | 'skipped_busy' | 'deferred_budget'
  | 'interrupted' | 'cancelled' | 'error';

export type NightlyPlanRow = {
  skill_name: string;
  enrolled: number;
  window_start: string;
  window_end: string;
  max_cost_usd: number | null;
  rounds: number;
  config_json: string | null;
  min_new_tasks: number;
  copy_id: string | null;
  last_night: string | null;
  last_run_at: string | null;
  last_job_id: string | null;
  last_result: NightlyResult | null;
  last_detail: string | null;
  consecutive_noop: number;
  auto_paused_at: string | null;
  updated_by: number | null;
  updated_at: string;
};

export type NightlyPlanInput = {
  enrolled: boolean;
  windowStart: string;
  windowEnd: string;
  maxCostUsd: number | null;
  rounds: number;
  config: Record<string, unknown>;
  minNewTasks: number;
  /** 纳入时副本的身份;移出时可不给(保留原值) */
  copyId?: string | null;
};

/** 连续几晚没收益就自动暂停(《实施计划》F8)。 */
export const NIGHTLY_AUTOPAUSE_AFTER = 3;

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export const skillWhetNightlyDb = {
  list(): NightlyPlanRow[] {
    return getConnection().prepare('SELECT * FROM skillwhet_nightly_plan ORDER BY skill_name').all() as NightlyPlanRow[];
  },

  get(skill: string): NightlyPlanRow | null {
    return (getConnection().prepare('SELECT * FROM skillwhet_nightly_plan WHERE skill_name = ?').get(skill) as NightlyPlanRow | undefined) ?? null;
  },

  /**
   * 纳入 / 改设置 / 移出。重新纳入一个被自动暂停的 skill 时清掉暂停标记与连续计数 ——
   * root 看过、决定再给它机会,旧的"连续 3 晚"不该让它明早又被停掉。
   */
  upsert(skill: string, input: NightlyPlanInput, updatedBy: number | null): NightlyPlanRow {
    const db = getConnection();
    const before = this.get(skill);
    const reEnroll = input.enrolled && (!before || before.enrolled === 0);
    db.prepare(`
      INSERT INTO skillwhet_nightly_plan
        (skill_name, enrolled, window_start, window_end, max_cost_usd, rounds, config_json, min_new_tasks,
         copy_id, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(skill_name) DO UPDATE SET
        enrolled = excluded.enrolled,
        window_start = excluded.window_start,
        window_end = excluded.window_end,
        max_cost_usd = excluded.max_cost_usd,
        rounds = excluded.rounds,
        config_json = excluded.config_json,
        min_new_tasks = excluded.min_new_tasks,
        copy_id = COALESCE(excluded.copy_id, skillwhet_nightly_plan.copy_id),
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(skill, input.enrolled ? 1 : 0, input.windowStart, input.windowEnd, input.maxCostUsd, input.rounds,
      JSON.stringify(input.config ?? {}), input.minNewTasks, input.copyId ?? null, updatedBy, nowIso());
    if (reEnroll) {
      db.prepare('UPDATE skillwhet_nightly_plan SET consecutive_noop = 0, auto_paused_at = NULL WHERE skill_name = ?').run(skill);
    }
    return this.get(skill) as NightlyPlanRow;
  },

  /** 副本被移除 / 换掉:移出夜训(不动其余设置,root 重新纳入即可)。@returns 原来是否纳入着 */
  unenroll(skill: string, result: NightlyResult | null = null, detail: string | null = null): boolean {
    const row = this.get(skill);
    if (!row || row.enrolled !== 1) return false;
    getConnection().prepare(`
      UPDATE skillwhet_nightly_plan
      SET enrolled = 0, last_result = COALESCE(?, last_result), last_detail = COALESCE(?, last_detail)
      WHERE skill_name = ?
    `).run(result, detail, skill);
    return true;
  },

  /** 这一晚起了作业。`last_run_at` 同时是下一晚「新任务」的起算点。 */
  markStarted(skill: string, night: string, jobId: string, at: string = nowIso()): void {
    getConnection().prepare(`
      UPDATE skillwhet_nightly_plan
      SET last_night = ?, last_run_at = ?, last_job_id = ?, last_result = 'running', last_detail = NULL
      WHERE skill_name = ?
    `).run(night, at, jobId, skill);
  },

  /**
   * 这一晚没起作业(任务不够 / 有别的作业在跑 / 一晚预算用完 / 出错)。不动 `last_run_at`、不算无收益。
   * hl(动态 P2-15):`consumeNight=false` 时不写 `last_night` —— 这一晚还能再试(手动作业占着、G1 没过当晚修好)。
   */
  markSkipped(skill: string, night: string, result: NightlyResult, detail: string | null, consumeNight = true): void {
    if (consumeNight) {
      getConnection().prepare(`
        UPDATE skillwhet_nightly_plan SET last_night = ?, last_result = ?, last_detail = ? WHERE skill_name = ?
      `).run(night, result, detail, skill);
    } else {
      getConnection().prepare('UPDATE skillwhet_nightly_plan SET last_result = ?, last_detail = ? WHERE skill_name = ?').run(result, detail, skill);
    }
  },

  /**
   * 作业结束。`noop` = 跑完了但没有收益(无候选 / 无改进 / 超预算没改进)。
   * @returns 这一次是否触发了自动暂停
   */
  markFinished(skill: string, result: NightlyResult, detail: string | null, noop: boolean): boolean {
    // 被打断的:把"这一晚已处理"清掉,调度器下一次就会(带 resume)再挑它 —— 同一晚还在时窗里就是今晚
    const db = getConnection();
    const row = this.get(skill);
    if (!row) return false;
    const streak = noop ? row.consecutive_noop + 1 : (result === 'improved' ? 0 : row.consecutive_noop);
    const pause = noop && row.enrolled === 1 && streak >= NIGHTLY_AUTOPAUSE_AFTER;
    db.prepare(`
      UPDATE skillwhet_nightly_plan
      SET last_result = ?, last_detail = ?, consecutive_noop = ?,
          last_night = CASE WHEN ? = 'interrupted' THEN NULL ELSE last_night END,
          enrolled = CASE WHEN ? THEN 0 ELSE enrolled END,
          auto_paused_at = CASE WHEN ? THEN ? ELSE auto_paused_at END
      WHERE skill_name = ?
    `).run(result, detail, streak, result, pause ? 1 : 0, pause ? 1 : 0, nowIso(), skill);
    return pause;
  },
};
