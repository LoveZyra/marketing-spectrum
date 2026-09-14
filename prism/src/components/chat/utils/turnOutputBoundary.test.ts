import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';

import { canRenderTurnOutputs, endsTurnForOutputs } from './turnBoundary';

/**
 * fl(K02 回归):产出归属不许跨回合。
 *
 * fj 把"哪条消息能挂产出卡"的判据收窄了(此前 ExitPlanMode 之类会把卡吃掉),
 * 但**连清空也一起收窄了** —— 于是 `Write → 报错 → 用户又问一句 → 助手回答`
 * 这一串里,前一轮的文件被挂到了下一轮的回答下面,用户点开的是上一轮的文件。
 *
 * fu:这两个判据以前在这里**抄了一份** —— 组件里改了、测试里那份没改,
 * 就红不起来。现在从 `utils/turnBoundary` import 真身,组件用的也是同一份。
 */

/** 照抄 Pane 里的传递逻辑,拿一串消息跑一遍,返回每条最终拿到的产出。 */
function walk(items: ChatMessage[], groupOutputs: Map<number, string[]>): Array<string[]> {
  let pending: string[] = [];
  return items.map((item, index) => {
    if (groupOutputs.has(index)) {
      pending = groupOutputs.get(index)!;
      return [];
    }
    if (canRenderTurnOutputs(item)) {
      const taken = pending;
      pending = [];
      return taken;
    }
    if (endsTurnForOutputs(item)) pending = [];
    return [];
  });
}

const msg = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, content: '', timestamp: '2026-09-09T00:00:00Z', ...extra }) as ChatMessage;

describe('fl:产出归属不跨回合', () => {
  it('Write → 报错 → 用户提问 → 助手回答:文件不跟到下一轮', () => {
    const items = [
      msg('assistant'),                     // 0:占位(工具组在下面用 map 注入)
      msg('error'),                         // 1:本轮以错误收尾
      msg('user'),                          // 2:新一轮
      msg('assistant'),                     // 3:下一轮的回答 —— 不该拿到文件
    ];
    const out = walk(items, new Map([[0, ['/w/a.ts']]]));
    expect(out[3]).toEqual([]);
  });

  it('只有用户消息隔开时也不跨轮', () => {
    const items = [msg('assistant'), msg('user'), msg('assistant')];
    const out = walk(items, new Map([[0, ['/w/a.ts']]]));
    expect(out[2]).toEqual([]);
  });

  it('本轮内的不可展示行(思考 / 交互式提示)继续往下传 —— 这是 fj 修的那一条', () => {
    const items = [
      msg('assistant'),                                   // 0:工具组
      msg('assistant', { isInteractivePrompt: true }),    // 1:ExitPlanMode
      msg('assistant', { isThinking: true }),             // 2:思考
      msg('assistant'),                                   // 3:本轮的最终回答 —— 应当拿到
    ];
    const out = walk(items, new Map([[0, ['/w/a.ts']]]));
    expect(out[3]).toEqual(['/w/a.ts']);
  });

  it('流式中的助手行不领(等它落定)', () => {
    const items = [msg('assistant'), msg('assistant', { isStreaming: true }), msg('assistant')];
    const out = walk(items, new Map([[0, ['/w/a.ts']]]));
    expect(out[1]).toEqual([]);
    expect(out[2]).toEqual(['/w/a.ts']);
  });
});
