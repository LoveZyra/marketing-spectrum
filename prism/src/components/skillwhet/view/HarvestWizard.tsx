import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, History, Loader2, Search, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { useToast } from '../../../shared/view/ui';
import { LIVE_STATES } from '../hooks/useJobs';
import {
  unwrap, type HarvestProject, type HarvestResult, type Job, type ManagedSkill,
} from '../lib/types';

import { Badge } from './StatusStrip';

/**
 * ha(F3-01):「从会话挖」—— root 专用向导。
 *
 *   ① 选 skill、项目(多选)、时间窗 → 「预览会话」:dry-run 作业,零模型调用,只列会被读的会话;
 *   ② 「开始挖」:同样的会话白名单 + 反馈叠加层,挖掘器(sonnet / mock)出任务 → 预览(脱敏后的
 *      intent、判据、outcome 来源:投票 or 猜测、split / 家族);
 *   ③ 勾选 → 「入库」。
 *
 * 白名单由服务端按**当前用户可见**的会话生成(root 也走可见性);这里只传项目路径与时间窗。
 * 挖出来的东西不会自己进任务集 —— 入库是第三步单独点的。
 */
type Stage = 'idle' | 'listing' | 'listed' | 'mining' | 'mined';

// 日期框按**本地**日历走;发给服务端的是本地零点对应的 ISO 时刻(不是 UTC 零点,差一个时区)
const pad = (n: number) => String(n).padStart(2, '0');
const daysAgo = (n: number): string => { const d = new Date(Date.now() - n * 86_400_000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localMidnightIso = (day: string): string | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const at = new Date(`${day}T00:00:00`);
  return Number.isFinite(at.getTime()) ? at.toISOString() : undefined;
};

export default function HarvestWizard({ skills, onImported }: { skills: ManagedSkill[]; onImported: () => Promise<void> }) {
  const { t } = useTranslation('skillwhet');
  const { toast } = useToast();
  const [projects, setProjects] = useState<HarvestProject[] | null>(null);
  const [skill, setSkill] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [since, setSince] = useState(daysAgo(30));
  const [mock, setMock] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<HarvestResult | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!skill && skills.length > 0) setSkill(skills[0].name);
  }, [skill, skills]);

  // hl(静态 P2-28):jobId 原来只存组件本地,跑到一半离开页面回来,挖出的任务再也入不了库。
  // 回到页面时从作业表找回最近一个还活着、或已跑完但**还没入库**的 harvest 作业(非 dry-run),接着轮询 / 直接进入库那一步。
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    if (recovered) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const data = await unwrap<{ jobs: Job[] }>(await api.skillWhet.jobs(undefined, 200));
        const cands = (data.jobs ?? []).filter((j) => j.kind === 'harvest' && !j.args?.dry_run);
        for (const j of cands) {
          if (cancelled) return;
          if (LIVE_STATES.has(j.state)) {
            setSkill(j.skill); setJob(j); setJobId(j.id); setStage('mining'); setRecovered(true);
            return;
          }
          if (j.state !== 'done') continue;
          const res = await unwrap<HarvestResult>(await api.skillWhet.jobResult(j.id)).catch(() => null);
          if (cancelled) return;
          if (!res || res.imported || res.result.dry_run) continue;
          setSkill(j.skill); setJob(j); setJobId(j.id);
          setResult(res);
          setChosen(new Set((res.result.tasks ?? []).map((task) => task.id)));
          setStage('mined');
          setRecovered(true);
          toast({ message: t('harvest.recovered', { defaultValue: '找回上次挖出、还没入库的任务({{id}})', id: j.id.replace(/^job_/, '') }), variant: 'default' });
          return;
        }
      } catch { /* 找不回就从头来 */ }
      if (!cancelled) setRecovered(true);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时找一次
  }, []);

  // 条件改了,上一次的预览就不作数了(开始挖用的是**当前**条件,不能拿旧清单当确认)。
  // 找回来的、还没入库的结果不受这条影响:它不是预览,改条件不该把它扔掉(hl)
  const restoredRef = useRef(false);
  useEffect(() => { restoredRef.current = stage === 'mined' && Boolean(result) && !result?.imported && recovered; }, [stage, result, recovered]);
  useEffect(() => {
    if (restoredRef.current) return;
    setStage((prev) => (prev === 'listed' || prev === 'mined' ? 'idle' : prev));
    setResult(null);
  }, [skill, picked, since]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await unwrap<{ projects: HarvestProject[] }>(await api.skillWhet.harvestProjects());
        if (!cancelled) setProjects(Array.isArray(res.projects) ? res.projects : []);
      } catch {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 作业跑着就 2 秒拉一次;终态后取结果
  useEffect(() => {
    if (!jobId) return undefined;
    let cancelled = false;
    let timer: number | null = null;
    let failures = 0;
    const giveUp = (message: string) => {
      toast({ message, variant: 'error' });
      setStage('idle');
      setJobId(null);
    };
    const tick = async () => {
      try {
        const res = await api.skillWhet.job(jobId);
        // 4xx(作业没了 / 权限变了)不会自己好:停,不空转
        if (res.status >= 400 && res.status < 500) { if (!cancelled) giveUp(t('harvest.lost', { defaultValue: '作业查不到了({{s}})', s: res.status })); return; }
        const detail = await unwrap<{ job: Job }>(res);
        if (cancelled) return;
        failures = 0;
        setJob(detail.job);
        if (LIVE_STATES.has(detail.job.state)) {
          timer = window.setTimeout(() => void tick(), 2_000);
          return;
        }
        if (detail.job.state === 'done') {
          const res = await unwrap<HarvestResult>(await api.skillWhet.jobResult(jobId));
          if (cancelled) return;
          setResult(res);
          setChosen(new Set((res.result.tasks ?? []).map((task) => task.id)));
          setStage(res.result.dry_run ? 'listed' : 'mined');
        } else {
          toast({ message: detail.job.error || t('harvest.failed', { defaultValue: '作业没跑完:{{s}}', s: detail.job.state }), variant: 'error' });
          setStage('idle');
        }
      } catch {
        failures += 1;
        if (cancelled) return;
        if (failures >= 6) { giveUp(t('harvest.lost', { defaultValue: '作业查不到了({{s}})', s: 'network' })); return; }
        timer = window.setTimeout(() => void tick(), 4_000);
      }
    };
    void tick();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [jobId, toast, t]);

  const start = useCallback(async (dryRun: boolean) => {
    if (!skill || picked.size === 0) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await unwrap<{ job: Job; sessions: number; feedbackRows: number }>(await api.skillWhet.harvestStart({
        skill, projects: [...picked], since: localMidnightIso(since), dry_run: dryRun, ...(mock ? { backend: 'mock' } : {}),
      }));
      toast({ message: t('harvest.started', { defaultValue: '已排队:{{n}} 个会话、{{f}} 条反馈', n: res.sessions, f: res.feedbackRows }), variant: 'success' });
      setJob(res.job);
      setJobId(res.job.id);
      setStage(dryRun ? 'listing' : 'mining');
    } catch (caught) {
      toast({ message: caught instanceof Error ? caught.message : String(caught), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [skill, picked, since, mock, toast, t]);

  const importChosen = async () => {
    if (!jobId || chosen.size === 0) return;
    setBusy(true);
    try {
      const res = await unwrap<{ added: number; total: number }>(await api.skillWhet.jobImport(jobId, [...chosen]));
      toast({ message: t('harvest.imported', { defaultValue: '已入库 {{n}} 条,现有 {{total}} 条', n: res.added, total: res.total }), variant: 'success' });
      setResult((prev) => (prev ? { ...prev, imported: { added: res.added, total: res.total, task_ids: [...chosen] } } : prev));
      await onImported();
    } catch (caught) {
      toast({ message: caught instanceof Error ? caught.message : String(caught), variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (set: Set<string>, id: string) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; };
  const tasks = useMemo(() => result?.result.tasks ?? [], [result]);
  const sessions = result?.result.sessions ?? [];
  const running = stage === 'listing' || stage === 'mining';
  const inputClass = 'rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none';
  const btn = 'inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50';

  return (
    <section className="flex flex-col gap-3 rounded-panel border border-border bg-card p-4" data-testid="harvest-wizard">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-foreground"><History className="h-4 w-4" aria-hidden />{t('harvest.title', { defaultValue: '从会话挖' })}</h2>
        <span className="text-[11px] text-muted-foreground">{t('harvest.hint', { defaultValue: '只读你看得见、且用过这个 skill(或有投给它的票)的会话;先预览会话(零费用),再挖(调模型),挖出来的先看再入库。' })}</span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 max-lg:grid-cols-1">
        <div className="flex flex-col gap-2 text-xs">
          <label className="flex items-center gap-2 text-muted-foreground">
            skill
            <select value={skill} onChange={(e) => setSkill(e.target.value)} disabled={running} className={`${inputClass} h-7 flex-1 font-mono`} aria-label="skill">
              {skills.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            {t('harvest.since', { defaultValue: '起始日期' })}
            <input type="date" value={since} onChange={(e) => setSince(e.target.value)} disabled={running} className={`${inputClass} h-7`} aria-label={t('harvest.since', { defaultValue: '起始日期' })} />
          </label>
          <label className="flex items-center gap-1.5 text-muted-foreground" title={t('harvest.mockHint', { defaultValue: '离线挖掘器:零费用,只验流程' })}>
            <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} disabled={running} /> mock
          </label>
          <div className="text-[11px] text-muted-foreground">{t('harvest.projects', { defaultValue: '项目(可多选)' })}</div>
          <div className="max-h-[200px] overflow-auto rounded-md border border-border">
            {projects === null ? (
              <div className="flex items-center gap-2 p-2 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />…</div>
            ) : projects.length === 0 ? (
              <p className="p-3 text-center text-muted-foreground">{t('harvest.noProjects', { defaultValue: '没有看得见的 Claude 会话。' })}</p>
            ) : projects.map((p) => (
              <label key={p.path} className="flex items-center gap-2 border-t border-border px-2 py-1 first:border-t-0 hover:bg-muted/50">
                <input type="checkbox" checked={picked.has(p.path)} onChange={() => setPicked((prev) => toggle(prev, p.path))} disabled={running} aria-label={p.name} />
                <span className="min-w-0 flex-1 truncate text-body" title={p.path}>{p.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{p.sessions}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => void start(true)} disabled={busy || running || !skill || picked.size === 0} className={btn} data-testid="harvest-preview">
              {stage === 'listing' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Search className="h-3 w-3" aria-hidden />}{t('harvest.preview', { defaultValue: '预览会话' })}
            </button>
            <button type="button" onClick={() => void start(false)} disabled={busy || running || stage !== 'listed' || sessions.length === 0} className="prism-action inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs disabled:opacity-50" data-testid="harvest-mine">
              {stage === 'mining' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Sparkles className="h-3 w-3" aria-hidden />}{t('harvest.mine', { defaultValue: '开始挖' })}
              {mock && <Badge tone="warn">mock</Badge>}
            </button>
          </div>
          {job && running && <p className="text-[11px] text-muted-foreground"><span className="font-mono">{job.skill}</span> · {job.id.replace(/^job_/, '')} · {job.state}{job.position ? ` · #${job.position + 1}` : ''}</p>}
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          {stage === 'idle' && <p className="py-6 text-center text-[12px] text-muted-foreground">{t('harvest.empty', { defaultValue: '选好 skill 与项目,先「预览会话」。' })}</p>}
          {stage === 'listed' && sessions.length === 0 && (
            <p className="py-4 text-center text-[12px] text-muted-foreground" data-testid="harvest-none">{t('harvest.noneForSkill', { defaultValue: '所选项目 / 时间窗里没有用过这个 skill 的会话(也没有投给它的票),没东西可挖。' })}</p>
          )}
          {(stage === 'listed' || stage === 'mining') && sessions.length > 0 && (
            <>
              <div className="text-xs text-body">{t('harvest.sessionsFound', { defaultValue: '会读 {{n}} 个用过这个 skill 的会话(其中 {{v}} 个带用户投票)', n: sessions.length, v: sessions.filter((x) => x.votes > 0).length })}</div>
              {(result?.result.skipped_other_skill ?? 0) > 0 && (
                <div className="text-[11px] text-muted-foreground" data-testid="harvest-skipped">{t('harvest.skippedOther', { defaultValue: '另有 {{m}} 个会话没用过这个 skill、也没有投给它的票,不挖', m: result?.result.skipped_other_skill })}</div>
              )}
              <div className="max-h-[260px] overflow-auto rounded-md border border-border">
                <table className="w-full text-[11px]">
                  <tbody>
                    {sessions.map((x) => (
                      <tr key={x.session_id} className="border-t border-border first:border-t-0">
                        <td className="px-2 py-1 font-mono text-muted-foreground">{x.session_id.slice(0, 8)}</td>
                        <td className="max-w-[360px] px-2 py-1 text-body"><span className="line-clamp-1" title={x.first_prompt}>{x.first_prompt}</span></td>
                        <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">{(x.skills ?? []).slice(0, 2).join(', ')}</td>
                        <td className="px-2 py-1 font-mono text-muted-foreground">{x.turns}</td>
                        <td className="px-2 py-1">{x.votes > 0 && <Badge tone="ok">{t('harvest.votes', { defaultValue: '投票 {{n}}', n: x.votes })}</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {stage === 'mined' && result && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-body">
                {t('harvest.tasksFound', { defaultValue: '{{s}} 个会话 → {{n}} 条可判分任务', s: sessions.length, n: tasks.length })}
                {typeof result.result.stats?.dropped_uncheckable === 'number' && result.result.stats.dropped_uncheckable > 0 && (
                  <Badge>{t('harvest.dropped', { defaultValue: '无判据丢弃 {{n}}', n: result.result.stats.dropped_uncheckable })}</Badge>
                )}
                <span className="flex-1" />
                {result.imported ? (
                  <Badge tone="ok"><Check className="h-[11px] w-[11px]" aria-hidden />{t('harvest.importedBadge', { defaultValue: '已入库 {{n}}', n: result.imported.added })}</Badge>
                ) : (
                  <button type="button" onClick={() => void importChosen()} disabled={busy || chosen.size === 0} className="prism-action inline-flex h-7 items-center gap-1 rounded-md border px-3 text-xs disabled:opacity-50" data-testid="harvest-import">
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}{t('harvest.import', { defaultValue: '入库选中 ({{n}})', n: chosen.size })}
                  </button>
                )}
              </div>
              {tasks.length === 0 ? (
                <p className="py-4 text-center text-[12px] text-muted-foreground">{t('harvest.noTasks', { defaultValue: '没挖出可判分的任务(没有判据的一律丢弃,不编)。' })}</p>
              ) : (
                <div className="max-h-[320px] overflow-auto rounded-md border border-border">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                      <tr>
                        <th className="w-7 px-2 py-1 font-normal" />
                        <th className="px-2 py-1 font-normal">{t('harvest.colIntent', { defaultValue: '意图' })}</th>
                        <th className="px-2 py-1 font-normal">{t('harvest.colRef', { defaultValue: '判据' })}</th>
                        <th className="px-2 py-1 font-normal">outcome</th>
                        <th className="px-2 py-1 font-normal">split</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map((task) => {
                        const voted = task.tags.includes('outcome:voted');
                        return (
                          <tr key={task.id} className="border-t border-border align-top">
                            <td className="px-2 py-1"><input type="checkbox" checked={chosen.has(task.id)} disabled={Boolean(result.imported)} onChange={() => setChosen((prev) => toggle(prev, task.id))} aria-label={task.id} /></td>
                            <td className="max-w-[260px] px-2 py-1 text-body"><span className="line-clamp-2" title={task.intent}>{task.intent}</span></td>
                            <td className="max-w-[260px] px-2 py-1 text-body"><Badge className="mr-1">{task.reference_kind}</Badge><span className="line-clamp-2" title={task.reference}>{task.reference}</span></td>
                            <td className="px-2 py-1"><Badge tone={task.outcome === 'fail' ? 'bad' : task.outcome === 'success' ? 'ok' : 'muted'}>{task.outcome}</Badge> <span className="text-muted-foreground">{voted ? t('harvest.voted', { defaultValue: '投票' }) : t('harvest.guessed', { defaultValue: '猜测' })}</span></td>
                            <td className="px-2 py-1 font-mono text-muted-foreground" title={task.family_id ? `family ${task.family_id}` : undefined}>{task.split}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
