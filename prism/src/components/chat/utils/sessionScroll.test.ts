import { describe, expect, it } from 'vitest';

import {
  EMPTY_SPOT_MEMORY,
  MAX_RESTORE_COMMITS,
  MAX_RESTORE_STALE_COMMITS,
  beginScrollRestore,
  rememberReadingSpot,
  resolveReadingSpot,
  stepScrollRestore,
  type ScrollRestoreState,
  type SessionSpotMemory,
} from './messageWindow';

describe('rememberReadingSpot', () => {
  it('记住位置,也记得住「当时就在底部」', () => {
    let memory: SessionSpotMemory = EMPTY_SPOT_MEMORY;
    memory = rememberReadingSpot(memory, 'A', { indexFromEnd: 12, offset: -30 });
    memory = rememberReadingSpot(memory, 'B', null);
    expect(memory.get('A')).toEqual({ indexFromEnd: 12, offset: -30 });
    // null ≠ 没记过:它表示"回来直接跟底"
    expect(memory.get('B')).toBeNull();
    expect(memory.has('B')).toBe(true);
    expect(memory.has('C')).toBe(false);
  });

  it('不改原来那份', () => {
    const before = rememberReadingSpot(EMPTY_SPOT_MEMORY, 'A', { indexFromEnd: 1, offset: 0 });
    const after = rememberReadingSpot(before, 'A', { indexFromEnd: 9, offset: 5 });
    expect(before.get('A')).toEqual({ indexFromEnd: 1, offset: 0 });
    expect(after.get('A')).toEqual({ indexFromEnd: 9, offset: 5 });
  });
});

/**
 * **倒数下标越界就别硬来。** 回来时行数可能比离开时少(窗口被钳、这一页还没
 * 补齐),`rows[负数]` 是 undefined,再往下就是把视口钉到一个算不出来的地方。
 */
describe('resolveReadingSpot', () => {
  it('落得下去 → 换算成正数下标', () => {
    expect(resolveReadingSpot({ indexFromEnd: 0, offset: 8 }, 10)).toEqual({ rowIndex: 9, offset: 8 });
    expect(resolveReadingSpot({ indexFromEnd: 9, offset: -4 }, 10)).toEqual({ rowIndex: 0, offset: -4 });
  });

  it('**行数不够 → null(放弃守位,跟底)**', () => {
    expect(resolveReadingSpot({ indexFromEnd: 10, offset: 0 }, 10)).toBeNull();
    expect(resolveReadingSpot({ indexFromEnd: 250, offset: 0 }, 30)).toBeNull();
  });

  it('没记过 / 一行都没有 / 脏值 → null', () => {
    expect(resolveReadingSpot(null, 10)).toBeNull();
    expect(resolveReadingSpot(undefined, 10)).toBeNull();
    expect(resolveReadingSpot({ indexFromEnd: 0, offset: 0 }, 0)).toBeNull();
    expect(resolveReadingSpot({ indexFromEnd: -1, offset: 0 }, 10)).toBeNull();
    expect(resolveReadingSpot({ indexFromEnd: Number.NaN, offset: 0 }, 10)).toBeNull();
    expect(resolveReadingSpot({ indexFromEnd: 3, offset: Number.POSITIVE_INFINITY }, 10)).toBeNull();
  });
});

describe('beginScrollRestore', () => {
  it('当时就在底部(null)→ 不武装恢复', () => {
    expect(beginScrollRestore('A', null)).toBeNull();
  });
  it('没有会话键 → 不武装', () => {
    expect(beginScrollRestore('', { indexFromEnd: 3, offset: 0 })).toBeNull();
  });
  it('有位置 → 从零开始等', () => {
    expect(beginScrollRestore('A', { indexFromEnd: 3, offset: 0 })).toEqual({
      sessionKey: 'A', spot: { indexFromEnd: 3, offset: 0 }, commits: 0, lastRowCount: -1, stale: 0,
    });
  });
});

describe('stepScrollRestore', () => {
  const armed = (): ScrollRestoreState => beginScrollRestore('A', { indexFromEnd: 40, offset: 12 })!;

  it('行够了 → 立刻落位', () => {
    expect(stepScrollRestore(armed(), 'A', 100)).toEqual({ action: 'apply', rowIndex: 59, offset: 12 });
  });

  it('行还在长 → 等下一次 commit', () => {
    const step = stepScrollRestore(armed(), 'A', 30);
    expect(step.action).toBe('wait');
    if (step.action === 'wait') {
      expect(step.next.lastRowCount).toBe(30);
      expect(step.next.stale).toBe(0);
      // 下一帧长到 100 就落位
      expect(stepScrollRestore(step.next, 'A', 100).action).toBe('apply');
    }
  });

  it('**串会话立刻放弃** —— 这份位置属于别人', () => {
    expect(stepScrollRestore(armed(), 'B', 100)).toEqual({ action: 'giveUp' });
  });

  it('**行数不再增长,宽限用完就放弃**(否则一直不跟底)', () => {
    let state = armed();
    let step = stepScrollRestore(state, 'A', 20);           // 第一次:从 -1 长到 20
    expect(step.action).toBe('wait');
    for (let i = 0; i < MAX_RESTORE_STALE_COMMITS; i += 1) {
      if (step.action !== 'wait') break;
      state = step.next;
      step = stepScrollRestore(state, 'A', 20);             // 一直是 20,不长了
    }
    expect(step.action).toBe('giveUp');
  });

  it('**总 commit 数封顶**,哪怕行数一直在长', () => {
    let state = armed();
    let rows = 0;
    let step = stepScrollRestore(state, 'A', rows);
    let guard = 0;
    while (step.action === 'wait' && guard < MAX_RESTORE_COMMITS * 2) {
      state = step.next;
      rows += 1;                                            // 每帧长一行,永远够不到 41 行前就封顶
      step = stepScrollRestore(state, 'A', rows);
      guard += 1;
    }
    expect(step.action).toBe('giveUp');
    expect(guard).toBeLessThanOrEqual(MAX_RESTORE_COMMITS);
  });

  it('端到端:离开时停在倒数第 40 行,回来行齐了就回到同一行', () => {
    let memory: SessionSpotMemory = EMPTY_SPOT_MEMORY;
    memory = rememberReadingSpot(memory, 'A', { indexFromEnd: 40, offset: -18 });
    const state = beginScrollRestore('A', memory.get('A'));
    expect(state).not.toBeNull();
    const step = stepScrollRestore(state!, 'A', 600);
    expect(step).toEqual({ action: 'apply', rowIndex: 559, offset: -18 });
  });
});

/**
 * fz:**用户已经接管方向盘时,恢复必须让位。**
 *
 * 恢复落地时会故意把锚点的 scrollTop 写成当前值好让 `userMoved` 失效 ——
 * 那是为了让守位分支肯动手,代价是恢复完全不认"用户自己滚过了",
 * 而控制器其余部分处处以 userMoved 为最高优先级。
 */
describe('stepScrollRestore 的第四条放弃条件:用户自己滚了', () => {
  const armed = (): ScrollRestoreState => beginScrollRestore('A', { indexFromEnd: 40, offset: 12 })!;

  it('**等待期间用户滚过 → 放弃**,哪怕行数已经够了', () => {
    expect(stepScrollRestore(armed(), 'A', 100, { userMoved: true })).toEqual({ action: 'giveUp' });
  });

  it('用户没滚 → 照旧落位', () => {
    expect(stepScrollRestore(armed(), 'A', 100, { userMoved: false }).action).toBe('apply');
  });

  it('不传信号时按"没滚过"处理(老调用点不变行为)', () => {
    expect(stepScrollRestore(armed(), 'A', 100).action).toBe('apply');
  });

  it('用户滚过 → 连等都不等了(不会留着一份 wait 挂在那儿)', () => {
    expect(stepScrollRestore(armed(), 'A', 5, { userMoved: true })).toEqual({ action: 'giveUp' });
  });
});
