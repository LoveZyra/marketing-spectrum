import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';

import { canRenderTurnOutputs, endsTurnForOutputs } from './turnBoundary';

/**
 * 产出归属不许跨回合。
 *
 * 「领取」产出卡的判据(canRenderTurnOutputs)只认普通助手正文,ExitPlanMode、思考之类的行既不领也不清;
 * 「清空」的判据(endsTurnForOutputs)单独成立:用户消息与错误行就地清空,否则
 * `Write → 报错 → 用户又问一句 → 助手回答` 这一串里,前一轮的文件会挂到下一轮的回答下面。
 * 两个判据直接从 `utils/turnBoundary` 导入,与组件用的是同一份。
 */

/** 按 ChatMessagesPane 里的传递逻辑把一串消息跑一遍,返回每条最终拿到的产出。 */
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

describe('产出归属不跨回合', () => {
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

  it('本轮内的不可展示行(思考 / 交互式提示)继续往下传', () => {
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

describe('插话不是回合边界', () => {
  it('合流进这一轮的用户消息(interjection)不切断回合;普通用户消息照旧是边界', () => {
    const at = new Date('2026-10-01T00:00:00Z');
    expect(endsTurnForOutputs({ type: 'user', content: '插话', timestamp: at, interjection: true } as ChatMessage)).toBe(false);
    expect(endsTurnForOutputs({ type: 'user', content: '新一轮', timestamp: at } as ChatMessage)).toBe(true);
  });
});
