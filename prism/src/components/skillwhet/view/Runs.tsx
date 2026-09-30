import { useState } from 'react';
import { Loader2, Moon, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { useToast } from '../../../shared/view/ui';
import { useJobs } from '../hooks/useJobs';
import { jobBadge, ownerOf, useJobKindLabel, useJobLabel } from '../lib/job-state';
import { useNightlyResultLabel } from '../lib/nightly';
import { unwrap, type Job } from '../lib/types';
import type { SkillWhetData } from '../SkillWhetPage';

import RunNew from './RunNew';
import { Badge } from './StatusStrip';

/**
 * gz:优化训练(原名优化运行)—— 左边作业表(有在跑的就 3 秒一刷),右边「新建训练」。
 * 同时只跑一个训练,其余排队;产物只进 staging,发布是另一个动作。
 */
const fmtTime = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * he(F4-02):最近一晚的夜训一句话 ——「昨夜 2026-09-24 夜训 3 个 skill:A 有候选待审阅、B 无变化、C 超预算」。
 * 只有纳入过夜训、且至少处理过一晚时才画。
 */
function NightlySummary({ data }: { data: SkillWhetData }) {
  const { t } = useTranslation('skillwhet');
  const label = useNightlyResultLabel();
  const plans = data.nightly?.plans ?? [];
  const nights = plans.map((p) => p.last_night).filter((x): x is string => Boolean(x)).sort();
  const enrolled = plans.filter((p) => p.enrolled).length;
  if (nights.length === 0 && enrolled === 0) return null;
  const night = nights[nights.length - 1];
  const rows = plans.filter((p) => p.last_night === night);
  return (
    <section className="flex flex-col gap-1.5 rounded-panel border border-border bg-card px-4 py-3 text-xs" data-testid="nightly-summary">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-foreground">
        <Moon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        {night
          ? t('nightly.summary', { defaultValue: '最近一晚({{d}})夜训处理了 {{n}} 个 skill', d: night, n: rows.length })
          : t('nightly.summaryNone', { defaultValue: '夜训还没跑过' })}
        <span className="text-muted-foreground">· {t('nightly.enrolledCount', { defaultValue: '当前纳入 {{n}} 个', n: enrolled })}</span>
      </div>
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rows.map((p) => {
            const l = label(p.last_result);
            return (
              <span key={p.skill_name} className="inline-flex items-center gap-1" title={p.last_detail ?? undefined}>
                <span className="font-mono text-body">{p.skill_name}</span><Badge tone={l.tone}>{l.label}</Badge>
                {!p.enrolled && p.auto_paused_at && <Badge tone="warn">{t('nightly.autopaused', { defaultValue: '已自动暂停' })}</Badge>}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

type RunsProps = {
  data: SkillWhetData;
  isRoot: boolean;
  username: string;
  userId: number | null;
  initialSkill?: string | null;
  onOpen: (jobId: string) => void;
};

export default function Runs({ data, isRoot, username, userId, initialSkill, onOpen }: RunsProps) {
  const { t } = useTranslation('skillwhet');
  const { toast } = useToast();
  const { jobs, loading, error, refresh, live } = useJobs(null);
  const labelOf = useJobLabel();
  const kindOf = useJobKindLabel();
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  const cancel = async (job: Job) => {
    try {
      await unwrap(await api.skillWhet.jobCancel(job.id));
      toast({ message: t('runs.cancelled', { defaultValue: '已取消 {{id}}', id: job.id }), variant: 'success' });
      await refresh();
    } catch (caught) {
      toast({ message: caught instanceof Error ? caught.message : String(caught), variant: 'error' });
    }
  };

  const mayCancel = (job: Job) => (job.state === 'queued' || job.state === 'running') && (isRoot || (userId != null && job.tags?.includes(`user:${userId}`)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-foreground">{t('runs.title', { defaultValue: '优化训练' })}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('runs.subtitle', { defaultValue: '同时只跑一个训练,其余排队;产物只进 staging,发布是另一个动作。' })}</p>
        </div>
        <button type="button" onClick={() => void refresh()} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong">
          {live ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
          {live ? t('runs.polling', { defaultValue: '3 秒一刷' }) : t('runs.refresh', { defaultValue: '刷新' })}
        </button>
      </div>

      <NightlySummary data={data} />

      {/* hc:新建训练放上面,作业记录(优化运行)在下面 —— 原来左右两栏,表单挤在右边 400px */}
      <RunNew skills={data.skills?.skills ?? []} taskSummary={data.taskSummary} isRoot={isRoot} username={username} initialSkill={initialSkill} onCreated={(id) => { void refresh(); onOpen(id); }} />

      <div className="flex flex-col gap-2">
        <h2 className="text-[15px] font-semibold text-foreground" data-testid="runs-list-title">
          {t('runs.listTitle', { defaultValue: '优化运行' })}
          {jobs.length > 0 && <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">{jobs.length}</span>}
        </h2>
        <section className="overflow-hidden rounded-panel border border-border bg-card">
          {error && <div className="border-b border-border bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>}
          {loading && jobs.length === 0 ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('runs.loading', { defaultValue: '读取作业…' })}</div>
          ) : jobs.length === 0 ? (
            <div className="px-6 py-12 text-center text-[13px] text-muted-foreground">{t('runs.empty', { defaultValue: '还没有训练作业。上面新建一个 —— 第一次建议 mock 或 rounds=1 先看流程。' })}</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-[11px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-normal">{t('runs.colJob', { defaultValue: '作业' })}</th>
                  <th className="px-2 py-2 font-normal">skill</th>
                  <th className="px-2 py-2 font-normal">{t('runs.colState', { defaultValue: '状态' })}</th>
                  <th className="px-2 py-2 font-normal">val</th>
                  <th className="px-2 py-2 font-normal">{t('runs.colCost', { defaultValue: '费用' })}</th>
                  <th className="px-2 py-2 font-normal">{t('runs.colOwner', { defaultValue: '发起人' })}</th>
                  <th className="px-2 py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const { tone } = jobBadge(job);
                  const label = labelOf(job);
                  return (
                    <tr key={job.id} className="cursor-pointer border-t border-border hover:bg-muted/50" onClick={() => onOpen(job.id)}>
                      <td className="px-3 py-2">
                        <div className="font-mono text-foreground">{job.id.replace(/^job_/, '')}</div>
                        <div className="text-[11px] text-muted-foreground">{fmtTime(job.created_at)}{job.origin === 'nightly' && <Badge className="ml-1.5" tone="primary"><Moon className="h-[10px] w-[10px]" aria-hidden />{t('runs.nightly', { defaultValue: '夜训' })}</Badge>}</div>
                      </td>
                      <td className="px-2 py-2 font-mono text-body">{job.skill}{kindOf(job) && <Badge className="ml-1.5">{kindOf(job)}</Badge>}</td>
                      <td className="px-2 py-2"><Badge tone={tone}>{job.state === 'running' && <Loader2 className="h-[11px] w-[11px] animate-spin" aria-hidden />}{label}</Badge></td>
                      <td className="px-2 py-2 font-mono text-body">
                        {typeof job.val_baseline === 'number' ? <span className="text-muted-foreground">{job.val_baseline.toFixed(2)}</span> : '—'}
                        {typeof job.val_candidate === 'number' && <> → <strong>{job.val_candidate.toFixed(2)}</strong></>}
                        {typeof job.rounds_done === 'number' && job.rounds_done > 0 && <span className="ml-1 text-muted-foreground">· {job.rounds_done}/{String(job.args?.rounds ?? '?')}</span>}
                      </td>
                      <td className="px-2 py-2 font-mono text-body">{typeof job.cost_usd === 'number' ? `$${job.cost_usd.toFixed(2)}` : '—'}</td>
                      <td className="px-2 py-2 text-body">{ownerOf(job)}</td>
                      <td className="px-2 py-2 text-right">
                        {mayCancel(job) && (confirmCancel === job.id ? (
                          // hl(动态 P3):「撤」原来一点就撤,误触就丢一次训练 —— 加一步确认
                          <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button type="button" onClick={() => { setConfirmCancel(null); void cancel(job); }} className="h-6 rounded-md border border-red-500/40 px-2 text-[11px] text-red-700 hover:bg-red-500/10 dark:text-red-300" data-testid={`cancel-yes-${job.id}`}>{t('runs.cancelYes', { defaultValue: '确认撤销' })}</button>
                            <button type="button" onClick={() => setConfirmCancel(null)} className="h-6 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted">{t('card.cancel', { defaultValue: '取消' })}</button>
                          </span>
                        ) : (
                          <button type="button" onClick={(e) => { e.stopPropagation(); setConfirmCancel(job.id); }} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
                            <X className="h-3 w-3" aria-hidden />{t('runs.cancel', { defaultValue: '撤' })}
                          </button>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
