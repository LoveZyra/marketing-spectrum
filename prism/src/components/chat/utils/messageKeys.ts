import type { ChatMessage } from '../types/types';

const toMessageKeyPart = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

export const getIntrinsicMessageKey = (message: ChatMessage): string | null => {
  const candidates = [
    message.id,
    message.messageId,
    message.toolId,
    message.toolCallId,
    message.blobId,
    message.rowid,
    message.sequence,
  ];

  for (const candidate of candidates) {
    const keyPart = toMessageKeyPart(candidate);
    if (keyPart) {
      return `message-${message.type}-${keyPart}`;
    }
  }

  const timestamp = new Date(message.timestamp).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const toolName = typeof message.toolName === 'string' ? message.toolName : '';
  // 兜底 key **不含正文**。以前带正文前 48 字,于是流式那条每来一批 token 就换一次
  // key —— React 卸载重建整个气泡,markdown 重解析、代码块重新高亮、高度先塌后涨。
  // 同一时间戳下的多条由 ChatMessagesPane 的出现次序做后缀消歧,不需要正文参与。
  return `message-${message.type}-${timestamp}-${toolName}`;
};
