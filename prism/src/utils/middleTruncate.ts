/**
 * 从**中间**省略的截断。
 *
 * 用户名、文件名这类标识符,尾部往往才是区分度所在(`zhangsan-2024` 与
 * `zhangsan-2025`),用 CSS 的 `truncate`(尾部省略)会把两个人截成同一个名字。
 * 中间省略保留头尾,既压得住宽度,又不会把不同的人显示成一样。
 *
 * CSS 做不到中间省略,所以只能在渲染前算好;调用方记得同时给一个 `title`,
 * 让鼠标悬停还能看到全名(截断而没有 title,等于把信息丢了)。
 *
 * 按**码点**切,不按 UTF-16 码元 —— 否则中文、emoji 会被劈成半个字符。
 */
export function middleTruncate(value: string | null | undefined, max = 18): string {
  if (!value) return '';
  const chars = Array.from(value);
  if (max <= 1) return chars.length > 0 ? '…' : '';
  if (chars.length <= max) return value;

  // 省略号占一位,剩下的名额头多尾少(头部通常信息量更大)。
  const budget = max - 1;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return `${chars.slice(0, head).join('')}…${tail > 0 ? chars.slice(chars.length - tail).join('') : ''}`;
}
