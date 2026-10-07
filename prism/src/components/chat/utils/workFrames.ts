import type { ChatMessage } from '../types/types';

/**
 * 服务端工作面板帧(GET /sessions/:id/work-frames 响应里的 frames)。
 *
 * 服务端只下发折叠会读的字段(见 server sessions.service 的 WORK_FRAME_INPUT_FIELDS):
 * Write 只有 file_path、不带正文,TaskCreate 只有 subject,TaskUpdate 只有 taskId / status / subject,
 * TodoWrite 原样;resultContent 除 TaskCreate 的以外只是开头一段。折叠要读新字段、或者要解析
 * 别的工具的结果时,服务端那边要一起改。
 */
export interface SessionWorkFrame {
  id?: string;
  timestamp?: string;
  /** 'changed_file' = checkpoint 改动清单里的新增文件(Bash 等写盘),形状与 Write 帧相同。 */
  kind?: 'tool' | 'changed_file';
  toolName: string;
  toolInput: unknown;
  resultContent: string | null;
  resultIsError: boolean;
  /** 服务端数的用户回合(见 server sessions.service 的 SessionWorkFrame.turn)。 */
  turn?: number;
  /** toolInput 被服务端删过字段。 */
  inputTrimmed?: boolean;
  /** resultContent 只是开头一段。 */
  resultTrimmed?: boolean;
}

/** 上一次落地的 work-frames 响应的 ETag,连同它属于哪个会话。 */
export interface WorkFramesValidator {
  sessionId: string;
  etag: string;
}

/**
 * 重取 work-frames 时的条件请求头。
 *
 * 手里那份 ETag 属于同一会话才带 If-None-Match:服务端回 304 的意思是"你手里那份就是最新的",
 * 手里那份必须真是这个会话当前显示的基线。
 */
export function workFramesRequestHeaders(
  validator: WorkFramesValidator | null,
  sessionId: string,
): Record<string, string> | undefined {
  if (!validator || validator.sessionId !== sessionId || !validator.etag) return undefined;
  return { 'If-None-Match': validator.etag };
}

/**
 * 基线末尾的"回合号"标记 —— 服务端全量日志里的用户回合数。
 *
 * 刷新时窗口只有尾部 20 条,这一轮的用户消息常常不在里面;这一轮还没有任务帧的话,基线里的最大回合号
 * 也还是上一轮的 —— 这一轮新建的任务就会和上一轮被停下的老任务落在同一个回合号上。接一条标记把计数推到
 * 真实的回合数,窗口里的任务事件就落在正确的回合上。不是工具帧,别的折叠函数都不看它。
 */
export function turnMarkerMessage(userTurns: unknown): ChatMessage[] {
  if (typeof userTurns !== 'number' || !Number.isFinite(userTurns) || userTurns <= 0) return [];
  const marker: ChatMessage = { type: 'work_turn_marker', content: '', timestamp: 0, taskTurn: userTurns };
  return [marker];
}

/**
 * 实时 changed_files 帧 → 伪 Write 成功消息。
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

/**
 * 服务端工作面板帧 → 伪 ChatMessage。
 *
 * 前端已加载窗口只有首屏尾部 20 条,只靠它,长会话一刷新早前回合的清单与产出就会变少。
 * 所以服务端从全量历史滤出相关工具帧当基线,前端把基线转成最小 ChatMessage 拼在已加载消息前面,
 * 交给同一套折叠函数 —— 折叠对重放幂等,基线与窗口的重叠段不会算错;折叠规则始终只有前端一份。
 *
 * 帧里只有折叠要读的字段,这些伪消息只喂清单 / 产出两个折叠函数,不能拿去画工具行或算写入量。
 */
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
      // 回合号原样带过去,给任务清单分辨"这一轮"(见 taskChecklist 的 TodoItem.turn)
      ...(typeof frame.turn === 'number' && frame.turn > 0 ? { taskTurn: frame.turn } : {}),
    }) as ChatMessage);
}
