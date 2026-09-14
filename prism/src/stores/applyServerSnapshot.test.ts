import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { applyServerSnapshot, createEmptySlot } from './useSessionStore';
import type { NormalizedMessage, SessionSlot } from './useSessionStore';

/**
 * B1:四条取历史的路径(首屏 / 刷新 / 补页 / 搜索定位)收口到同一个归并函数。
 *
 * 之前它们各写一份:窗口替换、游标推进、total/hasMore、剪实时行、重算合并。
 * 三份长得像但**并不相同** —— 剪实时行只有首屏和刷新做、游标改写只有刷新
 * 写对了。fk 的两处回归(K01/K02)是同一个形状:**收窄一个判据时只收窄了
 * 它的一半**。这里钉的就是"规则只有一份"这件事,而不是某一条路径。
 */

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 9, 10, 0, seconds)).toISOString();

const message = (
  id: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 's1',
  timestamp: at(0),
  provider: 'claude',
  kind: 'text',
  content: id,
  ...overrides,
} as NormalizedMessage);

const user = (id: string, content: string, timestamp: string) =>
  message(id, { role: 'user', content, timestamp });

const assistant = (id: string, content: string, timestamp: string) =>
  message(id, { role: 'assistant', content, timestamp });

const toolUse = (id: string, toolId: string, timestamp: string) =>
  message(id, { kind: 'tool_use', role: 'assistant', toolId, content: '', timestamp });

function slotWith(patch: Partial<SessionSlot>): SessionSlot {
  return Object.assign(createEmptySlot(), patch);
}

describe('applyServerSnapshot — replace(首屏 / 刷新 / 搜索定位)', () => {
  test('窗口被整份换掉,游标跟着窗口一起改写', () => {
    const slot = slotWith({
      serverMessages: [user('s9', '旧窗口', at(9))],
      offset: 40,
      total: 40,
      hasMore: true,
    });

    applyServerSnapshot(slot, {
      messages: [user('s1', '新窗口', at(1)), assistant('s2', '回答', at(2))],
      total: 120,
      hasMore: true,
    }, { mode: 'replace' });

    assert.deepEqual(slot.serverMessages.map((m) => m.id), ['s1', 's2']);
    // 游标留在 40 而窗口只剩 2 条,下一次「看更早」就会从 offset=40 取页,
    // 服务端的尾部偏移语义直接跳过倒数 2~40 那一段(du 修过的那条)。
    assert.equal(slot.offset, 2, '游标必须等于当前窗口的条数');
    assert.equal(slot.total, 120);
    assert.equal(slot.hasMore, true);
  });

  test('搜索定位那一页带 offsetBase:游标 = 起点 + 本页条数', () => {
    const slot = createEmptySlot();

    applyServerSnapshot(slot, {
      messages: [user('s5', '第五条', at(5))],
      total: 120,
      hasMore: true,
    }, { mode: 'replace', offsetBase: 60 });

    assert.equal(slot.offset, 61);
  });

  test('服务端没给 total 时按本页条数兜底,hasMore 缺省为 false', () => {
    const slot = slotWith({ total: 99, hasMore: true });

    applyServerSnapshot(slot, { messages: [user('s1', '只有一条', at(1))] }, { mode: 'replace' });

    assert.equal(slot.total, 1);
    assert.equal(slot.hasMore, false);
  });
});

describe('applyServerSnapshot — prepend(补页)', () => {
  test('更早的一页前插在已加载窗口之前', () => {
    const slot = slotWith({
      serverMessages: [user('s3', '第三条', at(3))],
      offset: 1,
      total: 3,
      hasMore: true,
    });

    applyServerSnapshot(slot, {
      messages: [user('s1', '第一条', at(1)), user('s2', '第二条', at(2))],
      total: 3,
      hasMore: false,
    }, { mode: 'prepend' });

    assert.deepEqual(slot.serverMessages.map((m) => m.id), ['s1', 's2', 's3']);
    assert.equal(slot.hasMore, false);
  });

  test('与已加载窗口重叠的行不重复插入,但游标按服务端返回的条数推进', () => {
    // 流式期间新行不断落盘、total 在涨,而补页按"已加载条数"从尾部取页 ——
    // 这一页会和已加载窗口重叠。去重是本地的事,游标对应的是服务端分页位置。
    const slot = slotWith({
      serverMessages: [user('s2', '第二条', at(2)), user('s3', '第三条', at(3))],
      offset: 2,
      total: 5,
      hasMore: true,
    });

    applyServerSnapshot(slot, {
      messages: [user('s1', '第一条', at(1)), user('s2', '第二条', at(2))],
      total: 6,
      hasMore: true,
    }, { mode: 'prepend' });

    assert.deepEqual(slot.serverMessages.map((m) => m.id), ['s1', 's2', 's3'], '重叠那条不该出现两次');
    assert.equal(slot.offset, 4, '游标按服务端这一页返回的条数推进,不是去重后的条数');
    assert.equal(slot.total, 6, '补页也要跟上服务端的 total —— 原来这里不更新');
  });
});

describe('N02:补页也剪实时行', () => {
  test('补页取回的服务端行会顶掉 realtime 里的同一次工具调用', () => {
    // 回合在**非当前查看**的会话里跑完:complete 分支的刷新被 sid 判定挡掉,
    // realtime 里留着整整一轮。之后重新打开这条会话、再上翻一页,补页正好
    // 把那一轮的服务端行取了回来 —— 原来补页不剪,于是两份并排渲染到 F5。
    const slot = slotWith({
      serverMessages: [user('s9', '后面的问题', at(9))],
      realtimeMessages: [toolUse('rt_tool', 'toolu_01', at(2))],
      offset: 1,
      total: 3,
      hasMore: true,
    });

    applyServerSnapshot(slot, {
      messages: [user('s1', '前面的问题', at(1)), toolUse('s2', 'toolu_01', at(2))],
      total: 3,
      hasMore: false,
    }, { mode: 'prepend' });

    assert.deepEqual(
      slot.realtimeMessages.map((m) => m.id),
      [],
      '同一个 toolId 的服务端行已经补齐,实时那份必须被剪掉',
    );
    assert.deepEqual(slot.serverMessages.map((m) => m.id), ['s1', 's2', 's9']);
  });

  test('剪的依据是**合并后的完整窗口**,不是补回来的这一页', () => {
    // 只按这一页剪会把尾部那一轮尚未落盘的实时行误删 —— 它们的服务端行
    // 根本不在这一页里。
    const slot = slotWith({
      serverMessages: [user('s9', '最新的问题', at(9))],
      realtimeMessages: [
        toolUse('rt_old', 'toolu_01', at(2)),
        toolUse('rt_live', 'toolu_99', at(10)),
      ],
      offset: 1,
      total: 3,
      hasMore: true,
    });

    applyServerSnapshot(slot, {
      messages: [user('s1', '前面的问题', at(1)), toolUse('s2', 'toolu_01', at(2))],
      hasMore: false,
    }, { mode: 'prepend' });

    assert.deepEqual(
      slot.realtimeMessages.map((m) => m.id),
      ['rt_live'],
      '还没落盘的那一轮必须留在屏幕上',
    );
  });

  test('replace 同样剪:重开会话走首屏,那一轮不能渲染两份', () => {
    const slot = slotWith({
      realtimeMessages: [toolUse('rt_tool', 'toolu_01', at(2))],
    });

    applyServerSnapshot(slot, {
      messages: [user('s1', '问题', at(1)), toolUse('s2', 'toolu_01', at(2))],
    }, { mode: 'replace' });

    assert.deepEqual(slot.realtimeMessages.map((m) => m.id), []);
  });
});

describe('applyServerSnapshot — 附带状态', () => {
  test('tokenUsage 有才覆盖,没有就保留原值', () => {
    const slot = slotWith({ tokenUsage: { total: 1 } });

    applyServerSnapshot(slot, { messages: [] }, { mode: 'replace' });
    assert.deepEqual(slot.tokenUsage, { total: 1 }, '这一页没带用量,不该把已知的用量清空');

    applyServerSnapshot(slot, { messages: [], tokenUsage: { total: 2 } }, { mode: 'replace' });
    assert.deepEqual(slot.tokenUsage, { total: 2 });
  });

  test('落地后 merged 立即可用(调用方不必自己再重算一次)', () => {
    const slot = createEmptySlot();

    applyServerSnapshot(slot, {
      messages: [user('s1', '问题', at(1)), assistant('s2', '回答', at(2))],
    }, { mode: 'replace' });

    assert.deepEqual(slot.merged.map((m) => m.id), ['s1', 's2']);
    assert.ok(slot.fetchedAt > 0, 'fetchedAt 也在这里统一打时间戳');
  });
});


/**
 * fz:**前插之后要确认它真的是"更早的"。**
 *
 * 服务端的 offset 是尾部偏移。回合跑着、total 在涨,而这期间没有整体刷新落地 ——
 * 上翻一页取回的那一页尾部可能落在已有窗口**之后**:那几行比手里所有行都新,
 * 却不在 existingIds 里,于是被当成"更早的一页"塞到数组最前面。而这条落地路径
 * 紧接着 prune 掉它们的实时副本,computeMerged 随后走"realtime 为空就原样返回
 * server"的快路径 —— **不排序**。用户看到本轮最新的几条跳到 transcript 最顶端。
 */
describe('前插不许把更新的行放到前面', () => {
  test('这一页里混进了比手里所有行都新的几条 —— 落地之后仍按时间有序', () => {
    const slot: SessionSlot = createEmptySlot();
    // 手里是 [t20, t21]
    applyServerSnapshot(slot, {
      messages: [message('m20', { timestamp: at(20) }), message('m21', { timestamp: at(21) })],
      total: 2, hasMore: true,
    } as never, { mode: 'replace', offsetBase: 0 });

    // 补页取回 [t10, t11] 外加两条 total 涨出来的新行 [t30, t31]
    applyServerSnapshot(slot, {
      messages: [
        message('m10', { timestamp: at(10) }),
        message('m11', { timestamp: at(11) }),
        message('m30', { timestamp: at(30) }),
        message('m31', { timestamp: at(31) }),
      ],
      total: 6, hasMore: true,
    } as never, { mode: 'prepend' });

    assert.deepEqual(
      slot.serverMessages.map((m) => m.id),
      ['m10', 'm11', 'm20', 'm21', 'm30', 'm31'],
    );
  });

  test('纯粹的更早页 —— 引用不变(不白排一次)', () => {
    const slot: SessionSlot = createEmptySlot();
    applyServerSnapshot(slot, {
      messages: [message('m20', { timestamp: at(20) })], total: 1, hasMore: true,
    } as never, { mode: 'replace', offsetBase: 0 });

    applyServerSnapshot(slot, {
      messages: [message('m10', { timestamp: at(10) })], total: 2, hasMore: false,
    } as never, { mode: 'prepend' });

    assert.deepEqual(slot.serverMessages.map((m) => m.id), ['m10', 'm20']);
  });
});
