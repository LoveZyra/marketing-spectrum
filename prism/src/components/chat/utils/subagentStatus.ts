import type { ChatMessage } from '../types/types';

/**
 * gh:**「这个子代理还在跑吗」只有一处定义。**
 *
 * 卡片、抬头「N 个进行中」、展开区的步骤行,此前三处各写一遍,而展开区那一份
 * 不看 `background` —— 转后台的 Task 一定有 toolResult("running in the background"),
 * 于是抬头写着「1 个进行中」、卡片转着圈、点开每一步都是 ✗「已中断」。
 * 有后台状态就以它为准;没有才看"这一轮在不在跑 + 交没交结果"。
 */
export function subagentStillRunning(message: ChatMessage, isCurrentTurn: boolean): boolean {
  const background = message.subagentState?.background;
  if (background) return background.status === 'running';
  if (!isCurrentTurn) return false;
  return !(message.subagentState?.isComplete || message.toolResult);
}

/** gh:只有工具调用才算"步"—— 正文/思考是叙述,不是步。 */
export function subagentToolStepCount(message: ChatMessage): number {
  const children = message.subagentState?.childTools ?? [];
  const tools = children.filter((child) => child.kind !== 'text' && child.kind !== 'thinking').length;
  return Math.max(message.subagentState?.background?.toolUses ?? 0, tools);
}
