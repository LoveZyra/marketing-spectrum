import type { ChatMessage } from '../types/types';

/**
 * 「这个子代理还在跑吗」的唯一判据,卡片、抬头「N 个进行中」、展开区的步骤行共用。
 *
 * 必须先看 `background`:转后台的 Task 一定已有 toolResult("running in the background"),
 * 只看 toolResult 会把仍在跑的后台子代理判成已结束。
 * 有后台状态就以它为准;没有才看"这一轮在不在跑 + 交没交结果"。
 */
export function subagentStillRunning(message: ChatMessage, isCurrentTurn: boolean): boolean {
  const background = message.subagentState?.background;
  if (background) return background.status === 'running';
  if (!isCurrentTurn) return false;
  return !(message.subagentState?.isComplete || message.toolResult);
}

/** 只有工具调用才算"步":正文 / 思考是叙述,不算步。 */
export function subagentToolStepCount(message: ChatMessage): number {
  const children = message.subagentState?.childTools ?? [];
  const tools = children.filter((child) => child.kind !== 'text' && child.kind !== 'thinking').length;
  return Math.max(message.subagentState?.background?.toolUses ?? 0, tools);
}
