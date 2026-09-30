import { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, BookOpen, Check, ChevronDown, ChevronRight, Code, FlaskConical, GitBranch, Loader2, Search, Shield, Sparkles, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { currentActivity, groupEvents, type StepGroup } from '../lib/process-events';
import type { ProgressEvent } from '../lib/types';

/**
 * hd:优化过程 —— 把训练里"此刻在做什么"画出来,而不是只写"训练中"。
 *
 * SkillWhet 0.4.2 起训练会发细粒度事件:`step` / `step_end`(每一步的起止、耗时、累计调用与费用)、
 * `task`(每条任务跑完:过没过、没过的原因)、`proposing` / `proposals`(向模型要修改方案、拿到几个)、
 * `candidate`(每个候选过门的结果)、`selected`(最后采用哪个、理由)。这里把一个 step 和它里面的
 * 任务 / 候选收成一行,可展开;汇总事件(基线、归因、G7、轮结束…)照旧一行一条。
 * 0.4.1 及以前的作业没有这些事件,画出来和原来一样。
 */

type Line = { icon: typeof Check; tone: string; main: string; sub: string };
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const fmtTs = (iso: unknown): string => (typeof iso === 'string' ? new Date(iso).toLocaleTimeString() : '');
const shortTask = (id: unknown) => String(id ?? '').split('::').pop() ?? '';
const fmtSecs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(s < 10 ? 1 : 0)}s`);

function useStepLabel() {
  const { t } = useTranslation('skillwhet');
  return (e: ProgressEvent): Line => {
    const r = typeof e.round === 'number' ? t('proc.roundTag', { defaultValue: '第 {{r}} 轮 · ', r: e.round }) : '';
    const n = num(e.n);
    switch (String(e.step)) {
      case 'baseline': return { icon: FlaskConical, tone: '', main: t('proc.baseline', { defaultValue: '测 S₀ 基线(val)' }), sub: t('proc.nTasks', { defaultValue: '{{n}} 条任务', n }) };
      case 'rollout': {
        const why = String(e.why ?? '');
        const main = why === 'measure' ? t('proc.rolloutMeasure', { defaultValue: '{{r}}跑训练任务,看当前版本哪些不过', r })
          : why === 'after_fix' ? t('proc.rolloutAfterFix', { defaultValue: '{{r}}采用修改后重跑训练任务', r })
            : why === 'full_check' ? t('proc.rolloutFull', { defaultValue: '{{r}}整轮复查训练任务(防回归)', r })
              : why === 'g7' ? t('proc.rolloutG7', { defaultValue: '{{r}}G7 留出门:在 val 上评改完的版本', r })
                : why === 'before_doc' ? t('proc.rolloutBeforeDoc', { defaultValue: '{{r}}改文档前先在 val 上量一次', r })
                  : why === 'after_doc' ? t('proc.rolloutAfterDoc', { defaultValue: '{{r}}改文档后在 val 上再量一次', r })
                    : String(e.split) === 'test' ? t('proc.rolloutTest', { defaultValue: '跑 test({{w}})', w: why })
                      : t('proc.rollout', { defaultValue: '{{r}}跑任务', r });
        return { icon: FlaskConical, tone: '', main, sub: t('proc.nTasksSplit', { defaultValue: '{{n}} 条 {{s}} 任务', n, s: String(e.split ?? '') }) };
      }
      case 'attribution': return { icon: Search, tone: '', main: t('proc.attribution', { defaultValue: '{{r}}归因:分析失败是代码问题、文档问题还是能力缺口', r }), sub: t('proc.failures', { defaultValue: '{{n}} 条失败', n: num(e.failures) }) };
      case 'counterfactual': return { icon: Search, tone: '', main: t('proc.counterfactual', { defaultValue: '{{r}}反事实:逐节去掉文档试跑,找有害段落', r }), sub: '' };
      case 'synthesis': return { icon: Sparkles, tone: '', main: t('proc.synthesis', { defaultValue: '{{r}}合成相邻任务', r }), sub: '' };
      case 'evolve_tests': return { icon: Code, tone: '', main: t('proc.evolveTests', { defaultValue: '{{r}}补测试(代码冻结)', r }), sub: t('proc.targets', { defaultValue: '{{n}} 个目标', n: num(e.targets) }) };
      case 'fast_loop': return { icon: Code, tone: '', main: `${t('proc.fastLoop', { defaultValue: '{{r}}快环:让模型提代码修改,逐个过 G0–G6', r })}${num(e.iter) > 1 ? t('proc.iter', { defaultValue: '(第 {{i}} 次)', i: num(e.iter) }) : ''}`, sub: t('proc.codeDefects', { defaultValue: '{{n}} 个代码缺陷', n: num(e.code_defects) }) };
      case 'slow_loop': return { icon: BookOpen, tone: '', main: t('proc.slowLoop', { defaultValue: '{{r}}慢环:让模型改 SKILL.md / references', r }), sub: t('proc.docDefects', { defaultValue: '{{n}} 个文档缺陷', n: num(e.doc_defects) }) };
      case 'governance': return { icon: Shield, tone: '', main: t('proc.governance', { defaultValue: '{{r}}G8 治理:台账、膨胀、泄漏检查', r }), sub: '' };
      case 'pairwise': return { icon: Shield, tone: '', main: t('proc.pairwise', { defaultValue: '{{r}}成对评判:新旧答案逐条比', r }), sub: '' };
      case 'slow_update': return { icon: BookOpen, tone: '', main: t('proc.slowUpdate', { defaultValue: '{{r}}轮间总结:对比上一版,写经验', r }), sub: '' };
      case 'retire_guidance': return { icon: BookOpen, tone: '', main: t('proc.retire', { defaultValue: '{{r}}清理不再需要的指引', r }), sub: '' };
      case 'staging': return { icon: GitBranch, tone: '', main: t('proc.staging', { defaultValue: '把最好的版本写进 staging' }), sub: '' };
      default: return { icon: Activity, tone: '', main: String(e.step ?? e.kind), sub: '' };
    }
  };
}

function useNoteLine() {
  const { t } = useTranslation('skillwhet');
  return (e: ProgressEvent): { ok: boolean | null; text: string } => {
    switch (e.kind) {
      case 'proposing': return { ok: null, text: t('proc.proposing', { defaultValue: '向模型要修改方案:{{d}} 个缺陷,每个要 {{k}} 个', d: num(e.code_defects), k: num(e.k) }) };
      case 'proposing_doc': return { ok: null, text: t('proc.proposingDoc', { defaultValue: '向模型要文档修改:{{d}} 个文档缺陷', d: num(e.doc_defects) }) };
      case 'proposals': {
        const by = (e.by_origin ?? {}) as Record<string, number>;
        return { ok: null, text: t('proc.proposals', { defaultValue: '拿到 {{n}} 个候选{{by}}', n: num(e.n), by: Object.keys(by).length ? `(${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')})` : '' }) };
      }
      case 'candidate': return {
        ok: Boolean(e.viable),
        text: `${t('proc.candidate', { defaultValue: '候选 {{i}}/{{n}}', i: num(e.i), n: num(e.n) })} · ${String(e.origin ?? '')} · ${String(e.what ?? '')}${e.viable
          ? ` · ${t('proc.viable', { defaultValue: '过门' })}`
          : ` · ${t('proc.rejectedAt', { defaultValue: '死在 {{g}}', g: String(e.stage ?? '') })}${e.reason ? `(${String(e.reason)})` : ''}`}${num(e.refined) ? ` · ${t('proc.refined', { defaultValue: '修补 {{n}} 次', n: num(e.refined) })}` : ''}`,
      };
      case 'selected': return { ok: true, text: `${t('proc.selected', { defaultValue: '采用' })} ${String(e.origin ?? '')} · ${String(e.what ?? '')}${num(e.among) > 1 ? ` · ${t('proc.among', { defaultValue: '{{n}} 个可行里排第一', n: num(e.among) })}` : ''}${e.rationale ? ` —— ${String(e.rationale)}` : ''}` };
      case 'step': return { ok: null, text: `${t('proc.nested', { defaultValue: '回放' })} · ${String(e.step ?? '')}` };
      default: return { ok: null, text: e.kind };
    }
  };
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export default function ProcessTimeline({ events, live, renderEvent }: {
  events: ProgressEvent[];
  live: boolean;
  renderEvent: (e: ProgressEvent) => Line;
}) {
  const { t } = useTranslation('skillwhet');
  const stepLabel = useStepLabel();
  const noteLine = useNoteLine();
  const items = useMemo(() => groupEvents(events), [events]);
  const current = useMemo(() => (live ? currentActivity(events) : null), [events, live]);
  const now = useNow(Boolean(current));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const nestedLine = (c: StepGroup): { ok: boolean | null; text: string } => {
    const p = c.tasks.filter((x) => x.passed).length;
    const tally = c.tasks.length ? ` · ${t('proc.tally', { defaultValue: '{{p}} 过 · {{f}} 不过', p, f: c.tasks.length - p })}` : '';
    return { ok: null, text: `${stepLabel(c.start).main}${tally}${c.end ? ` · ${fmtSecs(num(c.end.secs))}` : ''}` };
  };
  const usage = useMemo(() => {
    const ends = events.filter((e) => e.kind === 'step_end' && typeof e.llm_calls === 'number');
    const last = ends[ends.length - 1];
    return last ? { calls: num(last.llm_calls), cost: num(last.cost_usd) } : null;
  }, [events]);

  return (
    <div className="flex flex-col gap-3">
      {current && (() => {
        const line = stepLabel(current.step);
        const started = Date.parse(String(current.step.ts));
        const secs = Number.isFinite(started) ? Math.max(0, (now - started) / 1000) : 0;
        const n = num(current.step.n);
        const last = current.last;
        const lastText = last
          ? last.kind === 'task'
            ? `${last.passed ? '✓' : '✗'} ${shortTask(last.task)}${!last.passed && last.why ? ` —— ${String(last.why)}` : ''}`
            : noteLine(last).text
          : '';
        return (
          <div className="flex flex-col gap-1.5 rounded-panel border border-primary/30 bg-primary/5 px-4 py-3" data-testid="current-activity">
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
              <span className="font-medium">{t('proc.now', { defaultValue: '正在:' })}{current.parent ? `${stepLabel(current.parent).main} › ` : ''}{line.main}</span>
              <span className="flex-1" />
              <span className="font-mono text-[11px] text-muted-foreground">{fmtSecs(secs)}</span>
            </div>
            {n > 0 && (
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.min(100, (current.done / n) * 100)}%` }} />
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">{current.done}/{n}</span>
              </div>
            )}
            {lastText && <div className="truncate text-xs text-muted-foreground" title={lastText}>{t('proc.latest', { defaultValue: '最新:' })}{lastText}</div>}
            {usage && <div className="text-[11px] text-muted-foreground">{t('proc.usage', { defaultValue: '到目前:{{c}} 次模型调用 · ${{cost}}', c: usage.calls, cost: usage.cost.toFixed(4) })}</div>}
          </div>
        );
      })()}

      <section className="rounded-panel border border-border bg-card px-4 py-1">
        {items.map((item) => {
          if (item.kind === 'event') {
            const line = renderEvent(item.e);
            const Icon = line.icon;
            return (
              <div key={item.key} className="flex items-start gap-3 border-b border-border py-2 last:border-b-0">
                <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-muted ${line.tone}`}><Icon className="h-3 w-3" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-foreground">{line.main}</div>
                  {line.sub && <div className="text-xs text-muted-foreground">{line.sub}</div>}
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtTs(item.e.ts)}</span>
              </div>
            );
          }
          const line = stepLabel(item.start);
          const Icon = line.icon;
          const running = item.end === null && live;
          const passed = item.tasks.filter((x) => x.passed).length;
          const failed = item.tasks.length - passed;
          const cands = item.notes.filter((x) => x.kind === 'candidate');
          const summary = [
            line.sub,
            item.tasks.length
              ? (['rollout', 'baseline'].includes(String(item.start.step))
                ? t('proc.tally', { defaultValue: '{{p}} 过 · {{f}} 不过', p: passed, f: failed })
                : t('proc.replayTally', { defaultValue: '候选回放 {{p}} 过 · {{f}} 不过', p: passed, f: failed }))
              : '',
            cands.length ? t('proc.candTally', { defaultValue: '候选 {{v}}/{{n}} 过门', v: cands.filter((c) => c.viable).length, n: cands.length }) : '',
            item.end ? fmtSecs(num(item.end.secs)) : '',
            item.end && typeof item.end.llm_calls === 'number' ? t('proc.cumUsage', { defaultValue: '累计 {{c}} 次调用 · ${{cost}}', c: num(item.end.llm_calls), cost: num(item.end.cost_usd).toFixed(4) }) : '',
          ].filter(Boolean).join(' · ');
          const expandable = item.tasks.length + item.notes.length > 0;
          const isOpen = open[item.key] ?? (running || cands.length > 0 && cands.length <= 6);
          return (
            <div key={item.key} className="border-b border-border py-2 last:border-b-0" data-testid="process-step">
              <button type="button" disabled={!expandable} onClick={() => setOpen((prev) => ({ ...prev, [item.key]: !isOpen }))} className="flex w-full items-start gap-3 text-left disabled:cursor-default">
                <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md ${running ? 'bg-primary/10 text-primary' : 'bg-muted'}`}>
                  {running ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Icon className="h-3 w-3" aria-hidden />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 text-[13px] text-foreground">
                    {line.main}
                    {expandable && (isOpen ? <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden /> : <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden />)}
                  </div>
                  {summary && <div className="text-xs text-muted-foreground">{summary}</div>}
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtTs(item.start.ts)}</span>
              </button>
              {isOpen && expandable && (
                <ul className="ml-8 mt-1.5 flex flex-col gap-0.5 border-l border-border pl-3 text-[11.5px]">
                  {item.notes.map((x) => {
                    const child = x.kind === 'step' ? item.children.find((c) => c.start.seq === x.seq) : undefined;
                    const nl = child ? nestedLine(child) : noteLine(x);
                    return (
                      <li key={`n${x.seq}`} className="flex items-start gap-1.5">
                        {nl.ok === null ? <Activity className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                          : nl.ok ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" aria-hidden /> : <X className="mt-0.5 h-3 w-3 shrink-0 text-red-600" aria-hidden />}
                        <span className="text-body">{nl.text}</span>
                      </li>
                    );
                  })}
                  {item.tasks.length > 0 && (
                    <li className="flex flex-wrap gap-1 pt-0.5">
                      {item.tasks.map((x) => (
                        <span key={`t${x.seq}`} title={`${String(x.task ?? '')}${!x.passed && x.why ? `\n${String(x.why)}` : ''}`}
                          className={`inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10.5px] ${x.passed ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300' : x.noise ? 'border-border bg-muted text-muted-foreground' : 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300'}`}>
                          {x.passed ? '✓' : x.noise ? '~' : '✗'} <span className="truncate">{shortTask(x.task)}</span>
                        </span>
                      ))}
                    </li>
                  )}
                  {item.tasks.some((x) => !x.passed && x.why) && (
                    <li className="pt-0.5 text-muted-foreground">
                      {item.tasks.filter((x) => !x.passed && x.why).slice(0, 5).map((x) => (
                        <div key={`w${x.seq}`} className="truncate" title={String(x.why)}>✗ {shortTask(x.task)}:{String(x.why)}</div>
                      ))}
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
        {live && !current && <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />{t('detail.running', { defaultValue: '进行中 · 3 秒一刷' })}</div>}
        {items.length === 0 && <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><AlertTriangle className="h-3 w-3" aria-hidden />{t('detail.noEvents', { defaultValue: '还没有事件' })}</div>}
      </section>
    </div>
  );
}
