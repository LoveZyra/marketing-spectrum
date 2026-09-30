import i18next from 'i18next';

/**
 * hl(动态 P3 中英混排):日期 / 数字按**界面语言**格式化,而不是浏览器语言。
 *
 * `toLocaleString()` 不传 locale 用的是浏览器的 —— 中文界面、英文浏览器下会出现
 * 「9/29/2026, 3:04:05 PM」夹在一屏中文里。i18next 还没初始化时返回 undefined(= 老行为)。
 */
export function uiLocale(): string | undefined {
  const language = i18next.isInitialized ? i18next.language : undefined;
  return language || undefined;
}
