import type { NormalizedMessage } from '@/shared/types.js';

export type SessionExportFormat = 'md' | 'json';

export type SessionExportMetadata = {
  sessionId: string;
  provider: string;
  title: string;
  projectPath: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SessionExport = {
  body: string;
  contentType: string;
  filename: string;
};

/**
 * Formats accepted by the export endpoint.
 *
 * Exported so the route and the renderer cannot disagree about the set: a value
 * that passes validation but has no branch in `renderSessionExport` would fall
 * through to whatever the default arm happens to be.
 */
export const SESSION_EXPORT_FORMATS: readonly SessionExportFormat[] = ['md', 'json'];

export function isSessionExportFormat(value: unknown): value is SessionExportFormat {
  return typeof value === 'string'
    && (SESSION_EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * Builds the download filename stem for a session.
 *
 * This value reaches the client inside a `Content-Disposition` header, and a
 * session title is user-controlled free text: it can hold newlines (which would
 * split the header and let the rest be read as a header of its own), quotes
 * (which would end the quoted-string early), path separators, and NUL. So this
 * is an allowlist — letters, digits, dot, dash, underscore — rather than a
 * blocklist of the characters known to be dangerous today.
 *
 * Non-ASCII is dropped rather than percent-encoded: the result is only the
 * ASCII `filename=` fallback, and callers that want the original title should
 * emit a `filename*=UTF-8''` parameter alongside it.
 *
 * Always returns a non-empty stem, because a title consisting entirely of
 * rejected characters (a CJK-only name, an emoji) would otherwise produce
 * `filename=".md"` — a dotfile with no name.
 */
export function buildExportFilenameStem(title: string, sessionId: string): string {
  const cleaned = title
    .normalize('NFKD')
     
    .replace(/[^ -~]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 80)
    .replace(/[-._]+$/g, '');

  if (cleaned) {
    return cleaned;
  }

  const fallbackId = sessionId.replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 40);
  return fallbackId ? `session-${fallbackId}` : 'session';
}

function fencedBlock(body: string, language = ''): string {
  // A tool result can itself contain a ``` fence. Widening our own fence past
  // the longest run inside keeps the block from being closed early, which would
  // spill the rest of the transcript out as prose.
  const longestRun = [...body.matchAll(/`{3,}/g)]
    .reduce((longest, match) => Math.max(longest, match[0].length), 2);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

function stringifyToolPayload(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    // Circular tool inputs are rare but must not abort the whole export.
    return String(value);
  }
}

function renderMessage(message: NormalizedMessage): string | null {
  const timestamp = message.timestamp ? ` _(${message.timestamp})_` : '';

  switch (message.kind) {
    case 'text': {
      const content = message.content ?? message.text ?? '';
      if (!content.trim()) {
        return null;
      }
      const speaker = message.role === 'user' ? 'User' : 'Assistant';
      return `### ${speaker}${timestamp}\n\n${content}`;
    }
    case 'thinking': {
      const content = message.content ?? '';
      if (!content.trim()) {
        return null;
      }
      // Blockquoted rather than fenced: thinking is prose, and a reader
      // skimming the export should be able to tell it apart from output.
      const quoted = content.split('\n').map((line) => `> ${line}`).join('\n');
      return `### Thinking${timestamp}\n\n${quoted}`;
    }
    case 'tool_use': {
      const input = stringifyToolPayload(message.toolInput);
      const header = `### Tool: ${message.toolName ?? 'unknown'}${timestamp}`;
      const inputBlock = input ? `\n\n${fencedBlock(input, 'json')}` : '';
      const result = message.toolResult?.content;
      if (!result) {
        return `${header}${inputBlock}`;
      }
      const label = message.toolResult?.isError ? 'Error' : 'Result';
      return `${header}${inputBlock}\n\n**${label}**\n\n${fencedBlock(result)}`;
    }
    case 'error': {
      const content = message.content ?? message.text ?? '';
      return content.trim() ? `### Error${timestamp}\n\n${fencedBlock(content)}` : null;
    }
    default:
      // Transport and lifecycle kinds (stream_delta, status, session_created,
      // permission_request, ...) describe how the conversation was delivered,
      // not what was said, so they are not part of a readable transcript.
      return null;
  }
}

/**
 * Renders a session as Markdown.
 *
 * Kept separate from the route so the transcript shape is testable without a
 * live session: this walks user-controlled content, and the failure mode of
 * getting a fence or an escape wrong is a document that silently renders as
 * something other than what the conversation said.
 */
export function renderSessionMarkdown(
  metadata: SessionExportMetadata,
  messages: NormalizedMessage[],
): string {
  const header = [
    `# ${metadata.title}`,
    '',
    `- Session: \`${metadata.sessionId}\``,
    `- Provider: ${metadata.provider}`,
    `- Project: \`${metadata.projectPath || 'unknown'}\``,
    `- Created: ${metadata.createdAt ?? 'unknown'}`,
    `- Updated: ${metadata.updatedAt ?? 'unknown'}`,
    `- Messages: ${messages.length}`,
    '',
    '---',
  ].join('\n');

  const body = messages
    .map(renderMessage)
    .filter((section): section is string => section !== null)
    .join('\n\n');

  return body ? `${header}\n\n${body}\n` : `${header}\n`;
}

/**
 * Renders a session in the requested format, with the headers needed to serve
 * it as a download.
 */
export function renderSessionExport(
  format: SessionExportFormat,
  metadata: SessionExportMetadata,
  messages: NormalizedMessage[],
): SessionExport {
  const stem = buildExportFilenameStem(metadata.title, metadata.sessionId);

  if (format === 'json') {
    return {
      body: JSON.stringify({ ...metadata, messages }, null, 2),
      contentType: 'application/json; charset=utf-8',
      filename: `${stem}.json`,
    };
  }

  return {
    body: renderSessionMarkdown(metadata, messages),
    contentType: 'text/markdown; charset=utf-8',
    filename: `${stem}.md`,
  };
}
