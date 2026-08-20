import { describe, expect, it } from 'vitest';

import { ACTIVITY_MIN_ROWS, ACTIVITY_TAIL_ROWS, planActivityFold } from './toolRowSummary';

describe('planActivityFold', () => {
  it('还在跑时只露出最新三步', () => {
    const plan = planActivityFold(17, true);
    expect(plan.visibleCount).toBe(ACTIVITY_TAIL_ROWS);
    expect(plan.foldedCount).toBe(14);
    expect(plan.canFold).toBe(true);
    expect(plan.showSummary).toBe(true);
  });

  it('还在跑但总步数不到三步时不折', () => {
    const plan = planActivityFold(2, true);
    expect(plan.visibleCount).toBe(2);
    expect(plan.foldedCount).toBe(0);
    expect(plan.canFold).toBe(false);
  });

  it('跑完之后整段收起,只剩抬头', () => {
    const plan = planActivityFold(16, false);
    expect(plan.visibleCount).toBe(0);
    expect(plan.foldedCount).toBe(16);
    expect(plan.canFold).toBe(true);
    expect(plan.showSummary).toBe(true);
  });

  it('跑完但太短的段不折 —— 折了反而添乱', () => {
    const plan = planActivityFold(ACTIVITY_MIN_ROWS - 1, false);
    expect(plan.visibleCount).toBe(ACTIVITY_MIN_ROWS - 1);
    expect(plan.foldedCount).toBe(0);
    expect(plan.canFold).toBe(false);
    expect(plan.showSummary).toBe(false);
  });

  it('恰好三步且已跑完 —— 折成一行,抬头必须出现,否则那三行没有入口', () => {
    const plan = planActivityFold(ACTIVITY_MIN_ROWS, false);
    expect(plan.visibleCount).toBe(0);
    expect(plan.showSummary).toBe(true);
    expect(plan.canFold).toBe(true);
  });

  it('被折起来时抬头一定出现', () => {
    for (const total of [1, 2, 3, 4, 10, 40]) {
      for (const running of [true, false]) {
        const plan = planActivityFold(total, running);
        if (plan.foldedCount > 0) expect(plan.showSummary).toBe(true);
        expect(plan.visibleCount + plan.foldedCount).toBe(total);
      }
    }
  });
});
