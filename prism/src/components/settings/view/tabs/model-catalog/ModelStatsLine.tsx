import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';

import {
  failureReasonKey,
  formatFailureRate,
  formatTtft,
  isFailureRateHigh,
  isKnownFailureReason,
  topFailureReasons,
} from './catalogHints';
import type { ModelTurnStats } from './modelCatalogApi';

/**
 * 目录行上的一行健康度:`近 7 天 42 轮 · 失败 5% · 首字 1.2s`。
 *
 * 只给"够不够用"的信号,不做报表:失败率在样本够(≥ 5 轮)且 ≥ 10% 时标琥珀色;
 * 失败原因与首字 p90 放进悬停提示(title),不占行。没有记录就淡淡一行「无记录」,
 * 和"统计没拉到"(整行不画)区分开,否则 root 分不清是没人用还是接口挂了。
 */
export default function ModelStatsLine({ stats, days }: { stats: ModelTurnStats | undefined; days: number }) {
  const { t } = useTranslation('settings');

  if (!stats || stats.turns <= 0) {
    return <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground/60">{t('models.catalog.stats.none', { days })}</div>;
  }

  const high = isFailureRateHigh(stats);
  const p50 = formatTtft(stats.ttftP50Ms);
  const p90 = formatTtft(stats.ttftP90Ms);
  const reasonLabel = (reason: string) => (isKnownFailureReason(reason) ? t(failureReasonKey(reason)) : reason);
  const reasons = topFailureReasons(stats.reasons);

  const titleLines: string[] = [];
  if (reasons.length > 0) {
    titleLines.push(t('models.catalog.stats.reasonsTitle', {
      list: reasons.map((item) => `${reasonLabel(item.reason)} ×${item.count}`).join(' · '),
    }));
  }
  if (p50) {
    titleLines.push(t('models.catalog.stats.ttftTitle', { p50, p90: p90 ?? '—' }));
  }

  return (
    <div
      className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[11px] leading-4 text-muted-foreground"
      title={titleLines.length > 0 ? titleLines.join('\n') : undefined}
    >
      <Activity className="h-3 w-3 shrink-0" />
      <span>{t('models.catalog.stats.turns', { days, turns: stats.turns })}</span>
      <span aria-hidden>·</span>
      <span className={high ? 'font-medium text-amber-700 dark:text-amber-400' : undefined}>
        {t('models.catalog.stats.failRate', { rate: formatFailureRate(stats.errorRate, stats.errors) })}
      </span>
      {p50 && (
        <>
          <span aria-hidden>·</span>
          <span>{t('models.catalog.stats.ttft', { value: p50 })}</span>
        </>
      )}
    </div>
  );
}
