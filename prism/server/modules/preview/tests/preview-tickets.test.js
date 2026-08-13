import assert from 'node:assert/strict';

import { afterEach, describe, test, vi } from 'vitest';

import {
  PREVIEW_TICKET_TTL_MS,
  issuePreviewTicket,
  readPreviewTicket,
  resetPreviewTickets,
} from '../../../shared/preview-tickets.js';

afterEach(() => {
  vi.useRealTimers();
  resetPreviewTickets();
});

describe('预览票据', () => {
  test('签发的票据能读回来,并且带着它被限定的目录', () => {
    const ticket = issuePreviewTicket({ projectId: 'p1', relDir: 'reports' });

    assert.match(ticket, /^[a-f0-9]{64}$/);
    assert.deepEqual(readPreviewTicket(ticket), { projectId: 'p1', relDir: 'reports' });
  });

  test('项目根目录下的文件 relDir 为空串,不是 undefined', () => {
    const ticket = issuePreviewTicket({ projectId: 'p1', relDir: '' });
    assert.deepEqual(readPreviewTicket(ticket), { projectId: 'p1', relDir: '' });
  });

  test('两次签发不会撞车', () => {
    const a = issuePreviewTicket({ projectId: 'p1', relDir: '' });
    const b = issuePreviewTicket({ projectId: 'p1', relDir: '' });
    assert.notEqual(a, b);
  });

  test('可以重复使用 —— 一次预览要拉文档加它引用的所有资源', () => {
    const ticket = issuePreviewTicket({ projectId: 'p1', relDir: '' });
    assert.ok(readPreviewTicket(ticket));
    assert.ok(readPreviewTicket(ticket));
    assert.ok(readPreviewTicket(ticket));
  });

  test('5 分钟后失效,并且是读的时候就判掉,不依赖清扫定时器', () => {
    vi.useFakeTimers();
    const ticket = issuePreviewTicket({ projectId: 'p1', relDir: '' });

    vi.advanceTimersByTime(PREVIEW_TICKET_TTL_MS - 1);
    assert.ok(readPreviewTicket(ticket), '还没到期就不该失效');

    vi.advanceTimersByTime(2);
    assert.equal(readPreviewTicket(ticket), null);
  });

  test('未知票据、空值一律 null,不抛异常', () => {
    assert.equal(readPreviewTicket('f'.repeat(64)), null);
    assert.equal(readPreviewTicket(''), null);
    assert.equal(readPreviewTicket(undefined), null);
    assert.equal(readPreviewTicket(null), null);
    assert.equal(readPreviewTicket(123), null);
  });
});
