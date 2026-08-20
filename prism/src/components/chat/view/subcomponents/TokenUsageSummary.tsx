import { ActivityIcon } from 'lucide-react';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Context-usage ring (prism): shown when the backend reports exact native
 * context usage (`contextExact`, from the persistent runtime's
 * `getContextUsage()`). 三档改配色(设计语言无告警红):
 * <60% 绿 → ≥60% 弱化灰描边 → ≥80% 前景色描边 + 百分比加粗(auto-compact 区)。
 */
function ContextRing({ ratio }: { ratio: number }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const tone = clamped >= 0.8
    ? 'stroke-foreground'
    : clamped >= 0.6
      ? 'stroke-muted-foreground'
      : 'stroke-primary';

  return (
    <span className="relative grid h-[18px] w-[18px] place-items-center">
      <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] -rotate-90">
        <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" className="stroke-border" />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          className={`${tone} transition-colors duration-500`}
        />
      </svg>
    </span>
  );
}

export default function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;
  const totalTokens = readUsageNumber(usage?.total);
  const contextExact = Boolean(usage?.contextExact) && totalTokens > 0;
  const ratio = contextExact ? usedTokens / totalTokens : 0;

  const title = contextExact
    ? `${usedTokens.toLocaleString()} / ${totalTokens.toLocaleString()} context tokens (${Math.round(ratio * 100)}%)${ratio >= 0.8 ? ' — auto-compact threshold reached' : ''}`
    : `${usedTokens.toLocaleString()} tokens used`;

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-2"
      title={title}
      aria-label="Show token usage"
    >
      {contextExact ? (
        <ContextRing ratio={ratio} />
      ) : (
        <ActivityIcon className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
      )}
      <span className="font-mono font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
      {contextExact ? (
        <span className={`hidden font-mono sm:inline ${ratio >= 0.8 ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
          {Math.round(ratio * 100)}%
        </span>
      ) : (
        <span className="hidden font-mono text-muted-foreground sm:inline">tokens</span>
      )}
    </button>
  );
}
