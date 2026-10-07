import type { ChatMessage } from '../types/types';

import { isSubagentGroupItem, isToolGroupItem, type MessageListItem } from './toolGrouping';
import type { ActivityItemRole } from './toolRowSummary';

/**
 * 回合边界与回合归属的判据,只在这里定义一份:ChatMessagesPane 与单测都从这里导入,
 * 避免组件里改了判据、测试里的副本没跟上。
 */

/**
 * 这一项是不是回合边界 —— 到它为止,前面攒的产出就不该再往后传了。
 *
 * 用户消息开启新一轮(插话除外,见下);错误行终结本轮(后面就算还有助手正文,也是另一件事)。
 * 其余不可展示的行(思考、工具、交互式提示、任务通知)都还在本轮里,继续往下传。
 */
export function endsTurnForOutputs(item: ChatMessage): boolean {
  /**
   * 插话不是回合边界。「立即发送」/ 另一端发来的话被合流进正在跑的这一轮(模型在下一个工具间隙读到、
   * 接着干),它在列表里落在这一轮中间。当成边界的话:正在跑的子代理卡与工具段被判成"已中断"、当场收起,
   * 这一轮此前写出的文件也从产出卡里清掉。
   */
  if (item.type === 'user') return !(item as { interjection?: boolean }).interjection;
  /**
   * 只有 provider 报的错才终结回合,前端的本地提示(`isLocalNotice`)不算。
   *
   * 前端会在与回合无关的时候往同一条会话里插红字(附件超 20MB、文档解析失败、抓网页失败、
   * 图片上传失败、断线时授权没发出去……),用的都是当前时间戳,按时间排序正好落在正在跑的那一轮最后。
   * 这个判据同时驱动产出卡清账与活动段折叠:若把本地红字当边界,`focusActivityGroup` 倒扫第一项就撞上
   * 边界、返回 -1,正在跑的工具清单当场收成一行并标「已中断」,这一轮写出的文件也从产出卡里清空。
   */
  return item.type === 'error' && !(item as { isLocalNotice?: boolean }).isLocalNotice;
}

/**
 * 这条消息会不会真的渲染「产出」卡。
 *
 * 只有已落定(非流式)的普通助手正文才会。工具行、任务通知、压缩摘要、交互式提示
 * (ExitPlanMode / AskUserQuestion)、思考块虽然也是 `assistant`,
 * 但它们各自的渲染分支不读 `turnOutputs` —— 让它们参与"领取/清空"就等于
 * 把这一轮的产出卡吃掉。
 */
export function canRenderTurnOutputs(item: ChatMessage): boolean {
  if (item.type !== 'assistant' || (item as { isStreaming?: boolean }).isStreaming) return false;
  const flags = item as ChatMessage & {
    isToolUse?: boolean;
    isTaskNotification?: boolean;
    isCompactSummary?: boolean;
    isInteractivePrompt?: boolean;
    isThinking?: boolean;
  };
  return !flags.isToolUse
    && !flags.isTaskNotification
    && !flags.isCompactSummary
    && !flags.isInteractivePrompt
    && !flags.isThinking;
}

/**
 * 一项在「哪一段属于正在跑的这一轮」里扮演什么角色(怎么用见 `focusActivityGroup`)。
 *
 * 两条线都复用已有的判据,不另写一份(免得改了一处、另一处没跟上):
 * - 回合边界 = `endsTurnForOutputs`(与产出卡清账同一条线);
 * - 正式回复 = `canRenderTurnOutputs`(与"哪条消息能挂产出卡"同一条线)——
 *   它排除的正是工具行、思考块、任务通知、压缩摘要、交互式提示,
 *   剩下的就是"这一轮真正的回答",也正是活动段该收起来的那一刻。
 */
export function activityItemRole(item: MessageListItem): ActivityItemRole {
  if (isToolGroupItem(item)) return 'activity';
  if (isSubagentGroupItem(item)) return 'other';
  if (endsTurnForOutputs(item)) return 'turn-boundary';
  return canRenderTurnOutputs(item) ? 'reply' : 'other';
}
