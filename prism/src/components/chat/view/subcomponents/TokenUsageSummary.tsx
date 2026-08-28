import { ActivityIcon, Archive, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  /** 正在压缩:环切成不确定态,百分比让位 —— 那个数字此刻是压缩前的快照。 */
  isCompacting?: boolean;
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
function ContextRing({ ratio, over }: { ratio: number; over?: boolean }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const tone = over || clamped >= 0.8
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

export default function TokenUsageSummary({ usage, isCompacting = false, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation('chat');
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
  /**
   * 分母是 CLI 的**自动压缩触发线**(autoCompactWindow),不是模型窗口 ——
   * 越过它是正常且预期的状态(越过就是该压了)。所以这里会 >100%,而环一直是
   * 夹住的。数字也得夹,但**不能悄悄夹**:超了就显示 ≥100%,原始值留在悬停里。
   */
  const overThreshold = ratio > 1;
  const percentLabel = overThreshold ? '≥100%' : `${Math.round(ratio * 100)}%`;
  /** 已过线、但 CLI 还在跑工具 —— 压缩被推迟。此前这件事界面上完全不说。 */
  const compactionDeferred = Boolean(usage?.compactionDeferred);

  // 会话累计费用(F4):result 帧带来的 total_cost_usd,挂在悬停提示里 ——
  // 芯片本体寸土寸金,金额进 tooltip,点开 /cost 弹窗看明细。
  const costUsd = readUsageNumber(usage?.costUsd);
  const costSuffix = costUsd > 0
    ? ` · $${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`
    : '';

  const contextTitle = (() => {
    if (!contextExact) return `${usedTokens.toLocaleString()} tokens used`;
    // 分母是什么、现在什么状态,一次说清 —— 排查窗口配置时这一行就是答案。
    const head = `${usedTokens.toLocaleString()} / ${totalTokens.toLocaleString()} (${Math.round(ratio * 100)}%) — 分母是自动压缩触发线,不是模型窗口`;
    if (isCompacting) return `${head}\n正在压缩上下文,这个数字是压缩前的快照`;
    if (compactionDeferred) return `${head}\n已过线,但 CLI 还在跑工具 — 空闲后自动压缩`;
    if (ratio >= 0.8) return `${head}\n已到自动压缩线`;
    return head;
  })();

  const title = contextTitle + costSuffix;

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-2"
      title={title}
      aria-label="Show token usage"
    >
      {isCompacting ? (
        <Archive className="prism-compaction-chip h-4 w-4 flex-none text-primary" strokeWidth={2} />
      ) : compactionDeferred && contextExact ? (
        <Clock className="h-4 w-4 flex-none text-foreground" strokeWidth={2} />
      ) : contextExact ? (
        <ContextRing ratio={ratio} over={overThreshold} />
      ) : (
        <ActivityIcon className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
      )}
      <span className="font-mono font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
      {isCompacting ? (
        // 压缩期间不摆那个数字:它是**触发这次压缩的那个值**,一直显示到压缩
        // 结束才刷新 —— 用户看到的就是"正在压缩"和"104%"同框。
        <span className="hidden font-mono text-muted-foreground sm:inline">
          {t('session.tokens.compacting', { defaultValue: '压缩中' })}
        </span>
      ) : contextExact ? (
        <span className={`hidden font-mono sm:inline ${ratio >= 0.8 ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
          {percentLabel}
        </span>
      ) : (
        <span className="hidden font-mono text-muted-foreground sm:inline">tokens</span>
      )}
    </button>
  );
}
