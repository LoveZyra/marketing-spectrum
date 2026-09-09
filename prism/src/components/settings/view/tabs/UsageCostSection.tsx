import { useCallback, useEffect, useState } from 'react';
import { Coins, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';

/**
 * 用量与费用。
 *
 * ## 这不是 `/cost` 弹窗里那个数
 *
 * 弹窗里那个是**当前上下文占用**(读 transcript 最后一条 assistant 消息的 usage),
 * 用来判断"还能再聊几轮"。这里是**累计花销**,来自 `usage_records` 台账,
 * 一轮一行逐条累加。两个数天然不一样,差可以是一个数量级。
 *
 * ## 为什么按"维度"切而不是画个大图
 *
 * 用这张表的人只有四个问题:这个月花了多少、谁花的、哪个项目花的、哪个模型花的。
 * 一个下拉切维度、一张排序好的表,四个问题都答得了;而一张堆叠面积图一个都答不利索。
 */

type SummaryRow = {
  key: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
};

type SummaryResponse = {
  by?: string;
  days?: number;
  rows?: SummaryRow[];
  scoped?: boolean;
  error?: string;
};

const DIMENSIONS = [
  { key: 'day', labelZh: '按日期' },
  { key: 'username', labelZh: '按用户' },
  { key: 'project_path', labelZh: '按项目' },
  { key: 'model', labelZh: '按模型' },
  { key: 'source', labelZh: '按来源' },
] as const;

const RANGES = [7, 30, 90] as const;

/** 来源标签。`compact` 是自动压缩 —— 单列出来正是为了让它可见。 */
const SOURCE_LABEL: Record<string, string> = {
  chat: '对话',
  compact: '自动压缩',
  task: '定时任务',
  api: '外部接口',
};

const formatTokens = (value: number): string => {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

/**
 * 费用一律四位小数。
 *
 * 两位不够:单轮对话常常是 $0.0031,显示成 $0.00 会让整张表看起来"没花钱",
 * 而那正是这个功能要回答的问题。
 */
const formatUsd = (value: number): string => `$${(Number(value) || 0).toFixed(4)}`;

export default function UsageCostSection() {
  const { t } = useTranslation('settings');
  const [by, setBy] = useState<string>('day');
  const [days, setDays] = useState<number>(30);
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [scoped, setScoped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (dimension: string, range: number) => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/usage/summary?by=${dimension}&days=${range}`);
      const payload = (await response.json()) as SummaryResponse;
      if (!response.ok) throw new Error(payload.error || 'Failed to load usage');
      setRows(payload.rows ?? []);
      setScoped(payload.scoped === true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(by, days); }, [load, by, days]);

  const totalCost = rows.reduce((sum, row) => sum + (Number(row.cost_usd) || 0), 0);
  const totalRuns = rows.reduce((sum, row) => sum + (Number(row.runs) || 0), 0);

  const renderKey = (row: SummaryRow): string => {
    if (by === 'source') return SOURCE_LABEL[row.key] ?? row.key;
    // 项目路径按最后一段显示,完整路径进 title —— 一屏放不下绝对路径,
    // 但去掉它又分不清同名目录。
    if (by === 'project_path' && row.key.includes('/')) return row.key.split('/').filter(Boolean).pop() ?? row.key;
    return row.key;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Coins className="h-4 w-4 text-muted-foreground" />
          {t('usage.title', '用量与费用')}
          <span className="text-xs font-normal text-muted-foreground">
            {t('usage.totalLine', {
              cost: formatUsd(totalCost),
              runs: totalRuns,
              defaultValue: `${formatUsd(totalCost)} · ${totalRuns} 轮`,
            })}
          </span>
        </h3>
        <button
          type="button"
          onClick={() => void load(by, days)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-body transition-colors hover:border-border-strong hover:bg-card hover:text-foreground"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'text-primary' : ''}`} />
          {t('usage.refresh', '刷新')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={by}
          onChange={(event) => setBy(event.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-body focus:border-border-strong focus:outline-none"
        >
          {DIMENSIONS.map((dimension) => (
            <option key={dimension.key} value={dimension.key}>
              {t(`usage.by.${dimension.key}`, dimension.labelZh)}
            </option>
          ))}
        </select>
        <select
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-body focus:border-border-strong focus:outline-none"
        >
          {RANGES.map((range) => (
            <option key={range} value={range}>
              {t('usage.lastDays', { count: range, defaultValue: `最近 ${range} 天` })}
            </option>
          ))}
        </select>
        {scoped && (
          // 非 root 看到的是自己的账。不说清楚的话,他会把这个数当成团队总额。
          <span className="text-xs text-muted-foreground">
            {t('usage.scopedHint', '只统计你自己的用量')}
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">{error}</p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-card text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('usage.columns.key', '维度')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('usage.columns.runs', '轮次')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('usage.columns.input', '输入')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('usage.columns.output', '输出')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('usage.columns.cost', '费用')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {loading
                    ? t('usage.loading', '加载中…')
                    : t('usage.empty', '这段时间还没有用量记录。跑一轮对话之后就会出现。')}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border">
                <td className="max-w-[220px] truncate px-3 py-1.5 text-xs font-medium" title={row.key}>
                  {renderKey(row)}
                </td>
                <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">{row.runs}</td>
                <td className="px-3 py-1.5 text-right font-mono text-[11px] text-muted-foreground">
                  {formatTokens(row.input_tokens)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[11px] text-muted-foreground">
                  {formatTokens(row.output_tokens)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-[11px] font-medium">
                  {formatUsd(row.cost_usd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('usage.footnote',
          '费用取自模型返回的计费值,按轮记账。与对话页 /cost 里的数字不是一回事 —— 那个是当前上下文占用,这里是累计花销。')}
      </p>
    </div>
  );
}
