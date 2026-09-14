import { describe, expect, it } from 'vitest';

import { composerStillOwnedBySubmit } from './useChatComposerState';

/**
 * **新会话第一条消息发完之后,输入框必须清空。**
 *
 * ## 这条测试对应的线上现象
 *
 * "图片和文字一起发出后,还会有同样的文字排队,会一直发送,不会停止。"
 *
 * ## 机制
 *
 * 判据原来是 `sessionKey === submitSessionKey` —— 两者是同一个闭包变量,恒等,
 * 这道守卫从来没生效过。fl 把它改成读 ref,修好了"发送期间切走、清空了新会话
 * 输入框"那件事,**却把新会话这一支一起收窄掉了**:
 *
 *   新会话页 `submitSessionKey` 是 null,而这次发送**自己会创建**一条会话 ——
 *   `onSessionEstablished` 一调,ref 就变成新 id。收尾时 `id !== null`,
 *   守卫判定"用户切走了",输入框不清。
 *
 * 那句话于是留在输入框里。用户看到消息已发出、输入框却没空,自然再按一次回车 ——
 * 撞上正在跑的回合被收进排队;回合结束自动续发,发完输入框依然没清(同一个判据),
 * 再排一次……同一句话反复发送,而排队卡上永远显示着它。
 *
 * 又一次是同一个形状:**收窄一个判据时只收窄了它的一半。**
 */
describe('composerStillOwnedBySubmit', () => {
  it('会话没变 → 清', () => {
    expect(composerStillOwnedBySubmit('s1', 's1', null)).toBe(true);
  });

  it('**新会话页发出的那一条**:null → 这次发送建的那条,照样是同一个输入框', () => {
    // 这就是那个循环的入口。fl 之后这里返回 false,输入框不清。
    expect(composerStillOwnedBySubmit('new-1', null, 'new-1')).toBe(true);
  });

  it('新会话页发出,但期间用户切到了**别的**会话 → 不清', () => {
    expect(composerStillOwnedBySubmit('other', null, 'new-1')).toBe(false);
  });

  it('新会话页发出,期间切回了新会话页 → 不清(这个输入框已经是下一条对话的了)', () => {
    expect(composerStillOwnedBySubmit(null, null, 'new-1')).toBe(true);
  });

  it('已有会话里发送,期间切走 → 不清(fl 要修的那件事,保住)', () => {
    // 在 A 里发送(要等上传/建会话)→ 切到 B → 在 B 里打字 → A 的发送完成,
    // 若这里返回 true,B 的输入框当场清空,刚打的字消失。
    expect(composerStillOwnedBySubmit('B', 'A', null)).toBe(false);
  });

  it('已有会话里发送、期间切走,而这次发送**没有**建新会话 → 不清', () => {
    expect(composerStillOwnedBySubmit('B', 'A', 'A')).toBe(false);
  });

  it('新会话页发出但服务端没给会话号 → 退回严格比较', () => {
    expect(composerStillOwnedBySubmit('s9', null, null)).toBe(false);
    expect(composerStillOwnedBySubmit(null, null, null)).toBe(true);
  });
});
