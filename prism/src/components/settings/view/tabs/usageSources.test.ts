import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 用量「按来源」的标签:`background` 是 CLI 自己发起的回合(比如后台任务回报),
 * 没有标签时界面会直接显示原始的 key。中文兜底写在组件里,译文在 `usage.sources.*`。
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const sources = (lang: string) =>
  (JSON.parse(read(`../../../../i18n/locales/${lang}/settings.json`)) as { usage: { sources: Record<string, string> } }).usage.sources;

describe('用量来源标签', () => {
  it('组件里的中文兜底包含 background,并且走 i18n', () => {
    const section = read('./UsageCostSection.tsx');
    expect(section).toMatch(/background: '后台任务',/);
    expect(section).toMatch(/t\(`usage\.sources\.\$\{row\.key\}`, \{ defaultValue: fallback \}\)/);
  });

  it('en / zh-CN 的译文', () => {
    expect(sources('en').background).toBe('Background');
    expect(sources('zh-CN').background).toBe('后台任务');
  });

  it('每个来源 key 在 en / zh-CN / zh-TW 都有译文', () => {
    const keys = [...read('./UsageCostSection.tsx').matchAll(/^ {2}(\w+): '[^']+',$/gm)].map((match) => match[1]);
    expect(keys).toEqual(['chat', 'compact', 'task', 'api', 'background']);
    for (const lang of ['en', 'zh-CN', 'zh-TW']) {
      expect(Object.keys(sources(lang)).sort(), lang).toEqual([...keys].sort());
    }
  });
});
