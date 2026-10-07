/**
 * 附件容量的显示格式与超配额提示文案。
 */

import { describe, it, expect } from 'vitest';

import { formatBytes, quotaExceededMessage } from '../attachment-storage.js';

describe('formatBytes', () => {
  it('按量级切单位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatBytes(10 * 1024 * 1024 * 1024)).toBe('10.0 GB');
  });

  it('负数与非数字不炸,回落到 0', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('quotaExceededMessage', () => {
  it('把已用和上限都说清楚,并给出下一步', () => {
    const message = quotaExceededMessage({
      usedBytes: 20 * 1024 * 1024,
      quotaBytes: 10 * 1024 * 1024,
    });
    expect(message).toContain('20.0 MB');
    expect(message).toContain('10.0 MB');
    // 只说"超了"是没用的,得告诉用户能做什么
    expect(message).toContain('设置');
  });
});
