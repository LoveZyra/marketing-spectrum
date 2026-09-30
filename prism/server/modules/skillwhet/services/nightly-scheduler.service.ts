import { auditLogDb, skillWhetNightlyDb, type NightlyPlanRow, type NightlyResult } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { readBudget } from './budget.js';
import { g1Problem, type GateCache } from './g1.js';
import type { SkillWhetClient } from './skillwhet-client.js';

/**
 * he:夜训调度器(《实施计划》P4-03)。
 *
 * 每分钟看一次 `skillwhet_nightly_plan`:
 *   1. 收尾 —— 上次起的夜训作业结束了就记结果;跑完没收益累加 `consecutive_noop`,
 *      到 3 自动移出夜训并审计 `skillwhet_nightly_autopause`;
 *   2. **串行** —— 还有夜训作业在排队 / 在跑就什么都不起;
 *   3. 挑一个:已纳入、此刻在它的时窗里、这一晚还没处理过,按上次夜训时间最早的先;
 *      · 上次是被中断的、SkillWhet 那边还有对得上的 checkpoint → 带 `resume` 续跑(不看任务门槛);
 *      · 否则自上次夜训起新进库的可判分任务 < `min_new_tasks` → 记 `skipped_no_new_tasks`;
 *      · 这一晚夜训已花 + 这次预留 > 一晚合计上限 → 记 `deferred_budget`,排到明晚;
 *      · 同一 skill 已有别的作业在跑(手动起的)→ 记 `skipped_busy`;
 *   4. 起作业(`origin: nightly`),一次 tick 只起一个。
 *
 * 时窗是**服务器本地时间**,可以跨零点。"一晚"是当天中午到次日中午(记当天的日期)——
 * 所有 skill 共用这一个口径:一晚只跑一次、一晚合计预算都按它算,不随各自时窗漂移
 * (A 22:00–02:00、B 01:00–05:00 属于同一晚;把时窗往后挪也不会同一晚跑两次)。
 * 时窗到点时还没跑完的作业不杀(它有自己的费用 / 时长上限),没轮到的 skill 排明晚。
 *
 * 纳入是 root 对**那一份副本**的批准:副本被移除 / 重新上传 / 重新导入后身份(`copy_id`)对不上,
 * 或上传来源的副本 G1 安全门不是 PASS,这一晚不跑并自动移出(非 root 起训练同样要 G1 PASS)。
 * 夜训只产出 staging:采纳、发布永远是人的事。
 */

type JobRow = {
  id: string; kind: string; skill: string; state: string; origin?: string; created_at: string;
  args?: Record<string, unknown>; cost_usd?: number | null; stop_reason?: string | null;
  improved?: boolean | null; staging?: string | null; error?: string | null;
};

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export type NightlyDeps = {
  client: Pick<SkillWhetClient, 'request'>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logger?: Logger;
};

export type TickOutcome = {
  finalized: Array<{ skill: string; result: NightlyResult; autopaused: boolean }>;
  started: { skill: string; jobId: string; resume: boolean } | null;
  skipped: Array<{ skill: string; result: NightlyResult; detail: string }>;
  waitingFor: string | null;
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isHhMm = (value: unknown): value is string => typeof value === 'string' && HHMM.test(value);
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "一晚" = 当天 12:00 到次日 12:00(服务器本地时间),记当天的日期。 */
export const nightKey = (now: Date): string => localDate(new Date(now.getTime() - 12 * 3600_000));

/** 此刻是否在时窗 `[start, end)` 里(`start > end` 表示跨零点),以及属于哪一晚。 */
export function nightWindow(now: Date, start: string, end: string): { inWindow: boolean; night: string } {
  const s = toMinutes(start);
  const e = toMinutes(end);
  const m = now.getHours() * 60 + now.getMinutes();
  const inWindow = s === e ? false : s > e ? (m >= s || m < e) : (m >= s && m < e);
  return { inWindow, night: nightKey(now) };
}

/** 纳入时记下的副本身份:来源 | 上传者 | 导入时间。重新上传 / 重新导入都会变。 */
export const copyIdOf = (status: { source?: unknown; uploaded_by?: unknown; imported_at?: unknown }): string =>
  `${String(status.source ?? '')}|${String(status.uploaded_by ?? '')}|${String(status.imported_at ?? '')}`;

const LIVE = new Set(['queued', 'running']);

/** 结束的作业 → 夜训结果;`noop` = 跑完了但没有收益。 */
export function classifyJob(job: JobRow): { result: NightlyResult; noop: boolean; detail: string } {
  const cost = typeof job.cost_usd === 'number' ? ` · $${job.cost_usd.toFixed(2)}` : '';
  const staging = job.staging ? ` · staging ${job.staging}` : '';
  if (job.state === 'done') {
    if (job.improved) return { result: 'improved', noop: false, detail: `有候选待审阅${staging}${cost}` };
    if (job.stop_reason === 'backend_unavailable') return { result: 'error', noop: false, detail: `模型后端不可用${cost}` };
    if (job.stop_reason === 'budget') return { result: 'budget', noop: true, detail: `超预算停下、无改进${cost}` };
    if (job.stop_reason === 'no_signal') return { result: 'no_candidate', noop: true, detail: `没有可修的失败${cost}` };
    return { result: 'unchanged', noop: true, detail: `无改进(${job.stop_reason ?? '?'})${cost}` };
  }
  if (job.state === 'interrupted') return { result: 'interrupted', noop: false, detail: '服务重启打断,下次从最后完成的一轮续跑' };
  if (job.state === 'cancelled') return { result: 'cancelled', noop: false, detail: '被取消' };
  return { result: 'error', noop: false, detail: String(job.error ?? job.state).slice(0, 200) };
}

export function parsePlanConfig(row: NightlyPlanRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.config_json ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export class NightlyScheduler {
  private readonly client: NightlyDeps['client'];
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(deps: NightlyDeps) {
    this.client = deps.client;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? console;
  }

  start(intervalMs = 60_000, firstDelayMs = 30_000): void {
    if (this.timer) return;
    const run = () => { void this.tick().catch((error: unknown) => this.logger.error('[skillwhet-nightly] tick 失败:', error instanceof Error ? error.message : error)); };
    this.kick = setTimeout(run, firstDelayMs);
    this.timer = setInterval(run, intervalMs);
    this.kick.unref?.();
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
  }

  private audit(event: 'skillwhet_job_start' | 'skillwhet_nightly_autopause' | 'skillwhet_nightly_unenroll', detail: string, outcome: 'success' | 'failure' = 'success') {
    auditLogDb.record({ userId: null, username: 'nightly', event, detail, outcome });
  }

  /** 一次调度。重入保护:上一轮还没跑完(serve 慢)就直接返回。 */
  async tick(): Promise<TickOutcome> {
    const out: TickOutcome = { finalized: [], started: null, skipped: [], waitingFor: null };
    if (this.running) return out;
    this.running = true;
    try {
      const plans = skillWhetNightlyDb.list();
      if (plans.length === 0) return out;
      const now = this.now();

      // 1. 收尾
      for (const plan of plans) {
        if (plan.last_result !== 'running' || !plan.last_job_id) continue;
        let job: JobRow | null = null;
        try {
          job = (await this.client.request<{ job: JobRow }>('GET', `/jobs/${encodeURIComponent(plan.last_job_id)}`)).job;
        } catch (error) {
          if (error instanceof AppError && error.statusCode === 404) {
            skillWhetNightlyDb.markFinished(plan.skill_name, 'error', `作业 ${plan.last_job_id} 不见了`, false);
            out.finalized.push({ skill: plan.skill_name, result: 'error', autopaused: false });
            continue;
          }
          throw error;
        }
        if (LIVE.has(job.state)) continue;
        const c = classifyJob(job);
        const autopaused = skillWhetNightlyDb.markFinished(plan.skill_name, c.result, c.detail, c.noop);
        out.finalized.push({ skill: plan.skill_name, result: c.result, autopaused });
        this.logger.log(`[skillwhet-nightly] ${plan.skill_name} 夜训结束:${c.result} · ${c.detail}`);
        if (autopaused) {
          this.audit('skillwhet_nightly_autopause', `${plan.skill_name} 连续无收益,已移出夜训(最后一次:${c.result})`);
        }
      }

      // 2. 串行:还有夜训作业活着就等。起作业之后、记账之前 Prism 挂了的,这里把作业认领回计划上
      const jobs = (await this.client.request<{ jobs: JobRow[] }>('GET', '/jobs?limit=500')).jobs ?? [];
      const liveNightly = jobs.find((j) => j.origin === 'nightly' && LIVE.has(j.state));
      if (liveNightly) {
        const owner = plans.find((p) => p.skill_name === liveNightly.skill);
        if (owner && owner.last_job_id !== liveNightly.id) {
          const created = new Date(liveNightly.created_at);
          skillWhetNightlyDb.markStarted(owner.skill_name, nightKey(created), liveNightly.id, liveNightly.created_at);
        }
        out.waitingFor = liveNightly.id;
        return out;
      }

      // 3. 挑一个
      const budget = readBudget(this.env);
      const fresh = skillWhetNightlyDb.list();
      const due = fresh
        .map((plan) => ({ plan, w: nightWindow(now, plan.window_start, plan.window_end) }))
        .filter(({ plan, w }) => plan.enrolled === 1 && w.inWindow && plan.last_night !== w.night)
        .sort((a, b) => String(a.plan.last_run_at ?? '').localeCompare(String(b.plan.last_run_at ?? '')));

      for (const { plan, w } of due) {
        const skill = plan.skill_name;
        /**
         * hl(动态 P2-15):`retry=true` 的原因(手动作业占着 / 上传来源 G1 没过)不把这一晚记成"已处理",
         * 时窗内下一分钟再试 —— 原来 `skipped_busy` 记整晚,手动作业跑完也不补;G1 当晚修好也不跑。
         * 每分钟重试会重复写同一条结果:只在结果或说明变了才落库、才打日志。
         */
        const skip = (result: NightlyResult, detail: string, retry = false) => {
          // 被打断、还没续上的:结果仍记"被打断",下一晚接着试续跑(说明里写这一晚为什么没跑)
          const keep = plan.last_result === 'interrupted' && (result === 'deferred_budget' || result === 'skipped_busy');
          const finalResult = keep ? 'interrupted' : result;
          const finalDetail = keep ? `${detail}(被打断的那次待续跑)` : detail;
          out.skipped.push({ skill, result, detail });
          if (retry && plan.last_result === finalResult && plan.last_detail === finalDetail) return;
          skillWhetNightlyDb.markSkipped(skill, w.night, finalResult, finalDetail, !retry);
          this.logger.log(`[skillwhet-nightly] ${skill} ${retry ? '此刻不跑,时窗内再试' : '这一晚不跑'}:${result} · ${detail}`);
        };

        // 纳入的是那一份副本:身份对不上 / 上传来源的 G1 不是 PASS → 不跑,移出
        let status: { source?: string; uploaded_by?: string; imported_at?: string } | null = null;
        try {
          status = await this.client.request('GET', `/skills/${encodeURIComponent(skill)}/status`);
        } catch (error) {
          if (!(error instanceof AppError && error.statusCode === 404)) throw error;
        }
        const refuse = (why: string) => {
          skillWhetNightlyDb.unenroll(skill);
          skip('error', why);
          this.audit('skillwhet_nightly_unenroll', `${skill} ${why}`);
        };
        if (!status) { refuse('副本已不在,移出夜训'); continue; }
        if (plan.copy_id && copyIdOf(status) !== plan.copy_id) { refuse('副本在纳入之后被移除 / 重新上传 / 重新导入过,移出夜训;确认后请 root 重新纳入'); continue; }
        if (status.source === 'upload') {
          const gate = await this.client.request<GateCache>(
            'GET', `/skills/${encodeURIComponent(skill)}/gate`).catch(() => ({ cached: false, results: [] }));
          const problem = g1Problem(gate, '跑夜训');
          if (problem) {
            skip('error', `上传来源的副本:${problem}`, true);
            continue;
          }
        }

        // 续跑?
        let resume = false;
        if (plan.last_result === 'interrupted') {
          const ck = await this.client.request<{ exists: boolean; matches?: boolean; round?: number }>(
            'GET', `/skills/${encodeURIComponent(skill)}/checkpoint`).catch(() => ({ exists: false } as { exists: boolean; matches?: boolean }));
          resume = Boolean(ck.exists && ck.matches);
        }
        if (!resume) {
          const since = plan.last_run_at ?? '';
          const fresh = await this.client.request<{ new_checkable: number }>(
            'GET', `/tasks/new?skill=${encodeURIComponent(skill)}&since=${encodeURIComponent(since)}`);
          if (fresh.new_checkable < plan.min_new_tasks) {
            skip('skipped_no_new_tasks', `新进库可判分任务 ${fresh.new_checkable} 条 < 门槛 ${plan.min_new_tasks}`);
            continue;
          }
        }

        // 一晚合计预算
        // hf2:计划里 root 填的单次上限可以高于 .env(到硬上限),留空才用 .env 的
        const reserve = Math.min(plan.max_cost_usd ?? budget.maxCostUsd, budget.nightlyHardMaxCostUsd);
        const spent = jobs
          .filter((j) => j.origin === 'nightly' && nightKey(new Date(j.created_at)) === w.night)
          .reduce((sum, j) => sum + (typeof j.cost_usd === 'number' ? j.cost_usd : Number(j.args?.max_cost_usd) || 0), 0);
        if (spent + reserve > budget.nightlyMaxCostUsd + 1e-9) {
          skip('deferred_budget', `这一晚夜训已用 $${spent.toFixed(2)},这次预留 $${reserve.toFixed(2)},一晚上限 $${budget.nightlyMaxCostUsd.toFixed(2)}`);
          continue;
        }

        const config = parsePlanConfig(plan);
        const args: Record<string, unknown> = {
          ...config,
          rounds: plan.rounds,
          max_cost_usd: reserve,
          max_minutes: budget.maxHours * 60,
          workers: Math.min(Number(config.workers) || 2, budget.maxWorkers),
          ...(resume ? { resume: true } : {}),
        };
        try {
          const data = await this.client.request<{ job: JobRow }>('POST', '/jobs', {
            kind: 'train', skill, args, origin: 'nightly',
            tags: ['nightly', ...(plan.updated_by ? [`nightly_by:${plan.updated_by}`] : [])],
          }, 30_000);
          skillWhetNightlyDb.markStarted(skill, w.night, data.job.id, now.toISOString().replace(/\.\d{3}Z$/, 'Z'));
          this.audit('skillwhet_job_start', `${skill} ${data.job.id} origin=nightly${resume ? ' resume' : ''} args=${JSON.stringify(args).slice(0, 300)}`);
          this.logger.log(`[skillwhet-nightly] ${skill} 夜训开始:${data.job.id}${resume ? '(续跑)' : ''}`);
          out.started = { skill, jobId: data.job.id, resume };
          return out;
        } catch (error) {
          if (error instanceof AppError && error.statusCode === 503) throw error;      // serve 不在:下一分钟再来
          const code = error instanceof AppError ? String(error.code ?? '') : '';
          const message = error instanceof Error ? error.message : String(error);
          if (code === 'SKILLWHET_JOB_DUPLICATE') skip('skipped_busy', '这个 skill 已有训练作业在排队 / 在跑', true);
          else {
            skip('error', message.slice(0, 200));
            this.audit('skillwhet_job_start', `${skill} origin=nightly ${message}`.slice(0, 500), 'failure');
          }
        }
      }
      return out;
    } finally {
      this.running = false;
    }
  }
}
