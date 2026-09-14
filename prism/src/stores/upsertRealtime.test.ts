import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { upsertRealtimeRows } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

/**
 * F16 的另一半:**实时行按 id 落位**,同一个 id 再来一次是覆盖,不是追加。
 *
 * 两个入口原来都是无脑 `[...realtime, ...新来的]`。而同一个事件会来第二次
 * (重连补发、订阅重叠、seq 跳号触发的补拉),于是同一个工具调用在屏幕上
 * 并排两份 —— 而且要等服务端行落库、prune 接管之后才收得掉。
 */
const row = (id: string, patch: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id,
  sessionId: 's1',
  timestamp: '2026-09-09T10:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content: id,
  ...patch,
} as NormalizedMessage);

describe('upsertRealtimeRows', () => {
  test('新 id 追加在末尾', () => {
    const out = upsertRealtimeRows([row('a')], [row('b')], 's1');
    assert.deepEqual(out.map((m) => m.id), ['a', 'b']);
  });

  test('同一个 id 再来一次 → 覆盖,不是两份', () => {
    const out = upsertRealtimeRows([row('a'), row('b')], [row('b', { content: '补上了结果' })], 's1');
    assert.deepEqual(out.map((m) => m.id), ['a', 'b']);
    assert.equal(out[1].content, '补上了结果', '后到的那份通常更完整,取后者');
  });

  test('覆盖**不改位置** —— 否则早先的工具行会被重排到末尾,屏幕顺序会跳', () => {
    const out = upsertRealtimeRows(
      [row('a'), row('b'), row('c')],
      [row('a', { content: '更新' })],
      's1',
    );
    assert.deepEqual(out.map((m) => m.id), ['a', 'b', 'c']);
    assert.equal(out[0].content, '更新');
  });

  test('一批里带重复 id:批内也只留一份', () => {
    const out = upsertRealtimeRows(
      [],
      [row('x', { content: '第一次' }), row('y'), row('x', { content: '第二次' })],
      's1',
    );
    assert.deepEqual(out.map((m) => m.id), ['x', 'y']);
    assert.equal(out[0].content, '第二次');
  });

  test('归属会话被强制改写成目标会话', () => {
    const out = upsertRealtimeRows([], [row('a', { sessionId: '别的会话' })], 's1');
    assert.equal(out[0].sessionId, 's1');
  });

  test('空输入原样返回同一个数组(不触发无谓的重渲染)', () => {
    const existing = [row('a')];
    assert.equal(upsertRealtimeRows(existing, [], 's1'), existing);
  });

  test('超过上限时从头部裁剪 —— 保留最近的那一段', () => {
    const existing = Array.from({ length: 500 }, (_, i) => row(`m${i}`));
    const out = upsertRealtimeRows(existing, [row('new')], 's1');
    assert.equal(out.length, 500);
    assert.equal(out[out.length - 1].id, 'new');
    assert.equal(out[0].id, 'm1', '裁掉的是最早那条');
  });

  test('覆盖已有行时**不会**因为长度不变而漏裁 —— 长度本来就没涨', () => {
    const existing = Array.from({ length: 500 }, (_, i) => row(`m${i}`));
    const out = upsertRealtimeRows(existing, [row('m0', { content: '更新' })], 's1');
    assert.equal(out.length, 500);
    assert.equal(out[0].id, 'm0');
    assert.equal(out[0].content, '更新');
  });
});
