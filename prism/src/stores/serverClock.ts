/**
 * 服务器时钟相对浏览器时钟的偏差估计(按标签页,只在内存里)。
 *
 * 聊天列表里服务端来的行带服务器时间,前端自己造的行(本地回声、流式收尾提交的正文)要和它们
 * 按时间戳混排。浏览器表不准(手动调过时间、虚机 / 手机 NTP 没同步)时直接用浏览器时间打戳,
 * 本轮提问会排到本轮工具行下面,或者插进上一轮中间。所以前端打戳用"浏览器时间 + 偏差"。
 *
 * 样本来自服务端现发的控制帧(`chat_ack`、`chat_subscribed` 一类,时间戳就是服务端发帧那一刻,
 * 不进重放缓冲):帧上的服务器时间 − 收到它时的浏览器时间 = 偏差 − 传输耗时。耗时只会让样本偏小,
 * 所以取一段时间窗内的最大值;时间窗让估计跟得上浏览器时钟被调整。窗内没有新样本时沿用最后一次的
 * 估计,从没有过样本时偏差按 0 算,与不校正一样。
 */

export interface ClockSample {
  /** 服务器时间 − 浏览器时间(毫秒)。 */
  offsetMs: number;
  /** 取样时的浏览器时间(毫秒)。 */
  at: number;
}

export const CLOCK_SAMPLE_WINDOW_MS = 10 * 60 * 1000;
const MAX_CLOCK_SAMPLES = 32;

/** 记一个样本,同时丢掉时间窗外和超出条数上限的旧样本。 */
export function addClockSample(
  samples: readonly ClockSample[],
  sample: ClockSample,
  now: number,
): ClockSample[] {
  const fresh = samples.filter((entry) => now - entry.at <= CLOCK_SAMPLE_WINDOW_MS && entry.at <= now);
  fresh.push(sample);
  return fresh.length > MAX_CLOCK_SAMPLES ? fresh.slice(-MAX_CLOCK_SAMPLES) : fresh;
}

/**
 * 当前的偏差估计。
 *
 * 时间窗只用来在近期样本里取最大值:窗内有样本就取窗内的最大值;窗内一个都没有时,以最后一个样本
 * 的时刻为窗的终点再取一次,也就是沿用最后一次的估计,不归零。样本只来自控制帧,长回合里隔十几分钟
 * 才来一个很正常,归零的话这时发出的插话 / 排队那条又回到浏览器时间。从没有过样本是 0。
 */
export function estimateClockOffset(samples: readonly ClockSample[], now: number): number {
  let latest: number | null = null;
  for (const entry of samples) {
    if (entry.at <= now && (latest === null || entry.at > latest)) latest = entry.at;
  }
  if (latest === null) return 0;
  const windowEnd = now - latest <= CLOCK_SAMPLE_WINDOW_MS ? now : latest;
  let best = Number.NEGATIVE_INFINITY;
  for (const entry of samples) {
    if (entry.at > now || windowEnd - entry.at > CLOCK_SAMPLE_WINDOW_MS) continue;
    if (entry.offsetMs > best) best = entry.offsetMs;
  }
  return best;
}

let samples: ClockSample[] = [];

/** 收到一个现发的、带服务器时间的帧时调用。时间戳解析不了就忽略。 */
export function observeServerTime(timestamp: unknown, receivedAt: number = Date.now()): void {
  if (typeof timestamp !== 'string') return;
  const serverTime = Date.parse(timestamp);
  if (!Number.isFinite(serverTime)) return;
  samples = addClockSample(samples, { offsetMs: serverTime - receivedAt, at: receivedAt }, receivedAt);
}

/** 按服务器时钟的"现在"(毫秒)。 */
export function serverNow(localNow: number = Date.now()): number {
  return localNow + estimateClockOffset(samples, localNow);
}

/** 有没有过样本(窗外的也算,估计会沿用)。没有时 `serverNow()` 就是浏览器时间,可能差出几分钟。 */
export function hasServerClockSample(localNow: number = Date.now()): boolean {
  return samples.some((entry) => entry.at <= localNow);
}

/** 测试用:清掉样本。 */
export function resetServerClockForTest(): void {
  samples = [];
}
