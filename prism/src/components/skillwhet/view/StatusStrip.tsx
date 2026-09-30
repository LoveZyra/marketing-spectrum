import { Check, Minus, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { SkillWhetStatus } from '../hooks/useSkillWhetStatus';

/**
 * gy:体检条 —— `/api/skillwhet/status` 的九项检查。任一 false 直接红 / 灰并**说清缺什么**
 * (em 轮的做法:不让人对着一个红点猜),而不是只画个灯。
 *
 * 分两档:`serveReachable / tokenSet / homeWritable / pythonOk / claudeCli` 缺了就不能用
 * (红);`ruff / bandit / pyright / unshare` 缺了对应的门 SKIP、功能降级(灰)。
 */
export type Tone = 'ok' | 'bad' | 'warn' | 'muted' | 'primary';

export function Badge({ tone = 'muted', children, className = '', wrap = false }: { tone?: Tone; children: React.ReactNode; className?: string; wrap?: boolean }) {
  const tones: Record<Tone, string> = {
    ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    bad: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    muted: 'border-border bg-muted text-muted-foreground',
    primary: 'border-primary/30 bg-primary/10 text-foreground',
  };
  return (
    // hc:wrap = 长句子(体检里的降级说明)窄屏时折行,不被容器截掉
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 font-mono text-[11px] ${wrap ? 'min-h-[22px] max-w-full whitespace-normal break-words py-0.5 leading-4' : 'h-[22px] whitespace-nowrap'} ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}

const HARD = ['serveReachable', 'tokenSet', 'homeWritable', 'pythonOk', 'claudeCli'] as const;
const SOFT = ['ruff', 'bandit', 'pyright', 'unshare'] as const;

export default function StatusStrip({ status, onRecheck }: { status: SkillWhetStatus | null; onRecheck: () => void }) {
  const { t } = useTranslation('skillwhet');
  const checks = status?.checks ?? {};
  const serve = (status?.serve ?? null) as { version?: string; python?: string } | null;

  const labels: Record<string, { ok: string; bad: string }> = {
    serveReachable: {
      ok: status?.target ? t('status.serveOk', { defaultValue: 'serve 就绪 · {{target}}', target: status.target }) : t('status.serveOkPlain', { defaultValue: 'serve 就绪' }),
      bad: t('status.serveBad', { defaultValue: 'serve 不可达 · 看 PRISM_SKILLWHET_TARGET / AUTOSTART 与服务端日志' }),
    },
    tokenSet: { ok: t('status.tokenOk', { defaultValue: '令牌已配' }), bad: t('status.tokenBad', { defaultValue: '未配 PRISM_SKILLWHET_TOKEN(非自启时必填)' }) },
    homeWritable: { ok: t('status.homeOk', { defaultValue: 'HOME 可写' }), bad: status?.home ? t('status.homeBad', { defaultValue: 'HOME 不可写 · {{home}}', home: status.home }) : t('status.homeBadPlain', { defaultValue: 'HOME 不可写(问 root 看 PRISM_SKILLWHET_HOME)' }) },
    pythonOk: { ok: t('status.pythonOk', { defaultValue: 'Python {{version}}', version: serve?.python ?? '' }), bad: t('status.pythonBad', { defaultValue: 'Python 不可用' }) },
    claudeCli: { ok: t('status.claudeOk', { defaultValue: 'claude CLI' }), bad: t('status.claudeBad', { defaultValue: '没有 claude CLI · 慢环(agent runner)不可用' }) },
    ruff: { ok: 'ruff', bad: t('status.ruffBad', { defaultValue: '无 ruff · G2 静态检查 SKIP' }) },
    bandit: { ok: 'bandit', bad: t('status.banditBad', { defaultValue: '无 bandit · G1 少一层' }) },
    pyright: { ok: 'pyright', bad: t('status.pyrightBad', { defaultValue: '无 pyright · G2 类型检查 SKIP' }) },
    unshare: { ok: 'unshare', bad: t('status.unshareBad', { defaultValue: 'unshare 不可用 · 代码执行不再网络隔离,只剩 rlimit' }) },
  };

  const item = (key: string, hard: boolean) => {
    const ok = checks[key] === true;
    const tone: Tone = ok ? 'ok' : hard ? 'bad' : 'warn';
    const Icon = ok ? Check : hard ? X : Minus;
    return (
      <Badge key={key} tone={tone} wrap>
        <Icon className="h-[11px] w-[11px] shrink-0" aria-hidden />
        {ok ? labels[key].ok : labels[key].bad}
      </Badge>
    );
  };

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-panel border border-border bg-card px-3.5 py-2.5" data-testid="skillwhet-status">
      <span className="mr-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('status.title', { defaultValue: '体检' })}</span>
      {status ? (
        <>
          <Badge tone="ok"><Check className="h-[11px] w-[11px]" aria-hidden />{t('status.mounted', { defaultValue: '已挂载' })}</Badge>
          {HARD.map((key) => item(key, true))}
          {SOFT.map((key) => item(key, false))}
          {serve?.version && <span className="font-mono text-[11px] text-muted-foreground">skillwhet {serve.version}</span>}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{t('status.loading', { defaultValue: '正在体检…' })}</span>
      )}
      <span className="flex-1" />
      <button type="button" onClick={onRecheck} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        <RefreshCw className="h-3 w-3" aria-hidden />{t('status.recheck', { defaultValue: '重新体检' })}
      </button>
    </section>
  );
}
