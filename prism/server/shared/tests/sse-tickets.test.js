/**
 * SSE 票据:替代搜索 SSE 里"URL 带 JWT"的短命票据。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { issueSseTicket, consumeSseTicket, __resetSseTicketsForTest } from '../sse-tickets.js';

describe('sse-tickets', () => {
  beforeEach(() => __resetSseTicketsForTest());

  it('签发的票能被消费,拿回同一个 userId', () => {
    const t = issueSseTicket(42);
    expect(typeof t).toBe('string');
    expect(t.length).toBe(64);
    expect(consumeSseTicket(t)).toEqual({ userId: 42 });
  });

  it('有效期内可重复消费 —— EventSource 断线重连要靠这个', () => {
    const t = issueSseTicket(7);
    expect(consumeSseTicket(t)).toEqual({ userId: 7 });
    // 一次性票会让第二次(重连)拿到 null;这里必须仍然有效
    expect(consumeSseTicket(t)).toEqual({ userId: 7 });
  });

  it('未知 / 空 / 非字符串一律 null', () => {
    expect(consumeSseTicket('nope')).toBeNull();
    expect(consumeSseTicket('')).toBeNull();
    expect(consumeSseTicket(undefined)).toBeNull();
    expect(consumeSseTicket(null)).toBeNull();
  });

  it('userId 缺失时拒绝签发', () => {
    expect(() => issueSseTicket(undefined)).toThrow();
    expect(() => issueSseTicket(null)).toThrow();
    expect(() => issueSseTicket('')).toThrow();
  });

  it('两张票互不干扰', () => {
    const a = issueSseTicket(1);
    const b = issueSseTicket(2);
    expect(a).not.toBe(b);
    expect(consumeSseTicket(a)).toEqual({ userId: 1 });
    expect(consumeSseTicket(b)).toEqual({ userId: 2 });
  });
});
