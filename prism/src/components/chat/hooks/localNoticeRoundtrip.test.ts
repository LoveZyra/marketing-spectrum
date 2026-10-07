import { describe, expect, it } from 'vitest';

import { activityItemRole } from '../utils/turnBoundary';
import type { ChatMessage } from '../types/types';

import { chatMessageToNormalized } from './useChatSessionState';
import { normalizedToChatMessages } from './useChatMessages';

/**
 * 这条测试必须走完整条真实链路。
 *
 * 前端本地红字(附件超限、文档解析失败等)带 `isLocalNotice`,`endsTurnForOutputs` 按它放行;
 * 这些红字走 `addMessage` → `chatMessageToNormalized` → store → `normalizedToChatMessages`,
 * 任何一步丢掉这个标记,拖个大附件就会把正在跑的清单折掉、标「已中断」、清空产出卡。
 * 只拿手写的 `{type:'error', isLocalNotice:true}` 字面量喂纯函数,证明不了这一点。
 */
const roundTrip = (message: ChatMessage): ChatMessage => {
  const normalized = chatMessageToNormalized(message, 'S', 'claude');
  expect(normalized).not.toBeNull();
  const back = normalizedToChatMessages([normalized!]);
  expect(back).toHaveLength(1);
  return back[0];
};

describe('isLocalNotice 走完 addMessage → store → 渲染 这条真实链路', () => {
  it('本地红字的标记活得下来,而且不被当成回合边界', () => {
    const back = roundTrip({
      type: 'error',
      isLocalNotice: true,
      content: '附件超过 20MB',
      timestamp: new Date(),
    } as ChatMessage);

    expect(back.isLocalNotice).toBe(true);
    expect(activityItemRole(back)).toBe('other');
  });

  it('provider 报的错照旧终结回合', () => {
    const back = roundTrip({
      type: 'error',
      content: '模型返回错误',
      timestamp: new Date(),
    } as ChatMessage);

    expect(back.isLocalNotice).toBeUndefined();
    expect(activityItemRole(back)).toBe('turn-boundary');
  });

  it('正文与时间戳没被这次往返改坏', () => {
    const back = roundTrip({
      type: 'error', isLocalNotice: true, content: '文档解析失败:a.pdf', timestamp: new Date(),
    } as ChatMessage);
    expect(back.content).toBe('文档解析失败:a.pdf');
    expect(back.type).toBe('error');
  });
});
