import type { NormalizedMessage } from '../../../stores/useSessionStore';

/** 非 git 目录「撤销这一轮之后的文件改动」可选的轮次:服务端已落库、带 turnUuid、未撤回的用户消息;fileRewindTurns 去重后按新到旧返回。 */
export type FileRewindTurn = { turnUuid: string; prompt: string; timestamp: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function fileRewindTurns(messages: NormalizedMessage[] | null | undefined): FileRewindTurn[] {
  if (!Array.isArray(messages)) return [];
  const seen = new Set<string>();
  const turns: FileRewindTurn[] = [];
  for (const message of messages) {
    if (message.kind !== 'text' || message.role !== 'user' || message.withdrawn === true) continue;
    const turnUuid = typeof message.turnUuid === 'string' ? message.turnUuid : '';
    if (!UUID_RE.test(turnUuid) || seen.has(turnUuid)) continue;
    seen.add(turnUuid);
    turns.push({ turnUuid, prompt: String(message.content ?? '').trim(), timestamp: message.timestamp });
  }
  return turns.reverse();
}
