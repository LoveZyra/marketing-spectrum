import { Activity, Loader2, TrendingUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useJobs } from '../hooks/useJobs';
import type { SkillWhetStatus } from '../hooks/useSkillWhetStatus';
import { jobBadge, useJobLabel } from '../lib/job-state';
import { dailyCost } from '../lib/nightly';
import type { SkillWhetData } from '../SkillWhetPage';

import StatusStrip, { Badge } from './StatusStrip';

/** 近 14 天每日训练费用的柱图(手绘 SVG,只圆柱顶)。 */
function CostChart({ rows }: { rows: ReturnType<typeof dailyCost> }) {
  const { t } = useTranslation('skillwhet');
  const W = 560; const H = 150; const L = 40; const R = 8; const T = 10; const B = 22;
  const max = Math.max(0.01, ...rows.map((r) => r.cost));
  const top = max < 0.1 ? Math.ceil(max * 100) / 100 : Math.ceil(max * 10) / 10;
  const slot = (W - L - R) / rows.length;
  const bw = Math.max(4, slot - 2);                     // 2px 间隔
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const bar = (x: number, v: number) => {
    const h = Math.max(0, H - B - y(v));
    if (h <= 0) return '';
    const r = Math.min(4, h, bw / 2);                   // 只圆顶部,底部贴基线
    const x0 = x; const x1 = x + bw; const yb = H - B; const yt = yb - h;
    return `M${x0},${yb} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x1 - r} Q${x1},${yt} ${x1},${yt + r} V${yb} Z`;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t('overview.costChart', { defaultValue: '近 14 天每天训练费用' })} data-testid="cost-chart">
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="currentColor" className="text-border" />
      <line x1={L} y1={y(top)} x2={W - R} y2={y(top)} stroke="currentColor" strokeDasharray="3 3" className="text-border" />
      <text x={L - 4} y={y(top) + 3} fontSize={9} textAnchor="end" className="fill-muted-foreground font-mono">${top.toFixed(2)}</text>
      <text x={L - 4} y={H - B + 3} fontSize={9} textAnchor="end" className="fill-muted-foreground font-mono">$0</text>
      {rows.map((row, i) => {
        const x = L + i * slot + 1;
        const tip = t('overview.costTip', { defaultValue: '{{d}}:${{c}} · {{n}} 次训练(夜训 {{m}})', d: row.day, c: row.cost.toFixed(4), n: row.runs, m: row.nightly });
        return (
          <g key={row.day} className="group">
            <title>{tip}</title>
            <rect x={x - 1} y={T} width={slot} height={H - T - B} fill="transparent" />
            <path d={bar(x, row.cost)} fill="currentColor" className="text-primary opacity-80 group-hover:opacity-100" />
            {row.runs > 0 && row.cost === 0 && <rect x={x} y={H - B - 2} width={bw} height={2} rx={1} fill="currentColor" className="text-muted-foreground" />}
            {(i % 3 === 0 || i === rows.length - 1) && <text x={x + bw / 2} y={H - 8} fontSize={9} textAnchor="middle" className="fill-muted-foreground font-mono">{row.day.slice(5)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * 总览:六格数字(受管副本 / 任务集条数 / 有反馈但未导入的技能 / 在跑 + 排队 / 待审阅候选 / 累计费用)、
 * 近 14 天费用与接受率、最近五个作业。全部来自作业表与技能状态,不放演示数据。
 */
export default function Overview({ status, data, onRecheck, onOpenJob, onOpenRuns }: {
  status: SkillWhetStatus | null;
  data: SkillWhetData;
  onRecheck: () => void;
  onOpenJob: (jobId: string) => void;
  onOpenRuns: () => void;
}) {
  const { t } = useTranslation('skillwhet');
  const { jobs, live } = useJobs(null, 500);            // 14 天趋势要多拉一些作业
  const labelOf = useJobLabel();
  const skillRows = Array.isArray(data.skills?.skills) ? data.skills.skills : [];
  const managed = skillRows.length;
  const bootstrapped = skillRows.filter((skill) => skill.bootstrapped).length;
  const tasksTotal = data.taskSummary.reduce((sum, row) => sum + row.total, 0);
  const tasksSkills = data.taskSummary.filter((row) => row.total > 0).length;
  const feedbackOnly = Array.isArray(data.skills?.feedbackOnly) ? data.skills.feedbackOnly.length : 0;
  const surveyRate = status?.survey?.rate ?? 0.5;
  const running = jobs.filter((job) => job.state === 'running').length;
  const queued = jobs.filter((job) => job.state === 'queued').length;
  // 「待审阅候选」只算 improved=true 且还没采纳的训练产物;无改进的 staging 不算候选。
  const awaiting = skillRows.filter((skill) => jobs.some((job) =>
    job.skill === skill.name && (job.kind ?? 'train') === 'train' && job.state === 'done' && job.improved === true
    && job.staging && job.staging !== skill.adopted_staging)).length;
  const spent = jobs.reduce((sum, job) => sum + (typeof job.cost_usd === 'number' ? job.cost_usd : 0), 0);

  const cards = [
    { label: t('overview.managed', { defaultValue: '受管副本' }), value: String(managed), sub: t('overview.managedSub', { defaultValue: '{{n}} 个已 bootstrap(S₀ 已冻结)', n: bootstrapped }) },
    { label: t('overview.tasks', { defaultValue: '任务集' }), value: String(tasksTotal), sub: t('overview.tasksSub', { defaultValue: '挂在 {{n}} 个技能下', n: tasksSkills }) },
    { label: t('overview.feedbackSkills', { defaultValue: '有反馈但未导入的技能' }), value: String(feedbackOnly), sub: t('overview.feedbackSub', { defaultValue: '调查抽样 {{pct}}% · 冷却 {{min}} 分钟', pct: Math.round(surveyRate * 100), min: status?.survey?.cooldownMin ?? 60 }) },
    { label: t('overview.running', { defaultValue: '在跑 / 排队' }), value: `${running} / ${queued}`, sub: t('overview.runningSub', { defaultValue: '同时只跑一个,其余 FIFO 排队' }) },
    { label: t('overview.awaiting', { defaultValue: '待审阅候选' }), value: String(awaiting), sub: t('overview.awaitingSub', { defaultValue: '有 staging 但还没采纳的技能' }) },
    { label: t('overview.spent', { defaultValue: '累计费用' }), value: `$${spent.toFixed(2)}`, sub: t('overview.spentSub', { defaultValue: '{{n}} 个作业(含 mock 的 $0)', n: jobs.length }) },
  ];

  const recent = jobs.slice(0, 5);
  const daily = dailyCost(jobs);
  const trainDone = jobs.filter((job) => (job.kind ?? 'train') === 'train' && job.state === 'done');
  const accepted = trainDone.filter((job) => job.improved).length;
  const nightlyRuns = jobs.filter((job) => job.origin === 'nightly' && (job.kind ?? 'train') === 'train').length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t('overview.title', { defaultValue: '总览' })}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">{t('overview.subtitle', { defaultValue: '六格数字全是真数据:副本、任务集、反馈覆盖、作业、候选、费用。' })}</p>
      </div>
      <StatusStrip status={status} onRecheck={onRecheck} />
      {/* 按容器宽度排列(每格至少 190px)而不按视口:页面左边多一栏时,按视口分的三列会被挤得一行只剩一两个字。 */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3.5" data-testid="overview-cards">
        {cards.map(({ label, value, sub }) => (
          <div key={label} className="rounded-panel border border-border bg-card p-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
            <div className="mt-1 font-mono text-[28px] leading-none text-foreground">{data.loading && !data.skills ? '—' : value}</div>
            <div className="mt-2 text-xs text-muted-foreground">{sub}</div>
          </div>
        ))}
      </div>
      {data.error && <div className="rounded-panel border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{data.error}</div>}
      <section className="grid grid-cols-[minmax(0,1fr)_220px] gap-4 rounded-panel border border-border bg-card p-4 max-md:grid-cols-1" data-testid="overview-trends">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-foreground">
            <TrendingUp className="h-3.5 w-3.5" aria-hidden />{t('overview.costChart', { defaultValue: '近 14 天每天训练费用' })}
          </div>
          <CostChart rows={daily} />
        </div>
        <div className="flex flex-col justify-center gap-3 border-l border-border pl-4 max-md:border-l-0 max-md:pl-0">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('overview.acceptRate', { defaultValue: '接受率' })}</div>
            <div className="mt-1 font-mono text-[28px] leading-none text-foreground">{trainDone.length ? `${Math.round((accepted / trainDone.length) * 100)}%` : '—'}</div>
            <div className="mt-1.5 text-xs text-muted-foreground">{t('overview.acceptRateSub', { defaultValue: '{{a}} / {{n}} 次跑完的训练有改进', a: accepted, n: trainDone.length })}</div>
          </div>
          <div className="text-xs text-muted-foreground">{t('overview.nightlyRuns', { defaultValue: '其中夜训起的 {{n}} 次;统计最近 {{m}} 个作业', n: nightlyRuns, m: jobs.length })}</div>
        </div>
      </section>
      <section className="overflow-hidden rounded-panel border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[13px] font-semibold text-foreground">
          <Activity className="h-3.5 w-3.5" aria-hidden />{t('overview.recent', { defaultValue: '最近作业' })}
          {live && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden />}
          <span className="flex-1" />
          <button type="button" onClick={onOpenRuns} className="text-xs font-normal text-primary hover:underline">{t('overview.allRuns', { defaultValue: '全部 →' })}</button>
        </div>
        {recent.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{t('overview.noRuns', { defaultValue: '还没有训练作业。到「优化训练」建第一个。' })}</p>
        ) : (
          <ul>
            {recent.map((job) => (
              <li key={job.id}>
                <button type="button" onClick={() => onOpenJob(job.id)} className="flex w-full items-center gap-3 border-t border-border px-3 py-2 text-left text-xs hover:bg-muted/50">
                  <span className="font-mono text-foreground">{job.id.replace(/^job_/, '')}</span>
                  <span className="font-mono text-body">{job.skill}</span>
                  <Badge tone={jobBadge(job).tone}>{labelOf(job)}</Badge>
                  <span className="flex-1" />
                  <span className="font-mono text-muted-foreground">{typeof job.val_baseline === 'number' ? job.val_baseline.toFixed(2) : '—'}{typeof job.val_candidate === 'number' ? ` → ${job.val_candidate.toFixed(2)}` : ''}</span>
                  <span className="font-mono text-muted-foreground">{typeof job.cost_usd === 'number' ? `$${job.cost_usd.toFixed(2)}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
