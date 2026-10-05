import { useEffect, useState } from 'react';
import { Loader2, Moon, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { NumberInput, useToast } from '../../../shared/view/ui';
import { useModelCatalog } from '../../../hooks/useTaskLikeOptions';
import { useNightlyResultLabel } from '../lib/nightly';
import { unwrap, type ManagedSkill, type NightlyPlan, type NightlyResponse } from '../lib/types';

import SkillWhetModelSelect from './SkillWhetModelSelect';
import { Badge } from './StatusStrip';

/**
 * he:技能卡上的「夜训」一行(《实施计划》F4-01)。
 *
 * 纳入 / 移出 / 改时窗预算只 root(服务端同样只认 root);其他人只读看状态。
 * 时窗是**服务器本地时间**,表单旁边写着服务器现在几点,免得人按自己的时区填。
 * 连续 N 晚无收益会被调度器自动移出,这里标黄;root 重新纳入即清零。
 */
type Draft = {
  window_start: string; window_end: string; rounds: number; max_cost_usd: string; min_new_tasks: number;
  runner: string; fast_model: string; slow_model: string; eval_model: string; mock: boolean;
};

const draftOf = (plan: NightlyPlan | undefined, meta: NightlyResponse, skill: ManagedSkill): Draft => {
  const c = plan?.config ?? {};
  return {
    window_start: plan?.window_start ?? meta.defaults.window_start,
    window_end: plan?.window_end ?? meta.defaults.window_end,
    rounds: plan?.rounds ?? meta.defaults.rounds,
    max_cost_usd: plan?.max_cost_usd == null ? '' : String(plan.max_cost_usd),
    min_new_tasks: plan?.min_new_tasks ?? meta.defaults.min_new_tasks,
    runner: String(c.runner ?? (skill.has_unit_tests ? 'pytest' : 'agent')),
    fast_model: String(c.fast_model ?? 'haiku'),
    slow_model: String(c.slow_model ?? 'sonnet'),
    eval_model: String(c.eval_model ?? 'opus'),
    mock: c.fast_backend === 'mock',
  };
};

export default function NightlyControl({ skill, plan, meta, isRoot, onSaved }: {
  skill: ManagedSkill;
  plan: NightlyPlan | undefined;
  meta: NightlyResponse | null;
  isRoot: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const { t } = useTranslation('skillwhet');
  const { toast } = useToast();
  const resultLabel = useNightlyResultLabel();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(meta ? draftOf(plan, meta, skill) : null);

  // 表单开着时不被整页刷新(别的卡片做了动作)冲掉;关着时跟着最新计划走
  useEffect(() => { if (meta && !open) setDraft(draftOf(plan, meta, skill)); }, [plan, meta, skill, open]);

  if (!meta || !draft) return null;
  const enrolled = plan?.enrolled === true;
  const paused = !enrolled && Boolean(plan?.auto_paused_at);
  const last = plan?.last_result ? resultLabel(plan.last_result) : null;

  const save = async (enroll: boolean) => {
    setBusy(true);
    try {
      const config: Record<string, unknown> = { runner: draft.runner, fast_model: draft.fast_model, slow_model: draft.slow_model, eval_model: draft.eval_model };
      if (draft.mock) Object.assign(config, { fast_backend: 'mock', slow_backend: 'mock', eval_backend: 'mock' });
      await unwrap(await api.skillWhet.nightlySave(skill.name, {
        enrolled: enroll, window_start: draft.window_start, window_end: draft.window_end, rounds: draft.rounds,
        max_cost_usd: draft.max_cost_usd === '' ? null : Number(draft.max_cost_usd), min_new_tasks: draft.min_new_tasks, config,
      }));
      toast({ message: enroll ? t('nightly.enrolled', { defaultValue: '已纳入夜训' }) : t('nightly.unenrolled', { defaultValue: '已移出夜训' }), variant: 'success' });
      setOpen(false);
      await onSaved();
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const field = 'h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground';

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-xs" data-testid={`nightly-${skill.name}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Moon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <span className="text-muted-foreground">{t('nightly.title', { defaultValue: '夜训' })}</span>
        {enrolled
          ? <Badge tone="ok">{t('nightly.on', { defaultValue: '已纳入 · {{s}}–{{e}}', s: plan?.window_start, e: plan?.window_end })}</Badge>
          : paused
            ? <Badge tone="warn">{t('nightly.paused', { defaultValue: '连续 {{n}} 晚无收益,已暂停', n: plan?.consecutive_noop ?? meta.autopauseAfter })}</Badge>
            : <Badge>{t('nightly.off', { defaultValue: '未纳入' })}</Badge>}
        {last && plan?.last_night && (
          <span className="inline-flex items-center gap-1 text-muted-foreground" title={plan.last_detail ?? undefined}>
            {t('nightly.lastNight', { defaultValue: '{{d}}:', d: plan.last_night })}<Badge tone={last.tone}>{last.label}</Badge>
          </span>
        )}
        <span className="flex-1" />
        {isRoot && (
          <>
            <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-expanded={open}>
              <Settings2 className="h-3 w-3" aria-hidden />{t('nightly.settings', { defaultValue: '设置' })}
            </button>
            <button type="button" onClick={() => void save(!enrolled)} disabled={busy || (!enrolled && !skill.bootstrapped)}
              title={!skill.bootstrapped ? t('card.trainNeedsBootstrap', { defaultValue: '先 bootstrap 冻结 S₀' }) : undefined}
              className={`inline-flex h-6 items-center gap-1 rounded-md border px-2 disabled:opacity-50 ${enrolled ? 'border-border text-foreground hover:border-border-strong' : 'prism-action'}`}
              data-testid={`nightly-toggle-${skill.name}`}>
              {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              {enrolled ? t('nightly.unenroll', { defaultValue: '移出夜训' }) : t('nightly.enroll', { defaultValue: '纳入夜训' })}
            </button>
          </>
        )}
      </div>
      {open && isRoot && (
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1">{t('nightly.window', { defaultValue: '时窗' })}
              <input type="time" value={draft.window_start} onChange={(e) => setDraft({ ...draft, window_start: e.target.value })} className={field} aria-label="window_start" />
              –
              <input type="time" value={draft.window_end} onChange={(e) => setDraft({ ...draft, window_end: e.target.value })} className={field} aria-label="window_end" />
            </label>
            <span className="text-muted-foreground">{t('nightly.serverTime', { defaultValue: '服务器时间 {{t}}({{tz}})', t: meta.serverTime.local, tz: meta.serverTime.tz })}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1">{t('nightly.rounds', { defaultValue: '轮数' })}
              <NumberInput integer min={1} max={meta.nightlyMaxRounds ?? 10} value={draft.rounds} onChange={(v) => setDraft((d) => (d ? { ...d, rounds: v ?? 1 } : d))} className={`${field} w-14`} aria-label="rounds" />
            </label>
            <label className="inline-flex items-center gap-1">{t('nightly.maxCost', { defaultValue: '单次上限 $' })}
              <NumberInput allowEmpty min={0.01} step={0.5} value={draft.max_cost_usd === '' ? null : Number(draft.max_cost_usd)} placeholder={String(meta.maxCostUsd)} title={t('nightly.maxCostHint', { defaultValue: '留空 = .env 的单次上限 ${{env}};可填到 ${{max}}(不超过一晚合计)', env: meta.maxCostUsd, max: Math.min(meta.nightlyHardMaxCostUsd ?? meta.hardMaxCostUsd ?? meta.maxCostUsd, meta.nightlyMaxCostUsd) })} onChange={(v) => setDraft((d) => (d ? { ...d, max_cost_usd: v === null ? '' : String(v) } : d))} className={`${field} w-20`} aria-label="max_cost_usd" />
            </label>
            <label className="inline-flex items-center gap-1">{t('nightly.minNew', { defaultValue: '新任务 ≥' })}
              <NumberInput integer min={0} max={1000} value={draft.min_new_tasks} onChange={(v) => setDraft((d) => (d ? { ...d, min_new_tasks: v ?? 0 } : d))} className={`${field} w-16`} aria-label="min_new_tasks" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1">runner
              <select value={draft.runner} onChange={(e) => setDraft({ ...draft, runner: e.target.value })} className={field} aria-label="runner">
                <option value="pytest">pytest</option><option value="agent">agent</option>
              </select>
            </label>
            {/* hn(B7):模型从目录选(夜训配置只 root 能改 → 不限,可手填);只在设置展开时才拉目录 */}
            <NightlyModelFields draft={draft} onChange={(key, next) => setDraft((d) => (d ? { ...d, [key]: next } : d))} />
            <label className="inline-flex items-center gap-1 text-muted-foreground">
              <input type="checkbox" checked={draft.mock} onChange={(e) => setDraft({ ...draft, mock: e.target.checked })} aria-label="mock" />
              {t('nightly.mock', { defaultValue: 'mock 后端(零费用,试流程用)' })}
            </label>
          </div>
          <p className="text-muted-foreground">
            {t('nightly.hint', {
              defaultValue: '每晚在时窗里、自上次夜训起新进库的可判分任务够数才跑;所有夜训串行,一晚合计上限 ${{cap}};只产出 staging,采纳 / 发布仍要人点;连续 {{n}} 晚无收益自动暂停。',
              cap: meta.nightlyMaxCostUsd.toFixed(2), n: meta.autopauseAfter,
            })}
          </p>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => void save(true)} disabled={busy || !skill.bootstrapped} className="prism-action inline-flex h-7 items-center gap-1 rounded-md border px-2.5 disabled:opacity-50" data-testid={`nightly-save-${skill.name}`}>
              {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
              {enrolled ? t('nightly.saveSettings', { defaultValue: '保存设置' }) : t('nightly.saveEnroll', { defaultValue: '保存并纳入' })}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="h-7 rounded-md px-2 text-muted-foreground hover:bg-muted">{t('card.cancel', { defaultValue: '取消' })}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NightlyModelFields({ draft, onChange }: {
  draft: Draft;
  onChange: (key: 'fast_model' | 'slow_model' | 'eval_model', next: string) => void;
}) {
  const { models, aliasModels } = useModelCatalog();
  return (
    <>
      {(['fast_model', 'slow_model', 'eval_model'] as const).map((key) => (
        <div key={key} className="inline-flex items-center gap-1">{key.split('_')[0]}
          <SkillWhetModelSelect value={draft[key]} onChange={(next) => onChange(key, next)} models={models} aliasModels={aliasModels} allowed={null} ariaLabel={key} variant="chip" className="w-44" />
        </div>
      ))}
    </>
  );
}
