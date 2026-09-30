import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { unwrap, type ManagedSkill, type StagingSummary } from '../lib/types';
import { stagingTone } from '../lib/staging-state';
import type { SkillWhetData } from '../SkillWhetPage';

import { GateGrid } from './SkillCard';
import { Badge } from './StatusStrip';

/**
 * gz:评测 —— 每个 skill 一行:六门体检(缓存的最近一次)+ 最近一份 staging 的
 * val / test 通过率(S₀ → 最佳)+ 轮数与停止原因。数字全部来自 staging 的 report,
 * 没跑过训练的 skill 只有六门那一格;不画反事实 / 变异检查(该后端没有)。
 */
const fmtScore = (v: number | null | undefined): string => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—');

type Row = { skill: ManagedSkill; latest: StagingSummary | null; count: number };

export default function Evaluation({ data, onOpenVersions }: { data: SkillWhetData; onOpenVersions: (skill: string, stagingId: string | null) => void }) {
  const { t } = useTranslation('skillwhet');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const skills = useMemo(() => data.skills?.skills ?? [], [data.skills]);

  const load = useCallback(async (list: ManagedSkill[]) => {
    setLoading(true);
    const next = await Promise.all(list.map(async (skill) => {
      try {
        const res = await unwrap<{ staging: StagingSummary[] }>(await api.skillWhet.staging(skill.name));
        const staging = Array.isArray(res.staging) ? res.staging : [];
        return { skill, latest: staging[0] ?? null, count: staging.length };
      } catch {
        return { skill, latest: null, count: 0 };
      }
    }));
    setRows(next);
    setLoading(false);
  }, []);

  useEffect(() => { void load(skills); }, [load, skills]);

  const labelOf = (s: StagingSummary): string => {
    switch (stagingTone(s).key) {
      case 'adopted': return t('versions.state.adopted', { defaultValue: '已采纳' });
      case 'improved': return t('versions.state.improved', { defaultValue: '待审阅' });
      case 'stopped': return t('versions.state.stopped', { defaultValue: '提前停止' });
      default: return t('versions.state.unchanged', { defaultValue: '无变化' });
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="skillwhet-eval">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-foreground">{t('eval.title', { defaultValue: '评测' })}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('eval.subtitle', { defaultValue: '六门体检 + 最近一次训练的验证集 / 留出集通过率(S₀ → 最佳)。test 只看不选,防过拟合。' })}</p>
        </div>
        <button type="button" onClick={() => void load(skills)} disabled={loading} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:border-border-strong disabled:opacity-50">
          {loading ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}{t('runs.refresh', { defaultValue: '刷新' })}
        </button>
      </div>

      {skills.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-panel border border-dashed border-border px-6 py-14 text-center">
          <span className="grid h-10 w-10 place-items-center rounded-md bg-muted text-muted-foreground"><FlaskConical className="h-5 w-5" aria-hidden /></span>
          <p className="max-w-[520px] text-[13px] leading-5 text-muted-foreground">{t('eval.empty', { defaultValue: '还没有受管 skill。先在「技能资产」导入或上传。' })}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 max-xl:grid-cols-1">
          {rows.map(({ skill, latest, count }) => (
            <article key={skill.name} className="flex flex-col gap-3 rounded-panel border border-border bg-card p-4" data-testid={`eval-${skill.name}`}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[15px] font-medium text-foreground">{skill.name}</span>
                <span className="flex-1" />
                {latest ? <Badge tone={stagingTone(latest).tone}>{labelOf(latest)}</Badge> : <Badge tone="muted">{t('eval.noRun', { defaultValue: '未训练' })}</Badge>}
              </div>
              <GateGrid gate={skill.last_gate} />
              {latest ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">{t('eval.val', { defaultValue: '验证集 val' })}</dt>
                  <dd className="font-mono text-body">{fmtScore(latest.baseline_score)} → <strong className={latest.improved ? 'text-emerald-700 dark:text-emerald-300' : ''}>{fmtScore(latest.candidate_score)}</strong></dd>
                  <dt className="text-muted-foreground">{t('eval.test', { defaultValue: '留出集 test' })}</dt>
                  <dd className="font-mono text-body">{latest.release
                    ? <>{fmtScore(latest.test_score_baseline)} → {fmtScore(latest.test_score_best)}</>
                    : <span className="text-muted-foreground">{t('eval.testPending', { defaultValue: '未评(release-once:到版本页对这份 staging 评一次)' })}</span>}</dd>
                  <dt className="text-muted-foreground">{t('eval.rounds', { defaultValue: '轮次 / 停止' })}</dt>
                  <dd className="font-mono text-body">{latest.rounds} · {latest.stop_reason ?? '—'}{typeof latest.total_cost_usd === 'number' ? ` · $${latest.total_cost_usd.toFixed(2)}` : ''}</dd>
                  <dt className="text-muted-foreground">staging</dt>
                  <dd className="font-mono text-body">
                    <button type="button" onClick={() => onOpenVersions(skill.name, latest.id)} className="text-primary hover:underline">{latest.id}</button>
                    <span className="ml-1.5 text-muted-foreground">{t('eval.stagingCount', { defaultValue: '共 {{n}} 份', n: count })}</span>
                  </dd>
                </dl>
              ) : (
                <p className="text-xs text-muted-foreground">{t('eval.noRunHint', { defaultValue: '这个 skill 还没跑过训练;评测数字随第一次训练产生。' })}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
