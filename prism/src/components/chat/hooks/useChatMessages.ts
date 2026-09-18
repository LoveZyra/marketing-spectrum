/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';

function formatToolResultContent(content: unknown): string {
  /**
   * dv:`JSON.stringify(undefined)` 返回的是 **undefined 值**(不是字符串),
   * 紧接着 `.trim()` 就抛 TypeError —— 而 `NormalizedMessage.content` 是可选的,
   * transcript 解析层在 content 缺席时正好产出它。一条这样的 tool_result 就能
   * 让整个 `normalizedToChatMessages` 在 useMemo 里抛错、聊天页白屏。
   */
  const text = typeof content === 'string' ? content : (JSON.stringify(content) ?? '');
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
  /**
   * gd:**后台任务的进展与汇报,按 `toolId` 归到子代理卡上。**
   *
   * SDK 的 `task_progress` / `task_notification` 都带 `tool_use_id`,而那正是
   * 那次 Task/Agent 调用的 id —— 也就是子代理卡的身份。任务一转后台,
   * 子代理的内部步骤就**不再走实时流**了(那次工具调用当场拿到一个
   * "running in the background" 的 tool_result),卡片因此停在转后台之前的那几步。
   * 线上看到的「2 步」+ 另起一行的完成汇报,就是这两样没连起来。
   *
   * 汇报优先于进展:同一个 toolId 上,`task_notification` 是终态,不许被后到的
   * 进展帧盖回 running(帧的顺序在重连补发时不保证)。
   */
  const backgroundByToolId = new Map<string, NonNullable<ChatMessage['subagentState']>['background']>();
  for (const msg of messages) {
    if (msg.kind !== 'task_progress' && msg.kind !== 'task_notification') continue;
    if (!msg.toolId) continue;
    const existing = backgroundByToolId.get(msg.toolId);
    if (existing && existing.status !== 'running' && msg.kind === 'task_progress') continue;
    const progress = (msg as { taskProgress?: Record<string, number | string | undefined> }).taskProgress;
    backgroundByToolId.set(msg.toolId, {
      status: msg.kind === 'task_notification'
        ? (msg.status === 'completed' ? 'completed' : 'failed')
        : 'running',
      summary: typeof msg.summary === 'string' && msg.summary.trim() ? msg.summary : existing?.summary,
      toolUses: typeof progress?.toolUses === 'number' ? progress.toolUses : existing?.toolUses,
      durationMs: typeof progress?.durationMs === 'number' ? progress.durationMs : existing?.durationMs,
      lastToolName: typeof progress?.lastToolName === 'string' ? progress.lastToolName : existing?.lastToolName,
    });
  }
  /**
   * ge:**后台任务的完成/失败归到它自己那一行,主对话流里一行都不多出。**
   *
   * gd 只把有 `tool_use_id` 的汇报归给**子代理卡**,别的(转后台的 Bash、
   * workflow)照旧独立成行 —— 实机看下来那一串「✅ 后台任务完成 Run minidb
   * test suite」把一条本该连贯的时间轴切得七零八落,而它说的事**那一行自己
   * 就能说**(那条 Bash 就在上面几行)。
   *
   * 所以归属集合放宽到**任何 tool_use**:后台跑的东西必然是某次工具调用起的,
   * 它的终态就该回到那次调用上。剩下真正无主的(那一行被 trim 出窗口了),
   * 也不再单独成行 —— 内容仍在显示日志里,只是不在这条轴上插一句旁白。
   */
  const toolRowIds = new Set<string>();
  for (const msg of messages) {
    if (msg.kind === 'tool_use' && msg.toolId) toolRowIds.add(msg.toolId);
  }

  const childrenByParent = new Map<string, SubagentChildTool[]>();
  for (const msg of messages) {
    if (!msg.parentToolUseId) continue;
    /**
     * ge:**正文与思考也收进来。**
     *
     * SDK 默认只转发子代理的 `tool_use` / `tool_result`("enough for a heartbeat
     * counter"),`forwardSubagentText: true` 之后正文与思考也带着
     * `parent_tool_use_id` 一起来 —— SDK 明说那就是给"渲染嵌套 transcript"用的。
     * 此前这两种被**直接丢掉**(顶层那句 `continue` 之外没有别的去处),
     * 于是点开一张卡只有一串光秃秃的工具名,看不出它在想什么。
     */
    if (msg.kind === 'text' || msg.kind === 'thinking') {
      const body = typeof msg.content === 'string' ? msg.content.trim() : '';
      if (!body) continue;
      const narrationList = childrenByParent.get(msg.parentToolUseId) ?? [];
      narrationList.push({
        toolId: msg.id || `child_${narrationList.length}`,
        toolName: msg.kind === 'thinking' ? 'Thinking' : 'Text',
        toolInput: undefined,
        toolResult: null,
        timestamp: new Date(msg.timestamp || Date.now()),
        kind: msg.kind === 'thinking' ? 'thinking' : 'text',
        content: body,
      });
      childrenByParent.set(msg.parentToolUseId, narrationList);
      continue;
    }
    if (msg.kind !== 'tool_use') continue;
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
      kind: 'tool',
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
    /**
     * ge:任务生命周期的行**有主的不出顶层**。
     *
     * 进展每几秒一条,本来就只归行;带 `toolId` 的完成/失败也归到它自己那一行
     * (见上面 `toolRowIds`)。要的是"一根轴串下来",不是每隔几行插一句旁白。
     *
     * gh:**没有 `toolId` 的照旧渲染成回执行。** ge 把所有 task_notification 一刀切掉,
     * 连定时任务的三条回执(「⏰ 开始执行」「✅ 执行完成」「⚠️ 执行失败:<原因>」)也一起
     * 没了 —— 它们从来没有 tool_use_id,不是旁白,是那条会话唯一的成败说明。
     * 删一类东西之前要先列全它的来源;这里就是没列全的代价。
     */
    if (msg.kind === 'task_progress') continue;
    if (msg.kind === 'task_notification' && msg.toolId) continue;

    const toolResult = resolveToolResult(msg, toolResultMap);
    const realtimeChildren = msg.kind === 'tool_use' && msg.toolId
      ? childrenByParent.get(msg.toolId) ?? null
      : null;
    // ge:任何工具行都可能被转到后台,不只是子代理容器。
    const background = msg.kind === 'tool_use' && msg.toolId && toolRowIds.has(msg.toolId)
      ? backgroundByToolId.get(msg.toolId)
      : undefined;
    /**
     * gd:**后台状态必须进缓存签名。**
     *
     * 缓存按 `msg` 对象缓存,而后台任务的进展是**另一条消息**带来的 ——
     * 容器那一行自己一个字都没变。不进签名的话,进度涨了、任务完成了,
     * 这张卡还是缓存里那份旧的:"修复代码在,数据到不了它"的又一种形状。
     */
    const childSignature = [
      realtimeChildren
        ? `${realtimeChildren.length}:${realtimeChildren.filter((child) => child.toolResult).length}`
        : '',
      background
        ? `bg:${background.status}:${background.toolUses ?? ''}:${background.lastToolName ?? ''}:${background.durationMs ?? ''}`
        : '',
    ].join('|');

    const cached = conversionCache.get(msg);
    if (cached && cached.toolResult === toolResult && cached.childSignature === childSignature) {
      for (const chatMessage of cached.chatMessages) {
        converted.push(chatMessage);
      }
      continue;
    }

    const chatMessages = convertMessage(msg, toolResult, realtimeChildren, background);
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
  /** gd:这个子代理转到后台之后的进展与汇报(按 toolId 归拢,见调用点)。 */
  background: NonNullable<ChatMessage['subagentState']>['background'] = undefined,
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
            /**
             * dv:把结果帧的时间戳带上。
             *
             * `toolDuration`(工具行的「耗时」列)读的就是这个字段,而生产链路
             * 上唯一的构造点就是这里,原来只写 content/isError/toolUseResult ——
             * 于是真实会话里耗时**恒为空**;单测手搓对象所以一直是绿的。
             * 独立 tool_result 行有自己的 timestamp;服务端预挂的那份没有,
             * 缺席时仍返回空,行为与从前一致。
             */
            timestamp: (tr as { timestamp?: string | number | Date }).timestamp,
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
        // ge:转后台的工具行(不只子代理)——`summarizeToolRow` 据此显示真实终态。
        ...(background ? { background } : {}),
        isSubagentContainer,
        subagentState: isSubagentContainer
          ? {
              childTools,
              currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
              /**
               * gd:转到后台的任务,那次工具调用**立刻**就有 tool_result
               * ("running in the background"),按老判据当场就算"完成"了。
               * 真正的终态在 `task_notification` 里 —— 有后台状态时以它为准。
               */
              isComplete: background ? background.status !== 'running' : Boolean(toolResult),
              ...(background ? { background } : {}),
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
        // ga:本地提示的标记要还原回来 —— `endsTurnForOutputs` 靠它区分
        // "provider 报的错终结回合"与"前端就地插的一条红字"。
        // 剥掉它的后果:拖一个超大附件进输入框,正在跑的工具清单当场塌成一行、
        // 真正在跑的那条命令翻成「已中断」、这一轮的产出卡被清空。
        ...(msg.isLocalNotice ? { isLocalNotice: true } : {}),
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
