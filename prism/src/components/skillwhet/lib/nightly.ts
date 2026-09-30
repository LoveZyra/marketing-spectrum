import { useTranslation } from 'react-i18next';

import type { Tone } from '../view/StatusStrip';

import type { Job, NightlyResult } from './types';

/** he:夜训结果的人话与色调(技能卡、优化训练页顶部共用)。 */
export function useNightlyResultLabel() {
  const { t } = useTranslation('skillwhet');
  return (result: NightlyResult | null): { label: string; tone: Tone } => {
    switch (result) {
      case 'running': return { label: t('nightly.r.running', { defaultValue: '训练中' }), tone: 'primary' };
      case 'improved': return { label: t('nightly.r.improved', { defaultValue: '有候选待审阅' }), tone: 'ok' };
      case 'unchanged': return { label: t('nightly.r.unchanged', { defaultValue: '无变化' }), tone: 'muted' };
      case 'no_candidate': return { label: t('nightly.r.noCandidate', { defaultValue: '没有可修的失败' }), tone: 'muted' };
      case 'budget': return { label: t('nightly.r.budget', { defaultValue: '超预算' }), tone: 'warn' };
      case 'skipped_no_new_tasks': return { label: t('nightly.r.noNewTasks', { defaultValue: '新任务不够,跳过' }), tone: 'muted' };
      case 'skipped_busy': return { label: t('nightly.r.busy', { defaultValue: '有别的作业在跑,跳过' }), tone: 'muted' };
      case 'deferred_budget': return { label: t('nightly.r.deferred', { defaultValue: '一晚预算用完,排明晚' }), tone: 'warn' };
      case 'interrupted': return { label: t('nightly.r.interrupted', { defaultValue: '被打断,下次续跑' }), tone: 'warn' };
      case 'cancelled': return { label: t('nightly.r.cancelled', { defaultValue: '被取消' }), tone: 'muted' };
      case 'error': return { label: t('nightly.r.error', { defaultValue: '出错' }), tone: 'bad' };
      default: return { label: t('nightly.r.never', { defaultValue: '还没跑过' }), tone: 'muted' };
    }
  };
}

const DAYS = 14;
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * he(F4-04):近 14 天每天的训练费用(单系列柱图,按作业创建日、本地时间)+ 接受率。
 * 一个度量一张图,不画双轴;数据全来自作业表,没有作业的日子画空槽。
 */
export function dailyCost(jobs: Job[], now = new Date()): Array<{ day: string; cost: number; runs: number; nightly: number }> {
  const out: Array<{ day: string; cost: number; runs: number; nightly: number }> = [];
  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push({ day: dayKey(d), cost: 0, runs: 0, nightly: 0 });
  }
  const index = new Map(out.map((row, i) => [row.day, i]));
  for (const job of jobs) {
    if ((job.kind ?? 'train') !== 'train') continue;
    const i = index.get(dayKey(new Date(job.created_at)));
    if (i === undefined) continue;
    out[i].runs += 1;
    if (job.origin === 'nightly') out[i].nightly += 1;
    if (typeof job.cost_usd === 'number') out[i].cost += job.cost_usd;
  }
  return out;
}
