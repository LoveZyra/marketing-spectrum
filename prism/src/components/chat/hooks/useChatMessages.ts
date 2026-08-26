/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';

function formatToolResultContent(content: unknown): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const toolUseErrorMatch = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return toolUseErrorMatch ? toolUseErrorMatch[1] : text;
}

type ParsedTaskNotification = {
  status: string;
  summary: string;
  result: string;
};

/**
 * Parses a background-agent `<task-notification>` block.
 *
 * The harness injects these as user-role messages when a background task stops.
 * Newer notifications carry extra fields (`<tool-use-id>`, `<note>`, `<usage>`,
 * and a `<result>` markdown payload) that the previous single-shot regex could
 * not match, so the whole raw XML block leaked through as plain user text.
 * Fields are extracted independently so the block renders as an assistant
 * notification plus, when present, the agent's markdown result.
 */
function parseTaskNotification(content: string): ParsedTaskNotification | null {
  if (!content.trimStart().startsWith('<task-notification>')) {
    return null;
  }

  const statusMatch = /<status>([\s\S]*?)<\/status>/.exec(content);
  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(content);

  let result = '';
  const resultOpen = content.indexOf('<result>');
  if (resultOpen !== -1) {
    const afterOpen = content.slice(resultOpen + '<result>'.length);
    const closeIndex = afterOpen.indexOf('</result>');
    result =
      closeIndex === -1
        ? afterOpen.replace(/<\/task-notification>\s*$/, '').trim()
        : afterOpen.slice(0, closeIndex).trim();
  }

  return {
    status: statusMatch?.[1]?.trim() || 'completed',
    summary: summaryMatch?.[1]?.trim() || 'Background task finished',
    result,
  };
}

/**
 * The tool_result a `tool_use` row renders with, in either of the two shapes it
 * arrives in: pre-attached by the server, or a standalone message matched by id.
 */
type ResolvedToolResult = {
  content?: string;
  isError?: boolean;
  /** Present on standalone rows; not declared on NormalizedMessage. */
  toolUseResult?: unknown;
} | null;

/**
 * Pick the result a `tool_use` renders with, preferring the server's attached
 * copy over the standalone row.
 *
 * This lives in its own function so the memo below can key on exactly the value
 * the conversion consumes. Re-deriving the precedence rule at the cache site
 * would let the key drift from the thing it is supposed to be guarding.
 */
function resolveToolResult(
  msg: NormalizedMessage,
  toolResultMap: Map<string, NormalizedMessage>,
): ResolvedToolResult {
  if (msg.kind !== 'tool_use') {
    return null;
  }
  if (msg.toolResult) {
    return msg.toolResult;
  }
  return (msg.toolId ? toolResultMap.get(msg.toolId) : null) ?? null;
}

type ConversionCacheEntry = {
  /**
   * The result folded into `chatMessages`. A `tool_use` converted while its
   * tool_result was still in flight has to be reconverted once it lands, and
   * that result is not reachable from the tool_use object, so it is recorded
   * next to the output rather than inferred from it.
   */
  toolResult: ResolvedToolResult;
  /**
   * 子代理容器(Task/Agent)的实时子步骤指纹:`条数:已有结果数`。
   * 子代理每走一步,父卡的输出都要重转 —— 指纹不符即失效。非容器行恒为空串。
   */
  childSignature: string;
  chatMessages: ChatMessage[];
};

/**
 * Converted output, keyed on the input object.
 *
 * The point is reference stability, not raw speed. Every stream delta replaces
 * the store's realtime array, which re-runs this conversion across the *entire*
 * transcript; each pass used to mint brand-new ChatMessage objects for messages
 * that had not changed, so every `memo`'d row re-rendered on every frame of
 * streaming, and `ChatMessagesPane`'s key map saw a new object for the same
 * logical message after each pagination prepend — remounting the list and
 * jumping the viewport.
 *
 * Keying on identity is only sound because the store never mutates a
 * NormalizedMessage in place: `updateStreaming` and `finalizeStreaming` each
 * write a replacement object into a fresh array, and `computeMerged` only
 * reorders and filters. A message whose content changed is therefore always a
 * new key, and a WeakMap lets a closed session's entries be collected with it.
 */
const conversionCache = new WeakMap<NormalizedMessage, ConversionCacheEntry>();

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Truly internal/system content is already filtered server-side. Some Claude
 * transcript artifacts such as local slash commands and compact summaries are
 * intentionally preserved and annotated so they can render like normal chat.
 *
 * Unchanged messages keep their previous ChatMessage objects — see
 * `conversionCache`.
 */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  // First pass: collect tool results for attachment.
  // 带 parentToolUseId 的 result 属于子代理内部,不进顶层 result 表。
  const toolResultMap = new Map<string, NormalizedMessage>();
  for (const msg of messages) {
    if (msg.kind === 'tool_result' && msg.toolId && !msg.parentToolUseId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  /**
   * 子代理实时子步骤归拢(ci 轮)。
   *
   * SDK 在 forwardSubagentText=false 下依然实时转发子代理的 tool_use /
   * tool_result 帧(带 parentToolUseId),且已随显示日志持久化 —— 此前前端
   * 不消费,这些行被当**顶层工具行**混进主时间轴,层级全丢。现在:
   * 按 parentToolUseId 归拢成 SubagentChildTool[],塞给对应父容器
   * (toolId === parentToolUseId)的 subagentState;这些行自身不再出顶层。
   */
  const childResultByToolId = new Map<string, NormalizedMessage>();
  for (const msg of messages) {
    if (msg.parentToolUseId && msg.kind === 'tool_result' && msg.toolId) {
      childResultByToolId.set(msg.toolId, msg);
    }
  }
  const childrenByParent = new Map<string, SubagentChildTool[]>();
  for (const msg of messages) {
    if (!msg.parentToolUseId || msg.kind !== 'tool_use') continue;
    const result = msg.toolResult
      || (msg.toolId ? childResultByToolId.get(msg.toolId) : undefined)
      || null;
    const list = childrenByParent.get(msg.parentToolUseId) ?? [];
    list.push({
      toolId: msg.toolId || `child_${list.length}`,
      toolName: msg.toolName || 'Tool',
      toolInput: msg.toolInput,
      toolResult: result
        ? { content: formatToolResultContent(result.content), isError: Boolean(result.isError) }
        : null,
      timestamp: new Date(msg.timestamp || Date.now()),
    });
    childrenByParent.set(msg.parentToolUseId, list);
  }

  const converted: ChatMessage[] = [];
  for (const msg of messages) {
    // 子代理内部行不出顶层:tool_use/tool_result 已归拢进父卡;
    // 文本/思考帧(个别 CLI 版本会转发)直接不渲染,防止串进主对话。
    if (msg.parentToolUseId && (
      msg.kind === 'tool_use' || msg.kind === 'tool_result'
      || msg.kind === 'text' || msg.kind === 'thinking' || msg.kind === 'stream_delta'
    )) {
      continue;
    }

    const toolResult = resolveToolResult(msg, toolResultMap);
    const realtimeChildren = msg.kind === 'tool_use' && msg.toolId
      ? childrenByParent.get(msg.toolId) ?? null
      : null;
    const childSignature = realtimeChildren
      ? `${realtimeChildren.length}:${realtimeChildren.filter((child) => child.toolResult).length}`
      : '';

    const cached = conversionCache.get(msg);
    if (cached && cached.toolResult === toolResult && cached.childSignature === childSignature) {
      for (const chatMessage of cached.chatMessages) {
        converted.push(chatMessage);
      }
      continue;
    }

    const chatMessages = convertMessage(msg, toolResult, realtimeChildren);
    conversionCache.set(msg, { toolResult, childSignature, chatMessages });
    for (const chatMessage of chatMessages) {
      converted.push(chatMessage);
    }
  }

  return converted;
}

/**
 * Convert one store message into the rows it renders as.
 *
 * Returns an array because the mapping is not one-to-one in either direction:
 * control events render as nothing, and a `<task-notification>` renders as a
 * status line plus, when the agent returned one, its markdown result.
 */
function convertMessage(
  msg: NormalizedMessage,
  resolvedToolResult: ResolvedToolResult,
  realtimeChildren: SubagentChildTool[] | null = null,
): ChatMessage[] {
  const converted: ChatMessage[] = [];

  const sharedMetadata = {
    displayText: msg.displayText,
    commandName: msg.commandName,
    commandMessage: msg.commandMessage,
    commandArgs: msg.commandArgs,
    isLocalCommand: msg.isLocalCommand,
    isLocalCommandStdout: msg.isLocalCommandStdout,
    isCompactSummary: msg.isCompactSummary,
  };

  switch (msg.kind) {
    case 'text': {
      const content = msg.content || '';
      const images = Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined;
      if (!content.trim() && !images) break;

      if (msg.role === 'user') {
        // Parse task notifications
        const taskNotif = parseTaskNotification(content);
        if (taskNotif) {
          converted.push({
            type: 'assistant',
            content: taskNotif.summary,
            timestamp: msg.timestamp,
            isTaskNotification: true,
            taskStatus: taskNotif.status,
            ...sharedMetadata,
          });
          // Render the agent's result as a normal assistant message so its
          // markdown displays correctly instead of leaking raw XML.
          if (taskNotif.result) {
            converted.push({
              type: 'assistant',
              content: formatUsageLimitText(unescapeWithMathProtection(decodeHtmlEntities(taskNotif.result))),
              timestamp: msg.timestamp,
              ...sharedMetadata,
            });
          }
        } else {
          converted.push({
            type: 'user',
            content: unescapeWithMathProtection(decodeHtmlEntities(content)),
            timestamp: msg.timestamp,
            images,
            ...sharedMetadata,
          });
        }
      } else {
        let text = decodeHtmlEntities(content);
        text = unescapeWithMathProtection(text);
        text = formatUsageLimitText(text);
        converted.push({
          type: 'assistant',
          content: text,
          timestamp: msg.timestamp,
          // 这一轮实际服务的模型(响应元数据)—— 比模型的自我介绍可信。
          model: typeof (msg as { model?: unknown }).model === 'string'
            ? ((msg as { model?: string }).model)
            : undefined,
          ...sharedMetadata,
        });
      }
      break;
    }

    case 'tool_use': {
      const tr = resolvedToolResult;
      // SDK 不同版本给子代理容器报的工具名不同:早期 Task,新版 Agent。
      const isSubagentContainer = msg.toolName === 'Task' || msg.toolName === 'Agent';

      // Build child tools:历史路径(agent-*.jsonl 解析出的 subagentTools)
      // 与实时路径(parentToolUseId 帧归拢)按 toolId 合并 —— 实时项覆盖同 id
      // (它带着刚落地的 result),新项按到达顺序排在后面。
      const childTools: SubagentChildTool[] = [];
      if (isSubagentContainer) {
        const byId = new Map<string, number>();
        if (msg.subagentTools && Array.isArray(msg.subagentTools)) {
          for (const tool of msg.subagentTools as any[]) {
            byId.set(String(tool.toolId), childTools.length);
            childTools.push({
              toolId: tool.toolId,
              toolName: tool.toolName,
              toolInput: tool.toolInput,
              toolResult: tool.toolResult || null,
              timestamp: new Date(tool.timestamp || Date.now()),
            });
          }
        }
        for (const child of realtimeChildren ?? []) {
          const existing = byId.get(String(child.toolId));
          if (existing !== undefined) {
            childTools[existing] = child;
          } else {
            byId.set(String(child.toolId), childTools.length);
            childTools.push(child);
          }
        }
      }

      const toolResult = tr
        ? {
            content: formatToolResultContent(tr.content),
            isError: Boolean(tr.isError),
            toolUseResult: tr.toolUseResult,
          }
        : null;

      converted.push({
        type: 'assistant',
        content: '',
        timestamp: msg.timestamp,
        isToolUse: true,
        toolName: msg.toolName,
        toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
        toolId: msg.toolId,
        toolResult,
        isSubagentContainer,
        subagentState: isSubagentContainer
          ? {
              childTools,
              currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
              isComplete: Boolean(toolResult),
            }
          : undefined,
        ...sharedMetadata,
      });
      break;
    }

    case 'thinking':
      if (msg.content?.trim()) {
        converted.push({
          type: 'assistant',
          content: unescapeWithMathProtection(msg.content),
          timestamp: msg.timestamp,
          isThinking: true,
          ...sharedMetadata,
        });
      }
      break;

    case 'error':
      converted.push({
        type: 'error',
        content: msg.content || 'Unknown error',
        timestamp: msg.timestamp,
        ...sharedMetadata,
      });
      break;

    case 'interactive_prompt':
      converted.push({
        type: 'assistant',
        content: msg.content || '',
        timestamp: msg.timestamp,
        isInteractivePrompt: true,
        ...sharedMetadata,
      });
      break;

    case 'task_notification':
      converted.push({
        type: 'assistant',
        content: msg.summary || 'Background task update',
        timestamp: msg.timestamp,
        isTaskNotification: true,
        taskStatus: msg.status || 'completed',
        ...sharedMetadata,
      });
      break;

    case 'stream_delta':
      if (msg.content) {
        converted.push({
          type: 'assistant',
          content: msg.content,
          timestamp: msg.timestamp,
          isStreaming: true,
          ...sharedMetadata,
        });
      }
      break;

    // stream_end, complete, status, permission_*, session_created
    // are control events — not rendered as messages
    case 'stream_end':
    case 'complete':
    case 'status':
    case 'permission_request':
    case 'permission_cancelled':
    case 'session_created':
      // Skip — these are handled by useChatRealtimeHandlers
      break;

    // tool_result is handled via attachment to tool_use above
    case 'tool_result': {
      // Any result carrying a toolId is rendered by its tool_use, which reads
      // it out of `toolResultMap`. If the matching tool_use is not in the
      // loaded set, the pair is split across a pagination boundary (older page
      // not fetched yet) — rendering the raw content here produces an unstyled
      // dump that "fixes itself" once that page loads, so skip it either way
      // and let it attach when the tool_use arrives.
      if (msg.toolId) {
        break;
      }

      const content = formatToolResultContent(msg.content || '');
      if (!content.trim()) {
        break;
      }

      converted.push({
        type: msg.isError ? 'error' : 'assistant',
        content,
        timestamp: msg.timestamp,
        toolId: msg.toolId,
        ...sharedMetadata,
      });
      break;
    }

    default:
      break;
  }

  // 把稳定身份从 NormalizedMessage 盖到每条 ChatMessage 上。
  //
  // 此前这一步整个漏掉:convertMessage 产出的 ChatMessage 不带 id/seq/rowid,
  // 于是 getIntrinsicMessageKey 只能退化到 "时间戳+正文前 48 字" 当 key。两个
  // 后果都很实:
  //   1)「编辑重跑」按钮 gated 在 message.id 上,永远 undefined → 功能整体死掉;
  //   2)流式气泡的 id 本是稳定的 `__streaming_<sid>`,丢了之后 key 变成
  //      "时间戳+正文",而 updateStreaming 每次 flush 换新时间戳 → key 每 100ms
  //      漂移 → React 每次都卸载重建整个流式气泡(DOM 重建 + markdown 重排)。
  // 一处补齐,同时救这两个症状。
  //
  // 多输出防撞:一条 msg 可能拆成多条(task-notification = 状态行 + 结果正文),
  // 它们共用同一个 msg.id 会撞 key —— >1 时给 id 加 `#index` 后缀。
  const multi = converted.length > 1;
  return converted.map((chatMessage, index) => {
    if (chatMessage.id !== undefined && chatMessage.id !== null) return chatMessage;
    const baseId = typeof msg.id === 'string' && msg.id.length > 0 ? msg.id : undefined;
    return {
      ...chatMessage,
      id: baseId ? (multi ? `${baseId}#${index}` : baseId) : undefined,
      seq: msg.seq,
      rowid: msg.rowid,
      sequence: msg.sequence,
    };
  });
}
