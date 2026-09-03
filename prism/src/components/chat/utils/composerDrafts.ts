/**
 * 输入框草稿的存储键。
 *
 * 原来只按项目分(`draft_input_<projectId>`):同一项目里几个会话切来切去,
 * 草稿互相覆盖 —— 在 A 会话打了一半的话,切到 B 会话还挂在输入框里,
 * 回到 A 时可能已经被 B 里的输入冲掉。改成**会话优先**:
 *
 * - 有会话号:`draft_input_session_<sessionId>` —— 每个会话自己的草稿;
 * - 还没会话号(新建会话页,首条消息发出前):退回项目键,首发后该键即清。
 *
 * 旧的项目键数据不迁移:它天然只会再出现在"新建会话"页上,不会窜进
 * 已有会话。
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
 * dn-B2:按停止时,排队内容与输入框里正在打的字**合并**,谁都不丢。
 *
 * 场景:排了一条纠正、又开始打新内容、然后按停止 —— 原来是无条件
 * `setInput(排队内容)`,正在打的字被整个覆盖。合并顺序按时间:排队在前
 * (先写的),当前输入在后;都留在输入框里,发不发由用户下一次按键决定。
 */
export function mergeQueuedIntoInput(queuedContent: string, currentInput: string): string {
  const queued = (queuedContent || '').trimEnd();
  if (!(currentInput || '').trim()) return queuedContent || '';
  if (!queued) return currentInput;
  return `${queued}\n${currentInput}`;
}
