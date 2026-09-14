import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, test } from 'vitest';

import {
  EMPTY_SERVER_QUEUE,
  describeDroppedQueueMessage,
  queuedForSession,
  reduceServerQueue,
} from './serverQueue';

/**
 * B4:服务端排队卡片按会话存。
 *
 * 原来是全视图一个 `{sessionId, preview, enqueuedAt} | null`,而排队帧是
 * **所有已订阅会话**一起来的 —— 后来的会话把先前那条挤掉,切回去卡片就不见了,
 * 而服务端那条消息还在队列里等着。
 */
const q = (preview: string, enqueuedAt = '2026-09-09T10:00:00.000Z') => ({ preview, enqueuedAt });

describe('reduceServerQueue', () => {
  test('两条会话的排队互不干扰 —— 这就是当初被挤掉的那个场景', () => {
    let queue = reduceServerQueue(EMPTY_SERVER_QUEUE, 'A', q('A 的消息'));
    queue = reduceServerQueue(queue, 'B', q('B 的消息'));

    expect(queuedForSession(queue, 'A')?.preview).toBe('A 的消息');
    expect(queuedForSession(queue, 'B')?.preview).toBe('B 的消息');
  });

  test('清一条不影响另一条', () => {
    let queue = reduceServerQueue(EMPTY_SERVER_QUEUE, 'A', q('A 的消息'));
    queue = reduceServerQueue(queue, 'B', q('B 的消息'));
    queue = reduceServerQueue(queue, 'B', null);

    expect(queuedForSession(queue, 'A')?.preview).toBe('A 的消息');
    expect(queuedForSession(queue, 'B')).toBeNull();
  });

  test('没有变化时**返回同一个 Map** —— 空闲 ack 每秒好几帧,不能每帧都重渲染', () => {
    const empty = EMPTY_SERVER_QUEUE;
    expect(reduceServerQueue(empty, 'A', null)).toBe(empty);

    const one = reduceServerQueue(empty, 'A', q('排队中'));
    // 同一条 ack 重放:内容一模一样
    expect(reduceServerQueue(one, 'A', q('排队中'))).toBe(one);
    // 别的会话的空闲 ack
    expect(reduceServerQueue(one, 'B', null)).toBe(one);
  });

  test('内容变了就换新 Map(否则 React 不会重渲染)', () => {
    const one = reduceServerQueue(EMPTY_SERVER_QUEUE, 'A', q('排队中'));
    const two = reduceServerQueue(one, 'A', q('换了一条'));
    expect(two).not.toBe(one);
    expect(queuedForSession(two, 'A')?.preview).toBe('换了一条');
  });

  test('时间戳变了也算变了 —— 同样的文本重新排一次队是新的一条', () => {
    const one = reduceServerQueue(EMPTY_SERVER_QUEUE, 'A', q('继续', '2026-09-09T10:00:00.000Z'));
    const two = reduceServerQueue(one, 'A', q('继续', '2026-09-09T10:05:00.000Z'));
    expect(two).not.toBe(one);
  });

  test('只保留 preview / enqueuedAt —— 帧里多带的字段不进状态', () => {
    const queue = reduceServerQueue(
      EMPTY_SERVER_QUEUE,
      'A',
      { preview: 'x', enqueuedAt: 't', extra: 'ignored' } as unknown as { preview: string; enqueuedAt: string },
    );
    expect(queuedForSession(queue, 'A')).toEqual({ preview: 'x', enqueuedAt: 't' });
  });
});

describe('queuedForSession', () => {
  test('没有选中会话时恒为 null(新会话页不该显示别人的排队卡片)', () => {
    const queue = reduceServerQueue(EMPTY_SERVER_QUEUE, 'A', q('A 的消息'));
    expect(queuedForSession(queue, null)).toBeNull();
  });

  test('看的是没有排队的那条会话 → null', () => {
    const queue = reduceServerQueue(EMPTY_SERVER_QUEUE, 'A', q('A 的消息'));
    expect(queuedForSession(queue, 'B')).toBeNull();
  });
});

/**
 * ga:被丢弃的排队消息,提示文案必须按**实际发生的事**写。
 *
 * fz 把"正文已退回输入框"写死在 `undeliverable` 的文案里,而回填的前提是
 * "正在看这条会话"且"输入框是空的" —— 这条帧最常见的触发场景两个前提都不成立。
 * 于是用户被告知"东西还在你手上",他去输入框找,什么都没有。
 */
describe('describeDroppedQueueMessage', () => {
  it('真的退回输入框了 → 一句话都不说(东西在用户手上)', () => {
    expect(describeDroppedQueueMessage('aborted', '把配置也改一下', true)).toBeNull();
    expect(describeDroppedQueueMessage('undeliverable', '把配置也改一下', true)).toBeNull();
  });

  it('没退回去 → 不许再说"已退回输入框",而且要把原文抄出来', () => {
    const notice = describeDroppedQueueMessage('undeliverable', '把配置也改一下', false);
    expect(notice).not.toBeNull();
    expect(notice).not.toContain('已退回输入框');
    expect(notice).toContain('没能发出去');
    expect(notice).toContain('> 把配置也改一下');
  });

  it('多行原文逐行引用,不粘成一行', () => {
    const notice = describeDroppedQueueMessage('aborted', '第一行\n第二行', false);
    expect(notice).toContain('> 第一行\n> 第二行');
  });

  it('用户自己撤销的不提示 —— 他知道自己干了什么', () => {
    expect(describeDroppedQueueMessage('cancelled', '不想发了', false)).toBeNull();
  });

  it('过期作废照旧提示,原文一并带上', () => {
    const notice = describeDroppedQueueMessage('expired', '半小时前那句', false);
    expect(notice).toContain('30 分钟');
    expect(notice).toContain('> 半小时前那句');
  });

  it('没有正文时只说结论,不留一个空的"原文"小节', () => {
    const notice = describeDroppedQueueMessage('aborted', '   ', false);
    expect(notice).toBe('排队中的那条消息随本轮中止一起取消了,没有发送。');
    expect(describeDroppedQueueMessage('aborted', null, false)).toBe(notice);
  });

  it('reason 缺失 → 不提示(宁可不说,也别说错)', () => {
    expect(describeDroppedQueueMessage('', '内容', false)).toBeNull();
  });
});

/**
 * 上面证明"文案对了",下面证明**处理器真的按实际结果调它** —— 这一轮反复
 * 付代价的形状正是"判据写对了,喂给它的数据不是那个东西"。
 */
describe('chat_queue_cancelled 的接线', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../hooks/useChatRealtimeHandlers.ts', import.meta.url)),
    'utf8',
  );

  it('returnedToComposer 来自真实的回填回调,不是写死的', () => {
    expect(source).toMatch(/const returnedToComposer = Boolean\(/);
    expect(source).toMatch(/&& onServerQueueReturned\?\.\(sid, droppedContent\),/);
    expect(source).toMatch(/describeDroppedQueueMessage\(/);
  });

  it('文案不再由处理器现场拼 —— fz 那句写死的"已退回输入框"没有任何字符串留着', () => {
    // 只看字符串字面量(注释里引用它是为了记住这条教训)。
    expect(source).not.toMatch(/'[^'\n]*已退回输入框[^'\n]*'/);
    // 处理器里也不该再出现按 reason 现场拼文案的三元。
    expect(source).not.toMatch(/content: msg\.reason === 'aborted'/);
  });
});
