/**
 * 设置 → 模型目录每一行上的提示。纯函数,单测在 catalogHints.test.ts(客户端测试跑 node 环境,挂不起组件)。
 *
 * 两类:
 * 1. 没填窗口的新 Claude 模型:CLI 走自定义网关(ANTHROPIC_BASE_URL)时,认这几族名字就按 1M 窗口算
 *    (压缩线 967000)。目录里不填窗口而网关真实上限到不了 1M,请求会在压缩之前就被网关拒掉,
 *    所以要在目录行上提醒 root 填真实上限;
 * 2. 近 N 天健康度:回合数 / 失败率 / 首字延迟的格式化与"失败率偏高"的判定。
 */

/** CLI 按 1M 窗口算的那几族:claude-sonnet-5*、claude-opus-4-7 及更新的 opus、claude-fable-*。 */
export const ONE_MILLION_WINDOW_MODEL = /^claude-(sonnet-5|opus-(4-[7-9]|[5-9])|fable)/i;

/** CLI 会不会把这个模型名当成 1M 窗口。 */
export function cliAssumesOneMillionWindow(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && ONE_MILLION_WINDOW_MODEL.test(modelId.trim());
}

/** 目录条目的窗口算不算"没填"(null / 0 / 非数字都算 —— 服务端存的是 null,这里多兜一层)。 */
export function isContextWindowMissing(contextWindow: number | null | undefined): boolean {
  return typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0;
}

/** 目录行要不要挂「未填窗口」的琥珀色提醒。 */
export function needsContextWindowWarning(entry: { modelId: string; contextWindow: number | null | undefined }): boolean {
  return cliAssumesOneMillionWindow(entry.modelId) && isContextWindowMissing(entry.contextWindow);
}

/* ------------------------------ 健康度 ------------------------------ */

/** 设置页看最近几天(服务端默认也是 7)。 */
export const STATS_DAYS = 7;

/**
 * 服务端会记下的回合失败原因(`terminal_reason`)。这里列出的才去查翻译;
 * 列表外的原样显示 —— 服务端将来多一种原因,界面上至少还能看到它叫什么。
 */
export const KNOWN_FAILURE_REASONS = [
  'prompt_too_long',
  'rapid_refill_breaker',
  'api_error',
  'malformed_tool_use_exhausted',
  'model_error',
  'image_error',
  'max_turns',
  'budget_exhausted',
  'blocking_limit',
  'turn_setup_failed',
  'unknown',
] as const;
export type KnownFailureReason = (typeof KNOWN_FAILURE_REASONS)[number];

const KNOWN_REASON_SET: ReadonlySet<string> = new Set(KNOWN_FAILURE_REASONS);

export function isKnownFailureReason(reason: string): reason is KnownFailureReason {
  return KNOWN_REASON_SET.has(reason);
}

/** 失败原因的 i18n 键(settings 命名空间)。键名由单测对着两份 locale 核过。 */
export function failureReasonKey(reason: KnownFailureReason): string {
  return `models.catalog.stats.reasons.${reason}`;
}

/** 首字延迟:不到 1 秒写毫秒(`850ms`),否则一位小数的秒(`1.2s`)。没数据 → null。 */
export function formatTtft(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const rounded = Math.round(ms);
  // 999.6 四舍五入成 1000:按秒写,别出现 "1000ms"
  if (rounded < 1000) return `${rounded}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 失败率写成整数百分比;有失败但不到 0.5% 写 `<1%`,别让"有失败"被四舍五入成 0%。 */
export function formatFailureRate(errorRate: number, errors: number): string {
  const percent = Number.isFinite(errorRate) ? Math.round(Math.max(0, errorRate) * 100) : 0;
  if (percent === 0 && errors > 0) return '<1%';
  return `${percent}%`;
}

/** 样本够(≥ 5 轮)且失败率 ≥ 10% 才标琥珀色 —— 2 轮里错 1 轮不说明什么。 */
export const HIGH_FAILURE_MIN_TURNS = 5;
export const HIGH_FAILURE_RATE = 0.1;

export function isFailureRateHigh(stats: { turns: number; errorRate: number }): boolean {
  return stats.turns >= HIGH_FAILURE_MIN_TURNS && stats.errorRate >= HIGH_FAILURE_RATE;
}

/** 悬停提示里列几个原因(服务端已按次数降序)。 */
export function topFailureReasons<T extends { reason: string; count: number }>(reasons: readonly T[], limit = 3): T[] {
  return reasons.filter((item) => item.count > 0).slice(0, Math.max(0, limit));
}

/* ------------------------------ 实测 ------------------------------ */

/** 实测是多久以前做的:`<1m` / `5m` / `3h` / `2d`;时间认不出或在将来 → 空串。目录与私有模型的实测共用。 */
export function probeAgo(iso: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
