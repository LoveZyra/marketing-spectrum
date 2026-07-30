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
 * `getContextUsage()`). Green → amber (≥60%) → red (≥80%, auto-compact zone).
 */
function ContextRing({ ratio }: { ratio: number }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const tone = clamped >= 0.8
    ? 'text-red-500'
    : clamped >= 0.6
      ? 'text-amber-500'
      : 'text-primary';

  return (
    <span className="relative grid h-5 w-5 place-items-center">
      <svg viewBox="0 0 20 20" className="h-5 w-5 -rotate-90">
        <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" className="stroke-border/60" />
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          className={`${tone} stroke-current transition-all duration-500`}
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
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={title}
      aria-label="Show token usage"
    >
      {contextExact ? (
        <ContextRing ratio={ratio} />
      ) : (
        <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
          <ActivityIcon className="h-3.5 w-3.5" />
        </span>
      )}
      <span className="font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
      {contextExact ? (
        <span className={`hidden sm:inline ${ratio >= 0.8 ? 'font-medium text-red-500' : 'text-muted-foreground/70'}`}>
          {Math.round(ratio * 100)}%
        </span>
      ) : (
        <span className="hidden text-muted-foreground/70 sm:inline">tokens</span>
      )}
    </button>
  );
}
