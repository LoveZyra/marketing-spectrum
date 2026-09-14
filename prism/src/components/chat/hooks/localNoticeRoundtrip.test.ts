import { describe, expect, it } from 'vitest';

import { activityItemRole } from '../utils/turnBoundary';
import type { ChatMessage } from '../types/types';

import { chatMessageToNormalized } from './useChatSessionState';
import { normalizedToChatMessages } from './useChatMessages';

/**
 * ga:**这条测试必须走完整条真实链路。**
 *
 * fw/fz 给前端那九处红字打了 `isLocalNotice`,`endsTurnForOutputs` 也按它放行 ——
 * 可这些红字全部走 `addMessage` → `chatMessageToNormalized` → store →
 * `normalizedToChatMessages`,而**标记在第一步就被剥掉了**
 * (`NormalizedMessage` 里当时根本没有这个字段)。
 * 修复代码在,数据到不了它:拖个大附件照旧把正在跑的清单折掉、标「已中断」、
 * 清空产出卡 —— 和 fw 之前一模一样。
 *
 * 而当时的单测是手搓 `{type:'error', isLocalNotice:true}` 字面量喂给纯函数,
 * 所以一直是绿的。**手搓字面量不算证明。**
 */
const roundTrip = (message: ChatMessage): ChatMessage => {
  const normalized = chatMessageToNormalized(message, 'S', 'claude');
  expect(normalized).not.toBeNull();
  const back = normalizedToChatMessages([normalized!]);
  expect(back).toHaveLength(1);
  return back[0];
};

describe('isLocalNotice 走完 addMessage → store → 渲染 这条真实链路', () => {
  it('**本地红字的标记活得下来,而且不被当成回合边界**', () => {
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
