/**
 * 输入框草稿的存储键,会话优先:
 *
 * - 有会话号:`draft_input_session_<sessionId>` —— 每个会话各存各的,同项目内切换会话时草稿不互相覆盖;
 * - 还没会话号(新建会话页,首条消息发出前):退回项目键 `draft_input_<projectId>`,首发后该键即清。
 */
export function draftStorageKey(
  sessionKey: string | null | undefined,
  projectId: string | null | undefined,
): string | null {
  if (sessionKey) return `draft_input_session_${sessionKey}`;
  if (projectId) return `draft_input_${projectId}`;
  return null;
}

/**
 * 按停止时,把排队内容与输入框里正在打的字合并,两边都不丢。
 *
 * 顺序按书写时间:排队内容在前,当前输入在后;都留在输入框里,发不发由用户下一次按键决定。
 */
export function mergeQueuedIntoInput(queuedContent: string, currentInput: string): string {
  const queued = (queuedContent || '').trimEnd();
  if (!(currentInput || '').trim()) return queuedContent || '';
  if (!queued) return currentInput;
  return `${queued}\n${currentInput}`;
}
