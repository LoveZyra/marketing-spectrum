import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { unwrap, type WikiPattern, type WikiResponse, type WikiStatus } from '../lib/types';
import type { SkillWhetData } from '../SkillWhetPage';

import { Badge, type Tone } from './StatusStrip';

/**
 * gy:经验 Wiki(只读)—— 每个副本 `.evo/wiki/` 里的 patterns 与 logs。
 * 第一期没有训练,这里多半是空的;bootstrap 之后才会有内容。写入是训练的事,不在页面上编辑。
 */
const STATUS_TONE: Record<WikiStatus, Tone> = { supported: 'ok', hypothesis: 'muted', disputed: 'warn', retired: 'muted' };
const STATUS_ORDER: WikiStatus[] = ['supported', 'hypothesis', 'disputed', 'retired'];

function useStatusLabel() {
  const { t } = useTranslation('skillwhet');
  return (s: WikiStatus): string => {
    switch (s) {
      case 'supported': return t('wiki.status.supported', { defaultValue: '已证实' });
      case 'disputed': return t('wiki.status.disputed', { defaultValue: '有争议' });
      case 'retired': return t('wiki.status.retired', { defaultValue: '已退休' });
      default: return t('wiki.status.hypothesis', { defaultValue: '假设' });
    }
  };
}

/**
 * he:每条经验一张卡 —— 状态(假设 / 已证实 / 有争议 / 已退休)、范围、反例、修订号。
 * 已退休的默认不显示(它们也不再进提议模型的提示)。0.4.x 的 serve 不回 index,退回原来的纯文本卡。
 */
function PatternCard({ p }: { p: WikiPattern }) {
  const { t } = useTranslation('skillwhet');
  const statusLabel = useStatusLabel();
  return (
    <article className={`flex flex-col gap-1.5 rounded-panel border border-border bg-card p-3 ${p.status === 'retired' ? 'opacity-60' : ''}`} data-testid={`wiki-pattern-${p.id}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={STATUS_TONE[p.status] ?? 'muted'}>{statusLabel(p.status)}</Badge>
        <span className="text-[13px] font-medium text-foreground">{p.title}</span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-muted-foreground">{p.kind} · {t('wiki.seen', { defaultValue: '见过 {{n}} 次', n: p.observations })} · rev {p.revision}</span>
      </div>
      {p.scope.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {p.scope.slice(0, 8).map((sc) => <span key={sc} className="rounded border border-border bg-background px-1.5 font-mono text-[10.5px] text-body">{sc}</span>)}
        </div>
      )}
      {p.workaround && <p className="whitespace-pre-wrap text-xs text-body">{p.workaround}</p>}
      {p.counterexamples.length > 0 && (
        <ul className="flex flex-col gap-0.5 border-l-2 border-amber-500/40 pl-2 text-[11.5px] text-muted-foreground">
          <li className="font-medium text-amber-700 dark:text-amber-300">{t('wiki.counterexamples', { defaultValue: '反例 {{n}}', n: p.counterexamples.length })}</li>
          {p.counterexamples.slice(-3).map((c) => <li key={c}>{c}</li>)}
        </ul>
      )}
    </article>
  );
}

export default function Wiki({ data }: { data: SkillWhetData }) {
  const { t } = useTranslation('skillwhet');
  const skills = useMemo(() => data.skills?.skills ?? [], [data.skills]);
  const [skill, setSkill] = useState('');
  const [wiki, setWiki] = useState<WikiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<WikiStatus | 'active'>('active');
  const statusLabel = useStatusLabel();

  useEffect(() => {
    if (!skill && skills.length > 0) setSkill(skills[0].name);
  }, [skill, skills]);

  useEffect(() => {
    if (!skill) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const result = await unwrap<WikiResponse>(await api.skillWhet.wiki(skill));
        if (!cancelled) setWiki(result);
      } catch (caught) {
        if (!cancelled) { setWiki(null); setError(caught instanceof Error ? caught.message : String(caught)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [skill]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-foreground">{t('wiki.title', { defaultValue: '经验 Wiki' })}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('wiki.subtitle', { defaultValue: '训练沉淀下来的模式与日志,按技能看;只读 —— 写入是训练的事。' })}</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          skill
          <select value={skill} onChange={(event) => setSkill(event.target.value)} className="h-7 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground" aria-label="skill">
            {skills.length === 0 && <option value="">{t('wiki.noSkills', { defaultValue: '(还没有副本)' })}</option>}
            {skills.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
        </label>
      </div>

      {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('wiki.loading', { defaultValue: '读取中…' })}</div>}
      {error && <div className="rounded-panel border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>}

      {wiki && !loading && (
        wiki.patterns.length === 0 && !wiki.logs ? (
          <div className="flex flex-col items-center gap-2 rounded-panel border border-dashed border-border px-6 py-12 text-center text-[13px] text-muted-foreground">
            <BookOpen className="h-5 w-5" aria-hidden />
            {t('wiki.empty', { defaultValue: '这个技能还没有沉淀 —— 第一次训练之后这里会出现模式卡与日志。' })}
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 max-lg:grid-cols-1">
            <section className="flex flex-col gap-2">
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('wiki.patterns', { defaultValue: '模式' })} · {wiki.patterns.length}</h2>
              {wiki.index && wiki.index.length > 0 ? (() => {
                const index = wiki.index;
                const count = (s: WikiStatus) => index.filter((p) => p.status === s).length;
                const shown = index
                  .filter((p) => (filter === 'active' ? p.status !== 'retired' : p.status === filter))
                  .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.observations - a.observations);
                const chip = (id: WikiStatus | 'active', label: string, n: number) => (
                  <button key={id} type="button" onClick={() => setFilter(id)} className={`h-6 rounded-md border px-2 text-[11px] ${filter === id ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                    {label} <span className="font-mono">{n}</span>
                  </button>
                );
                return (
                  <>
                    <div className="flex flex-wrap gap-1" data-testid="wiki-filter">
                      {chip('active', t('wiki.active', { defaultValue: '在用' }), index.length - count('retired'))}
                      {STATUS_ORDER.map((s) => chip(s, statusLabel(s), count(s)))}
                    </div>
                    {shown.length === 0
                      ? <p className="text-xs text-muted-foreground">{t('wiki.noneInFilter', { defaultValue: '这一类没有' })}</p>
                      : shown.map((p) => <PatternCard key={p.id} p={p} />)}
                  </>
                );
              })() : wiki.patterns.map((pattern) => (
                <article key={pattern.id} className="rounded-panel border border-border bg-card p-3">
                  <div className="font-mono text-xs text-muted-foreground">{pattern.id}</div>
                  <pre className="mt-1 whitespace-pre-wrap font-sans text-[13px] leading-5 text-body">{pattern.text}</pre>
                </article>
              ))}
            </section>
            <section className="flex flex-col gap-2">
              <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('wiki.logs', { defaultValue: '日志' })}</h2>
              <pre className="whitespace-pre-wrap rounded-panel border border-border bg-card p-3 font-mono text-[12px] leading-5 text-body">{wiki.logs || '—'}</pre>
            </section>
          </div>
        )
      )}
    </div>
  );
}
