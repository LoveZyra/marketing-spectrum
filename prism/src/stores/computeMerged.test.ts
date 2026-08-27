import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { computeMerged } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

/**
 * G1:聊天消息的合并逻辑。
 *
 * 屏幕上那一串是"服务端历史 + 本地实时"合出来的,而这段是整个聊天里最容易出
 * **重影**(同一句话两个气泡)和**顺序错乱**(实时行全堆在最底下)的地方 ——
 * bw 轮修过一次,cq 轮又碰过一次。它是纯函数,直接钉行为最便宜。
 */
const message = (
  id: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 's1',
  timestamp: '2026-08-27T10:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  content: id,
  ...overrides,
} as NormalizedMessage);

const user = (id: string, content: string, timestamp: string) =>
  message(id, { role: 'user', content, timestamp });

const assistant = (id: string, content: string, timestamp: string) =>
  message(id, { role: 'assistant', content, timestamp });

describe('computeMerged', () => {
  test('只有一侧时原样返回', () => {
    const server = [user('s1', '问题', '2026-08-27T10:00:00.000Z')];
    assert.deepEqual(computeMerged(server, []).map((m) => m.id), ['s1']);
    assert.deepEqual(computeMerged([], server).map((m) => m.id), ['s1']);
    assert.deepEqual(computeMerged([], []), []);
  });

  test('id 相同的实时行不重复出现 —— 服务端那份是权威', () => {
    const shared = assistant('a1', '回答', '2026-08-27T10:00:01.000Z');
    const merged = computeMerged([shared], [shared]);
    assert.equal(merged.length, 1);
  });

  test('乐观的 local_ 用户行在服务端回声到达后消失(不留重影)', () => {
    const local = user('local_123', '帮我看下这个报错', '2026-08-27T10:00:00.000Z');
    const echoed = user('srv_1', '帮我看下这个报错', '2026-08-27T10:00:00.500Z');

    const merged = computeMerged([echoed], [local]);
    assert.deepEqual(merged.map((m) => m.id), ['srv_1'], '同一句话不该出现两个气泡');
  });

  test('**重复发同一句话**不会被误当成回声吞掉 —— 时间窗之外的照常显示', () => {
    const echoed = user('srv_1', '继续', '2026-08-27T10:00:00.000Z');
    // 十分钟后又发了一次"继续",服务端还没回声 —— 这条必须留在屏幕上
    const localAgain = user('local_999', '继续', '2026-08-27T10:10:00.000Z');

    const merged = computeMerged([echoed], [localAgain]);
    assert.deepEqual(merged.map((m) => m.id), ['srv_1', 'local_999']);
  });

  test('实时行按时间戳插回它所属的那一轮,而不是堆在最底下', () => {
    const server = [
      user('s1', '第一问', '2026-08-27T10:00:00.000Z'),
      assistant('s2', '第一答', '2026-08-27T10:00:05.000Z'),
      user('s3', '第二问', '2026-08-27T10:00:10.000Z'),
    ];
    // 一条属于第一轮、服务端还没落库的实时行
    const realtime = [assistant('rt1', '第一轮的补充', '2026-08-27T10:00:06.000Z')];

    const merged = computeMerged(server, realtime);
    assert.deepEqual(merged.map((m) => m.id), ['s1', 's2', 'rt1', 's3']);
  });

  test('时间戳相同的消息保持稳定顺序,不会每次渲染换一次', () => {
    const server = [
      user('s1', 'a', '2026-08-27T10:00:00.000Z'),
      assistant('s2', 'b', '2026-08-27T10:00:00.000Z'),
    ];
    const realtime = [assistant('rt1', 'c', '2026-08-27T10:00:00.000Z')];

    const first = computeMerged(server, realtime).map((m) => m.id);
    const second = computeMerged(server, realtime).map((m) => m.id);
    assert.deepEqual(first, second, '同样的输入必须给同样的顺序');
  });

  test('时间戳缺失/损坏不会把整条链炸掉', () => {
    const server = [user('s1', '问题', 'not-a-date')];
    const realtime = [assistant('rt1', '回答', '')];

    const merged = computeMerged(server, realtime);
    assert.equal(merged.length, 2, '解析不出时间也要照常显示,只是顺序退化');
  });

  test('实时侧全是已知 id 时直接返回服务端那份(不做无谓的重排)', () => {
    const server = [
      user('s1', 'a', '2026-08-27T10:00:00.000Z'),
      assistant('s2', 'b', '2026-08-27T10:00:01.000Z'),
    ];
    const merged = computeMerged(server, [server[0]]);
    assert.deepEqual(merged.map((m) => m.id), ['s1', 's2']);
  });
});
