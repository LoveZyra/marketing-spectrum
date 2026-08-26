/**
 * 配额判定与人话文案。
 *
 * 关键一条:**拿不到 userId 时一律放行**。宁可漏拦也不能因为身份缺失就把
 * 上传堵死 —— 一个拿不到用户上下文的部署,不该整个上传功能都不能用。
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
