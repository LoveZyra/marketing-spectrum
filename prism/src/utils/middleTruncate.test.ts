import { describe, expect, it } from 'vitest';

import { middleTruncate } from './middleTruncate';

/**
 * 账号审批表里用户名过长会把整行撑成两行(2026-09-15 实测截图)。
 * 尾部省略在这里不行 —— `zhangsan-2024` 和 `zhangsan-2025` 会截成同一个名字。
 */
describe('middleTruncate', () => {
  it('没超长就原样返回', () => {
    expect(middleTruncate('tianji.chang')).toBe('tianji.chang');
    expect(middleTruncate('abc', 3)).toBe('abc');
  });

  it('超长时从中间省略,头尾都留着', () => {
    const out = middleTruncate('zhangsan-from-the-platform-team-2025', 18);
    expect(Array.from(out)).toHaveLength(18);
    expect(out.startsWith('zhangsan')).toBe(true);
    expect(out.endsWith('2025')).toBe(true);
    expect(out).toContain('…');
  });

  it('区分度在尾部的两个名字,截完仍然不一样', () => {
    const a = middleTruncate('zhangsan-from-the-platform-team-2024', 18);
    const b = middleTruncate('zhangsan-from-the-platform-team-2025', 18);
    expect(a).not.toBe(b);
  });

  it('按码点切,中文与 emoji 不会被劈成半个字', () => {
    const out = middleTruncate('张三丰的超级无敌长的用户名字符串', 9);
    expect(Array.from(out)).toHaveLength(9);
    expect(out).toContain('…');
    const emoji = middleTruncate('🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂', 5);
    expect(Array.from(emoji)).toHaveLength(5);
    expect(emoji).not.toContain('�');
  });

  it('空值与极小 max 不炸', () => {
    expect(middleTruncate(null)).toBe('');
    expect(middleTruncate(undefined)).toBe('');
    expect(middleTruncate('')).toBe('');
    expect(middleTruncate('abcdef', 1)).toBe('…');
  });
});
