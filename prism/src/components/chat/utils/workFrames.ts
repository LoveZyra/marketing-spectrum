import type { ChatMessage } from '../types/types';

/**
 * dq:服务端工作面板帧(GET /sessions/:id/work-frames)→ 伪 ChatMessage。
 *
 * 面板此前只吃前端已加载窗口(首屏尾 20 条),长会话一刷新,早前回合的
 * 清单与产出凭空变少。现在服务端从全量历史滤出相关工具帧当**基线**,前端
 * 把基线转成最小 ChatMessage 拼在已加载消息**前面**,交给同一套折叠函数 ——
 * 折叠对重放幂等,基线与窗口的重叠段不会算错;折叠规则始终只有前端一份。
 */
export interface SessionWorkFrame {
  id?: string;
  timestamp?: string;
  toolName: string;
  toolInput: unknown;
  resultContent: string | null;
  resultIsError: boolean;
}

/**
 * dr:实时 changed_files 帧 → 伪 Write 成功消息。
 *
 * 回合末的 changed_files 是 Bash/python 写盘文件的唯一证据;落库基线要等
 * 下一次 refetch(与落库赛跑,可能慢一拍),实时帧直接喂面板即刻入列 ——
 * 与服务端 collectWorkFrames 的展开完全同构(只算新增、cwd 拼绝对路径),
 * 刷新后由基线接管,重叠靠折叠幂等去重。
 */
export function changedFilesToMessages(
  cwd: string | null | undefined,
  files: readonly unknown[],
): ChatMessage[] {
  const base = typeof cwd === 'string' && cwd ? cwd.replace(/[\\/]+$/, '') : '';
  const messages: ChatMessage[] = [];
  for (const entry of files) {
    const file = entry as { path?: unknown; status?: unknown; untracked?: unknown } | null;
    const relPath = typeof file?.path === 'string' ? file.path.trim() : '';
    if (!relPath) continue;
    if (file?.status !== 'added' && !file?.untracked) continue;
    messages.push({
      type: 'assistant',
      content: '',
      timestamp: Date.now(),
      isToolUse: true,
      toolName: 'Write',
      toolInput: { file_path: base ? `${base}/${relPath}` : relPath },
      toolResult: { content: 'checkpoint', isError: false },
    } as ChatMessage);
  }
  return messages;
}

export function workFramesToMessages(frames: readonly SessionWorkFrame[]): ChatMessage[] {
  return frames
    .filter((frame) => frame && typeof frame.toolName === 'string')
    .map((frame) => ({
      type: 'assistant',
      content: '',
      timestamp: frame.timestamp || 0,
      isToolUse: true,
      toolName: frame.toolName,
      toolInput: frame.toolInput,
      // 结果未落地(resultContent null 且非错)→ toolResult 为 null:
      // 与实时消息一致,「未执行完的 Write 不算产出」这条规则原样生效。
      toolResult: frame.resultContent !== null || frame.resultIsError
        ? { content: frame.resultContent ?? '', isError: frame.resultIsError }
        : null,
    }) as ChatMessage);
}
