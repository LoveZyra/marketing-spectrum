import { describe, expect, test } from 'vitest';

import { classifyOlderPage } from './useChatSessionState';

/**
 * 「看更早」补回来的这一页算什么结局。
 *
 * 必须按这一页的净增条数判断,不能看累计已加载条数:流式期间新行不断落盘,补页按已加载条数
 * 算 offset 从尾部取页,取回的一页可能与已加载窗口完全重叠(去重后净增 0),服务端却仍报
 * `hasMore: true`。把它当成加载成功,自动补页会以为自己在前进,打满 30 次请求而界面不动。
 */
const slot = (loaded: number, hasMore: boolean) => ({
  serverMessages: new Array(loaded).fill(null),
  hasMore,
});

describe('classifyOlderPage', () => {
  test('真的多出来了 → loaded', () => {
    expect(classifyOlderPage(slot(40, true), 20)).toBe('loaded');
  });

  test('多出来了、而且服务端说到头了 → 仍是 loaded(收尾由调用方做)', () => {
    // 这一页要前插、可见窗口要放开,同时才是「全部到手」。合成一个结局会漏掉前者。
    expect(classifyOlderPage(slot(35, false), 20)).toBe('loaded');
  });

  test('一条没多、服务端说没有了 → exhausted', () => {
    expect(classifyOlderPage(slot(20, false), 20)).toBe('exhausted');
  });

  test('一条没多、服务端却说还有 → stalled,不能当成加载成功', () => {
    // 自动补页会在这个状态上空转到请求上限。
    expect(classifyOlderPage(slot(20, true), 20)).toBe('stalled');
  });

  test('累计条数不为 0 也可能一条没多 —— 原来的判据在这里恒假', () => {
    // 判据是净增条数而不是累计条数:累计 20 条、净增 0 不能算成功。
    expect(classifyOlderPage(slot(20, true), 20)).not.toBe('loaded');
  });

  test('请求失败(null)→ failed,与"没有更多"区分开', () => {
    // 两者都会让「看更早」停下,但只有失败要提示用户,而且不能置
    // allMessagesLoaded —— 那会让这条会话的分页永久关死。
    expect(classifyOlderPage(null, 20)).toBe('failed');
    expect(classifyOlderPage(undefined, 0)).toBe('failed');
  });

  test('空会话:一条也没有、也没有更多 → exhausted(不是 loaded)', () => {
    expect(classifyOlderPage(slot(0, false), 0)).toBe('exhausted');
  });
});
