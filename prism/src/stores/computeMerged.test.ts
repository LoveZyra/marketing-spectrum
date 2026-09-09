import assert from 'node:assert/strict';

import { describe, expect, it, test } from 'vitest';

import { computeMerged, pruneRealtimeSupersededByServer } from './useSessionStore';
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

/**
 * fi:服务端刷新之后清本地实时行。
 *
 * 线上截图:同一组工具调用(「执行 17 条命令 → 读取 news-spec.md → 思考」)在
 * 一条会话里出现两次,F5 才消失。库里查过没有重复行 —— 是本地实时行没被清掉。
 *
 * 清理规则原来只认三类:id 撞上的、助手正文、带 toolId 的 tool_use。
 * `tool_result` 和 `thinking` 一条规则都没有,落到兜底 `return true` 永远留着。
 * 构造 id 不一致(服务端补了 id / 前端本地合成)的场景实测:3 条变 6 条。
 */
describe('pruneRealtimeSupersededByServer:服务端已有对应行时本地实时行要清掉', () => {
  const T = '2026-08-27T10:00:01.000Z';
  const turn = [user('u1', '来', '2026-08-27T10:00:00.000Z')];

  test('tool_result 按 toolId 清(与 tool_use 同源)', () => {
    const server = [...turn,
      message('srv-tu', { kind: 'tool_use', role: 'assistant', toolId: 'T1', timestamp: T }),
      message('srv-tr', { kind: 'tool_result', role: 'assistant', toolId: 'T1', content: 'ok', timestamp: T }),
    ];
    const realtime = [
      message('rt-tu', { kind: 'tool_use', role: 'assistant', toolId: 'T1', timestamp: T }),
      message('rt-tr', { kind: 'tool_result', role: 'assistant', toolId: 'T1', content: 'ok', timestamp: T }),
    ];
    const kept = pruneRealtimeSupersededByServer(server, realtime);
    assert.deepEqual(kept.map((m) => m.id), [], 'tool_use 和 tool_result 服务端都有了,本地两条都该清');
  });

  test('thinking 按"同一轮里服务端有同文"清(与助手正文同一套)', () => {
    const server = [...turn,
      message('srv-th', { kind: 'thinking', role: 'assistant', content: '先看规格', timestamp: T }),
    ];
    const realtime = [
      message('rt-th', { kind: 'thinking', role: 'assistant', content: '先看规格', timestamp: T }),
    ];
    assert.deepEqual(pruneRealtimeSupersededByServer(server, realtime).map((m) => m.id), []);
  });

  test('⚠️ 服务端还没落库的实时行必须留着 —— 回合进行中不能闪空', () => {
    /*
     * 这条是上面两条的边界。清理只能在"服务端确实有对应行"时发生;
     * 服务端还没写到的,哪怕 kind 相同也要留 —— 否则回合进行中每次刷新
     * 都会把还在进行的工具调用从屏幕上抹掉一瞬。
     */
    const server = [...turn,
      message('srv-tr', { kind: 'tool_result', role: 'assistant', toolId: 'T1', content: 'ok', timestamp: T }),
    ];
    const realtime = [
      message('rt-tr-2', { kind: 'tool_result', role: 'assistant', toolId: 'T2', content: 'new', timestamp: T }),
      message('rt-th', { kind: 'thinking', role: 'assistant', content: '还没落库的想法', timestamp: T }),
    ];
    assert.deepEqual(
      pruneRealtimeSupersededByServer(server, realtime).map((m) => m.id),
      ['rt-tr-2', 'rt-th'],
      '服务端没有 T2 的结果、也没有这段 thinking,本地两条都要留',
    );
  });

  test('整组重影的原样复现:id 全不一致时合并后不能翻倍', () => {
    const server = [...turn,
      message('s1', { kind: 'thinking', role: 'assistant', content: '想', timestamp: T }),
      message('s2', { kind: 'tool_use', role: 'assistant', toolId: 'T1', timestamp: T }),
      message('s3', { kind: 'tool_result', role: 'assistant', toolId: 'T1', content: 'r', timestamp: T }),
    ];
    const realtime = [
      message('r1', { kind: 'thinking', role: 'assistant', content: '想', timestamp: T }),
      message('r2', { kind: 'tool_use', role: 'assistant', toolId: 'T1', timestamp: T }),
      message('r3', { kind: 'tool_result', role: 'assistant', toolId: 'T1', content: 'r', timestamp: T }),
    ];
    const merged = computeMerged(server, pruneRealtimeSupersededByServer(server, realtime));
    assert.equal(merged.length, 4, `1 条用户 + 3 条助手 = 4;得到 ${merged.length} 就是整组重影`);
  });
});

/**
 * fj:回合序号不许把同一句用户消息数两遍。
 *
 * 合并数组里同一句常常有两份(本地乐观行 `local_*` + 服务端落库那份),而
 * `computeMerged` 的去重是渲染时做的。序号多算之后,fi 那条按"同一轮同文"
 * 判定的 thinking 去重就会漏删或跨回合误删。
 */
describe('fj:回合序号与用户回声', () => {
  const userMsg = (id: string, content: string, ts: string) => ({
    id, kind: 'text', role: 'user', content, timestamp: ts, sessionId: 's', provider: 'claude',
  }) as never;
  const thinkingMsg = (id: string, ts: string) => ({
    id, kind: 'thinking', role: 'assistant', content: '想…', timestamp: ts, sessionId: 's', provider: 'claude',
  }) as never;

  it('乐观行与服务端那份同文时只算一轮', () => {
    const server = [userMsg('srv_1', '第一句', '2026-09-08T00:00:01.000Z')];
    const realtime = [
      userMsg('local_1', '第一句', '2026-09-08T00:00:01.000Z'),
      thinkingMsg('rt_think', '2026-09-08T00:00:02.000Z'),
    ];
    // 服务端已经有这条 thinking → 应当被剪掉(序号对得上才判得出"同一轮")
    const serverWithThinking = [
      ...server,
      thinkingMsg('srv_think', '2026-09-08T00:00:02.000Z'),
    ];
    const pruned = pruneRealtimeSupersededByServer(serverWithThinking, realtime);
    expect(pruned.some((m) => m.id === 'rt_think')).toBe(false);
  });
});
