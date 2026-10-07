import { describe, expect, it } from 'vitest';

import { takeIfOwned } from './useChatComposerState';

/**
 * 分叉点与隐藏上下文按会话隔离,而且取到了才清。
 *
 * 两者都可能是在别处装上的:
 *   - 分叉点(编辑重跑)要先走一次 `/api/claude/fork-point`,期间用户可能切到别的会话,
 *     装上时的 composer 已经不是发起时那个;
 *   - 隐藏上下文由一个全局 window 事件装上,没有会话概念。
 *
 * 不判归属时:在 A 里点「编辑重跑」→ 网络还没回来就切到 B → 在 B 里发一句话,
 * 这一句会从 A 的 provider 会话分叉出去,B 的对话被接到 A 的历史上。
 */
describe('takeIfOwned', () => {
  const fork = { owner: 's1', providerSessionId: 'prov-1', resumeSessionAt: 'uuid-9' };

  it('归属相同 → 取到,并且不带 owner 字段(它不进命令)', () => {
    const taken = takeIfOwned(fork, 's1');
    expect(taken.consumed).toBe(true);
    expect(taken.value).toEqual({ providerSessionId: 'prov-1', resumeSessionAt: 'uuid-9' });
  });

  it('归属不同 → 取不到,而且 consumed=false(不许清掉别人的那一份)', () => {
    const taken = takeIfOwned(fork, 's2');
    expect(taken.value).toBeNull();
    expect(taken.consumed).toBe(false);
  });

  it('什么都没装 → 取不到,也没有可清的', () => {
    const taken = takeIfOwned(null, 's1');
    expect(taken.value).toBeNull();
    expect(taken.consumed).toBe(false);
  });

  it('新会话页(owner 为 null)只匹配同样是 null 的那一份', () => {
    const armedOnNewSessionPage = { owner: null, value: '隐藏说明' };
    expect(takeIfOwned(armedOnNewSessionPage, null).consumed).toBe(true);
    expect(takeIfOwned(armedOnNewSessionPage, 's1').consumed).toBe(false);
    expect(takeIfOwned(fork, null).consumed).toBe(false);
  });

  it('隐藏上下文同一套规则', () => {
    const hidden = { owner: 's1', value: '一次性票据与接口用法' };
    expect(takeIfOwned(hidden, 's1').value).toEqual({ value: '一次性票据与接口用法' });
    expect(takeIfOwned(hidden, 's2').value).toBeNull();
  });
});
