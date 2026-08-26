import { describe, test, expect } from 'vitest';

import { findOccurrenceStarts, stepMatchIndex } from './findMatches';

/**
 * F1 回归:会话内查找的纯匹配逻辑。
 */
describe('findOccurrenceStarts', () => {
  test('大小写不敏感,返回全部起点', () => {
    expect(findOccurrenceStarts('Foo foo FOO', 'foo')).toEqual([0, 4, 8]);
  });

  test('不重叠匹配', () => {
    expect(findOccurrenceStarts('aaaa', 'aa')).toEqual([0, 2]);
  });

  test('空查询/无命中', () => {
    expect(findOccurrenceStarts('abc', '')).toEqual([]);
    expect(findOccurrenceStarts('abc', 'xyz')).toEqual([]);
  });

  test('中文与混排', () => {
    expect(findOccurrenceStarts('部署命令:部署完成', '部署')).toEqual([0, 5]);
  });
});

describe('stepMatchIndex', () => {
  test('环形前进/后退', () => {
    expect(stepMatchIndex(0, 3, 'next')).toBe(1);
    expect(stepMatchIndex(2, 3, 'next')).toBe(0);
    expect(stepMatchIndex(0, 3, 'prev')).toBe(2);
  });

  test('未定位时:next 从头、prev 从尾', () => {
    expect(stepMatchIndex(-1, 3, 'next')).toBe(0);
    expect(stepMatchIndex(-1, 3, 'prev')).toBe(2);
  });

  test('无命中返回 -1', () => {
    expect(stepMatchIndex(0, 0, 'next')).toBe(-1);
  });
});
