import type { ChatMessage } from '../types/types';

import { isSubagentGroupItem, isToolGroupItem, type MessageListItem } from './toolGrouping';
import type { ActivityItemRole } from './toolRowSummary';

/**
 * 回合边界与回合归属的判据 —— **一处定义,三处共用**。
 *
 * 这三个判据原本躺在 `ChatMessagesPane` 里当私有函数,单测只能照抄一份
 * (见 fl 那轮的 turnOutputBoundary.test.ts 开头的复制件)。抄一份的代价在
 * fs/ft 两轮里连着付了两次:判据在组件里改了,测试里那份没改,红不起来。
 *
 * 现在搬到这里,组件与测试都 import 同一份。改坏了,测试立刻红。
 */

/**
 * fl:这一项是不是**回合边界** —— 到它为止,前面攒的产出就不该再往后传了。
 *
 * 用户消息开启新一轮;错误行终结本轮(后面就算还有助手正文,也是另一件事)。
 * 其余不可展示的行(思考、工具、交互式提示、任务通知)都还在本轮里,继续往下传。
 */
export function endsTurnForOutputs(item: ChatMessage): boolean {
  if (item.type === 'user') return true;
  /**
   * fz:**只有 provider 报的错才终结回合,前端的本地提示不算。**
   *
   * 前端会在与回合完全无关的时候往同一条会话里插红字:附件超 20MB、
   * 文档解析失败、抓网页失败、图片上传失败、断线时授权没发出去…… 一共九处,
   * 用的都是当前时间戳,按时间排序正好落在**正在跑的那一轮最后**。
   *
   * 而这个判据同时驱动两件事:产出卡清账,以及(fw 起)活动段折不折。
   * 于是"拖错一个附件"会让 `focusActivityGroup` 倒扫第一项就撞上边界、
   * 返回 -1 —— 正在滚动的那份工具清单当场收成一行,此刻真正在跑的那条命令
   * 从「运行中」翻成「已中断」,这一轮此前写出的文件也从产出卡里被清空。
   * 用户会以为是那个附件把回合搞崩了。
   */
  return item.type === 'error' && !(item as { isLocalNotice?: boolean }).isLocalNotice;
}

/**
 * fj:这条消息会不会真的渲染「产出」卡。
 *
 * 只有普通的助手正文才会。工具行、任务通知、压缩摘要、交互式提示
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
 * **两条线都复用已有的判据,不另写一份**:
 * - 回合边界 = `endsTurnForOutputs`(与产出卡清账同一条线);
 * - 正式回复 = `canRenderTurnOutputs`(与"哪条消息能挂产出卡"同一条线)——
 *   它排除的正是工具行、思考块、任务通知、压缩摘要、交互式提示,
 *   剩下的就是"这一轮真正的回答",也正是活动段该收起来的那一刻。
 *
 * 抄第三份定义 = 下一次"改了一处、另两处没跟上"。
 */
export function activityItemRole(item: MessageListItem): ActivityItemRole {
  if (isToolGroupItem(item)) return 'activity';
  if (isSubagentGroupItem(item)) return 'other';
  if (endsTurnForOutputs(item)) return 'turn-boundary';
  return canRenderTurnOutputs(item) ? 'reply' : 'other';
}
