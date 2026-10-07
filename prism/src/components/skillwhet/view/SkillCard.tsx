import { useEffect, useState } from 'react';
import {
  AlertTriangle, Check, Download, FileText, Layers, Loader2, Minus, Play, RefreshCw, Trash2, Upload, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { useToast } from '../../../shared/view/ui';
import {
  unwrap, type ContractResponse, type FeedbackStats, type GateResult, type ManagedSkill, type NightlyResponse, type PyramidResult,
} from '../lib/types';

import NightlyControl from './NightlyControl';
import { Badge, type Tone } from './StatusStrip';

const GATE_ORDER = ['G0.parse', 'G1.security', 'G2.static', 'G3.contract', 'G4.unit', 'G5.holdout'] as const;

/**
 * 一张技能卡,把受管副本的全部"体征"放在一处:来源 / 六门健康度 / 契约入口点 / 对话反馈 / 夜训。
 *
 * 动作按权限分层(与服务端 `assertMayMutate` 一致,前端只是不画或禁用不能点的按钮):
 * - 重跑体检:权限同 mutate(它会执行副本里的 tests/),零模型费用;
 * - bootstrap / 移除副本:技能库来源 → root;上传来源 → 上传者本人或 root;
 * - 从技能库更新副本:root。
 * 「新建训练」跳到优化训练页并预选这个 skill;要先 bootstrap,权限同 mutate。
 */

const toneOf = (verdict: GateResult['verdict'] | undefined): Tone => (verdict === 'pass' ? 'ok' : verdict === 'fail' ? 'bad' : 'muted');
const IconOf = (verdict: GateResult['verdict'] | undefined) => (verdict === 'pass' ? Check : verdict === 'fail' ? X : Minus);

const fmtMs = (ms: number | undefined): string => (ms === undefined ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export function GateGrid({ gate }: { gate: PyramidResult | null | undefined }) {
  const { t } = useTranslation('skillwhet');
  const byName = new Map((gate?.results ?? []).map((result) => [result.gate, result]));
  return (
    <div className="grid grid-cols-2 gap-1.5" data-testid="gate-grid">
      {GATE_ORDER.map((name) => {
        const result = byName.get(name);
        const Icon = IconOf(result?.verdict);
        const reason = result?.verdict === 'skip' ? String(result.detail?.reason ?? '') : '';
        return (
          <div key={name} className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1">
            <Badge tone={gate ? toneOf(result?.verdict) : 'muted'}>
              <Icon className="h-[11px] w-[11px]" aria-hidden />
              {gate ? (result?.verdict ?? 'skip').toUpperCase() : t('card.gateNotRun', { defaultValue: '未跑' })}
            </Badge>
            <span className="whitespace-nowrap font-mono text-[11px] text-body">{name.replace('.', ' ')}</span>
            <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground" title={reason || undefined}>
              {result ? (reason || fmtMs(result.elapsed_ms)) : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type SkillCardProps = {
  skill: ManagedSkill;
  isRoot: boolean;
  username: string;
  onChanged: () => Promise<void>;
  onTrain: (skill: string) => void;
  /** 夜训计划(整页拉一次);null = 服务端没有夜训接口,不画那一行 */
  nightly?: NightlyResponse | null;
};

export default function SkillCard({ skill, isRoot, username, onChanged, onTrain, nightly = null }: SkillCardProps) {
  const { t } = useTranslation('skillwhet');
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [contract, setContract] = useState<ContractResponse | null>(null);
  const [showContract, setShowContract] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [gate, setGate] = useState<PyramidResult | null>(skill.last_gate ?? null);

  useEffect(() => { setGate(skill.last_gate ?? null); }, [skill.last_gate]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await unwrap<FeedbackStats>(await api.skillWhet.feedbackStats(skill.name));
        if (!cancelled) setStats(data);
      } catch { /* 统计拿不到就不画那一行 */ }
    })();
    return () => { cancelled = true; };
  }, [skill.name]);

  const mayMutate = isRoot || (skill.source === 'upload' && skill.uploaded_by === username);

  const run = async (key: string, fn: () => Promise<void>, doneMessage?: string) => {
    setBusy(key);
    try {
      await fn();
      if (doneMessage) toast({ message: doneMessage, variant: 'success' });
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const recheck = () => run('gate', async () => {
    const result = await unwrap<PyramidResult>(await api.skillWhet.gate(skill.name, true));
    setGate(result);
  }, t('card.recheckDone', { defaultValue: '体检完成' }));

  const bootstrap = () => run('bootstrap', async () => {
    await unwrap(await api.skillWhet.bootstrap(skill.name));
    await onChanged();
  }, t('card.bootstrapDone', { defaultValue: '已冻结 S₀ 基线' }));

  const reimport = () => run('import', async () => {
    await unwrap(await api.skillWhet.importSkill(skill.name, true));
    await onChanged();
  }, t('card.reimportDone', { defaultValue: '副本已从技能库更新' }));

  const remove = () => run('remove', async () => {
    await unwrap(await api.skillWhet.removeSkill(skill.name));
    setConfirmRemove(false);
    await onChanged();
  }, t('card.removeDone', { defaultValue: '副本已移除(归档到 _removed/)' }));

  const toggleContract = () => run('contract', async () => {
    if (!contract) setContract(await unwrap<ContractResponse>(await api.skillWhet.contract(skill.name)));
    setShowContract((value) => !value);
  });

  const sourceLine = [
    skill.source === 'upload'
      ? t('card.sourceUpload', { defaultValue: '来源:上传 · 上传者 {{user}}', user: skill.uploaded_by ?? '?' })
      : t('card.sourceLive', { defaultValue: '来源:技能库' }),
    skill.imported_at ? new Date(skill.imported_at).toLocaleString() : null,
    skill.bootstrapped ? t('card.bootstrapped', { defaultValue: 'S₀ 已冻结' }) : t('card.notBootstrapped', { defaultValue: '未 bootstrap' }),
    t('card.pyCount', { defaultValue: '{{n}} 个 .py', n: skill.python_files ?? 0 }),
    skill.has_unit_tests ? t('card.hasTests', { defaultValue: '带 tests/unit' }) : null,
  ].filter(Boolean).join(' · ');

  const gateFailed = gate ? gate.results.filter((result) => result.verdict === 'fail') : [];
  const firstFinding = gateFailed[0]?.findings?.[0];
  const entrypoints = contract?.contract.entrypoints ?? [];
  const stable = entrypoints.filter((entry) => entry.stability === 'stable').length;

  return (
    <article className="flex flex-col gap-3 rounded-panel border border-border bg-card p-4" data-testid={`skill-card-${skill.name}`}>
      <div className="flex items-center gap-2.5">
        <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-md bg-muted text-body"><Layers className="h-[15px] w-[15px]" aria-hidden /></span>
        <div className="min-w-0">
          <div className="truncate font-mono text-[15px] font-medium text-foreground">{skill.name}</div>
          <div className="truncate text-xs text-muted-foreground" title={sourceLine}>{sourceLine}</div>
        </div>
        <div className="flex-1" />
        {skill.source === 'live' && skill.live_exists === false && (
          <Badge tone="warn"><AlertTriangle className="h-[11px] w-[11px]" aria-hidden />{t('card.liveGone', { defaultValue: '技能库里已不在' })}</Badge>
        )}
        {gateFailed.length > 0 && <Badge tone="bad">{gateFailed[0].gate.split('.')[0]} {t('card.gateFail', { defaultValue: '未通过' })}</Badge>}
        {/* 缺工具的门是 SKIP、整体不算通过:说清是环境没装工具,不是 skill 有问题。 */}
        {gate && gateFailed.length === 0 && (gate.missing_tools?.length ?? 0) > 0 && (
          <span title={(gate.warnings ?? []).join('\n')}><Badge tone="warn"><AlertTriangle className="h-[11px] w-[11px]" aria-hidden />{t('card.gateMissingTools', { defaultValue: '缺工具未查:{{tools}}', tools: (gate.missing_tools ?? []).join(' / ') })}</Badge></span>
        )}
        {gate?.passed && (() => {
          // 有门 SKIP 时显示"六门通过"会误导(比如 G3/G4/G5 全跳过的 skill),要写明跳过了几门
          const skipped = (gate.results ?? []).filter((r) => r.verdict === 'skip').length;
          return skipped === 0
            ? <Badge tone="ok">{t('card.gateAllPass', { defaultValue: '六门通过' })}</Badge>
            : <span title={t('card.gateSkippedHint', { defaultValue: '跳过的门没查任何东西:见各格里的原因' })}><Badge tone="ok">{t('card.gatePassSkipped', { defaultValue: '通过 · {{n}} 门跳过', n: skipped })}</Badge></span>;
        })()}
      </div>

      <GateGrid gate={gate} />

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t('card.contract', { defaultValue: 'CONTRACT 入口点' })}</dt>
        <dd className="font-mono text-body">
          {!skill.has_contract
            ? t('card.contractNone', { defaultValue: '—(先 bootstrap)' })
            : contract
              ? t('card.contractCount', { defaultValue: '{{n}} · stable {{stable}} / experimental {{exp}}', n: entrypoints.length, stable, exp: entrypoints.length - stable })
              : t('card.contractHas', { defaultValue: '已生成 · 点「查看契约」看入口点' })}
        </dd>
        <dt className="text-muted-foreground">{t('card.feedback', { defaultValue: '反馈' })}</dt>
        <dd className="text-body">
          {stats === null
            ? '…'
            : stats.shown + stats.votes === 0
              ? (skill.source === 'upload'
                ? t('card.feedbackNoneUpload', { defaultValue: '尚无(上传的 skill 没有对话反馈,靠任务集)' })
                : t('card.feedbackNone', { defaultValue: '尚无' }))
              : (
                <>
                  {t('card.feedbackLine', {
                    defaultValue: '弹出 {{shown}} · 答复 {{answered}} · 👍 {{votes}} · 好 {{good}} 一般 {{neutral}} 差 {{bad}} · 来自 {{projects}} 个项目 {{users}} 人',
                    shown: stats.shown, answered: stats.answered, votes: stats.votes, good: stats.good, neutral: stats.neutral, bad: stats.bad, projects: stats.projects, users: stats.users,
                  })}
                  {stats.users <= 1 && stats.answered + stats.votes > 0 && <Badge tone="warn" className="ml-1.5">{t('card.singleSource', { defaultValue: '样本来源单一' })}</Badge>}
                  {(stats.divergentProjects ?? []).length > 0 && (
                    <Badge tone="warn" className="ml-1.5" data-testid="divergent-projects">
                      {t('card.divergent', { defaultValue: '{{p}} 在这里偏差大,可考虑为它派生副本', p: (stats.divergentProjects ?? []).join('、') })}
                    </Badge>
                  )}
                  {(stats.byProject ?? []).length > 1 && (
                    <button type="button" onClick={() => setShowProjects((value) => !value)} className="ml-2 text-primary hover:underline">
                      {showProjects ? t('card.hideProjects', { defaultValue: '收起按项目' }) : t('card.showProjects', { defaultValue: '按项目 ({{n}})', n: (stats.byProject ?? []).length })}
                    </button>
                  )}
                  {stats.recentNotes.length > 0 && (
                    <button type="button" onClick={() => setShowNotes((value) => !value)} className="ml-2 text-primary hover:underline">
                      {showNotes ? t('card.hideNotes', { defaultValue: '收起待优化点' }) : t('card.showNotes', { defaultValue: '最近待优化点 ({{n}})', n: stats.recentNotes.length })}
                    </button>
                  )}
                </>
              )}
        </dd>
      </dl>

      {showProjects && stats?.byProject && (
        <table className="w-full rounded-md border border-border bg-background text-xs" data-testid="feedback-by-project">
          <tbody>
            {stats.byProject.map((row, index) => (
              <tr key={`${row.project_id ?? 'x'}-${index}`} className="border-t border-border first:border-t-0">
                <td className="px-2 py-1 text-body">{row.project_name ?? t('card.otherProject', { defaultValue: '其他项目' })}</td>
                <td className="px-2 py-1 font-mono text-muted-foreground">{row.answered}</td>
                <td className="px-2 py-1"><Badge tone="ok">{row.good}</Badge> <Badge>{row.neutral}</Badge> <Badge tone="bad">{row.bad}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showNotes && stats && (
        <ul className="flex flex-col gap-1 rounded-md border border-border bg-background p-2 text-xs">
          {stats.recentNotes.map((row, index) => (
            <li key={`${row.updated_at}-${index}`} className="flex gap-2">
              <Badge tone={row.verdict === 1 ? 'ok' : row.verdict === -1 ? 'bad' : 'muted'}>{row.verdict === 1 ? t('card.good', { defaultValue: '好' }) : row.verdict === -1 ? t('card.bad', { defaultValue: '差' }) : t('card.neutral', { defaultValue: '一般' })}</Badge>
              <span className="min-w-0 flex-1 text-body">{row.note}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{new Date(row.updated_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}

      {showContract && contract && (
        <div className="rounded-md border border-border bg-background p-2 text-xs">
          {entrypoints.length === 0
            ? <span className="text-muted-foreground">{t('card.contractEmpty', { defaultValue: '契约里还没有入口点' })}</span>
            : (
              <table className="w-full">
                <thead><tr className="text-left text-[11px] text-muted-foreground"><th className="pr-2 font-normal">module</th><th className="pr-2 font-normal">id</th><th className="pr-2 font-normal">stability</th><th className="font-normal">side effects</th></tr></thead>
                <tbody>
                  {entrypoints.map((entry) => (
                    <tr key={`${entry.module}:${entry.id}`} className="font-mono text-[11px] text-body">
                      <td className="pr-2">{entry.module}</td><td className="pr-2">{entry.id}</td><td className="pr-2">{entry.stability ?? ''}</td><td>{(entry.side_effects ?? []).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          {contract.contract.allowed_imports && contract.contract.allowed_imports.length > 0 && (
            <div className="mt-1.5 font-mono text-[10px] text-muted-foreground">allowed_imports: {contract.contract.allowed_imports.join(', ')}</div>
          )}
        </div>
      )}

      {nightly && (
        <NightlyControl skill={skill} plan={nightly.plans.find((p) => p.skill_name === skill.name)} meta={nightly} isRoot={isRoot} onSaved={onChanged} />
      )}

      {firstFinding && (
        <p className="flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {[firstFinding.path, firstFinding.line ? `:${firstFinding.line}` : ''].join('')} {String(firstFinding.message ?? '')}
            {' — '}{t('card.fixThenRecheck', { defaultValue: '修好再体检;G1 未通过时非 root 不能起训练' })}
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={recheck} disabled={busy !== null || !mayMutate} title={!mayMutate ? t('card.recheckNoPerm', { defaultValue: '体检会执行副本里的测试:上传者本人或 root 才能点' }) : undefined} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50">
          {busy === 'gate' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
          {t('card.recheck', { defaultValue: '重跑体检' })}
        </button>
        {skill.has_contract && (
          <button type="button" onClick={toggleContract} disabled={busy !== null} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50">
            <FileText className="h-3 w-3" aria-hidden />{t('card.viewContract', { defaultValue: '查看契约' })}
          </button>
        )}
        {mayMutate && !skill.bootstrapped && (
          <button type="button" onClick={bootstrap} disabled={busy !== null} className="prism-action inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs disabled:opacity-50">
            {busy === 'bootstrap' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Play className="h-3 w-3" aria-hidden />}
            {t('card.bootstrap', { defaultValue: 'bootstrap · 冻结 S₀' })}
          </button>
        )}
        {isRoot && skill.source === 'live' && skill.live_exists !== false && (
          <button type="button" onClick={reimport} disabled={busy !== null} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50">
            {busy === 'import' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Download className="h-3 w-3" aria-hidden />}
            {t('card.reimport', { defaultValue: '从技能库更新副本' })}
          </button>
        )}
        {mayMutate && (
          <button type="button" onClick={() => onTrain(skill.name)} disabled={busy !== null || !skill.bootstrapped} title={!skill.bootstrapped ? t('card.trainNeedsBootstrap', { defaultValue: '先 bootstrap 冻结 S₀' }) : undefined} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50" data-testid={`train-${skill.name}`}>
            <Upload className="h-3 w-3" aria-hidden />{t('card.train', { defaultValue: '新建训练' })}
          </button>
        )}
        <span className="flex-1" />
        {mayMutate && (
          confirmRemove ? (
            <span className="inline-flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">{t('card.removeConfirm', { defaultValue: '移除副本?训练产物一起归档' })}</span>
              <button type="button" onClick={remove} disabled={busy !== null} className="h-7 rounded-md border border-red-500/40 px-2 text-red-700 hover:bg-red-500/10 dark:text-red-300">{t('card.removeYes', { defaultValue: '移除' })}</button>
              <button type="button" onClick={() => setConfirmRemove(false)} className="h-7 rounded-md px-2 text-muted-foreground hover:bg-muted">{t('card.cancel', { defaultValue: '取消' })}</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmRemove(true)} disabled={busy !== null} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
              <Trash2 className="h-3 w-3" aria-hidden />{t('card.remove', { defaultValue: '移除副本' })}
            </button>
          )
        )}
      </div>
    </article>
  );
}
