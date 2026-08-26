import { describe, test, expect } from 'vitest';

import type { ChatMessage } from '../types/types';

import { groupConsecutiveTools, isSubagentGroupItem, isToolGroupItem, stabilizeGroupIdentity } from './toolGrouping';
import type { SubagentGroupItem, ToolGroupItem } from './toolGrouping';

const tool = (toolName: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: new Date('2026-08-26T00:00:00Z').toISOString(),
  isToolUse: true,
  toolName,
  ...extra,
});

const text = (content: string): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp: new Date('2026-08-26T00:00:00Z').toISOString(),
});

/**
 * C9 回归:组身份保持 —— 成员没变的活动段沿用上一轮的同一个组对象,
 * 让 memo(ActivityTimeline) 在流式 tick 间真正生效。
 */
describe('stabilizeGroupIdentity', () => {
  test('成员完全相同的段复用上一轮的组对象', () => {
    const a = tool('Read');
    const b = tool('Bash');
    const firstPass = groupConsecutiveTools([a, b]);
    const { items: firstItems, nextByAnchor } = stabilizeGroupIdentity(firstPass, new WeakMap());
    const firstGroup = firstItems[0] as ToolGroupItem;

    // 第二轮:同样的消息对象(store 里没变的消息就是同一个引用)
    const secondPass = groupConsecutiveTools([a, b]);
    const { items: secondItems } = stabilizeGroupIdentity(secondPass, nextByAnchor);
    expect(secondItems[0]).toBe(firstGroup);
  });

  test('段内新增一步:换新组对象', () => {
    const a = tool('Read');
    const b = tool('Bash');
    const { nextByAnchor } = stabilizeGroupIdentity(groupConsecutiveTools([a, b]), new WeakMap());

    const c = tool('Edit');
    const { items } = stabilizeGroupIdentity(groupConsecutiveTools([a, b, c]), nextByAnchor);
    const group = items[0] as ToolGroupItem;
    expect(group.messages).toHaveLength(3);
  });

  test('某一步被替换(如 tool_result 落地换了消息对象):换新组对象', () => {
    const a = tool('Read');
    const b = tool('Bash');
    const first = stabilizeGroupIdentity(groupConsecutiveTools([a, b]), new WeakMap());
    const firstGroup = first.items[0] as ToolGroupItem;

    const bWithResult = tool('Bash', { toolResult: { content: 'ok', isError: false } });
    const second = stabilizeGroupIdentity(groupConsecutiveTools([a, bWithResult]), first.nextByAnchor);
    expect(second.items[0]).not.toBe(firstGroup);
    expect((second.items[0] as ToolGroupItem).messages[1]).toBe(bWithResult);
  });

  test('非组条目原样透传,不影响相邻组的复用', () => {
    const a = tool('Read');
    const t1 = text('正文');
    const firstPass = groupConsecutiveTools([a, t1]);
    const first = stabilizeGroupIdentity(firstPass, new WeakMap());
    const firstGroup = first.items[0] as ToolGroupItem;
    expect(isToolGroupItem(first.items[1])).toBe(false);

    const t2 = text('正文换了一条');
    const second = stabilizeGroupIdentity(groupConsecutiveTools([a, t2]), first.nextByAnchor);
    expect(second.items[0]).toBe(firstGroup);
    expect(second.items[1]).toBe(t2);
  });
});

/**
 * cd 回归:回合中间的过渡性正文收进活动时间轴,收尾最终回答留在段外。
 */
describe('groupConsecutiveTools · 过渡正文吸收', () => {
  test('工具-正文-工具:一段三条,不再被正文切断', () => {
    const a = tool('Read');
    const mid = text('校验通过,接着写文档');
    const b = tool('Write');
    const items = groupConsecutiveTools([a, mid, b]);
    expect(items).toHaveLength(1);
    expect((items[0] as ToolGroupItem).messages).toEqual([a, mid, b]);
  });

  test('收尾正文(后面没有活动)保持段外大正文', () => {
    const a = tool('Read');
    const final = text('全部完成,总结如下…');
    const items = groupConsecutiveTools([a, final]);
    expect(items).toHaveLength(2);
    expect(isToolGroupItem(items[0])).toBe(true);
    expect(items[1]).toBe(final);
  });

  test('正文后面是用户消息:不吸收', () => {
    const a = tool('Read');
    const mid = text('说一句');
    const user: ChatMessage = { type: 'user', content: '继续', timestamp: new Date().toISOString() };
    const items = groupConsecutiveTools([a, mid, user]);
    expect(items).toHaveLength(3);
    expect(items[1]).toBe(mid);
  });

  test('回合开头正文后接工具:正文开段并入流程', () => {
    const lead = text('我来跑一下测试');
    const a = tool('Bash');
    const final = text('通过');
    const items = groupConsecutiveTools([lead, a, final]);
    expect(items).toHaveLength(2);
    expect((items[0] as ToolGroupItem).messages).toEqual([lead, a]);
    expect(items[1]).toBe(final);
  });

  test('连续两条中间正文一起吸收', () => {
    const a = tool('Read');
    const m1 = text('第一段说明');
    const m2 = text('第二段说明');
    const b = tool('Edit');
    const items = groupConsecutiveTools([a, m1, m2, b]);
    expect(items).toHaveLength(1);
    expect((items[0] as ToolGroupItem).messages).toEqual([a, m1, m2, b]);
  });

  test('流式尾巴(isStreaming)不吸收,保持正文实时显示', () => {
    const a = tool('Read');
    const streamingTail = text('正在打字…');
    (streamingTail as ChatMessage).isStreaming = true;
    const b = tool('Write');
    const items = groupConsecutiveTools([a, streamingTail, b]);
    // 流式行把段切开:前段 [a],流式正文自成一条,b 另开一段
    expect(items).toHaveLength(3);
    expect(items[1]).toBe(streamingTail);
  });

  test('特殊行(任务通知/压缩摘要/交互提示)不吸收', () => {
    const a = tool('Read');
    const notif = { ...text('后台任务完成'), isTaskNotification: true } as ChatMessage;
    const b = tool('Write');
    const items = groupConsecutiveTools([a, notif, b]);
    expect(items).toHaveLength(3);

    const compact = { ...text('摘要'), isCompactSummary: true } as ChatMessage;
    expect(groupConsecutiveTools([a, compact, b])).toHaveLength(3);
  });

  test('隐藏思考夹在正文与工具之间不阻断吸收', () => {
    const a = tool('Read');
    const mid = text('说明');
    const hidden = { ...text('推理过程'), isThinking: true } as ChatMessage;
    const b = tool('Write');
    const items = groupConsecutiveTools([a, mid, hidden, b], false);
    expect(items).toHaveLength(1);
    expect((items[0] as ToolGroupItem).messages).toEqual([a, mid, b]);
  });
});

/**
 * ci 回归:子代理容器聚合成卡片组,不进普通活动段。
 */
describe('groupConsecutiveTools · 子代理卡片组', () => {
  const agent = (desc: string): ChatMessage => ({
    ...tool('Agent'),
    isSubagentContainer: true,
    toolInput: JSON.stringify({ description: desc }),
  } as ChatMessage);

  test('相邻两个子代理收成一组网格', () => {
    const a = agent('读文件');
    const b = agent('列目录');
    const items = groupConsecutiveTools([a, b]);
    expect(items).toHaveLength(1);
    expect(isSubagentGroupItem(items[0])).toBe(true);
    expect((items[0] as SubagentGroupItem).messages).toEqual([a, b]);
  });

  test('子代理组与普通活动段互不混合', () => {
    const read = tool('Read');
    const a = agent('任务A');
    const write = tool('Write');
    const items = groupConsecutiveTools([read, a, write]);
    expect(items).toHaveLength(3);
    expect(isToolGroupItem(items[0])).toBe(true);
    expect(isSubagentGroupItem(items[1])).toBe(true);
    expect(isToolGroupItem(items[2])).toBe(true);
  });

  test('正文后面是子代理组:正文按过程叙述折进前段', () => {
    const read = tool('Read');
    const mid = text('现在并行派两路子代理。');
    const a = agent('任务A');
    const items = groupConsecutiveTools([read, mid, a]);
    expect(items).toHaveLength(2);
    expect((items[0] as ToolGroupItem).messages).toEqual([read, mid]);
    expect(isSubagentGroupItem(items[1])).toBe(true);
  });

  test('组身份保持对子代理组同样生效', () => {
    const a = agent('任务A');
    const b = agent('任务B');
    const first = stabilizeGroupIdentity(groupConsecutiveTools([a, b]), new WeakMap());
    const second = stabilizeGroupIdentity(groupConsecutiveTools([a, b]), first.nextByAnchor);
    expect(second.items[0]).toBe(first.items[0]);
  });
});
