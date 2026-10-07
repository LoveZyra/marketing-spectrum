import { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowLeft, BookOpen, Check, Code, Download, GitBranch, Loader2, Play, RefreshCw, Shield, Square, Upload, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { useToast } from '../../../shared/view/ui';
import { useJobProgress } from '../hooks/useJobs';
import { jobBadge, ownerOf, useJobLabel } from '../lib/job-state';
import { unwrap, type CheckpointInfo, type ProgressEvent, type StagingDetail } from '../lib/types';

import DiffView from './DiffView';
import ProcessTimeline from './ProcessTimeline';
import { Badge } from './StatusStrip';

/**
 * 运行详情。训练作业六个页签:优化过程(progress 事件 → 时间轴)/ 指标趋势(val 曲线,纵轴 0–1 固定)/
 * 代码与文档(staging 逐文件 diff)/ 执行证据(provenance + ledger)/ 回放评测(逐轮门与治理)/ 模型与参数;
 * 挖任务与留出集评估作业只有过程与参数两页。第一轮结束前曲线为空并明说;「对话与工具」不画(该后端无工具)。
 */
type Tab = 'process' | 'metrics' | 'diff' | 'evidence' | 'replay' | 'params';

const fmtTs = (iso: unknown): string => (typeof iso === 'string' ? new Date(iso).toLocaleTimeString() : '');

function eventLine(e: ProgressEvent, t: (k: string, o?: Record<string, unknown>) => string): { icon: typeof Check; tone: string; main: string; sub: string } {
  const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
  switch (e.kind) {
    case 'job_start': if (e.job_kind) return { icon: GitBranch, tone: 'text-primary', main: t('ev.jobStart', { defaultValue: '作业开始' }), sub: `${String(e.job_kind)} · ${String(e.skill ?? '').split('/').pop()}${e.staging ? ` · staging ${String(e.staging)}` : ''}${e.dry_run ? ' · dry-run' : ''}` };
      return { icon: GitBranch, tone: 'text-primary', main: t('ev.jobStart', { defaultValue: '作业开始' }), sub: `${String(e.skill ?? '').split('/').pop()} · ${t('ev.roundsPlanned', { defaultValue: '计划 {{n}} 轮', n: n(e.rounds) })} · runner ${String(e.runner ?? '')}` };
    case 'tasks_split': return { icon: Activity, tone: '', main: t('ev.tasks', { defaultValue: '任务集切分' }), sub: `train ${n(e.train)} · val ${n(e.val)} · test ${n(e.test)}${n(e.synthetic) ? ` · synthetic ${n(e.synthetic)}` : ''}` };
    case 'baseline': return { icon: Activity, tone: '', main: t('ev.baseline', { defaultValue: 'S₀ 基线' }), sub: `val ${n(e.val_score).toFixed(2)}(${n(e.val_tasks)} ${t('ev.tasksUnit', { defaultValue: '个任务' })})` };
    case 'round_start': return { icon: GitBranch, tone: 'text-primary', main: t('ev.roundStart', { defaultValue: '第 {{r}} 轮开始', r: n(e.round) }), sub: e.tests_phase ? t('ev.testsPhase', { defaultValue: '本轮先长测试(代码冻结)' }) : '' };
    case 'attribution': {
      const parts = Object.entries(e).filter(([k, v]) => !['seq', 'ts', 'kind', 'round'].includes(k) && typeof v === 'number').map(([k, v]) => `${k} ${String(v)}`);
      return { icon: Activity, tone: '', main: t('ev.attribution', { defaultValue: '归因' }), sub: parts.join(' · ') };
    }
    case 'fast_loop': {
      const rb = (e.rejected_by ?? {}) as Record<string, number>;
      return { icon: Code, tone: '', main: t('ev.fast', { defaultValue: '快环 · 代码' }), sub: `${t('ev.proposed', { defaultValue: '提出' })} ${n(e.proposed)} · ${t('ev.accepted', { defaultValue: '接受' })} ${n(e.accepted)} · ${t('ev.rejected', { defaultValue: '拒绝' })} ${n(e.rejected)}${Object.keys(rb).length ? `(${Object.entries(rb).map(([g, c]) => `${g} ${c}`).join(', ')})` : ''}` };
    }
    case 'slow_loop': {
      const parts = Object.entries(e).filter(([k, v]) => !['seq', 'ts', 'kind', 'round'].includes(k) && (typeof v === 'number' || typeof v === 'boolean')).map(([k, v]) => `${k} ${String(v)}`);
      return { icon: BookOpen, tone: '', main: t('ev.slow', { defaultValue: '慢环 · 文档' }), sub: parts.join(' · ') };
    }
    case 'governance': return { icon: Shield, tone: e.passed ? '' : 'text-red-600', main: t('ev.governance', { defaultValue: 'G8 治理' }), sub: `${e.passed ? 'PASS' : 'FAIL'} · ${t('ev.violations', { defaultValue: '{{n}} 违规', n: n(e.violations) })}${typeof e.bloat_ratio === 'number' ? ` · ${t('ev.bloat', { defaultValue: '膨胀' })} ${(e.bloat_ratio * 100).toFixed(0)}%` : ''}` };
    case 'gate': return { icon: e.accepted ? Check : X, tone: e.accepted ? 'text-emerald-600' : 'text-red-600', main: `${t('ev.gate', { defaultValue: 'G7 留出门 · {{a}}', a: e.accepted ? t('ev.accept', { defaultValue: '接受' }) : t('ev.reject', { defaultValue: '拒绝' }) })}${e.replayed ? t('ev.replayed', { defaultValue: '(第 {{r}} 轮,上次跑的)', r: n(e.round) }) : ''}`, sub: `train ${n(e.train_score).toFixed(2)} · val ${n(e.val_baseline).toFixed(2)} → ${n(e.val_candidate).toFixed(2)}${e.formula ? ` · ${String(e.formula)}` : ''}` };
    case 'round_end': return { icon: e.accepted ? Check : X, tone: e.accepted ? 'text-emerald-600' : 'text-muted-foreground', main: t('ev.roundEnd', { defaultValue: '第 {{r}} 轮结束 · {{a}}', r: n(e.round), a: e.accepted ? t('ev.accept', { defaultValue: '接受' }) : t('ev.reject', { defaultValue: '拒绝' }) }), sub: `${t('ev.bundles', { defaultValue: '接受 {{a}} / 拒绝 {{b}} 个候选', a: n(e.accepted_bundles), b: n(e.rejected_bundles) })} · $${n(e.cost_usd).toFixed(4)} · ${n(e.llm_calls)} ${t('ev.calls', { defaultValue: '次调用' })}${e.reason ? ` · ${String(e.reason)}` : ''}` };
    case 'harvest_sessions': return { icon: Activity, tone: '', main: t('ev.harvestSessions', { defaultValue: '读会话' }), sub: t('ev.harvestSessionsSub', { defaultValue: '{{n}} 个会话,{{v}} 个带用户投票', n: n(e.sessions), v: n(e.voted) }) };
    case 'release_score': return { icon: Shield, tone: '', main: t('ev.releaseScore', { defaultValue: '留出集 · {{l}}', l: e.label === 'baseline' ? 'S₀' : t('ev.candidate', { defaultValue: '候选' }) }), sub: `test ${n(e.score).toFixed(2)} · ${n(e.passed)}/${n(e.total)}` };
    case 'done':
      if (e.stop_reason === 'dry_run' || e.stop_reason === 'mined' || e.stop_reason === 'no_sessions') {
        return { icon: Check, tone: 'text-emerald-600', main: t('ev.harvestDone', { defaultValue: '挖完 · {{r}}', r: String(e.stop_reason) }), sub: t('ev.harvestDoneSub', { defaultValue: '{{s}} 个会话 → {{k}} 条任务 · ${{c}}', s: n(e.sessions), k: n(e.tasks), c: n(e.cost_usd).toFixed(4) }) };
      }
      if (e.stop_reason === 'release_eval') {
        return { icon: Shield, tone: 'text-emerald-600', main: t('ev.releaseDone', { defaultValue: '留出集评估完成(这份 staging 的 test 已用掉)' }), sub: `test ${n(e.test_score_baseline).toFixed(2)} → ${n(e.test_score_best).toFixed(2)} · $${n(e.cost_usd).toFixed(4)}` };
      }
      return { icon: e.improved ? Check : Square, tone: e.improved ? 'text-emerald-600' : '', main: t('ev.done', { defaultValue: '完成 · {{r}}', r: String(e.stop_reason ?? '') }), sub: `${e.improved ? t('ev.improved', { defaultValue: '有改进' }) : t('ev.unchanged', { defaultValue: '无改进(staged S₀)' })} · val ${n(e.baseline_score).toFixed(2)} → ${n(e.best_score).toFixed(2)} · $${n(e.cost_usd).toFixed(4)}${e.staging ? ` · staging ${String(e.staging)}` : ''}` };
    case 'error': return { icon: AlertTriangle, tone: 'text-red-600', main: t('ev.error', { defaultValue: '出错' }), sub: String(e.message ?? '') };
    // 从中断处续跑
    case 'resumed': return { icon: GitBranch, tone: 'text-primary', main: t('ev.resumed', { defaultValue: '从第 {{r}} 轮之后续跑', r: n(e.from_round) }), sub: t('ev.resumedSub', { defaultValue: '前 {{r}} 轮上次已跑完(花了 ${{c}}),S₀ 基线不重测;被打断的那一轮丢弃重来', r: n(e.from_round), c: n(e.prior_cost_usd).toFixed(4) }) };
    // 一轮之内到了费用上限:不再开新的提议(已该做的验证照做)
    case 'budget_reached': return { icon: AlertTriangle, tone: 'text-amber-600', main: t('ev.budgetReached', { defaultValue: '到费用上限了:跳过 {{what}}', what: String(e.skipped ?? '') }), sub: t('ev.budgetReachedSub', { defaultValue: '已花 ${{s}} / 上限 ${{m}};已经该做的验证照做,这一轮结束就停', s: n(e.spent_usd).toFixed(4), m: n(e.max_cost_usd).toFixed(2) }) };
    case 'resume_unavailable': return { icon: AlertTriangle, tone: 'text-amber-600', main: t('ev.resumeUnavailable', { defaultValue: '续跑不成,从头开始' }), sub: String(e.reason ?? '') };
    default: return { icon: Activity, tone: '', main: e.kind, sub: '' };
  }
}

function ScoreChart({ events, planned }: { events: ProgressEvent[]; planned: number }) {
  const { t } = useTranslation('skillwhet');
  const base = events.find((e) => e.kind === 'baseline');
  const gates = events.filter((e) => e.kind === 'gate');
  const points: Array<{ label: string; v: number; accepted: boolean }> = [];
  if (base) points.push({ label: 'S₀', v: Number(base.val_score ?? 0), accepted: true });
  let current = points[0]?.v ?? 0;
  for (const g of gates) {
    const v = Number(g.val_candidate ?? current);
    if (g.accepted) current = v;
    points.push({ label: `r${String(g.round)}`, v, accepted: Boolean(g.accepted) });
  }
  if (points.length < 2) {
    return <div className="rounded-panel border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">{t('chart.empty', { defaultValue: '第一轮结束前没有曲线 —— 这里到时画 val 通过率(纵轴固定 0–100%)' })}</div>;
  }
  const W = 360; const H = 130; const L = 34; const R = 12; const T = 10; const B = 26;
  const slots = Math.max(points.length, planned + 1);
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, slots - 1);
  const y = (v: number) => T + (1 - Math.max(0, Math.min(1, v))) * (H - T - B);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="val">
      <line x1={L} y1={T} x2={L} y2={H - B} stroke="currentColor" className="text-border" />
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="currentColor" className="text-border" />
      {[0, 0.5, 1].map((v) => <text key={v} x={4} y={y(v) + 3} fontSize={9} className="fill-muted-foreground font-mono">{Math.round(v * 100)}</text>)}
      <line x1={L} y1={y(0.5)} x2={W - R} y2={y(0.5)} stroke="currentColor" strokeDasharray="3 3" className="text-border" />
      <polyline fill="none" stroke="currentColor" strokeWidth={2} className="text-primary" points={points.map((p, i) => `${x(i)},${y(p.v)}`).join(' ')} />
      {points.map((p, i) => (
        <g key={p.label}>
          <circle cx={x(i)} cy={y(p.v)} r={3.5} fill={p.accepted ? 'currentColor' : 'white'} stroke="currentColor" strokeWidth={2} className={p.accepted ? 'text-primary' : 'text-red-500'} />
          <text x={x(i)} y={H - 8} fontSize={9} textAnchor="middle" className="fill-muted-foreground font-mono">{p.label} {p.v.toFixed(2)}</text>
        </g>
      ))}
    </svg>
  );
}

type RunDetailProps = {
  jobId: string;
  isRoot: boolean;
  userId: number | null;
  onBack: () => void;
  onOpenVersions: (skill: string, stagingId: string | null) => void;
  /** 续跑起了新作业后跳过去 */
  onOpenJob?: (jobId: string) => void;
};

export default function RunDetail({ jobId, isRoot, userId, onBack, onOpenVersions, onOpenJob }: RunDetailProps) {
  const { t } = useTranslation('skillwhet');
  const { toast } = useToast();
  const labelOf = useJobLabel();
  const { job, events, error, refresh } = useJobProgress(jobId);
  const [tab, setTab] = useState<Tab>('process');
  const [staging, setStaging] = useState<StagingDetail | null>(null);
  const [log, setLog] = useState<string | null>(null);
  // stdout 按 (作业 id, 作业状态, 刷新次数) 重拉:作业状态每变一次、每点一次刷新都重新读,
  // 不能拉到一次就缓存,否则作业结束后的输出永远看不到。
  const [logTick, setLogTick] = useState(0);
  const [harvestImported, setHarvestImported] = useState<boolean | null>(null);
  const [evidence, setEvidence] = useState<{ provenance: unknown[]; ledger: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState<CheckpointInfo | null>(null);

  const stagingId = job?.staging ?? null;
  useEffect(() => {
    setStaging(null);
    if (!job || !stagingId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const detail = await unwrap<StagingDetail>(await api.skillWhet.stagingDetail(job.skill, stagingId));
        if (!cancelled) setStaging(detail);
      } catch { /* staging 可能被移除 */ }
    })();
    return () => { cancelled = true; };
  }, [job?.skill, stagingId, job]);

  useEffect(() => {
    if (tab !== 'evidence' || !job || evidence) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const [prov, ledger] = await Promise.all([
          unwrap<{ records: unknown[] }>(await api.skillWhet.provenance(job.skill)).catch(() => ({ records: [] })),
          unwrap<{ text: string }>(await api.skillWhet.ledger(job.skill)).catch(() => ({ text: '' })),
        ]);
        if (!cancelled) setEvidence({ provenance: prov.records ?? [], ledger: ledger.text ?? '' });
      } catch { /* 留空 */ }
    })();
    return () => { cancelled = true; };
  }, [tab, job, evidence]);

  const jobState = job?.state ?? null;
  useEffect(() => {
    if (tab !== 'params' || !job) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const data = await unwrap<{ log: string }>(await api.skillWhet.jobLog(job.id, 200));
        if (!cancelled) setLog(data.log ?? '');
      } catch { if (!cancelled) setLog(''); }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按 id / 状态 / 刷新次数重拉,不跟着 job 对象每 3 秒变
  }, [tab, job?.id, jobState, logTick]);

  // 挖任务作业跑完了、还没入库:运行详情也给一个「入库」入口,作为向导找不回作业时的兜底。
  const isHarvest = (job?.kind ?? 'train') === 'harvest';
  useEffect(() => {
    setHarvestImported(null);
    if (!job || !isHarvest || job.state !== 'done' || job.args?.dry_run) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const res = await unwrap<{ imported: unknown; result: { dry_run?: boolean } }>(await api.skillWhet.jobResult(job.id));
        if (!cancelled) setHarvestImported(res.result?.dry_run ? null : Boolean(res.imported));
      } catch { /* 结果没了 */ }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, jobState, isHarvest]);

  // 中断 / 失败 / 取消的训练,看 SkillWhet 那边有没有这次训练存下的 checkpoint(存的时间落在这次作业跑的时间里)
  const ended = job ? ['interrupted', 'failed', 'cancelled'].includes(job.state) && (job.kind ?? 'train') === 'train' : false;
  useEffect(() => {
    setCheckpoint(null);
    if (!job || !ended) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const info = await unwrap<CheckpointInfo>(await api.skillWhet.checkpoint(job.skill));
        const at = info.saved_at ? Date.parse(info.saved_at) : NaN;
        const from = Date.parse(String(job.started_at ?? job.created_at));
        const to = job.finished_at ? Date.parse(job.finished_at) : Date.now();
        const ours = Number.isFinite(at) && at >= from - 1000 && at <= to + 1000;
        if (!cancelled) setCheckpoint(info.exists && info.matches && ours ? info : null);
      } catch { /* 旧版 serve 没有这条路由:不画续跑 */ }
    })();
    return () => { cancelled = true; };
  }, [job, ended]);

  const rounds = useMemo(() => events.filter((e) => e.kind === 'round_end'), [events]);
  const planned = Number(job?.args?.rounds ?? 0);
  const live = job ? job.state === 'queued' || job.state === 'running' : false;
  const mayCancel = job && live && (isRoot || (userId != null && job.tags?.includes(`user:${userId}`)));

  const act = async (key: string, fn: () => Promise<void>, done?: string) => {
    setBusy(key);
    try { await fn(); if (done) toast({ message: done, variant: 'success' }); } catch (caught) { toast({ message: caught instanceof Error ? caught.message : String(caught), variant: 'error' }); } finally { setBusy(null); }
  };
  const mayResume = Boolean(checkpoint && job && (isRoot || (userId != null && job.tags?.includes(`user:${userId}`))));
  const resume = () => act('resume', async () => {
    const data = await unwrap<{ job: { id: string } }>(await api.skillWhet.jobResume(jobId));
    onOpenJob?.(data.job.id);
  }, t('detail.resumed', { defaultValue: '已从中断处续跑' }));
  const cancel = () => act('cancel', async () => { await unwrap(await api.skillWhet.jobCancel(jobId)); await refresh(); }, t('runs.cancelled', { defaultValue: '已取消 {{id}}', id: jobId }));
  const importHarvest = () => act('import', async () => {
    const res = await unwrap<{ added: number; total: number }>(await api.skillWhet.jobImport(jobId));
    setHarvestImported(true);
    toast({ message: t('harvest.imported', { defaultValue: '已入库 {{n}} 条,现有 {{total}} 条', n: res.added, total: res.total }), variant: 'success' });
  });
  const download = () => act('export', async () => {
    if (!job || !stagingId) return;
    const response = await api.skillWhet.stagingExport(job.skill, stagingId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${job.skill}-${stagingId}.tar.gz`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });

  if (error && !job) return <div className="rounded-panel border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>;
  if (!job) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('detail.loading', { defaultValue: '读取作业…' })}</div>;

  const { tone } = jobBadge(job);
  // 挖任务 / 留出集评估没有轮次、diff、provenance:只留过程与参数两页。
  const isTrain = (job.kind ?? 'train') === 'train';
  const tabs: Array<{ id: Tab; label: string; n?: number }> = [
    { id: 'process', label: t('detail.tabProcess', { defaultValue: '优化过程' }) },
    ...(isTrain ? [
      { id: 'metrics' as Tab, label: t('detail.tabMetrics', { defaultValue: '指标趋势' }) },
      { id: 'diff' as Tab, label: t('detail.tabDiff', { defaultValue: '代码与文档' }), n: staging?.diffs.length },
      { id: 'evidence' as Tab, label: t('detail.tabEvidence', { defaultValue: '执行证据' }) },
      { id: 'replay' as Tab, label: t('detail.tabReplay', { defaultValue: '回放评测' }), n: rounds.length || undefined },
    ] : []),
    { id: 'params', label: t('detail.tabParams', { defaultValue: '模型与参数' }) },
  ];
  const doneEv = events.find((e) => e.kind === 'done');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <button type="button" onClick={onBack} className="grid h-8 w-8 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground" aria-label={t('detail.back', { defaultValue: '返回' })}><ArrowLeft className="h-4 w-4" /></button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-lg font-semibold text-foreground">{job.skill}</h1>
            <Badge tone={tone}>{live && job.state === 'running' && <Loader2 className="h-[11px] w-[11px] animate-spin" aria-hidden />}{labelOf(job)}{job.state === 'running' && rounds.length > 0 ? ` · ${rounds.length}/${planned || '?'}` : ''}</Badge>
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {job.id} · {ownerOf(job)} · {fmtTs(job.started_at ?? job.created_at)}{typeof job.cost_usd === 'number' ? ` · $${job.cost_usd.toFixed(4)}` : ''}{job.error ? ` · ${job.error}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setLogTick((n) => n + 1); void refresh(); }} className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong"><RefreshCw className="h-3 w-3" aria-hidden />{t('runs.refresh', { defaultValue: '刷新' })}</button>
          {isHarvest && harvestImported === false && isRoot && (
            <button type="button" onClick={importHarvest} disabled={busy !== null} className="prism-action inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs disabled:opacity-50" data-testid="harvest-import-all">
              {busy === 'import' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}{t('detail.importHarvest', { defaultValue: '入库全部挖出的任务' })}
            </button>
          )}
          {isHarvest && harvestImported === true && <Badge tone="ok"><Check className="h-[11px] w-[11px]" aria-hidden />{t('detail.harvestImported', { defaultValue: '已入库' })}</Badge>}
          {mayCancel && <button type="button" onClick={cancel} disabled={busy !== null} className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50"><Square className="h-3 w-3" aria-hidden />{t('detail.cancel', { defaultValue: '取消' })}</button>}
          {stagingId && isTrain && <button type="button" onClick={download} disabled={busy !== null} className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50"><Download className="h-3 w-3" aria-hidden />{t('detail.download', { defaultValue: '下载包' })}</button>}
          {stagingId && <button type="button" onClick={() => onOpenVersions(job.skill, stagingId)} className="prism-action inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs"><Upload className="h-3 w-3" aria-hidden />{t('detail.review', { defaultValue: '审阅 / 采纳 / 发布' })}</button>}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((item) => (
          <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] ${tab === item.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {item.label}{item.n ? <span className="ml-1 rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">{item.n}</span> : null}
          </button>
        ))}
      </div>

      {checkpoint && (
        <div className="flex flex-wrap items-center gap-2 rounded-panel border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-200" data-testid="resume-banner">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          <span className="flex-1">{t('detail.checkpoint', { defaultValue: '这次训练跑完了 {{r}} 轮后停下,已完成的轮次存了 checkpoint —— 续跑会从第 {{next}} 轮接着来,不重测基线、不重跑已完成的轮。', r: checkpoint.round ?? 0, next: (checkpoint.round ?? 0) + 1 })}</span>
          {mayResume && (
            <button type="button" onClick={resume} disabled={busy !== null} className="prism-action inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs disabled:opacity-50" data-testid="resume-job">
              {busy === 'resume' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Play className="h-3 w-3" aria-hidden />}
              {t('detail.resume', { defaultValue: '从中断处续跑' })}
            </button>
          )}
        </div>
      )}

      {tab === 'process' && (events.length === 0 ? (
        <section className="rounded-panel border border-border bg-card px-4 py-1">
          <div className="py-8 text-center text-xs text-muted-foreground">{job.state === 'queued' ? t('detail.queuedHint', { defaultValue: '排队中,轮到它时这里开始出现事件' }) : t('detail.noEvents', { defaultValue: '还没有事件' })}</div>
          {live && <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />{t('detail.running', { defaultValue: '进行中 · 3 秒一刷' })}</div>}
        </section>
      ) : (
        <ProcessTimeline events={events} live={live} renderEvent={(e) => eventLine(e, t as never)} />
      ))}

      {tab === 'metrics' && (
        <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-4 max-lg:grid-cols-1">
          <section className="rounded-panel border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between text-xs"><h2 className="text-[15px] font-semibold text-foreground">{t('chart.title', { defaultValue: 'val 通过率' })}</h2><span className="text-muted-foreground">{t('chart.axis', { defaultValue: '纵轴固定 0–100%' })}</span></div>
            <ScoreChart events={events} planned={planned} />
          </section>
          <section className="rounded-panel border border-border bg-card p-4 text-xs">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-muted-foreground">{t('chart.cost', { defaultValue: '费用累计' })}</dt><dd className="font-mono text-body">${Number(doneEv?.cost_usd ?? rounds.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)).toFixed(4)}{typeof job.args?.max_cost_usd === 'number' ? ` / ${t('chart.reserved', { defaultValue: '上限' })} $${Number(job.args.max_cost_usd).toFixed(2)}` : ''}</dd>
              <dt className="text-muted-foreground">{t('chart.calls', { defaultValue: '模型调用' })}</dt><dd className="font-mono text-body">{rounds.reduce((s, r) => s + Number(r.llm_calls ?? 0), 0)}</dd>
              <dt className="text-muted-foreground">{t('chart.rounds', { defaultValue: '轮次' })}</dt><dd className="font-mono text-body">{rounds.length} / {planned || '?'}</dd>
              <dt className="text-muted-foreground">{t('chart.stop', { defaultValue: '停止原因' })}</dt><dd className="font-mono text-body">{String(job.stop_reason ?? (live ? '—' : job.state))}</dd>
              {staging && <><dt className="text-muted-foreground">test</dt><dd className="font-mono text-body">{staging.test_score_baseline ?? '—'} → {staging.test_score_best ?? '—'}</dd></>}
            </dl>
          </section>
        </div>
      )}

      {tab === 'diff' && (staging ? <DiffView diffs={staging.diffs} base={staging.diff_base} /> : <div className="text-xs text-muted-foreground">{live ? t('detail.diffLater', { defaultValue: '训练结束后这里出现 staging 的逐文件 diff' }) : t('detail.noStaging', { defaultValue: '没有 staging(作业没跑完)' })}</div>)}

      {tab === 'evidence' && (
        <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
          <section className="rounded-panel border border-border bg-card p-4">
            <h2 className="mb-2 text-[15px] font-semibold text-foreground">{t('detail.provenance', { defaultValue: '来源记录(provenance)' })}</h2>
            {!evidence ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden /> : evidence.provenance.length === 0 ? <p className="text-xs text-muted-foreground">{t('detail.noProvenance', { defaultValue: '还没有记录' })}</p> : (
              <ul className="flex max-h-[60vh] flex-col gap-1 overflow-auto font-mono text-[11px] text-body">
                {evidence.provenance.slice(-50).reverse().map((row, i) => <li key={i} className="rounded-md bg-muted px-2 py-1">{JSON.stringify(row).slice(0, 400)}</li>)}
              </ul>
            )}
          </section>
          <section className="rounded-panel border border-border bg-card p-4">
            <h2 className="mb-2 text-[15px] font-semibold text-foreground">{t('detail.ledger', { defaultValue: 'Preserve Ledger' })}</h2>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-body">{evidence?.ledger || '—'}</pre>
          </section>
        </div>
      )}

      {tab === 'replay' && (
        <section className="overflow-hidden rounded-panel border border-border bg-card">
          {rounds.length === 0 ? <div className="px-4 py-8 text-center text-xs text-muted-foreground">{t('detail.noRounds', { defaultValue: '还没有跑完一轮' })}</div> : (
            <table className="w-full text-xs">
              <thead className="text-left text-[11px] text-muted-foreground"><tr><th className="px-3 py-2 font-normal">{t('replay.round', { defaultValue: '轮' })}</th><th className="px-2 py-2 font-normal">G7</th><th className="px-2 py-2 font-normal">train → val</th><th className="px-2 py-2 font-normal">G8</th><th className="px-2 py-2 font-normal">{t('replay.bundles', { defaultValue: '候选' })}</th><th className="px-2 py-2 font-normal">{t('runs.colCost', { defaultValue: '费用' })}</th></tr></thead>
              <tbody>
                {rounds.map((r) => {
                  const gate = events.find((e) => e.kind === 'gate' && e.round === r.round);
                  const gov = events.find((e) => e.kind === 'governance' && e.round === r.round);
                  return (
                    <tr key={r.seq} className="border-t border-border">
                      <td className="px-3 py-2 font-mono">{String(r.round)}</td>
                      <td className="px-2 py-2"><Badge tone={r.accepted ? 'ok' : 'bad'}>{r.accepted ? 'ACCEPT' : 'REJECT'}</Badge></td>
                      <td className="px-2 py-2 font-mono text-body">{gate ? `${Number(gate.train_score).toFixed(2)} → ${Number(gate.val_candidate).toFixed(2)}` : '—'}</td>
                      <td className="px-2 py-2">{gov ? <Badge tone={gov.passed ? 'ok' : 'bad'}>{gov.passed ? 'PASS' : 'FAIL'} · {String(gov.violations ?? 0)}</Badge> : '—'}</td>
                      <td className="px-2 py-2 font-mono text-body">{String(r.accepted_bundles ?? 0)} / {String(r.rejected_bundles ?? 0)}</td>
                      <td className="px-2 py-2 font-mono text-body">${Number(r.cost_usd ?? 0).toFixed(4)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'params' && (
        <div className="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
          <section className="rounded-panel border border-border bg-card p-4">
            <h2 className="mb-2 text-[15px] font-semibold text-foreground">{t('detail.args', { defaultValue: '参数' })}</h2>
            <pre className="whitespace-pre-wrap font-mono text-[11px] text-body">{JSON.stringify(job.args, null, 2)}</pre>
            {staging?.report?.model_snapshot && <><h3 className="mb-1 mt-3 text-xs font-medium text-foreground">{t('detail.models', { defaultValue: '模型快照' })}</h3><pre className="whitespace-pre-wrap font-mono text-[11px] text-body">{JSON.stringify(staging.report.model_snapshot, null, 2)}</pre></>}
          </section>
          <section className="rounded-panel border border-border bg-card p-4">
            <h2 className="mb-2 text-[15px] font-semibold text-foreground">stdout</h2>
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-body">{log === null ? '…' : log || '—'}</pre>
          </section>
        </div>
      )}
    </div>
  );
}
