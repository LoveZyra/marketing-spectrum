/**
 * 压缩实况的展示逻辑。
 *
 * **压缩没有进度条可做** —— 它是一次模型调用(把整段对话交给模型总结),
 * 不存在 0→100 的完成度,任何百分比都是编的。能诚实回答的只有三件事:
 *
 *   1. 还在跑吗?     → `beat`,只在 CLI 真的往流里推东西时才递增
 *   2. 跑多久了?     → 客户端从 phase 进入 running 起自己计时
 *   3. 正常吗?       → 对照本会话**上次**压缩的耗时(`lastDurationMs`)
 *
 * 心跳是这里最重要的一条:定时动画在真卡住时照转不误,而心跳会跟着停。
 */

export type CompactionPhase = 'running' | 'done' | 'failed' | 'skipped';
export type CompactionTrigger = 'manual' | 'auto' | 'maintenance' | 'presend';

export interface CompactionActivity {
  phase: CompactionPhase;
  /**
   * `skipped` 时为什么没压。**「没压」和「压失败」是两件事** —— CLI 自己也把
   * "对话太短"和"用户中止"排除在错误通知之外,只有别的才算真失败。
   */
  skipReason?: 'too-short' | 'aborted';
  trigger: CompactionTrigger;
  /** 这次压缩占不占用户的等待时间(回合中途压 = 占,回合答完后压 = 不占)。 */
  blocking: boolean;
  beat?: number;
  /** 心跳断多久算「没有响应」。服务端按该回合的看门狗预算给。 */
  stallAfterMs?: number;
  /**
   * 服务端算的已用时长。**必须**由服务端给:客户端自己从"第一次看到 running"
   * 起算的话,断线重连或换个标签页看就会从 0 重来,"比平常久"永远判不出来。
   */
  elapsedMs?: number;
  preTokens?: number | null;
  postTokens?: number | null;
  durationMs?: number | null;
  lastDurationMs?: number | null;
  error?: string | null;
}

/**
 * 结束态在指示器上停留多久。
 *
 * 存在的理由:压缩跑在 `complete` 之前,结果帧刚到、下一帧 `complete` 就把活动
 * 状态清空 —— 按原生 220ms 的退场动画,等于没显示过。
 *
 * 只给 500ms 的理由:它是**一闪而过的提示,不是记录**。压缩本身在 transcript 里
 * 已经有那张可折叠的摘要卡;这一行只负责"刚刚压完了"。尤其在 CLI 原生压缩那条
 * 路径上(压完继续答这一轮),它必须赶在正文streaming 起来之前退场,
 * 否则就会一直挂在正式回答下面。
 */
export const COMPACTION_RESULT_LINGER_MS = 500;

/** 终态:不再变化,该退场了。 */
export function isTerminalCompactionPhase(phase: CompactionPhase | null | undefined): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'skipped';
}

/**
 * 心跳断多久算「没有响应」的**兜底**值。
 *
 * 正常情况下这个阈值由服务端随帧带过来(`stallAfterMs`,取该回合静默看门狗预算
 * 的一半)—— 看门狗认为多久没动静算异常,界面就在一半的时候先出声。写死一个
 * 小数字会在每次大上下文压缩时误报:从推入 `/compact` 到流上第一个 token,
 * 中间隔着一次超长 prompt 的模型往返,几十秒是常态。
 */
export const COMPACTION_STALL_MS = 45_000;

/** 没有上次耗时做参照时,超过这个时长就算"久"。 */
export const COMPACTION_SLOW_FALLBACK_MS = 60_000;

export function isCompactionActivity(value: unknown): value is CompactionActivity {
  if (!value || typeof value !== 'object') return false;
  const phase = (value as CompactionActivity).phase;
  return phase === 'running' || phase === 'done' || phase === 'failed' || phase === 'skipped';
}

/**
 * 释放比例:218K → 46K 就是 0.79。
 * 数据不全、或者压完反而更大(极少见)时返回 null —— 宁可不显示,不编。
 */
export function freedRatio(
  preTokens: number | null | undefined,
  postTokens: number | null | undefined,
): number | null {
  if (!Number.isFinite(preTokens as number) || !Number.isFinite(postTokens as number)) return null;
  const pre = preTokens as number;
  const post = postTokens as number;
  if (pre <= 0 || post < 0 || post >= pre) return null;
  return (pre - post) / pre;
}

/**
 * 「比平常久」。有上次耗时就按 1.5 倍判(且至少 30 秒,免得上次特别快时一开始
 * 就报警);没有参照就用绝对阈值。
 */
export function runningLongerThanUsual(
  elapsedMs: number,
  lastDurationMs: number | null | undefined,
): boolean {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return false;
  if (Number.isFinite(lastDurationMs as number) && (lastDurationMs as number) > 0) {
    return elapsedMs > Math.max((lastDurationMs as number) * 1.5, 30_000);
  }
  return elapsedMs > COMPACTION_SLOW_FALLBACK_MS;
}

/** 心跳停了多久算失联。从没收到过心跳(lastBeatAt 为 0)时不判失联。 */
export function beatIsStale(
  lastBeatAtMs: number,
  now: number,
  stallMs: number = COMPACTION_STALL_MS,
): boolean {
  if (!Number.isFinite(lastBeatAtMs) || lastBeatAtMs <= 0) return false;
  return now - lastBeatAtMs >= stallMs;
}

/** 218K / 46K / 1.2M —— 和用量芯片同一套口径。 */
export function formatTokens(value: number | null | undefined): string {
  if (!Number.isFinite(value as number) || (value as number) <= 0) return '0';
  const n = value as number;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/**
 * 38s / 2m14s。**不足一秒返回空串** —— 一次空操作后面挂个「0s」是纯噪声,
 * 而且会让人以为发生过什么。
 */
export function formatDuration(ms: number | null | undefined): string {
  if (!Number.isFinite(ms as number) || (ms as number) < 1000) return '';
  const totalSeconds = Math.round((ms as number) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes < 1 ? `${seconds}s` : `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

export type CompactionTone = 'running' | 'slow' | 'stalled' | 'done' | 'failed' | 'skipped';

/**
 * 一次压缩当前该以什么形态呈现。纯函数,时间从外面传进来 —— 组件只负责画。
 */
export function compactionTone(
  compaction: CompactionActivity,
  elapsedMs: number,
  lastBeatAtMs: number,
  now: number,
): CompactionTone {
  if (compaction.phase === 'failed') return 'failed';
  if (compaction.phase === 'skipped') return 'skipped';
  if (compaction.phase === 'done') return 'done';
  if (beatIsStale(lastBeatAtMs, now, compaction.stallAfterMs || COMPACTION_STALL_MS)) return 'stalled';
  if (runningLongerThanUsual(elapsedMs, compaction.lastDurationMs)) return 'slow';
  return 'running';
}
