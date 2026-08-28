import { describe, expect, test } from 'vitest';

import {
  MESSAGE_BATCH_SIZE,
  SEARCH_TARGET_MARGIN,
  findTargetIndex,
  initialWindowAfterLoadAll,
  normalizeSearchPhrase,
  revealBatch,
  visibleCountForTarget,
} from './messageWindow';

const at = (minute: number) => new Date(Date.UTC(2026, 7, 28, 10, minute)).toISOString();

const makeMessages = (count: number, texts: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, i) => ({
    content: texts[i] ?? `消息 ${i}`,
    timestamp: at(i),
  }));

describe('revealBatch', () => {
  test('每次加一批', () => {
    expect(revealBatch(100)).toBe(100 + MESSAGE_BATCH_SIZE);
    expect(revealBatch(100, 50)).toBe(150);
  });

  test('已经是 Infinity(用户点过「全部展开」)就不动', () => {
    expect(revealBatch(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('initialWindowAfterLoadAll', () => {
  test('「加载全部」拉完数据只放开一批,不是整段进 DOM', () => {
    expect(initialWindowAfterLoadAll(100)).toBe(MESSAGE_BATCH_SIZE);
  });

  test('窗口已经比一批大就保持,不往回收', () => {
    expect(initialWindowAfterLoadAll(MESSAGE_BATCH_SIZE + 300)).toBe(MESSAGE_BATCH_SIZE + 300);
  });

  test('已经全部展开的会话不被打回一批', () => {
    expect(initialWindowAfterLoadAll(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('normalizeSearchPhrase', () => {
  test('去掉首尾省略号并小写', () => {
    expect(normalizeSearchPhrase('...Reverse Proxy Mounted...')).toBe('reverse proxy mounted');
  });

  test('太短的片段不参与匹配(容易命中错的那条)', () => {
    expect(normalizeSearchPhrase('短')).toBe('');
    expect(normalizeSearchPhrase(undefined)).toBe('');
  });

  test('只取前 80 字,和 DOM 侧口径一致', () => {
    expect(normalizeSearchPhrase('a'.repeat(200))).toHaveLength(80);
  });
});

describe('findTargetIndex', () => {
  test('按正文片段定位', () => {
    const messages = makeMessages(50, { 7: '这里提到了 reverse proxy 的挂载方式' });
    expect(findTargetIndex(messages, { snippet: '...reverse proxy 的挂载...' })).toBe(7);
  });

  test('displayText 也参与匹配', () => {
    const messages = [
      { content: '', displayText: '命令执行结果里出现的关键词 arbitration clause', timestamp: at(0) },
      { content: '别的', timestamp: at(1) },
    ];
    expect(findTargetIndex(messages, { snippet: 'arbitration clause' })).toBe(0);
  });

  test('片段找不到时退回时间戳最近的一条', () => {
    const messages = makeMessages(10);
    expect(findTargetIndex(messages, { snippet: '完全不存在的片段内容', timestamp: at(6) })).toBe(6);
  });

  test('片段和时间戳都没有:定位失败', () => {
    expect(findTargetIndex(makeMessages(10), {})).toBe(-1);
  });

  test('时间戳非法不会把 NaN 当成"最近"', () => {
    const messages = [
      { content: 'a', timestamp: 'not-a-date' },
      { content: 'b', timestamp: at(3) },
    ];
    expect(findTargetIndex(messages, { timestamp: at(3) })).toBe(1);
  });
});

describe('visibleCountForTarget', () => {
  test('目标在末尾附近:窗口几乎不用动', () => {
    const messages = makeMessages(800, { 795: '搜索命中的那一条 needle here' });
    const count = visibleCountForTarget(messages, { snippet: 'needle here' }, 100);
    // 800 - 795 + 20 = 25,比当前窗口还小 —— 保持 100,不缩窗口。
    expect(count).toBe(100);
  });

  test('目标在很早的位置:开到刚好盖住它,而不是整段', () => {
    const messages = makeMessages(800, { 300: '很早以前说过的 needle here' });
    const count = visibleCountForTarget(messages, { snippet: 'needle here' }, 100);
    expect(count).toBe(800 - 300 + SEARCH_TARGET_MARGIN);
    expect(count).toBeLessThan(messages.length);
  });

  test('目标就是第一条:窗口不会超过总长', () => {
    const messages = makeMessages(50, { 0: '最开头那条 needle here' });
    expect(visibleCountForTarget(messages, { snippet: 'needle here' }, 10)).toBe(50);
  });

  test('定位不到就放全 —— 搜索跳转不能因为省 DOM 而跳不到', () => {
    const messages = makeMessages(400);
    expect(visibleCountForTarget(messages, {}, 100)).toBe(400);
  });

  test('空会话不动窗口', () => {
    expect(visibleCountForTarget([], { snippet: 'needle here' }, 100)).toBe(100);
  });

  test('已经全部展开就不再计算', () => {
    const messages = makeMessages(800, { 10: 'needle here' });
    expect(visibleCountForTarget(messages, { snippet: 'needle here' }, Number.POSITIVE_INFINITY)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
