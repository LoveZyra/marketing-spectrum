import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  computeMerged,
  pruneRealtimeSupersededByServer,
  upsertRealtimeRows,
  withoutLocalEcho,
} from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

/**
 * 本地乐观回声 ↔ 服务端用户行的配对。
 *
 * 发送时前端先画一条 `local_*` 回声,服务端落库的那一行(以及同一行作为实时帧推来的那一份)
 * 带着同一个 `clientMessageId`。配对按这个键精确进行:同键才是它的回声、异键一定不是;
 * 服务端行没有这个键(升级前写的老行、定时任务和外部 API 写的行)才退回"同文 + 时间窗"。
 * 一条服务端行最多认领一条本地行。
 */
const message = (id: string, patch: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id,
  sessionId: 's1',
  timestamp: '2026-10-07T10:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  content: id,
  ...patch,
} as NormalizedMessage);

const user = (id: string, content: string, timestamp: string, clientMessageId?: string) =>
  message(id, { role: 'user', content, timestamp, ...(clientMessageId ? { clientMessageId } : {}) });

const assistant = (id: string, content: string, timestamp: string) =>
  message(id, { role: 'assistant', content, timestamp });

const thinking = (id: string, content: string, timestamp: string) =>
  message(id, { kind: 'thinking', role: 'assistant', content, timestamp });

const T0 = '2026-10-07T10:00:00.000Z';
const T0_20S = '2026-10-07T10:00:20.000Z';
const T2M = '2026-10-07T10:02:00.000Z';
const T2M_5S = '2026-10-07T10:02:05.000Z';

describe('两分钟内重发同一句话', () => {
  // 第一轮的「继续」已经落库(带着它自己的幂等键),两分钟后又发了一次「继续」
  const server = [
    user('srv_u1', '继续', T0, 'cmid-1'),
    assistant('srv_a1', '好的,第一步做完了。', T0_20S),
  ];
  const realtime = [user('local_2', '继续', T2M, 'cmid-2')];

  test('本地行可见:上一轮的同文消息不认领它', () => {
    const merged = computeMerged(server, realtime);
    assert.deepEqual(merged.map((m) => m.id), ['srv_u1', 'srv_a1', 'local_2']);
  });

  test('服务端快照落地时本地行不被剪掉', () => {
    assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime).map((m) => m.id), ['local_2']);
  });

  test('第二轮的 thinking 与第一轮同文也不被当成回声剪掉(回合序号不并轮)', () => {
    const serverWithThinking = [
      user('srv_u1', '继续', T0, 'cmid-1'),
      thinking('srv_t1', '先跑一遍测试', '2026-10-07T10:00:05.000Z'),
      assistant('srv_a1', '好的,第一步做完了。', T0_20S),
    ];
    const live = [
      user('local_2', '继续', T2M, 'cmid-2'),
      thinking('rt_t2', '先跑一遍测试', T2M_5S),
    ];
    assert.deepEqual(
      pruneRealtimeSupersededByServer(serverWithThinking, live).map((m) => m.id),
      ['local_2', 'rt_t2'],
      '第二轮还没落库,它的 thinking 必须留着',
    );
  });

  test('第二句落库之后,它认领的是自己那份,不是上一轮那条', () => {
    const persisted = [...server, user('srv_u2', '继续', '2026-10-07T10:02:01.000Z', 'cmid-2')];
    assert.deepEqual(computeMerged(persisted, realtime).map((m) => m.id), ['srv_u1', 'srv_a1', 'srv_u2']);
    assert.deepEqual(pruneRealtimeSupersededByServer(persisted, realtime), []);
  });
});

describe('按 clientMessageId 精确配对', () => {
  test('同键:正文不完全一样也是它的回声(服务端那份可能带着附件块)', () => {
    const server = [user('srv_1', '看看这个\n\n<attached-document name="a.pdf">…</attached-document>', T0, 'cmid-a')];
    const realtime = [user('local_1', '看看这个', T0, 'cmid-a')];
    assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['srv_1']);
    assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime), []);
  });

  test('异键:同文、同一秒也不是它的回声', () => {
    const server = [user('srv_1', '好', T0, 'cmid-x')];
    const realtime = [user('local_1', '好', '2026-10-07T10:00:01.000Z', 'cmid-y')];
    assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['srv_1', 'local_1']);
    assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime).map((m) => m.id), ['local_1']);
  });

  test('服务端行没有幂等键(老行 / 定时任务 / 外部 API):退回同文 + 时间窗', () => {
    const server = [user('srv_1', '帮我看下这个报错', '2026-10-07T10:00:00.500Z')];
    const realtime = [user('local_1', '帮我看下这个报错', T0, 'cmid-1')];
    assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['srv_1']);
    assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime), []);
  });

  test('一条服务端行最多认领一条本地行', () => {
    // 老服务端:落库行不带幂等键。连发两次「好」,服务端只落了第一条。
    const server = [user('srv_1', '好', T0)];
    const realtime = [
      user('local_a', '好', '2026-10-07T10:00:01.000Z', 'cmid-a'),
      user('local_b', '好', '2026-10-07T10:00:30.000Z', 'cmid-b'),
    ];
    assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['srv_1', 'local_b']);
    assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime).map((m) => m.id), ['local_b']);
  });

  test('两边都没有幂等键、两分钟内重发同一句:上一轮那条不认领它', () => {
    // 回声按服务器时钟打过戳,服务端那份不会比它早出几分钟;早两分钟的只能是上一轮
    const server = [
      user('srv_u1', '继续', T0),
      assistant('srv_a1', '好的,第一步做完了。', T0_20S),
    ];
    const realtime = [user('local_1', '继续', T2M)];
    assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['srv_u1', 'srv_a1', 'local_1']);
    assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime).map((m) => m.id), ['local_1']);
  });

  test('校正过的回声:服务端那份早几秒(估计误差)照样认领', () => {
    const server = [user('srv_1', '好', '2026-10-07T10:01:55.000Z')];
    const realtime = [user('local_1', '好', T2M, 'cmid-1')];
    assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['srv_1']);
  });

  test('打戳时还没有时钟样本的回声(浏览器表快两分钟):服务端那份早两分钟也认领', () => {
    const server = [user('srv_1', '帮我看下这个报错', T0)];
    const realtime = [message('local_1', { role: 'user', content: '帮我看下这个报错', timestamp: T2M, clientMessageId: 'cmid-1', clockUnsynced: true })];
    assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['srv_1']);
    assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime), []);
  });

  test('精确配对优先:有同键的那条时,无键老行不抢先认领', () => {
    const server = [
      user('srv_old', '继续', '2026-10-07T09:58:30.000Z'),
      user('srv_new', '继续', '2026-10-07T10:00:01.000Z', 'cmid-1'),
    ];
    const realtime = [user('local_1', '继续', T0, 'cmid-1')];
    assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['srv_old', 'srv_new']);
  });
});

describe('实时用户帧与本地回声', () => {
  const tool = (id: string) => message(id, { kind: 'tool_use', role: 'assistant', toolId: id, content: '' });

  test('同键的实时用户帧原位替换本地回声 —— 不出两份,位置不动,id 换成服务端的', () => {
    const existing = [user('local_1', '问一句', T0, 'cmid-1'), tool('t1')];
    const frame = user('srv_9', '问一句', '2026-10-07T10:00:00.300Z', 'cmid-1');
    const out = upsertRealtimeRows(existing, [frame], 's1');
    assert.deepEqual(out.map((m) => m.id), ['srv_9', 't1']);
    assert.equal(out[0].timestamp, frame.timestamp, '取服务端那份(服务器时钟)');
  });

  test('实时帧先到、本地回声后到:回声不再追加', () => {
    const existing = [user('srv_9', '问一句', T0, 'cmid-1')];
    const out = upsertRealtimeRows(existing, [user('local_1', '问一句', T0, 'cmid-1')], 's1');
    assert.deepEqual(out.map((m) => m.id), ['srv_9']);
  });

  test('没有对应回声的实时用户帧(别人发的 / 另一个标签页发的)照常追加', () => {
    const existing = [user('local_1', '我的', T0, 'cmid-1')];
    const out = upsertRealtimeRows(existing, [user('srv_9', '别人的', T0, 'cmid-2'), user('srv_10', '定时任务', T0)], 's1');
    assert.deepEqual(out.map((m) => m.id), ['local_1', 'srv_9', 'srv_10']);
  });

  test('发起端整条链路:回声 → 本轮的 thinking → 实时用户帧,合并视图里只有一个提问气泡', () => {
    let rows = upsertRealtimeRows([], [user('local_1', '问一句', T0, 'cmid-1')], 's1');
    rows = upsertRealtimeRows(rows, [thinking('rt_th', '想一想', '2026-10-07T10:00:01.000Z')], 's1');
    rows = upsertRealtimeRows(rows, [user('srv_9', '问一句', '2026-10-07T10:00:00.300Z', 'cmid-1')], 's1');
    const merged = computeMerged([], rows);
    assert.deepEqual(merged.filter((m) => m.role === 'user').map((m) => m.id), ['srv_9']);
    assert.deepEqual(merged.map((m) => m.id), ['srv_9', 'rt_th']);
  });

  test('之后服务端快照里出现同 id 的行,实时那份按同 id 规则被取代', () => {
    const realtime = upsertRealtimeRows([user('local_1', '问一句', T0, 'cmid-1')], [user('srv_9', '问一句', T0, 'cmid-1')], 's1');
    const server = [user('srv_9', '问一句', T0, 'cmid-1')];
    assert.deepEqual(computeMerged(server, realtime).map((m) => m.id), ['srv_9']);
    assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime), []);
  });
});

describe('withoutLocalEcho:没发出去的那条从对话里撤掉', () => {
  test('只撤本地回声,同键的服务端行与别的行不动', () => {
    const rows = [
      user('local_1', '排队的那句', T0, 'cmid-1'),
      user('local_2', '另一句', T0, 'cmid-2'),
      assistant('a1', '回答', T0),
    ];
    const { rows: next, removed } = withoutLocalEcho(rows, 'cmid-1');
    assert.deepEqual(next.map((m) => m.id), ['local_2', 'a1']);
    assert.equal(removed?.content, '排队的那句');
  });

  test('没有这条回声时原样返回同一个数组', () => {
    const rows = [user('srv_1', '已落库', T0, 'cmid-1')];
    const result = withoutLocalEcho(rows, 'cmid-1');
    assert.equal(result.rows, rows);
    assert.equal(result.removed, null);
  });
});

describe('realtime 超上限裁剪时保留用户行', () => {
  test('长回合里本轮提问不被挤掉', () => {
    let rows = [user('local_u1', '跑一遍全量测试', '2026-10-07T10:00:30.000Z', 'cmid-1')];
    for (let i = 0; i < 260; i += 1) {
      rows = upsertRealtimeRows(rows, [
        message(`tu${i}`, { kind: 'tool_use', role: 'assistant', toolId: `t${i}`, timestamp: '2026-10-07T10:01:00.000Z' }),
        message(`tr${i}`, { kind: 'tool_result', toolId: `t${i}`, timestamp: '2026-10-07T10:01:00.000Z' }),
      ], 's1');
    }
    assert.equal(rows.length, 500);
    assert.equal(rows[0].id, 'local_u1', '用户行留在原位(最前面)');
    assert.equal(rows[rows.length - 1].id, 'tr259', '最新的那一段完整保留');
    // 520 条工具行留下最后 499 条:最早的 21 条(tu0 … tu10)被裁掉
    assert.equal(rows[1].id, 'tr10', '裁掉的是最早的那些工具行');
  });

  test('全是用户行也照样封顶', () => {
    const rows = Array.from({ length: 501 }, (_, i) => user(`u${i}`, `第 ${i} 句`, T0, `c${i}`));
    const out = upsertRealtimeRows(rows.slice(0, 500), [rows[500]], 's1');
    assert.equal(out.length, 500);
    assert.equal(out[0].id, 'u1');
  });
});
