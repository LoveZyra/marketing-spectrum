import { describe, expect, test } from 'vitest';

import { abortDiscardsPendingSend, canAbortActivity } from './useChatSessionState';

/**
 * da:停止按钮不再被 `canInterrupt` 锁死。
 *
 * 事故现场:自动压缩发 `canInterrupt: false`,停止按钮却只按 isLoading 渲染 ——
 * 于是按钮可见、可点、按下去什么都不发生,而且没有任何反馈。用户盯着一个
 * 转了 20 分钟的"正在压缩"束手无策。服务端的中止逻辑一直是完整的。
 *
 * 这里盯死两件事:
 *   1. **任何**在跑的状态都必须可中止 —— 包括压缩这种 canInterrupt=false 的;
 *   2. canInterrupt 仍然有用,但只用来告诉用户"这一下会连消息一起取消"。
 */
describe('中止闸门', () => {
  test('压缩中(canInterrupt=false)照样可以中止 —— 这就是当初卡死的那个状态', () => {
    expect(canAbortActivity({ canInterrupt: false })).toBe(true);
  });

  test('普通运行中可以中止', () => {
    expect(canAbortActivity({ canInterrupt: true })).toBe(true);
    expect(canAbortActivity({})).toBe(true);
  });

  test('没有在跑的会话没有可中止的东西', () => {
    expect(canAbortActivity(null)).toBe(false);
  });

  test('canInterrupt=false 时提示"会连同刚发的消息一起取消"', () => {
    // 压缩发生在把用户消息推给 CLI 之前,中止会连那条消息一起丢掉。
    expect(abortDiscardsPendingSend({ canInterrupt: false })).toBe(true);
  });

  test('其余情况不提示,免得每次停止都吓唬人', () => {
    expect(abortDiscardsPendingSend({ canInterrupt: true })).toBe(false);
    expect(abortDiscardsPendingSend({})).toBe(false);
    expect(abortDiscardsPendingSend(null)).toBe(false);
  });
});
