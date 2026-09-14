import { describe, expect, test } from 'vitest';

import { deriveChatViewState } from './useChatSessionState';

/**
 * B3:正文此刻处于哪一步 —— 由槽位派生,不再由一个视图级布尔量拼。
 *
 * 这里钉的是三组**过去分不开、因而各出过一次事故**的状态:
 *   1. `unknown` ≠ `empty` —— 槽位还没落地时按"空的"渲染,切会话第一帧会闪
 *      一下起始卡片;
 *   2. `error` ≠ `empty` —— 首屏失败后 loading 置回 false,一条 5000 条的会话
 *      渲染成「这里还没有消息」,而且**没有任何出口**;
 *   3. 已有内容时不回 `loading` —— 刷新/补页把整屏换成 shimmer 会让人以为
 *      内容没了。
 */
const slot = (patch: Partial<{ status: string; fetchedAt: number; merged: unknown[] }> = {}) => ({
  status: 'idle',
  fetchedAt: 0,
  merged: [],
  ...patch,
} as { status: never; fetchedAt: number; merged: unknown[] });

describe('deriveChatViewState', () => {
  test('新会话页(没有会话)→ ready,不是"在加载"', () => {
    // 这正是 fj 修过的那个漏点:离开会话到新会话页时没人放下 loading 标志,
    // 页面永久渲染成「正在加载会话消息…」,起始卡片再也不出现。
    expect(deriveChatViewState(null, undefined)).toBe('ready');
    expect(deriveChatViewState(null, slot({ status: 'loading' }))).toBe('ready');
  });

  test('选了会话但槽位还没建 → unknown(调用方按"还在等"渲染)', () => {
    expect(deriveChatViewState('s1', undefined)).toBe('unknown');
  });

  test('正在拉首屏 → loading', () => {
    expect(deriveChatViewState('s1', slot({ status: 'loading' }))).toBe('loading');
  });

  test('拉过一页、有内容 → ready', () => {
    expect(deriveChatViewState('s1', slot({ fetchedAt: 1, merged: [{}] }))).toBe('ready');
  });

  test('拉过一页、确实是空的 → empty', () => {
    // **空会话必须先落地过一页才算空。**
    expect(deriveChatViewState('s1', slot({ fetchedAt: 1, merged: [] }))).toBe('empty');
  });

  test('一页都没落地过时,即使 status 是 idle 也不算 empty', () => {
    // 槽位可能因为一帧实时消息先建起来,那时 fetchedAt 还是 0。
    expect(deriveChatViewState('s1', slot({ status: 'idle', fetchedAt: 0 }))).not.toBe('empty');
    expect(deriveChatViewState('s1', slot({ status: 'idle', fetchedAt: 0 }))).toBe('unknown');
  });

  test('首屏失败 → error,**不是** empty', () => {
    // 这一条是整个状态机的由来:失败长得像空会话,用户只能切走再切回来。
    expect(deriveChatViewState('s1', slot({ status: 'error' }))).toBe('error');
  });

  test('已经有内容之后再失败(刷新挂了)→ 仍是 ready,不把已读内容换成错误页', () => {
    expect(deriveChatViewState('s1', slot({ status: 'error', fetchedAt: 1, merged: [{}] }))).toBe('ready');
  });

  test('已经有内容之后再拉(补页/刷新)→ 仍是 ready,不闪 shimmer', () => {
    expect(deriveChatViewState('s1', slot({ status: 'loading', fetchedAt: 1, merged: [{}] }))).toBe('ready');
  });

  test('流式中 → ready(有内容就渲染内容)', () => {
    expect(deriveChatViewState('s1', slot({ status: 'streaming', fetchedAt: 1, merged: [{}] }))).toBe('ready');
  });
});
