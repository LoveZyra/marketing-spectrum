import type { ChatMessage } from '../types/types';

export interface ToolGroupItem {
  _isGroup: true;
  /** 这一段活动里第一个工具的名字;纯思考段为 `thinking`。仅用于 key 与调试。 */
  toolName: string;
  messages: ChatMessage[];
  timestamp: ChatMessage['timestamp'];
}

/** 相邻的子代理容器(Task/Agent)收成一组,渲染成并排卡片网格(ci 轮)。 */
export interface SubagentGroupItem {
  _isSubagentGroup: true;
  messages: ChatMessage[];
  timestamp: ChatMessage['timestamp'];
}

export type MessageListItem = ChatMessage | ToolGroupItem | SubagentGroupItem;

export function isToolGroupItem(item: MessageListItem): item is ToolGroupItem {
  return '_isGroup' in item && (item as ToolGroupItem)._isGroup === true;
}

export function isSubagentGroupItem(item: MessageListItem): item is SubagentGroupItem {
  return '_isSubagentGroup' in item && (item as SubagentGroupItem)._isSubagentGroup === true;
}

function isSubagentContainerMessage(message: ChatMessage): boolean {
  return Boolean(message.isToolUse && message.isSubagentContainer);
}

/**
 * 这些工具必须原样内联渲染,不能收进活动时间轴:
 * 计划(要能直接读)、交互问答(要能点)。
 */
const UNGROUPABLE_TOOLS = new Set(['ExitPlanMode', 'exit_plan_mode', 'AskUserQuestion']);

function isGroupableToolMessage(message: ChatMessage): message is ChatMessage & { toolName: string } {
  return Boolean(
    message.isToolUse
    && message.toolName
    && !message.isSubagentContainer
    && !UNGROUPABLE_TOOLS.has(message.toolName),
  );
}

function isVisibleThinking(message: ChatMessage, showThinking: boolean): boolean {
  return Boolean(message.isThinking) && showThinking;
}

// Messages that render nothing (e.g. reasoning hidden when showThinking is off)
// shouldn't split an otherwise-continuous run — providers interleave hidden
// reasoning between consecutive tool calls.
function rendersNothing(message: ChatMessage, showThinking: boolean): boolean {
  return Boolean(message.isThinking && !showThinking);
}

/**
 * 回合**中间**的过渡性正文 —— 可以被收进活动时间轴的那种。
 *
 * 一轮长任务里模型常在工具调用之间说一段话("校验通过,接着写文档"),原来
 * 这段话会以完整正文打印、把时间轴切成两截,一轮任务在界面上碎成好几段流程。
 * 判定它"可吸收"的条件:普通的助手纯文本 —— 不是工具/思考,不在流式打字中
 * (流式尾巴要按正文实时显示,等下一个工具启动、它定稿后再折入),也不是任何
 * 有专属渲染的特殊行(交互问答/任务通知/压缩摘要/本地命令/带 reasoning 附页)。
 *
 * 真正吸不吸,还要看**它后面是不是还有活动**(见 groupConsecutiveTools):
 * 收尾的最终回答后面没有活动,永远保持大正文排版。
 */
export function isAbsorbableNarration(message: ChatMessage): boolean {
  return Boolean(
    message.type === 'assistant'
    && !message.isToolUse
    && !message.isThinking
    && !message.isStreaming
    && !message.isInteractivePrompt
    && !message.isTaskNotification
    && !message.isCompactSummary
    && !message.isLocalCommand
    && !message.isLocalCommandStdout
    && !message.commandName
    && !message.reasoning
    && typeof message.content === 'string'
    && message.content.trim().length > 0,
  );
}

/**
 * 把连续的「思考 + 工具调用」收成一段活动,交给活动时间轴渲染成一条竖线。
 *
 * 和早先的「工具执行卡」两点不同:
 * 1. **思考也进来** —— 它和工具调用本来就是同一轮里交替发生的,分成两种控件看,
 *    读者得自己在脑子里把顺序拼回去;
 * 2. **单条也成段** —— 阈值是 1。否则一次调用长这样、两次调用长那样,同一件事
 *    有两套外观。
 */
export function groupConsecutiveTools(
  messages: ChatMessage[],
  showThinking: boolean = true,
): MessageListItem[] {
  const items: MessageListItem[] = [];
  let index = 0;

  const isActivity = (message: ChatMessage) =>
    isGroupableToolMessage(message) || isVisibleThinking(message, showThinking);

  /**
   * 从 from 起,跳过连续的可吸收正文与隐藏思考,看**后面第一条有效消息**是不是
   * 活动。是 → 这串正文夹在流程中间,该吸收;返回活动的下标。否则返回 -1。
   */
  const narrationRunLeadsToActivity = (from: number): number => {
    let probe = from;
    while (probe < messages.length) {
      const peek = messages[probe];
      if (rendersNothing(peek, showThinking) || isAbsorbableNarration(peek)) {
        probe += 1;
        continue;
      }
      break;
    }
    // 子代理组也算"后面还有活动":正文夹在「工具流 → 派子代理」之间时同样
    // 属于过程叙述("现在并行派五路深读"),该折进时间轴而不是打断成大字。
    return probe < messages.length && probe > from
      && (isActivity(messages[probe]) || isSubagentContainerMessage(messages[probe]))
      ? probe
      : -1;
  };

  while (index < messages.length) {
    const message = messages[index];

    // 子代理容器:相邻的收成一组(中间的隐藏思考跳过),渲染成卡片网格。
    // 它们不进普通活动段 —— 层级不同:每张卡内部还有自己的子步骤。
    if (isSubagentContainerMessage(message)) {
      const run: ChatMessage[] = [message];
      let nextIndex = index + 1;
      while (nextIndex < messages.length) {
        const candidate = messages[nextIndex];
        if (rendersNothing(candidate, showThinking)) { nextIndex += 1; continue; }
        if (isSubagentContainerMessage(candidate)) { run.push(candidate); nextIndex += 1; continue; }
        break;
      }
      items.push({ _isSubagentGroup: true, messages: run, timestamp: message.timestamp });
      index = nextIndex;
      continue;
    }

    // 段的开启:活动本身,或"后面跟着活动"的过渡正文(回合开头先说一句再动手)。
    const startsGroup = isActivity(message)
      || (isAbsorbableNarration(message) && narrationRunLeadsToActivity(index) !== -1);

    if (!startsGroup) {
      items.push(message);
      index += 1;
      continue;
    }

    const run: ChatMessage[] = [message];
    let nextIndex = index + 1;

    while (nextIndex < messages.length) {
      const candidate = messages[nextIndex];

      // 隐藏的思考块不该把一段连续活动切两半
      if (rendersNothing(candidate, showThinking)) {
        nextIndex += 1;
        continue;
      }

      if (isActivity(candidate)) {
        run.push(candidate);
        nextIndex += 1;
        continue;
      }

      // 过渡正文:只有后面还有活动才吸收(连续几条一起看)。
      // 收尾的最终回答后面没有活动 —— 段在它前面结束,它保持大正文。
      if (isAbsorbableNarration(candidate)) {
        const activityAt = narrationRunLeadsToActivity(nextIndex);
        if (activityAt !== -1) {
          for (let absorb = nextIndex; absorb < activityAt; absorb += 1) {
            if (!rendersNothing(messages[absorb], showThinking)) {
              run.push(messages[absorb]);
            }
          }
          nextIndex = activityAt;
          continue;
        }
      }

      break;
    }

    items.push({
      _isGroup: true,
      toolName: run.find((item) => item.toolName)?.toolName || 'thinking',
      messages: run,
      timestamp: message.timestamp,
    });

    index = nextIndex;
  }

  return items;
}

/**
 * 分组身份保持:成员完全没变的段,沿用上一轮的同一个 ToolGroupItem 对象。
 *
 * `groupConsecutiveTools` 每次都 mint 全新的组对象 —— 流式期间 store 每
 * 100ms 换一次消息数组,于是**所有**时间轴都拿到"新"的 group prop,memo
 * 形同虚设,每段都重算 rows 与摘要。消息对象本身在 store 里是身份稳定的
 * (没变的消息复用同一个对象),所以"逐个引用相等 + 长度相等"就能断定
 * 这一段没动,直接还回上一轮的对象。
 *
 * 锚点用段内第一条消息的身份(WeakMap):段的边界移动时第一条消息一定换,
 * 天然不会拿错;消息被回收时条目自动消失。
 */
export function stabilizeGroupIdentity(
  items: MessageListItem[],
  previousByAnchor: WeakMap<ChatMessage, ToolGroupItem | SubagentGroupItem>,
): { items: MessageListItem[]; nextByAnchor: WeakMap<ChatMessage, ToolGroupItem | SubagentGroupItem> } {
  const nextByAnchor = new WeakMap<ChatMessage, ToolGroupItem | SubagentGroupItem>();
  const out = items.map((item) => {
    const isGroup = isToolGroupItem(item) || isSubagentGroupItem(item);
    if (!isGroup) return item as MessageListItem;
    const groupItem = item as ToolGroupItem | SubagentGroupItem;
    const anchor = groupItem.messages[0];
    if (!anchor) return item;
    const previous = previousByAnchor.get(anchor);
    // 两种组共用一张锚表:同一条消息不可能同时当两种组的段首,类型不会串。
    const reusable = Boolean(
      previous
      && ('_isGroup' in previous) === ('_isGroup' in groupItem)
      && previous.messages.length === groupItem.messages.length
      && previous.messages.every((message, index) => message === groupItem.messages[index]),
    );
    const group = reusable ? previous! : groupItem;
    nextByAnchor.set(anchor, group);
    return group;
  });
  return { items: out, nextByAnchor };
}
