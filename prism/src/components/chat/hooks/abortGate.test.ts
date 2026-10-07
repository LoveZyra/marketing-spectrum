import { describe, expect, test } from 'vitest';

import { abortDiscardsPendingSend, canAbortActivity } from './useChatSessionState';

/**
 * 停止按钮不受 `canInterrupt` 限制。
 *
 * 自动压缩期间会发 `canInterrupt: false`;服务端的中止逻辑对它同样有效,前端不能因此让停止按钮失效。
 * 这里钉住两件事:
 *   1. 任何在跑的状态都必须可中止,包括压缩这种 canInterrupt=false 的;
 *   2. canInterrupt 只用来提示用户"这一下会连消息一起取消"。
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
