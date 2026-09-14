/**
 * 会话导出:把一段对话渲染成 Markdown / 独立 HTML / JSON,汇报、留档、再加工用。
 *
 * 默认只导出正文(user/assistant 的 text 消息)——工具调用、thinking、流式增量
 * 都是过程噪音,导出的读者要的是"聊了什么",不是"执行了什么"。注入过滤在
 * normalize 层早已生效,这里拿到的就是干净的正文。渲染是纯函数,单测直接钉。
 *
 * F12 两处增强:
 *   - **JSON 格式** —— md/html 是给人读的,读完就完了。想把对话喂给别的工具
 *     (统计、二次分析、迁移到别处)时,把 HTML 再解析回来是荒谬的。
 *   - **含工具过程** —— 默认之所以剔掉工具,是因为多数导出是给人看的;但排查
 *     "它当时到底改了哪个文件"时,过程恰恰是唯一有用的东西。做成开关,而不是
 *     替谁做决定。
 */

export type ExportableMessage = {
  kind: string;
  role?: 'user' | 'assistant';
  content?: string;
  timestamp?: string;
  model?: string;
  /** 工具调用/结果才有;`includeTools` 打开时进导出。 */
  toolName?: string;
  toolInput?: unknown;
  /**
   * fj:字段名对齐 `NormalizedMessage` 的 `toolId`。
   *
   * 这里原来叫 `toolUseId`,而全仓的归一化消息上根本没有这个名字;导出路由又用
   * `history.messages as ExportableMessage[]` 强转,**类型系统因此不报错**,
   * 运行时恒为 `undefined` —— JSON 导出里每个 `tool_call`/`tool_result` 的
   * `toolUseId` 都是 null,消费方没法把结果连回调用。而 JSON 导出的自述目标
   * 就是"喂给别的工具做二次分析"。
   *
   * 对外的字段名保持 `toolUseId` 不变(见 renderJsonExport)。
   */
  toolId?: string;
  isError?: boolean;
  /**
   * F38:**这条消息带了哪些附件。**
   *
   * 导出此前完全不提附件 —— 一条"看这张图,里面的报错是什么"导出来只剩那句话,
   * 读的人无从知道当时还给了模型一张图。JSON 导出的自述目标是"喂给别的工具做
   * 二次分析",少了附件那份分析建立在残缺的输入上。
   *
   * 只导**清单**(文件名 / 路径 / 类型),不导内容:导出是给人读和给工具分析的,
   * 把几百 KB base64 塞进 Markdown 只会让它打不开。
   */
  attachments?: ExportableAttachment[];
};

export type ExportableAttachment = {
  name?: string;
  path?: string;
  mimeType?: string;
};

export type ExportOptions = {
  /** 带上工具调用与结果(默认 false —— 多数导出是给人读的)。 */
  includeTools?: boolean;
};

export type SessionExportInput = {
  title: string;
  sessionId: string;
  /**
   * F38:**provider 原生会话 id。**
   *
   * 导出里原来只有 app 会话 id,而 transcript、检查点、工具日志全按原生 id 组织
   * —— 拿着导出去对 jsonl 时,第一步就断了。带上它,导出才是自洽的。
   */
  providerSessionId?: string | null;
  exportedAt: string;
  messages: ExportableMessage[];
};

export type RenderedExport = {
  content: string;
  mime: string;
  extension: 'md' | 'html' | 'json';
};

export type ExportFormat = 'md' | 'html' | 'json';

/** 附件清单的一行:名字优先,退回路径的最后一段。 */
function attachmentLabel(attachment: ExportableAttachment): string {
  if (attachment.name && attachment.name.trim()) return attachment.name.trim();
  const p = typeof attachment.path === 'string' ? attachment.path : '';
  const base = p.split(/[\\/]/).pop();
  return base || '(未命名附件)';
}

function attachmentsOf(message: ExportableMessage): ExportableAttachment[] {
  return Array.isArray(message.attachments) ? message.attachments.filter(Boolean) : [];
}

const formatTimestamp = (value: string | undefined): string => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace('T', ' ').slice(0, 19);
};

const isBodyMessage = (message: ExportableMessage): boolean =>
  message.kind === 'text'
  && (message.role === 'user' || message.role === 'assistant')
  && typeof message.content === 'string'
  && message.content.trim().length > 0;

const isToolMessage = (message: ExportableMessage): boolean =>
  message.kind === 'tool_use' || message.kind === 'tool_result';

/**
 * 该进导出的消息。
 *
 * `includeTools` 打开时**保留原始顺序**把工具调用与结果混在正文里 —— 工具的意义
 * 全在"它发生在哪两句话之间",单独列一节等于把这层信息扔了。
 */
export function selectExportMessages(
  messages: ExportableMessage[],
  options: ExportOptions = {},
): ExportableMessage[] {
  return messages.filter((message) =>
    isBodyMessage(message) || (options.includeTools === true && isToolMessage(message)));
}

/** fj:`tool_use` 的 id → 工具名,给 `tool_result` 反查用。 */
function buildToolNameIndex(messages: ExportableMessage[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const message of messages) {
    if (message.kind === 'tool_use' && message.toolId && message.toolName) {
      index.set(message.toolId, message.toolName);
    }
  }
  return index;
}

/**
 * 工具消息的一行摘要(md/html 用)。
 *
 * fj:`tool_result` 上没有 `toolName`(归一化消息只给 `toolId`/`content`/`isError`),
 * 所以此前所有结果块都退回字面量「结果」,渲染成"结果 · 结果"。改成按 `toolId`
 * 反查同 id 的 `tool_use` 拿工具名。
 */
function toolSummary(message: ExportableMessage, byToolId?: Map<string, string>): string {
  const resolvedName = message.toolName
    || (message.kind === 'tool_result' && message.toolId ? byToolId?.get(message.toolId) : undefined);
  const name = resolvedName || (message.kind === 'tool_result' ? '结果' : '工具');
  if (message.kind === 'tool_result') {
    return `${name}${message.isError ? '(失败)' : ''}`;
  }
  return name;
}

/** 工具消息的正文(输入或结果),截断到可读长度。 */
function toolBody(message: ExportableMessage): string {
  const raw = message.kind === 'tool_use'
    ? (message.toolInput === undefined ? '' : JSON.stringify(message.toolInput, null, 2))
    : String(message.content ?? '');
  const trimmed = raw.trim();
  // 单条 8000 字符封顶:一次 Read 的结果能有几十万字,导出不是日志转储。
  return trimmed.length > 8000 ? `${trimmed.slice(0, 8000)}\n… (truncated)` : trimmed;
}

export function renderMarkdownExport(input: SessionExportInput, options: ExportOptions = {}): string {
  const lines: string[] = [
    `# ${input.title}`,
    '',
    `> 会话 ${input.sessionId} · 导出于 ${formatTimestamp(input.exportedAt)}`,
    '',
  ];
  const toolNamesById = buildToolNameIndex(input.messages);
  for (const message of selectExportMessages(input.messages, options)) {
    if (isToolMessage(message)) {
      // 工具用引用块 + 代码块:视觉上明显低于正文一档,扫读时能整块跳过。
      lines.push(`> **${message.kind === 'tool_use' ? '调用' : '结果'} · ${toolSummary(message, toolNamesById)}**`, '');
      const body = toolBody(message);
      if (body) lines.push('```', body, '```', '');
      continue;
    }
    const who = message.role === 'user' ? '用户' : '助手';
    const meta = [formatTimestamp(message.timestamp), message.role === 'assistant' ? message.model : null]
      .filter(Boolean)
      .join(' · ');
    lines.push(`## ${who}${meta ? ` (${meta})` : ''}`, '', (message.content ?? '').trim(), '');
    // F38:附件只列清单,不导内容(base64 塞进 Markdown 会让它打不开)。
    const attachments = attachmentsOf(message);
    if (attachments.length > 0) {
      lines.push(`附件(${attachments.length}):`);
      for (const attachment of attachments) {
        lines.push(`- ${attachmentLabel(attachment)}${attachment.path ? ` — \`${attachment.path}\`` : ''}`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * JSON 导出。
 *
 * 刻意**不是**把内部 NormalizedMessage 原样倒出来 —— 那是内部结构,导出一旦这么
 * 做就等于把它变成对外契约,以后改不动。这里给一份稳定、自解释的形状。
 */
export function renderJsonExport(input: SessionExportInput, options: ExportOptions = {}): string {
  const payload = {
    prismExportVersion: 1,
    title: input.title,
    sessionId: input.sessionId,
    // F38:带上原生 id —— transcript / 检查点 / 工具日志都按它组织。
    providerSessionId: input.providerSessionId ?? null,
    exportedAt: input.exportedAt,
    includesTools: options.includeTools === true,
    messages: selectExportMessages(input.messages, options).map((message) => {
      if (isToolMessage(message)) {
        return {
          type: message.kind === 'tool_use' ? 'tool_call' : 'tool_result',
          timestamp: message.timestamp ?? null,
          tool: message.toolName ?? null,
          // 对外契约不变,取值改成真实存在的那个字段。
          toolUseId: message.toolId ?? null,
          ...(message.kind === 'tool_use'
            ? { input: message.toolInput ?? null }
            : { output: message.content ?? '', isError: Boolean(message.isError) }),
        };
      }
      const attachments = attachmentsOf(message);
      return {
        type: 'message',
        role: message.role ?? null,
        timestamp: message.timestamp ?? null,
        model: message.role === 'assistant' ? message.model ?? null : null,
        content: (message.content ?? '').trim(),
        // F38:清单而不是内容 —— 消费方要原图自己按 path 取。
        attachments: attachments.map((attachment) => ({
          name: attachmentLabel(attachment),
          path: attachment.path ?? null,
          mimeType: attachment.mimeType ?? null,
        })),
      };
    }),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function renderHtmlExport(input: SessionExportInput, options: ExportOptions = {}): string {
  const toolNamesById = buildToolNameIndex(input.messages);
  const bubbles = selectExportMessages(input.messages, options)
    .map((message) => {
      if (isToolMessage(message)) {
        const body = toolBody(message);
        return `<div class="tool">
  <div class="who">${message.kind === 'tool_use' ? '调用' : '结果'} · ${escapeHtml(toolSummary(message, toolNamesById))}</div>
  ${body ? `<pre>${escapeHtml(body)}</pre>` : ''}
</div>`;
      }
      const isUser = message.role === 'user';
      const meta = [formatTimestamp(message.timestamp), isUser ? null : message.model]
        .filter(Boolean)
        .join(' · ');
      const attachments = attachmentsOf(message);
      // F38:附件只列清单 —— 导出是给人读的,内嵌 base64 会让文件打不开。
      const attachmentsHtml = attachments.length > 0
        ? `\n  <div class="attachments">附件(${attachments.length}):${
          attachments.map((attachment) => `<span>${escapeHtml(attachmentLabel(attachment))}</span>`).join('')
        }</div>`
        : '';
      return `<div class="msg ${isUser ? 'user' : 'assistant'}">
  <div class="who">${isUser ? '用户' : '助手'}${meta ? `<span class="meta">${escapeHtml(meta)}</span>` : ''}</div>
  <div class="body">${escapeHtml((message.content ?? '').trim())}</div>${attachmentsHtml}
</div>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
  body { margin: 0 auto; max-width: 860px; padding: 32px 20px 64px; font: 15px/1.7 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1f2328; background: #f6f7f9; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .exported { color: #6b7280; font-size: 12px; margin-bottom: 28px; }
  .msg { margin: 14px 0; padding: 12px 16px; border-radius: 12px; }
  .msg.user { background: #eef2ff; border: 1px solid #dfe5ff; margin-left: 15%; }
  .msg.assistant { background: #ffffff; border: 1px solid #e5e7eb; margin-right: 15%; }
  .who { font-weight: 600; font-size: 12px; margin-bottom: 6px; color: #4b5563; }
  .who .meta { font-weight: 400; margin-left: 8px; color: #9ca3af; font-family: ui-monospace, monospace; font-size: 11px; }
  .body { white-space: pre-wrap; word-break: break-word; }
  .attachments { margin-top: 8px; font-size: 12px; color: #6b7280; }
  .attachments span { display: inline-block; margin-left: 6px; padding: 1px 6px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fafafa; }
  .tool { margin: 8px 0 8px 6%; padding: 8px 12px; border-left: 3px solid #d1d5db; background: #fafafa; color: #4b5563; font-size: 13px; }
  .tool pre { margin: 6px 0 0; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, monospace; font-size: 12px; }
</style>
</head>
<body>
<h1>${escapeHtml(input.title)}</h1>
<div class="exported">会话 ${escapeHtml(input.sessionId)} · 导出于 ${escapeHtml(formatTimestamp(input.exportedAt))}</div>
${bubbles}
</body>
</html>
`;
}

export function renderSessionExport(
  input: SessionExportInput,
  format: ExportFormat,
  options: ExportOptions = {},
): RenderedExport {
  if (format === 'html') {
    return { content: renderHtmlExport(input, options), mime: 'text/html; charset=utf-8', extension: 'html' };
  }
  if (format === 'json') {
    return { content: renderJsonExport(input, options), mime: 'application/json; charset=utf-8', extension: 'json' };
  }
  return { content: renderMarkdownExport(input, options), mime: 'text/markdown; charset=utf-8', extension: 'md' };
}
