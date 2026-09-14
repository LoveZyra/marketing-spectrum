import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * gb:**判据抽出来了,组件有没有接上去** —— 这一轮反复付代价的正是这一步。
 *
 * `collapsedVisibleCount` 写对了、单测也绿,但只要组件里还留着那个字面量 `0`,
 * 用户点下去看到的还是"全没了"。vitest 这边没有 DOM 挂不起组件,所以读源码钉住。
 */
const source = readFileSync(
  fileURLToPath(new URL('./ActivityTimeline.tsx', import.meta.url)),
  'utf8',
);

describe('ActivityTimeline 的收起目标', () => {
  it('手动收起用的是 collapsedVisibleCount,不是写死的 0', () => {
    expect(source).toMatch(/const collapsedCount = collapsedVisibleCount\(rows\.length, keepTailOpen\);/);
    expect(source).toMatch(/manualFold === 'closed'\s*\n\s*\?\s*collapsedCount/);
  });

  it('那个字面量 0 已经不在这条分支上了', () => {
    // 旧代码:manualFold === 'closed' ? 0 : auto.visibleCount
    expect(source).not.toMatch(/manualFold === 'closed'\s*\n?\s*\?\s*0\b/);
  });

  it('自动分支照旧走 planActivityFold —— 两条路不许各写各的', () => {
    expect(source).toMatch(/const auto = planActivityFold\(rows\.length, keepTailOpen\);/);
    expect(source).toMatch(/:\s*auto\.visibleCount;/);
  });
});
