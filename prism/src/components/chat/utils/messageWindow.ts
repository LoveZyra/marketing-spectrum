import type { ChatMessage } from '../types/types';

/**
 * 聊天区的「渲染窗口」计算。
 *
 * 会话区没有虚拟化 —— `visibleMessageCount` 有多大,就有多少条**真实 DOM**
 * (`chatMessages.slice(-visibleMessageCount)`)。以前「加载全部」和搜索跳转会把
 * 它直接开到 `Infinity`,几百上千条的会话整棵树进 DOM,之后每来一个流式 token
 * 都要 diff 一遍这棵树,长会话越用越卡。
 *
 * 这里把「开到无穷」换成「分批放开」:**数据层照旧全量拉**(搜索、导出、跳转都
 * 不受影响),只是 DOM 分次长出来。真正的虚拟化要能预估每条高度,而这里的消息
 * 高度完全不可预测(markdown / 代码块 / 图片 / 可折叠工具卡),还要和滚动位置
 * 恢复、自动补齐、搜索高亮三套逻辑对齐,那是另一件事。
 */

/** 一批放多少条。「看更早的」每次加这么多,「加载全部」拉完数据先显示这么多。 */
export const MESSAGE_BATCH_SIZE = 200;

/** 搜索跳转时在目标上方多留几条,免得命中的那条正好贴在窗口第一行。 */
export const SEARCH_TARGET_MARGIN = 20;

/** 「看更早的」:在当前窗口上再放一批。已经是 Infinity 就不动。 */
export function revealBatch(current: number, step: number = MESSAGE_BATCH_SIZE): number {
  if (!Number.isFinite(current)) return current;
  return current + step;
}

/** 「加载全部」拉完数据后的初始窗口:至少一批,已经开得更大就保持。 */
export function initialWindowAfterLoadAll(current: number, batch: number = MESSAGE_BATCH_SIZE): number {
  if (!Number.isFinite(current)) return current;
  return Math.max(current, batch);
}

function toEpoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string' && value !== '') return new Date(value).getTime();
  return Number.NaN;
}

/** 和 DOM 侧的匹配口径保持一致:去掉首尾省略号、取前 80 字、小写。 */
export function normalizeSearchPhrase(snippet: string | undefined): string {
  if (typeof snippet !== 'string' || snippet === '') return '';
  const clean = snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
  const phrase = clean.slice(0, 80).toLowerCase().trim();
  return phrase.length >= 10 ? phrase : '';
}

export interface SearchTargetLike {
  snippet?: string;
  timestamp?: string;
}

/**
 * 在数据里定位搜索目标,返回下标;找不到返回 -1。
 *
 * 先按正文片段找(和 DOM 匹配同口径,正向取第一个命中),找不到再按时间戳取最
 * 接近的一条。注意 DOM 匹配的是渲染后的 `textContent`,这里匹配的是原始
 * `content`/`displayText`,两者不完全等价 —— 所以这个结果只用来**决定窗口开多
 * 大**,真正的滚动定位仍然由 DOM 那一轮负责。
 */
export function findTargetIndex(
  messages: readonly Pick<ChatMessage, 'content' | 'displayText' | 'timestamp'>[],
  target: SearchTargetLike,
): number {
  const phrase = normalizeSearchPhrase(target.snippet);
  if (phrase) {
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      const text = `${typeof message?.content === 'string' ? message.content : ''}\n${
        typeof message?.displayText === 'string' ? message.displayText : ''
      }`.toLowerCase();
      if (text.includes(phrase)) return i;
    }
  }

  const targetEpoch = toEpoch(target.timestamp);
  if (Number.isFinite(targetEpoch)) {
    let best = -1;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (let i = 0; i < messages.length; i += 1) {
      const epoch = toEpoch(messages[i]?.timestamp);
      if (!Number.isFinite(epoch)) continue;
      const diff = Math.abs(epoch - targetEpoch);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }

  return -1;
}

/**
 * 搜索跳转要开多大的窗口:**刚好盖住目标**,而不是整段放开。
 *
 * 定位不到目标时返回全长 —— 搜索跳转不能因为省 DOM 而跳不到,宁可这一次多渲染
 * 一些。目标本来就在末尾附近(最常见的情况)时,窗口几乎不用动。
 */
export function visibleCountForTarget(
  messages: readonly Pick<ChatMessage, 'content' | 'displayText' | 'timestamp'>[],
  target: SearchTargetLike,
  current: number,
  margin: number = SEARCH_TARGET_MARGIN,
): number {
  const total = messages.length;
  if (total === 0) return current;
  if (!Number.isFinite(current)) return current;

  const index = findTargetIndex(messages, target);
  if (index < 0) return total;

  const needed = Math.min(total, total - index + margin);
  return Math.max(current, needed);
}
