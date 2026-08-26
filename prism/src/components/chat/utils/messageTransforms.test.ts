import { describe, test, expect } from 'vitest';

import { calculateDiff, createCachedDiffCalculator } from './messageTransforms';

/**
 * C9 回归:diff 的 LCS 表加了格子预算(前后缀先裁剪、改动区超预算退化成
 * 全删+全增)。修前一次几千行×几千行的 Edit 会在渲染路径上分配千万级格子,
 * 主线程冻住数秒。
 */
describe('calculateDiff', () => {
  test('小改动:输出与行号不变', () => {
    const oldStr = 'a\nb\nc\nd';
    const newStr = 'a\nB\nc\nd';
    expect(calculateDiff(oldStr, newStr)).toEqual([
      { type: 'removed', content: 'b', lineNum: 2 },
      { type: 'added', content: 'B', lineNum: 2 },
    ]);
  });

  test('纯插入与纯删除', () => {
    expect(calculateDiff('a\nc', 'a\nb\nc')).toEqual([
      { type: 'added', content: 'b', lineNum: 2 },
    ]);
    expect(calculateDiff('a\nb\nc', 'a\nc')).toEqual([
      { type: 'removed', content: 'b', lineNum: 2 },
    ]);
  });

  test('两串完全相同时输出为空', () => {
    expect(calculateDiff('x\ny\nz', 'x\ny\nz')).toEqual([]);
  });

  test('大文件小改动:前后缀裁剪后行号仍指向原文', () => {
    // 5000 行文件改中间一行 —— 修前要建 5001×5001 的表;裁剪后改动区只有 1×1。
    const lines = Array.from({ length: 5000 }, (_, index) => `line-${index}`);
    const oldStr = lines.join('\n');
    const changed = [...lines];
    changed[2500] = 'CHANGED';
    const started = performance.now();
    const diff = calculateDiff(oldStr, changed.join('\n'));
    const elapsed = performance.now() - started;
    expect(diff).toEqual([
      { type: 'removed', content: 'line-2500', lineNum: 2501 },
      { type: 'added', content: 'CHANGED', lineNum: 2501 },
    ]);
    // 松上限:只为证明没有走 O(N²) 全表(那要秒级),不苛求微基准。
    expect(elapsed).toBeLessThan(500);
  });

  test('改动区超预算:退化为全删+全增,不再做行级对齐', () => {
    // 两边各 1000 行、完全不同(无公共前后缀)→ 100 万格 > 25 万预算。
    const oldStr = Array.from({ length: 1000 }, (_, index) => `old-${index}`).join('\n');
    const newStr = Array.from({ length: 1000 }, (_, index) => `new-${index}`).join('\n');
    const started = performance.now();
    const diff = calculateDiff(oldStr, newStr);
    const elapsed = performance.now() - started;
    expect(diff).toHaveLength(2000);
    expect(diff.slice(0, 1000).every((line) => line.type === 'removed')).toBe(true);
    expect(diff.slice(1000).every((line) => line.type === 'added')).toBe(true);
    expect(diff[0]).toEqual({ type: 'removed', content: 'old-0', lineNum: 1 });
    expect(diff[1000]).toEqual({ type: 'added', content: 'new-0', lineNum: 1 });
    expect(elapsed).toBeLessThan(500);
  });

  test('预算退化仍尊重公共前后缀:行号带前缀偏移', () => {
    // 公共前缀 3 行 + 各 600 行完全不同的核心(36 万格 > 预算)+ 公共后缀 2 行。
    const prefix = ['p1', 'p2', 'p3'];
    const suffix = ['s1', 's2'];
    const oldCore = Array.from({ length: 600 }, (_, index) => `o-${index}`);
    const newCore = Array.from({ length: 600 }, (_, index) => `n-${index}`);
    const diff = calculateDiff(
      [...prefix, ...oldCore, ...suffix].join('\n'),
      [...prefix, ...newCore, ...suffix].join('\n'),
    );
    expect(diff).toHaveLength(1200);
    expect(diff[0]).toEqual({ type: 'removed', content: 'o-0', lineNum: 4 });
    expect(diff[600]).toEqual({ type: 'added', content: 'n-0', lineNum: 4 });
  });
});

describe('createCachedDiffCalculator', () => {
  test('同一入参命中缓存(引用相等)', () => {
    const diff = createCachedDiffCalculator();
    const first = diff('a\nb', 'a\nc');
    const second = diff('a\nb', 'a\nc');
    expect(second).toBe(first);
    expect(diff('a\nb', 'a\nd')).not.toBe(first);
  });
});
