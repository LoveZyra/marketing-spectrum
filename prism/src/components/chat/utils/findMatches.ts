/**
 * 会话内查找的纯匹配逻辑(F1)。
 *
 * DOM 端(ChatFindBar)拿它算出每个文本节点里的命中区间,再包成 Range 丢给
 * CSS Custom Highlight API —— 匹配本身与 DOM 无关,单测在这里做。
 */

/** 大小写不敏感地找出 `query` 在 `text` 里的所有起点(不重叠)。 */
export function findOccurrenceStarts(text: string, query: string): number[] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const starts: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    starts.push(index);
    from = index + needle.length;
  }
  return starts;
}

/** 环形步进:在 total 个命中里从 current 往 前/后 走一步。total<=0 时返回 -1。 */
export function stepMatchIndex(current: number, total: number, direction: 'next' | 'prev'): number {
  if (total <= 0) return -1;
  if (current < 0) return direction === 'next' ? 0 : total - 1;
  return direction === 'next'
    ? (current + 1) % total
    : (current - 1 + total) % total;
}
