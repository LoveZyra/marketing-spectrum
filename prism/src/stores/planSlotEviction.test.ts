import { describe, test, expect } from 'vitest';

import { planSlotEviction } from './useSessionStore';

/**
 * C10 回归:会话槽位 LRU。原来"切会话不清、旧数据全留"导致逛几十个长会话
 * 后内存只涨不落;现在超过上限时,在切会话的边界按最久未用淘汰,当前会话
 * 与 60 秒内仍有动静(比如后台在推流)的会话不进候选。
 */
describe('planSlotEviction', () => {
  const NOW = 1_000_000_000;
  const entry = (sessionId: string, idleMs: number) => ({ sessionId, lastTouchedAt: NOW - idleMs });

  test('未超上限:不淘汰', () => {
    const entries = [entry('a', 900_000), entry('b', 500_000)];
    expect(planSlotEviction(entries, 'b', NOW, 12)).toEqual([]);
  });

  test('超上限:按最久未用先淘汰,收敛到上限', () => {
    const entries = [
      entry('oldest', 900_000),
      entry('older', 600_000),
      entry('recent', 120_000),
      entry('active', 0),
    ];
    expect(planSlotEviction(entries, 'active', NOW, 3)).toEqual(['oldest']);
    expect(planSlotEviction(entries, 'active', NOW, 2)).toEqual(['oldest', 'older']);
  });

  test('当前会话即使最久未用也不淘汰', () => {
    const entries = [entry('stale-active', 900_000), entry('b', 300_000), entry('c', 200_000)];
    const evicted = planSlotEviction(entries, 'stale-active', NOW, 2);
    expect(evicted).toEqual(['b']);
    expect(evicted).not.toContain('stale-active');
  });

  test('60 秒保护窗:刚被碰过的槽位(后台推流中)不进候选', () => {
    const entries = [
      entry('streaming-bg', 5_000),
      entry('idle-1', 300_000),
      entry('idle-2', 200_000),
      entry('active', 0),
    ];
    // 上限 2、超 2 个,但 streaming-bg 在保护窗内 → 只淘汰两个真正闲置的。
    expect(planSlotEviction(entries, 'active', NOW, 2)).toEqual(['idle-1', 'idle-2']);
  });

  test('候选不足时宁可暂超上限,也不动受保护的槽位', () => {
    const entries = [entry('bg-1', 10_000), entry('bg-2', 20_000), entry('active', 0)];
    expect(planSlotEviction(entries, 'active', NOW, 1)).toEqual([]);
  });
});
