import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, Download, FlaskConical, History, Loader2, RefreshCw, RotateCcw, Upload,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { useToast } from '../../../shared/view/ui';
import {
  unwrap, type ManagedSkill, type PublishEvent, type RollbackEntry, type StagingDetail, type StagingSummary,
} from '../lib/types';
import { stagingTone } from '../lib/staging-state';
import type { SkillWhetData } from '../SkillWhetPage';

import DiffView from './DiffView';
import { Badge } from './StatusStrip';

/**
 * 版本:一个 skill 的 staging 列表(训练产物)→ 选一份看 diff →「留出集评估」(只一次)→
 * 「采纳到副本」(上传者 / root)→「发布到技能库」或「发布为新技能」(root,二次确认);任一份都可「下载包」。
 * 左栏下方是技能库里被替换下来的旧版(保 3 份,root 可回滚)与发布 / 回滚记录。
 *
 * 每个动作的门都在服务端(assertMayMutate / requireRoot / `status.adopted` / drift 检查);
 * 前端只把不能点的说明白。
 */
const fmtTime = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '—');
const fmtScore = (v: number | null | undefined): string => (typeof v === 'number' ? v.toFixed(2) : '—');

type PublishResult = { skill: string; liveDir: string; files: Array<{ rel: string; sha256: string }>; rollback: string | null; replaced: boolean; note?: string };

type VersionsProps = {
  data: SkillWhetData;
  isRoot: boolean;
  username: string;
  initialSkill?: string | null;
  initialStaging?: string | null;
};

export default function Versions({ data, isRoot, username, initialSkill, initialStaging }: VersionsProps) {
  const { t } = useTranslation('skillwhet');
  const { toast } = useToast();
  const skills = useMemo(() => data.skills?.skills ?? [], [data.skills]);
  const [skill, setSkill] = useState<string>(initialSkill ?? '');
  const [list, setList] = useState<StagingSummary[]>([]);
  const [rollbacks, setRollbacks] = useState<RollbackEntry[]>([]);
  const [history, setHistory] = useState<PublishEvent[]>([]);
  const [liveExists, setLiveExists] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<string | null>(initialStaging ?? null);
  const [detail, setDetail] = useState<StagingDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'publish' | 'publishNew' | 'adoptForce' | { rollback: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState(0);
  const [releaseJob, setReleaseJob] = useState<{ id: string; skill: string; sid: string } | null>(null);
  // 快速切 skill 时旧请求可能后到、盖掉新列表:每次 load 发一张票,回来时票不对就丢弃
  const loadTicket = useRef(0);

  useEffect(() => {
    if (!skill && skills.length > 0) setSkill(initialSkill && skills.some((s) => s.name === initialSkill) ? initialSkill : skills[0].name);
  }, [skill, skills, initialSkill]);

  const target: ManagedSkill | null = skills.find((item) => item.name === skill) ?? null;
  const mayAdopt = Boolean(target) && (isRoot || (target?.source === 'upload' && target.uploaded_by === username));

  const load = useCallback(async (name: string) => {
    if (!name) return;
    const ticket = ++loadTicket.current;
    setLoading(true);
    try {
      const [staging, rb, hist, jobs] = await Promise.all([
        unwrap<{ staging: StagingSummary[] }>(await api.skillWhet.staging(name)),
        unwrap<{ rollbacks: RollbackEntry[]; liveExists: boolean }>(await api.skillWhet.rollbacks(name)).catch(() => ({ rollbacks: [] as RollbackEntry[], liveExists: null as boolean | null })),
        unwrap<{ history: PublishEvent[] }>(await api.skillWhet.publishHistory(name)).catch(() => ({ history: [] as PublishEvent[] })),
        // 留出集评估作业只记在组件里,离开再回来就丢了:从作业表找回还活着的那个,免得按钮又能点
        unwrap<{ jobs: Array<{ id: string; kind: string; state: string; args?: Record<string, unknown> }> }>(await api.skillWhet.jobs(name, 50)).catch(() => ({ jobs: [] as Array<{ id: string; kind: string; state: string; args?: Record<string, unknown> }> })),
      ]);
      if (ticket !== loadTicket.current) return;
      setHistory(Array.isArray(hist.history) ? hist.history : []);
      setList(Array.isArray(staging.staging) ? staging.staging : []);
      setRollbacks(rb.rollbacks ?? []);
      setLiveExists(rb.liveExists ?? null);
      const liveRelease = (jobs.jobs ?? []).find((j) => j.kind === 'release_eval' && (j.state === 'queued' || j.state === 'running') && typeof j.args?.staging === 'string');
      if (liveRelease) setReleaseJob({ id: liveRelease.id, skill: name, sid: String(liveRelease.args?.staging) });
      setError(null);
    } catch (caught) {
      if (ticket !== loadTicket.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (ticket === loadTicket.current) setLoading(false);
    }
  }, []);

  useEffect(() => { setSelected(initialSkill === skill ? (initialStaging ?? null) : null); void load(skill); }, [skill, load, initialSkill, initialStaging]);

  useEffect(() => {
    setDetail(null);
    if (!skill || !selected) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const d = await unwrap<StagingDetail>(await api.skillWhet.stagingDetail(skill, selected));
        if (!cancelled) setDetail(d);
      } catch (caught) {
        if (!cancelled) toast({ message: caught instanceof Error ? caught.message : String(caught), variant: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [skill, selected, toast, detailKey]);

  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    try {
      const message = await fn();
      if (message) toast({ message, variant: 'success' });
      setConfirm(null);
      await load(skill);
      setDetailKey((k) => k + 1);
      await data.refresh();
    } catch (caught) {
      toast({ message: caught instanceof Error ? caught.message : String(caught), variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  // force(没被留出门接受)与 skip_release(没做留出集评估)是两个独立开关,按这份 staging 的实际缺口各自带
  const adoptGaps = (s: StagingSummary | undefined) => ({
    force: !!s && !s.accepted,
    skipRelease: !!s && !s.release,
    // 评过了但 test 上没变好:不需要开关,但要人再确认一次
    releaseWorse: !!s?.release && typeof s.release.candidate === 'number' && typeof s.release.baseline === 'number' && s.release.candidate <= s.release.baseline,
  });
  const adopt = () => act('adopt', async () => {
    if (!selected) return undefined;
    const gaps = adoptGaps(list.find((s) => s.id === selected));
    await unwrap(await api.skillWhet.stagingAdopt(skill, selected, { force: gaps.force, skipRelease: gaps.skipRelease }));
    return t('versions.adoptDone', { defaultValue: '已采纳 {{sid}} 到副本;发布还要 root 再点一次', sid: selected });
  });

  // release-once:对这份 staging 做唯一一次留出集评估(排队作业);跑完 release 字段会出现。
  // 作业按 skill + staging 记,切走再切回来不会把别的 staging 的按钮锁住
  const releaseRunning = releaseJob !== null && releaseJob.skill === skill && releaseJob.sid === selected;
  const releaseEval = () => act('release', async () => {
    if (!selected) return undefined;
    const res = await unwrap<{ job: { id: string } }>(await api.skillWhet.releaseEval(skill, selected));
    setReleaseJob({ id: res.job.id, skill, sid: selected });
    return t('versions.releaseQueued', { defaultValue: '留出集评估已排队({{id}});这份 staging 的 test 只能看这一次', id: res.job.id.replace(/^job_/, '') });
  });
  useEffect(() => {
    if (!releaseJob) return undefined;
    let cancelled = false;
    let timer: number | null = null;
    let failures = 0;
    const tick = async () => {
      try {
        const res = await api.skillWhet.job(releaseJob.id);
        // 4xx(作业没了 / 没权限)不会自己好:停,不空转
        if (res.status >= 400 && res.status < 500) { if (!cancelled) setReleaseJob(null); return; }
        const d = await unwrap<{ job: { state: string; error?: string | null } }>(res);
        if (cancelled) return;
        failures = 0;
        if (d.job.state === 'queued' || d.job.state === 'running') { timer = window.setTimeout(() => void tick(), 2_500); return; }
        if (d.job.state !== 'done') toast({ message: d.job.error || d.job.state, variant: 'error' });
        setReleaseJob(null);
        if (releaseJob.skill === skill) { await load(skill); setDetailKey((k) => k + 1); }
      } catch {
        failures += 1;
        if (cancelled) return;
        if (failures >= 6) { setReleaseJob(null); return; }
        timer = window.setTimeout(() => void tick(), 5_000);
      }
    };
    void tick();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [releaseJob, skill, load, toast]);

  const publish = (mode: 'replace' | 'new') => act(mode === 'new' ? 'publishNew' : 'publish', async () => {
    const result = await unwrap<PublishResult>(await (mode === 'new' ? api.skillWhet.publishAsNew(skill) : api.skillWhet.publish(skill)));
    return t('versions.publishDone', { defaultValue: '已发布 {{n}} 个文件到技能库{{rb}};常驻会话要重开才读到新版', n: result.files.length, rb: result.rollback ? t('versions.publishRb', { defaultValue: ',旧版已留档' }) : '' });
  });

  const rollback = (to: string) => act('rollback', async () => {
    await unwrap(await api.skillWhet.rollback(skill, to));
    return t('versions.rollbackDone', { defaultValue: '已回滚到 {{ts}}', ts: to });
  });

  const download = () => act('export', async () => {
    if (!selected) return undefined;
    const response = await api.skillWhet.stagingExport(skill, selected);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${skill}-${selected}.tar.gz`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return undefined;
  });

  const current = list.find((s) => s.id === selected) ?? null;
  // 能不能发布看服务端的 status.adopted(副本当前内容是不是某次采纳的结果),
  // 而不是"列表里最新那份采纳了没":采纳的是较早的一份时也要能发布。
  const latestAdopted = target?.adopted ?? (list.length > 0 && list[0].adopted);
  const canPublish = isRoot && latestAdopted;
  const inputClass = 'rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none';
  const btn = 'inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50';

  const labelOf = (s: StagingSummary): string => {
    const { key } = stagingTone(s);
    switch (key) {
      case 'adopted': return t('versions.state.adopted', { defaultValue: '已采纳' });
      case 'improved': return t('versions.state.improved', { defaultValue: '待审阅' });
      case 'stopped': return t('versions.state.stopped', { defaultValue: '提前停止' });
      default: return t('versions.state.unchanged', { defaultValue: '无变化' });
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="skillwhet-versions">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-foreground">{t('versions.title', { defaultValue: '版本' })}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('versions.subtitle', { defaultValue: 'staging 是训练产物;采纳到副本是第一步,发布到技能库是 root 的第二步;旧版留 3 份可回滚。' })}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          skill
          <select value={skill} onChange={(event) => setSkill(event.target.value)} className={`${inputClass} h-7 font-mono`} aria-label="skill">
            {skills.length === 0 && <option value="">{t('tasks.noSkills', { defaultValue: '(先导入或上传一个 skill)' })}</option>}
            {skills.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void load(skill)} disabled={loading} className={btn}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}{t('runs.refresh', { defaultValue: '刷新' })}
        </button>
      </div>

      {error && <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>}

      <div className="grid grid-cols-[340px_minmax(0,1fr)] gap-4 max-xl:grid-cols-1">
        <div className="flex flex-col gap-4">
          <section className="overflow-hidden rounded-panel border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[13px] font-semibold text-foreground"><History className="h-3.5 w-3.5" aria-hidden />{t('versions.stagingList', { defaultValue: 'staging' })}<span className="font-mono text-[11px] font-normal text-muted-foreground">{list.length}</span></div>
            {list.length === 0 ? (
              <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">{loading ? '…' : t('versions.empty', { defaultValue: '这个 skill 还没有训练产物。去「优化训练」建一个。' })}</p>
            ) : (
              <ul>
                {list.map((s) => {
                  const { tone } = stagingTone(s);
                  return (
                    <li key={s.id}>
                      <button type="button" onClick={() => setSelected(s.id)} aria-current={selected === s.id ? 'true' : undefined} className={`flex w-full flex-col gap-0.5 border-t border-border px-3 py-2 text-left hover:bg-muted/50 ${selected === s.id ? 'bg-accent' : ''}`}>
                        <span className="flex items-center gap-2"><span className="font-mono text-xs text-foreground">{s.id}</span><span className="flex-1" />{(s.published?.length ?? 0) > 0 && <Badge tone="primary">{t('versions.publishedBadge', { defaultValue: '已发布' })}</Badge>}<Badge tone={tone}>{labelOf(s)}</Badge></span>
                        <span className="font-mono text-[11px] text-muted-foreground">val {fmtScore(s.baseline_score)} → {fmtScore(s.candidate_score)} · {s.rounds} {t('versions.roundsUnit', { defaultValue: '轮' })} · {s.files} {t('versions.filesUnit', { defaultValue: '文件' })}{typeof s.total_cost_usd === 'number' ? ` · $${s.total_cost_usd.toFixed(2)}` : ''}</span>
                        <span className="text-[11px] text-muted-foreground">{fmtTime(s.created_at)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="overflow-hidden rounded-panel border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[13px] font-semibold text-foreground"><RotateCcw className="h-3.5 w-3.5" aria-hidden />{t('versions.rollbacks', { defaultValue: '技能库旧版' })}<span className="font-mono text-[11px] font-normal text-muted-foreground">{rollbacks.length}/3</span></div>
            {liveExists === false && <p className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">{t('versions.liveMissing', { defaultValue: '技能库里还没有这个 skill(发布后才有)。' })}</p>}
            {rollbacks.length === 0 ? (
              <p className="px-4 py-5 text-center text-[12px] text-muted-foreground">{t('versions.rollbacksEmpty', { defaultValue: '还没有被替换下来的旧版。' })}</p>
            ) : (
              <ul>
                {rollbacks.map((rb) => (
                  <li key={rb.ts} className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs">
                    <span className="font-mono text-foreground">{rb.ts}</span>
                    <span className="text-muted-foreground">{rb.files} {t('versions.filesUnit', { defaultValue: '文件' })}</span>
                    <span className="flex-1" />
                    {isRoot && (
                      typeof confirm === 'object' && confirm?.rollback === rb.ts ? (
                        <span className="inline-flex items-center gap-1">
                          <button type="button" onClick={() => void rollback(rb.ts)} disabled={busy !== null} className="h-6 rounded-md border border-red-500/40 px-2 text-[11px] text-red-700 hover:bg-red-500/10 dark:text-red-300">{t('versions.rollbackYes', { defaultValue: '确认回滚' })}</button>
                          <button type="button" onClick={() => setConfirm(null)} className="h-6 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted">{t('card.cancel', { defaultValue: '取消' })}</button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setConfirm({ rollback: rb.ts })} disabled={busy !== null} className="h-6 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">{t('versions.rollback', { defaultValue: '回滚' })}</button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 发布 / 回滚记录:每次发布的是哪份 staging,点一下看它当初改了什么。 */}
          <section className="overflow-hidden rounded-panel border border-border bg-card" data-testid="publish-history">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[13px] font-semibold text-foreground"><Upload className="h-3.5 w-3.5" aria-hidden />{t('versions.history', { defaultValue: '发布记录' })}<span className="font-mono text-[11px] font-normal text-muted-foreground">{history.length}</span></div>
            {history.length === 0 ? (
              <p className="px-4 py-5 text-center text-[12px] text-muted-foreground">{t('versions.historyEmpty', { defaultValue: '还没有发布过(早期版本的发布没有记录)。' })}</p>
            ) : (
              <ul className="max-h-[260px] overflow-y-auto">
                {history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border px-3 py-1.5 text-xs first:border-t-0">
                    <Badge tone={h.event === 'publish' ? 'primary' : 'warn'}>{h.event === 'publish' ? t('versions.evPublish', { defaultValue: '发布' }) : t('versions.evRollback', { defaultValue: '回滚' })}</Badge>
                    {h.event === 'publish' && h.staging
                      ? <button type="button" onClick={() => setSelected(h.staging)} className="font-mono text-primary hover:underline">{h.staging}</button>
                      : h.event === 'rollback' && h.to ? <span className="font-mono text-body">→ {h.to}</span> : <span className="text-muted-foreground">—</span>}
                    <span className="flex-1" />
                    <span className="text-[11px] text-muted-foreground">{fmtTime(h.at)}{h.by ? ` · ${h.by}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="flex min-w-0 flex-col gap-3 rounded-panel border border-border bg-card p-4">
          {!current ? (
            <p className="py-10 text-center text-[13px] text-muted-foreground">{t('versions.pick', { defaultValue: '左边选一份 staging 看改动。' })}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium text-foreground">{current.id}</span>
                <Badge tone={stagingTone(current).tone}>{labelOf(current)}</Badge>
                {current.stop_reason && <Badge tone="muted">{t('versions.stop', { defaultValue: '停止原因' })}: {current.stop_reason}</Badge>}
                <span className="flex-1" />
                <button type="button" onClick={download} disabled={busy !== null} className={btn}>{busy === 'export' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Download className="h-3 w-3" aria-hidden />}{t('versions.download', { defaultValue: '下载包' })}</button>
              </div>

              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">val</dt>
                <dd className="font-mono text-body">{fmtScore(current.baseline_score)} → <strong>{fmtScore(current.candidate_score)}</strong>{current.improved ? <Badge tone="ok" className="ml-1.5"><Check className="h-[11px] w-[11px]" aria-hidden />{t('versions.improved', { defaultValue: '有改进' })}</Badge> : <span className="ml-1.5 text-muted-foreground">{t('versions.noImprove', { defaultValue: '无改进(留出门未接受)' })}</span>}</dd>
                <dt className="text-muted-foreground">test</dt>
                <dd className="font-mono text-body" data-testid="release-line">
                  {current.release
                    ? <>{fmtScore(current.release.baseline)} → <strong>{fmtScore(current.release.candidate)}</strong> <span className="text-muted-foreground">{t('versions.releaseLine', { defaultValue: '({{a}}/{{n}} → {{b}}/{{n}} 通过 · 已用掉,只评一次)', a: current.release.baseline_passed ?? '?', b: current.release.candidate_passed ?? '?', n: current.release.test_tasks })}</span></>
                    : current.adopted
                      ? <span className="text-muted-foreground">{t('versions.releaseSkipped', { defaultValue: '未评 —— 采纳时跳过了留出集评估(或是早期版本产出的,没有评估记录)' })}</span>
                      : <span className="text-muted-foreground">{t('versions.releaseNone', { defaultValue: '未评 —— 训练不看 test;打算采纳 / 发布这一份时做一次留出集评估' })}</span>}
                </dd>
                <dt className="text-muted-foreground">{t('versions.meta', { defaultValue: '轮次 / 费用 / 文件' })}</dt>
                <dd className="font-mono text-body">{current.rounds} · {typeof current.total_cost_usd === 'number' ? `$${current.total_cost_usd.toFixed(4)}` : '—'} · {current.files}</dd>
                {current.contract?.candidate_bundle_hash && (
                  <>
                    <dt className="text-muted-foreground">{t('versions.contract', { defaultValue: '契约哈希' })}</dt>
                    <dd className="font-mono text-[11px] text-muted-foreground" title={t('versions.contractHint', { defaultValue: 'base = 训练时的副本;candidate = 这份产物;protocol = runner + 模型 + 门配置' })}>
                      base {current.contract.base_bundle_hash?.slice(0, 10)} · cand {current.contract.candidate_bundle_hash.slice(0, 10)} · proto {current.contract.protocol_hash?.slice(0, 10)}
                    </dd>
                  </>
                )}
                {(current.published?.length ?? 0) > 0 && (
                  <>
                    <dt className="text-muted-foreground">{t('versions.publishedAt', { defaultValue: '发布' })}</dt>
                    <dd className="font-mono text-body">{(current.published ?? []).map((at) => fmtTime(at)).join(' · ')}</dd>
                  </>
                )}
                {detail?.adopted_info && (
                  <>
                    <dt className="text-muted-foreground">{t('versions.adoptedAt', { defaultValue: '采纳' })}</dt>
                    <dd className="font-mono text-body">{fmtTime(String(detail.adopted_info.at ?? ''))}{Array.isArray(detail.adopted_info.files) ? ` · ${detail.adopted_info.files.length} ${t('versions.filesUnit', { defaultValue: '文件' })}` : ''}</dd>
                  </>
                )}
              </dl>

              {!detail ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />{t('versions.loadingDiff', { defaultValue: '算 diff…' })}</div>
              ) : (
                <DiffView diffs={detail.diffs} base={detail.diff_base} />
              )}

              <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                {!current.adopted && !current.release && (
                  <button type="button" onClick={() => void releaseEval()} disabled={!mayAdopt || busy !== null || releaseRunning} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50" data-testid="release-eval">
                    {busy === 'release' || releaseRunning ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <FlaskConical className="h-3 w-3" aria-hidden />}{t('versions.releaseEval', { defaultValue: '留出集评估(只一次)' })}
                  </button>
                )}
                {!current.adopted && (
                  <button type="button" onClick={() => { const g = adoptGaps(current); return g.force || g.skipRelease || g.releaseWorse ? setConfirm('adoptForce') : void adopt(); }} disabled={!mayAdopt || busy !== null} title={!mayAdopt ? (target?.source === 'upload' ? t('tasks.uploaderOnly', { defaultValue: '只有上传者本人或 root 能入库' }) : t('versions.rootOnlyAdopt', { defaultValue: '技能库来源的 skill 只有 root 能采纳' })) : undefined} className="prism-action inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs disabled:opacity-50">
                    {busy === 'adopt' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}{t('versions.adopt', { defaultValue: '采纳到副本' })}
                    {(!current.accepted || !current.release) && <span className="rounded-sm border border-border px-1 font-mono text-[9px]">{!current.accepted ? 'force' : 'no-release'}</span>}
                  </button>
                )}
                {confirm === 'adoptForce' && (
                  <span className="inline-flex items-center gap-1 text-xs">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden />
                    <span className="text-muted-foreground">
                      {[
                        !current.accepted && t('versions.forceConfirm', { defaultValue: '这份 staging 没被留出门接受;强制采纳会把它写进副本。' }),
                        !current.release && t('versions.forceNoRelease', { defaultValue: '这份 staging 还没做留出集评估 —— 没有独立证据说它更好;仍要采纳?' }),
                        adoptGaps(current).releaseWorse && t('versions.releaseWorse', { defaultValue: '留出集上没有变好(候选 ≤ 基线);仍要采纳?' }),
                      ].filter(Boolean).join(' ')}
                    </span>
                    <button type="button" onClick={() => void adopt()} disabled={busy !== null} className="h-6 rounded-md border border-amber-500/40 px-2 text-[11px] text-amber-700 hover:bg-amber-500/10 dark:text-amber-300">{t('versions.forceYes', { defaultValue: '仍要采纳' })}</button>
                    <button type="button" onClick={() => setConfirm(null)} className="h-6 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted">{t('card.cancel', { defaultValue: '取消' })}</button>
                  </span>
                )}
                {isRoot && (
                  <>
                    <button type="button" onClick={() => setConfirm('publish')} disabled={!canPublish || busy !== null || liveExists === false} title={!latestAdopted ? t('versions.needAdopt', { defaultValue: '副本当前内容要是一次采纳的结果才能发布 —— 先采纳一份 staging' }) : liveExists === false ? t('versions.needLive', { defaultValue: '技能库里没有这个 skill,用「发布为新技能」' }) : undefined} className={btn}>
                      {busy === 'publish' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Upload className="h-3 w-3" aria-hidden />}{t('versions.publish', { defaultValue: '发布到技能库' })}<span className="rounded-sm border border-border px-1 font-mono text-[9px]">root</span>
                    </button>
                    {target?.source === 'upload' && (
                      <button type="button" onClick={() => setConfirm('publishNew')} disabled={!canPublish || busy !== null || liveExists === true} title={!latestAdopted ? t('versions.needAdopt', { defaultValue: '副本当前内容要是一次采纳的结果才能发布 —— 先采纳一份 staging' }) : liveExists === true ? t('versions.alreadyLive', { defaultValue: '技能库里已有同名 skill,用「发布到技能库」替换' }) : undefined} className={btn}>
                        {busy === 'publishNew' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Upload className="h-3 w-3" aria-hidden />}{t('versions.publishNew', { defaultValue: '发布为新技能' })}<span className="rounded-sm border border-border px-1 font-mono text-[9px]">root</span>
                      </button>
                    )}
                  </>
                )}
                {(confirm === 'publish' || confirm === 'publishNew') && (
                  <span className="inline-flex items-center gap-1 text-xs">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden />
                    <span className="text-muted-foreground">{confirm === 'publish' ? t('versions.publishConfirm', { defaultValue: '技能库里的 {{skill}} 会被整目录替换(旧版留档);所有项目的新会话立刻读到。', skill }) : t('versions.publishNewConfirm', { defaultValue: '会在技能库新建 {{skill}};所有项目的新会话立刻能用。', skill })}</span>
                    <button type="button" onClick={() => void publish(confirm === 'publish' ? 'replace' : 'new')} disabled={busy !== null} className="h-6 rounded-md border border-amber-500/40 px-2 text-[11px] text-amber-700 hover:bg-amber-500/10 dark:text-amber-300">{t('versions.publishYes', { defaultValue: '确认发布' })}</button>
                    <button type="button" onClick={() => setConfirm(null)} className="h-6 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted">{t('card.cancel', { defaultValue: '取消' })}</button>
                  </span>
                )}
                {!isRoot && current.adopted && <span className="text-[11px] text-muted-foreground">{t('versions.publishRootOnly', { defaultValue: '已在副本里;发布到技能库要 root 来点。' })}</span>}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
