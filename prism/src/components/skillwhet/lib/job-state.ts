import { useTranslation } from 'react-i18next';

import type { Tone } from '../view/StatusStrip';

import type { Job } from './types';

/**
 * 作业状态 → 徽章色 / 文案 / 发起人。单独成文件:Runs 与 RunDetail 共用,
 * 也不违反 react-refresh「组件文件只导出组件」的约束。
 */
export type JobBadge = { tone: Tone; key: 'queued' | 'running' | 'budget' | 'timeout' | 'review' | 'unchanged' | 'failed' | 'cancelled' | 'interrupted' | 'listed' | 'mined' | 'evaluated' | 'other' };

export function jobBadge(job: Job): JobBadge {
  switch (job.state) {
    case 'queued': return { tone: 'muted', key: 'queued' };
    case 'running': return { tone: 'primary', key: 'running' };
    case 'done':
      // 挖任务与留出集评估这两种作业的「完成」各有含义。
      if (job.kind === 'harvest') return job.stop_reason === 'dry_run' ? { tone: 'muted', key: 'listed' } : { tone: 'warn', key: 'mined' };
      if (job.kind === 'release_eval') return { tone: 'ok', key: 'evaluated' };
      if (job.stop_reason === 'budget') return { tone: 'bad', key: 'budget' };
      if (job.stop_reason === 'timeout') return { tone: 'bad', key: 'timeout' };
      return job.improved ? { tone: 'warn', key: 'review' } : { tone: 'muted', key: 'unchanged' };
    case 'failed': return { tone: 'bad', key: 'failed' };
    case 'cancelled': return { tone: 'muted', key: 'cancelled' };
    case 'interrupted': return { tone: 'bad', key: 'interrupted' };
    default: return { tone: 'muted', key: 'other' };
  }
}

/** 状态文案(所有键都写成字面量,i18n 守卫才数得到)。 */
export function useJobLabel() {
  const { t } = useTranslation('skillwhet');
  return (job: Job): string => {
    const { key } = jobBadge(job);
    switch (key) {
      case 'queued': return job.position != null ? t('runs.state.queuedN', { defaultValue: '排队 #{{n}}', n: job.position + 1 }) : t('runs.state.queued', { defaultValue: '排队' });
      case 'running': return job.kind === 'harvest' ? t('runs.state.harvesting', { defaultValue: '挖任务中' })
        : job.kind === 'release_eval' ? t('runs.state.evaluating', { defaultValue: '留出集评估中' })
          : t('runs.state.running', { defaultValue: '训练中' });
      case 'listed': return t('runs.state.listed', { defaultValue: '已列会话' });
      case 'mined': return t('runs.state.mined', { defaultValue: '已挖出 · 待入库' });
      case 'evaluated': return t('runs.state.evaluated', { defaultValue: '已评估' });
      case 'budget': return t('runs.state.budget', { defaultValue: '超预算停止' });
      case 'timeout': return t('runs.state.timeout', { defaultValue: '超时停止' });
      case 'review': return t('runs.state.review', { defaultValue: '待审阅' });
      case 'unchanged': return t('runs.state.unchanged', { defaultValue: '无变化' });
      case 'failed': return t('runs.state.failed', { defaultValue: '失败' });
      case 'cancelled': return t('runs.state.cancelled', { defaultValue: '已取消' });
      case 'interrupted': return t('runs.state.interrupted', { defaultValue: '中断' });
      default: return job.state;
    }
  };
}

// 夜训作业没有发起人(调度器以系统身份起),显示 nightly。
export const ownerOf = (job: Job): string => (job.tags ?? []).find((t) => t.startsWith('uploader:'))?.slice(9) ?? (job.origin === 'nightly' ? 'nightly' : '—');

/** 作业种类的短名(列表里一个小徽章;train 不标)。 */
export function useJobKindLabel() {
  const { t } = useTranslation('skillwhet');
  return (job: Job): string | null => {
    if (job.kind === 'harvest') return t('runs.kind.harvest', { defaultValue: '挖任务' });
    if (job.kind === 'release_eval') return t('runs.kind.release', { defaultValue: '留出集' });
    return null;
  };
}
