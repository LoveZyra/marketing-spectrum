import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { createTicketStore } from '../ticket-store.js';
import { issueTicket, consumeTicket } from '../ws-tickets.js';
import { issuePreviewTicket, readPreviewTicket, resetPreviewTickets } from '../preview-tickets.js';

/**
 * 两类票据合并到同一份实现之后,最要紧的是它们的**语义差别没有被抹掉**:
 * WS 票据取出即废,预览票据必须能重复使用。合并时想当然地统一成一次性,
 * 坏掉的是编辑器预览里的图片和样式 —— 第一张图之后全部失败。
 */
describe('票据存储', () => {
  test('单次模式:第二次取不到', () => {
    const store = createTicketStore({ ttlMs: 60_000 });
    const ticket = store.issue({ userId: 7 });
    assert.deepEqual(store.consume(ticket), { userId: 7 });
    assert.equal(store.consume(ticket), null);
  });

  test('可重用模式:同一张票能取多次', () => {
    const store = createTicketStore({ ttlMs: 60_000, singleUse: false });
    const ticket = store.issue({ projectId: 'p' });
    assert.deepEqual(store.consume(ticket), { projectId: 'p' });
    assert.deepEqual(store.consume(ticket), { projectId: 'p' });
  });

  test('过期票在两种模式下都取不到,且会被清掉', () => {
    for (const singleUse of [true, false]) {
      const store = createTicketStore({ ttlMs: -1, singleUse });
      const ticket = store.issue({ x: 1 });
      assert.equal(store.consume(ticket), null, `singleUse=${singleUse}`);
      assert.equal(store.size(), 0, `singleUse=${singleUse} 过期票应当被清掉`);
    }
  });

  test('未知票据返回 null,不抛', () => {
    const store = createTicketStore({ ttlMs: 60_000 });
    assert.equal(store.consume('nope'), null);
    assert.equal(store.consume(''), null);
    assert.equal(store.consume(undefined), null);
  });

  test('validate 判否时不返回载荷,但票已被消费', () => {
    const store = createTicketStore({ ttlMs: 60_000 });
    const ticket = store.issue({ userId: 1 });
    assert.equal(store.consume(ticket, (p) => p.userId === 2), null);
    assert.equal(store.consume(ticket), null, '判否也算用掉了');
  });
});

describe('两类票据的对外契约不变', () => {
  test('WS 票据是一次性的', () => {
    const ticket = issueTicket(42);
    assert.deepEqual(consumeTicket(ticket), { userId: 42 });
    assert.equal(consumeTicket(ticket), null);
  });

  test('WS 票据拒绝空 userId', () => {
    assert.throws(() => issueTicket(''), /requires a userId/);
    assert.throws(() => issueTicket(null), /requires a userId/);
  });

  test('预览票据可重复使用 —— 一次预览要拉文档加它引用的每个资源', () => {
    resetPreviewTickets();
    const ticket = issuePreviewTicket({ projectId: 'proj', relDir: 'docs' });
    assert.deepEqual(readPreviewTicket(ticket), { projectId: 'proj', relDir: 'docs' });
    assert.deepEqual(readPreviewTicket(ticket), { projectId: 'proj', relDir: 'docs' });
    assert.deepEqual(readPreviewTicket(ticket), { projectId: 'proj', relDir: 'docs' });
    resetPreviewTickets();
  });

  test('预览票据的 relDir 省略时归一化为空串', () => {
    resetPreviewTickets();
    const ticket = issuePreviewTicket({ projectId: 'proj' });
    assert.deepEqual(readPreviewTicket(ticket), { projectId: 'proj', relDir: '' });
    resetPreviewTickets();
  });
});
