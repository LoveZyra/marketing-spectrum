/**
 * 会话导出:把一段对话渲染成 Markdown 或独立 HTML,汇报/留档用。
 *
 * 只导出正文(user/assistant 的 text 消息)——工具调用、thinking、流式增量
 * 都是过程噪音,导出的读者要的是"聊了什么",不是"执行了什么"。注入过滤在
 * normalize 层早已生效,这里拿到的就是干净的正文。渲染是纯函数,单测直接钉。
 */

export type ExportableMessage = {
  kind: string;
  role?: 'user' | 'assistant';
  content?: string;
  timestamp?: string;
  model?: string;
};

export type SessionExportInput = {
  title: string;
  sessionId: string;
  exportedAt: string;
  messages: ExportableMessage[];
};

export type RenderedExport = {
  content: string;
  mime: string;
  extension: 'md' | 'html';
};

const formatTimestamp = (value: string | undefined): string => {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace('T', ' ').slice(0, 19);
};

/** 只留有内容的正文消息。 */
export function selectExportMessages(messages: ExportableMessage[]): ExportableMessage[] {
  return messages.filter(
    (message) =>
      message.kind === 'text'
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string'
      && message.content.trim().length > 0,
  );
}

export function renderMarkdownExport(input: SessionExportInput): string {
  const lines: string[] = [
    `# ${input.title}`,
    '',
    `> 会话 ${input.sessionId} · 导出于 ${formatTimestamp(input.exportedAt)}`,
    '',
  ];
  for (const message of selectExportMessages(input.messages)) {
    const who = message.role === 'user' ? '用户' : '助手';
    const meta = [formatTimestamp(message.timestamp), message.role === 'assistant' ? message.model : null]
      .filter(Boolean)
      .join(' · ');
    lines.push(`## ${who}${meta ? ` (${meta})` : ''}`, '', (message.content ?? '').trim(), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function renderHtmlExport(input: SessionExportInput): string {
  const bubbles = selectExportMessages(input.messages)
    .map((message) => {
      const isUser = message.role === 'user';
      const meta = [formatTimestamp(message.timestamp), isUser ? null : message.model]
        .filter(Boolean)
        .join(' · ');
      return `<div class="msg ${isUser ? 'user' : 'assistant'}">
  <div class="who">${isUser ? '用户' : '助手'}${meta ? `<span class="meta">${escapeHtml(meta)}</span>` : ''}</div>
  <div class="body">${escapeHtml((message.content ?? '').trim())}</div>
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

export function renderSessionExport(input: SessionExportInput, format: 'md' | 'html'): RenderedExport {
  if (format === 'html') {
    return { content: renderHtmlExport(input), mime: 'text/html; charset=utf-8', extension: 'html' };
  }
  return { content: renderMarkdownExport(input), mime: 'text/markdown; charset=utf-8', extension: 'md' };
}
