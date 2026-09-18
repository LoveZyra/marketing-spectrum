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
    // gh:入参换成"坐实了 250ms 的 keepTail"(见 useSettledTrue),判据本身不变
    expect(source).toMatch(/const collapsedCount = collapsedVisibleCount\(rows\.length, settledKeepTail\);/);
    expect(source).toMatch(/manualFold === 'closed'\s*\n\s*\?\s*\(closedToZeroRef\.current \? 0 : collapsedCount\)/);
  });

  /**
   * gh:用户在 ≤3 行时点「收起」收到 0 行,第 4 步到达时 collapsedVisibleCount 变 3,
   * 三行在用户明确收起的抬头下面自己弹出来。记住"收到 0"这一下,反向点开时清掉。
   */
  it('gh:收到 0 行那一下要记住,不随 total 跨过 3 而弹开;点开时清掉', () => {
    expect(source).toMatch(/const closedToZeroRef = useRef\(false\);/);
    expect(source).toMatch(/closedToZeroRef\.current = collapsedCount === 0;\s*\n\s*setManualFold\('closed'\);/);
    expect(source).toMatch(/closedToZeroRef\.current = false;\s*\n\s*setManualFold\('open'\);/);
  });

  /**
   * gh:每条助手 text 都是 'reply',`[组][text]` 一到就折、下一帧 text 被吸进组又展开。
   * true→false 延后 250ms,false→true 立刻 —— 真正的正文照旧折,只晚一眨眼。
   */
  it('gh:"正文出现了"要坐实 250ms 才折 —— 两条分支都吃 settledKeepTail', () => {
    expect(source).toMatch(/const settledKeepTail = useSettledTrue\(keepTailOpen, 250\);/);
    expect(source).toMatch(/function useSettledTrue\(value: boolean, delayMs: number\): boolean/);
    // false→true 立刻:返回值里 value 为真直接短路
    expect(source).toMatch(/return value \? true : settled;/);
  });

  it('那个字面量 0 已经不在这条分支上了', () => {
    // 旧代码:manualFold === 'closed' ? 0 : auto.visibleCount
    expect(source).not.toMatch(/manualFold === 'closed'\s*\n?\s*\?\s*0\b/);
  });

  it('自动分支照旧走 planActivityFold —— 两条路不许各写各的', () => {
    expect(source).toMatch(/const auto = planActivityFold\(rows\.length, settledKeepTail\);/);
    expect(source).toMatch(/:\s*auto\.visibleCount;/);
  });
});
