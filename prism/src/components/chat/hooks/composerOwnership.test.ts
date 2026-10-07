import { describe, expect, it } from 'vitest';

import { composerStillOwnedBySubmit } from './useChatComposerState';

/**
 * 提交收尾时,输入框是否仍属于这次提交;新会话第一条消息发完之后,输入框必须清空。
 *
 * 新会话页的 `submitSessionKey` 是 null,而这次发送自己会创建一条会话:`onSessionEstablished`
 * 之后当前会话键就变成新 id。判据若不把"这次发送建立的那条"算进去,会误判为用户切走而不清输入框;
 * 用户再按回车会撞上正在跑的回合进入排队,回合结束自动续发后输入框仍不清,同一句话就会反复发送。
 */
describe('composerStillOwnedBySubmit', () => {
  it('会话没变 → 清', () => {
    expect(composerStillOwnedBySubmit('s1', 's1', null)).toBe(true);
  });

  it('新会话页发出的那一条:null → 这次发送建的那条,照样是同一个输入框', () => {
    // 这里若返回 false,输入框不清,就会进入上面说的反复发送循环。
    expect(composerStillOwnedBySubmit('new-1', null, 'new-1')).toBe(true);
  });

  it('新会话页发出,但期间用户切到了别的会话 → 不清', () => {
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

  it('已有会话里发送、期间切走,而这次发送没有建新会话 → 不清', () => {
    expect(composerStillOwnedBySubmit('B', 'A', 'A')).toBe(false);
  });

  it('新会话页发出但服务端没给会话号 → 退回严格比较', () => {
    expect(composerStillOwnedBySubmit('s9', null, null)).toBe(false);
    expect(composerStillOwnedBySubmit(null, null, null)).toBe(true);
  });
});
