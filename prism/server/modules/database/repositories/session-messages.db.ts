import { getConnection } from '@/modules/database/connection.js';
import type { MessageKind, NormalizedMessage } from '@/shared/types.js';
import { generateMessageId } from '@/shared/utils.js';

type DisplayMessageRow = {
  payload: string;
};

/**
 * 会**留在对话里**的消息种类。
 *
 * 这份清单要和前端 `useChatRealtimeHandlers` 的 `shouldPersist` 对齐 ——
 * 那边决定"什么进 store",这边决定"什么进日志"。两边一致,刷新页面看到的
 * 才和刷新前一模一样。
 *
 * 用**白名单**而不是黑名单:新增一种 kind 时,默认不写日志是安全的
 * (顶多少显示一样东西);默认写进去则可能把 `stream_delta` 这种每 token 一条的
 * 洪流灌进库里。
 */
const DURABLE_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'error',
  'interactive_prompt',
  'task_notification',
]);

export function isDurableDisplayMessage(message: { kind?: unknown }): boolean {
  return typeof message?.kind === 'string' && DURABLE_KINDS.has(message.kind as MessageKind);
}

export const sessionMessagesDb = {
  /**
   * 追加一条显示日志。
   *
   * **永不抛异常** —— 写日志失败绝不能把正在进行的回合带崩。同一条消息重复推送
   * (重连补发之类)靠 `(session_id, message_id)` 唯一键幂等吞掉。
   */
  append(sessionId: string, message: NormalizedMessage): boolean {
    if (!sessionId || !isDurableDisplayMessage(message)) {
      return false;
    }

    /**
     * 去重键。
     *
     * 正常情况下每条规范化消息都带 `id`(transcript 行用 `uuid`,流式消息用
     * `uuid_块序号`),重复推送靠唯一键幂等吞掉。极少数没有 id 的消息**不能**
     * 一律记成空串 —— 那样第二条起会被唯一键当成重复丢掉,日志直接少内容。
     * 没 id 就临时造一个:失去幂等,但绝不丢行。丢行是真错,重复是小错。
     */
    const messageId = typeof message.id === 'string' && message.id
      ? message.id
      : generateMessageId('display');

    try {
      const db = getConnection();
      const result = db
        .prepare(`
          INSERT OR IGNORE INTO session_display_messages
            (session_id, message_id, kind, timestamp, payload)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          sessionId,
          messageId,
          String(message.kind),
          String(message.timestamp || new Date().toISOString()),
          JSON.stringify(message),
        );
      return result.changes > 0;
    } catch (error) {
      console.warn('[display-log] append failed:', (error as Error)?.message || error);
      return false;
    }
  },

  /** 这个会话有没有自己的显示日志 —— 决定回放走日志还是回落到 transcript。 */
  countForSession(sessionId: string): number {
    try {
      const db = getConnection();
      const row = db
        .prepare('SELECT COUNT(*) AS total FROM session_display_messages WHERE session_id = ?')
        .get(sessionId) as { total?: number } | undefined;
      return Number(row?.total || 0);
    } catch {
      return 0;
    }
  },

  /**
   * 按追加顺序读回整段。
   *
   * 分页交给上层的 `sliceTailPage` —— 和 transcript 那条路走同一套切片语义,
   * 免得两条路的 `hasMore` 含义不一样。
   */
  listForSession(sessionId: string): NormalizedMessage[] {
    try {
      const db = getConnection();
      const rows = db
        .prepare('SELECT payload FROM session_display_messages WHERE session_id = ? ORDER BY id ASC')
        .all(sessionId) as DisplayMessageRow[];
      const messages: NormalizedMessage[] = [];
      for (const row of rows) {
        try {
          messages.push(JSON.parse(row.payload) as NormalizedMessage);
        } catch {
          // 单行坏了就跳过,不要让一条脏数据把整个会话读不出来。
        }
      }
      return messages;
    } catch (error) {
      console.warn('[display-log] read failed:', (error as Error)?.message || error);
      return [];
    }
  },

  deleteForSession(sessionId: string): void {
    try {
      getConnection()
        .prepare('DELETE FROM session_display_messages WHERE session_id = ?')
        .run(sessionId);
    } catch (error) {
      console.warn('[display-log] delete failed:', (error as Error)?.message || error);
    }
  },
};
