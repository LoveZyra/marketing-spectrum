import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

/**
 * gd:**后台子代理的进展与汇报,要归到它那张卡上,不在主对话流里另起一行。**
 *
 * 线上现象:两张子代理卡都写着「2 步 ✓」,而它们跑出来的东西(十几条命令、
 * 十几个文件)全在外面;完成汇报又变成独立的一行「✅ 后台任务完成 …」。
 *
 * 病根在 SDK 的行为里(`background_tasks` 那条控制请求的原话):
 * **任务一转后台,那次工具调用立刻返回一个 "running in the background" 的
 * tool_result,回合继续**;任务自己在后台跑,settle 时发一条 `task_notification`。
 * 也就是说 —— 子代理的内部步骤在后台化之后**不再走实时流**,卡片当场"收工"
 * 停在转后台之前的那几步,之后的一切只存在于 `task_progress` /
 * `task_notification` 里,而它们**都带 `tool_use_id`**,那正是卡片的身份。
 *
 * 这一份跑的是真实转换链路(`normalizedToChatMessages`),不是手搓卡片对象。
 */
let seq = 0;
const msg = (overrides: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>): NormalizedMessage => {
  seq += 1;
  return {
    id: `m_${seq}`,
    sessionId: 's1',
    timestamp: `2026-09-10T00:00:${String(seq).padStart(2, '0')}.000Z`,
    provider: 'claude',
    ...overrides,
  } as NormalizedMessage;
};

const container = (toolId: string) => msg({
  kind: 'tool_use',
  toolName: 'Task',
  toolId,
  toolInput: { description: '审计:发送与排队' },
});

/** 转后台时那次工具调用立刻拿到的 tool_result —— 老判据就是被它骗了。 */
const backgroundedResult = (toolId: string) => msg({
  kind: 'tool_result',
  toolId,
  content: 'Task running in the background',
});

const progress = (toolId: string, toolUses: number, lastToolName?: string) => msg({
  kind: 'task_progress',
  toolId,
  taskId: 't1',
  status: 'running',
  taskProgress: { toolUses, lastToolName },
} as Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>);

const notification = (toolId: string | undefined, status: string, summary: string, toolUses?: number) => msg({
  kind: 'task_notification',
  ...(toolId ? { toolId } : {}),
  taskId: 't1',
  status,
  summary,
  content: summary,
  ...(toolUses === undefined ? {} : { taskProgress: { toolUses } }),
} as Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>);

const cardOf = (rows: ReturnType<typeof normalizedToChatMessages>) =>
  rows.find((row) => row.isSubagentContainer);

describe('后台子代理:进展与汇报归卡片', () => {
  it('转后台之后步数跟着涨,而不是停在「2 步」', () => {
    const rows = normalizedToChatMessages([
      container('toolu_A'),
      backgroundedResult('toolu_A'),
      progress('toolu_A', 46, 'Bash'),
    ]);
    const card = cardOf(rows);
    expect(card?.subagentState?.background?.toolUses).toBe(46);
    expect(card?.subagentState?.background?.lastToolName).toBe('Bash');
  });

  it('**"running in the background" 的 tool_result 不算完成**(老判据就是被它骗的)', () => {
    const rows = normalizedToChatMessages([
      container('toolu_B'),
      backgroundedResult('toolu_B'),
      progress('toolu_B', 12),
    ]);
    expect(cardOf(rows)?.subagentState?.isComplete).toBe(false);
    expect(cardOf(rows)?.subagentState?.background?.status).toBe('running');
  });

  it('task_notification 到达 → 卡片翻成完成,并带上汇报', () => {
    const rows = normalizedToChatMessages([
      container('toolu_C'),
      backgroundedResult('toolu_C'),
      progress('toolu_C', 20),
      notification('toolu_C', 'completed', '✅ 后台任务完成 · 已核对 12 个文件', 46),
    ]);
    const card = cardOf(rows);
    expect(card?.subagentState?.isComplete).toBe(true);
    expect(card?.subagentState?.background?.status).toBe('completed');
    expect(card?.subagentState?.background?.toolUses).toBe(46);
    expect(card?.subagentState?.background?.summary).toContain('已核对 12 个文件');
  });

  it('**有主的汇报不在主对话流里另起一行**', () => {
    const rows = normalizedToChatMessages([
      container('toolu_D'),
      notification('toolu_D', 'completed', '✅ 后台任务完成'),
    ]);
    expect(rows.filter((row) => row.isTaskNotification)).toHaveLength(0);
  });

  it('进展行**永远**不出顶层(每几秒一条)', () => {
    const rows = normalizedToChatMessages([
      container('toolu_E'),
      progress('toolu_E', 3),
      progress('toolu_E', 7),
    ]);
    expect(rows.filter((row) => row.isTaskNotification)).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });

  /**
   * ge:标准变了 —— 「后台任务完成」**一行都不许出现在主对话流里**。
   *
   * gd 还留了两种独立成行的情况(卡片被裁出窗口、没有 tool_use_id)。实机看下来
   * 那一串「✅ 后台任务完成 X」把一条本该连贯的时间轴切得七零八落,而它说的事
   * **那次工具调用自己那一行就能说**(见下面"归到工具行"那几条)。
   */
  it('这一屏没有那张卡时也不单独成行(内容仍在显示日志里)', () => {
    const rows = normalizedToChatMessages([
      notification('toolu_GONE', 'completed', '✅ 后台任务完成 · 孤儿汇报'),
    ]);
    expect(rows.filter((row) => row.isTaskNotification)).toHaveLength(0);
  });

  it('没有 tool_use_id 的也不单独成行', () => {
    const rows = normalizedToChatMessages([notification(undefined, 'completed', '✅ 后台任务完成 · 跑 pytest')]);
    expect(rows.filter((row) => row.isTaskNotification)).toHaveLength(0);
  });

  it('**普通工具行(不是子代理)转后台之后,终态归到那一行**', () => {
    const bash = msg({ kind: 'tool_use', toolName: 'Bash', toolId: 'toolu_BASH', toolInput: { command: 'pytest' } });
    const rows = normalizedToChatMessages([
      bash,
      msg({ kind: 'tool_result', toolId: 'toolu_BASH', content: 'Running in the background' }),
      notification('toolu_BASH', 'failed', '⚠️ 后台任务失败 · 退出码 1'),
    ]);
    const row = rows.find((r) => r.toolId === 'toolu_BASH');
    expect(row?.background?.status).toBe('failed');
    // 而且主流里没有多出一行
    expect(rows.filter((r) => r.isTaskNotification)).toHaveLength(0);
  });

  it('汇报是终态 —— 后到的进展帧不许把它盖回 running(重连补发不保证顺序)', () => {
    const rows = normalizedToChatMessages([
      container('toolu_F'),
      notification('toolu_F', 'completed', '✅ 完成', 30),
      progress('toolu_F', 12),
    ]);
    expect(cardOf(rows)?.subagentState?.background?.status).toBe('completed');
    expect(cardOf(rows)?.subagentState?.background?.toolUses).toBe(30);
  });

  it('失败的汇报把卡片翻成 failed', () => {
    const rows = normalizedToChatMessages([
      container('toolu_G'),
      notification('toolu_G', 'failed', '⚠️ 后台任务失败 · 命令返回 1'),
    ]);
    expect(cardOf(rows)?.subagentState?.background?.status).toBe('failed');
    expect(cardOf(rows)?.subagentState?.isComplete).toBe(true);
  });

  /**
   * **这一条是最容易漏的那种。**
   *
   * 转换有一层按 `msg` 对象缓存的结果,而后台进展是**另一条消息**带来的 ——
   * 容器那一行自己一个字都没变。不把后台状态放进缓存签名的话,进度涨了、
   * 任务完成了,这张卡还是缓存里那份旧的:"修复代码在,数据到不了它"。
   */
  it('后台状态变了,缓存必须失效(容器那一行自己没变)', () => {
    const c = container('toolu_H');
    const first = normalizedToChatMessages([c, progress('toolu_H', 5)]);
    expect(cardOf(first)?.subagentState?.background?.toolUses).toBe(5);

    const second = normalizedToChatMessages([c, progress('toolu_H', 40)]);
    expect(cardOf(second)?.subagentState?.background?.toolUses).toBe(40);

    const third = normalizedToChatMessages([c, notification('toolu_H', 'completed', '✅ 完成', 46)]);
    expect(cardOf(third)?.subagentState?.isComplete).toBe(true);
    expect(cardOf(third)?.subagentState?.background?.toolUses).toBe(46);
  });

  it('没有后台状态的普通子代理照旧走老判据(不许改坏)', () => {
    const rows = normalizedToChatMessages([container('toolu_I'), backgroundedResult('toolu_I')]);
    const card = cardOf(rows);
    expect(card?.subagentState?.background).toBeUndefined();
    expect(card?.subagentState?.isComplete).toBe(true);   // 有 toolResult = 完成
  });
});
