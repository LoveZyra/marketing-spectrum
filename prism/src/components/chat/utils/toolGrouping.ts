import type { ChatMessage } from '../types/types';

export interface ToolGroupItem {
  _isGroup: true;
  /** 这一段活动里第一个工具的名字;纯思考段为 `thinking`。仅用于 key 与调试。 */
  toolName: string;
  messages: ChatMessage[];
  timestamp: ChatMessage['timestamp'];
}

export type MessageListItem = ChatMessage | ToolGroupItem;

export function isToolGroupItem(item: MessageListItem): item is ToolGroupItem {
  return '_isGroup' in item && (item as ToolGroupItem)._isGroup === true;
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

  while (index < messages.length) {
    const message = messages[index];

    if (!isActivity(message)) {
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
