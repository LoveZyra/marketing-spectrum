import type { Statement } from 'better-sqlite3';

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

/**
 * 连接感知的 prepared statement 缓存。
 *
 * `append` 是所有出站消息的唯一收口 —— 每条 durable 消息都会 `db.prepare` 一次,
 * 重复编译同一句 SQL。缓存下来复用即可。但 prepared statement 绑在具体连接上,
 * 而库在备份 / 关停时会 close+reopen(见 connection.ts),换了连接旧 statement 就
 * 失效。所以按"当前连接是不是上次那个"来判定,连接一变就重新 prepare。
 */
type PreparedCache = {
  db: ReturnType<typeof getConnection> | null;
  append: Statement | null;
  count: Statement | null;
  list: Statement | null;
  fingerprint: Statement | null;
};
const prepared: PreparedCache = { db: null, append: null, count: null, list: null, fingerprint: null };

function ensurePrepared() {
  const db = getConnection();
  if (prepared.db !== db) {
    prepared.db = db;
    prepared.append = db.prepare(`
      INSERT OR IGNORE INTO session_display_messages
        (session_id, message_id, kind, timestamp, payload)
      VALUES (?, ?, ?, ?, ?)
    `);
    prepared.count = db.prepare('SELECT COUNT(*) AS total FROM session_display_messages WHERE session_id = ?');
    prepared.list = db.prepare('SELECT payload FROM session_display_messages WHERE session_id = ? ORDER BY id ASC');
    prepared.fingerprint = db.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM session_display_messages WHERE session_id = ?');
  }
  return prepared;
}

/**
 * 解析后的整段消息缓存。
 *
 * `listForSession` 是新会话的主显示路径 —— 每次打开 / 每次上翻都把整段日志读出来、
 * 逐条 JSON.parse 再交给上层切片,会话越长越慢,而 transcript 那条路的 LRU 完全
 * 覆盖不到它。这里按 (行数, 最大 id) 指纹缓存解析结果:日志没变(指纹一致)就直接
 * 返回上次解析好的数组,免掉重复读盘 + parse。写入(append/appendMany/delete)会
 * 使对应会话的缓存失效。容量有限,LRU 淘汰。
 */
const parsedListCache = new Map<string, { fingerprint: string; messages: NormalizedMessage[] }>();
const PARSED_LIST_CACHE_MAX = 32;

function displayLogFingerprint(sessionId: string): string {
  try {
    const row = ensurePrepared().fingerprint!.get(sessionId) as { c?: number; m?: number | null } | undefined;
    return `${Number(row?.c || 0)}:${row?.m ?? 0}`;
  } catch {
    return 'err';
  }
}

function invalidateParsedList(sessionId: string): void {
  parsedListCache.delete(sessionId);
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
      const result = ensurePrepared().append!.run(
        sessionId,
        messageId,
        String(message.kind),
        String(message.timestamp || new Date().toISOString()),
        JSON.stringify(message),
      );
      if (result.changes > 0) invalidateParsedList(sessionId);
      return result.changes > 0;
    } catch (error) {
      console.warn('[display-log] append failed:', (error as Error)?.message || error);
      return false;
    }
  },

  /**
   * 批量追加(老会话首次 seed 用),整批一个事务。
   *
   * 老会话第一条消息发送前要把几百上千条历史抄进日志,逐条 append 就是几百次
   * 独立的隐式事务(每次都 fsync),明显卡顿。用 better-sqlite3 的 transaction
   * 包起来,一次提交。返回真正写进去的行数(唯一键去重后)。永不抛。
   */
  appendMany(sessionId: string, messages: NormalizedMessage[]): number {
    if (!sessionId || !Array.isArray(messages) || messages.length === 0) return 0;
    try {
      const db = getConnection();
      let seeded = 0;
      const run = db.transaction((items: NormalizedMessage[]) => {
        for (const message of items) {
          if (sessionMessagesDb.append(sessionId, message)) seeded += 1;
        }
      });
      run(messages);
      return seeded;
    } catch (error) {
      console.warn('[display-log] appendMany failed:', (error as Error)?.message || error);
      return 0;
    }
  },

  /** 这个会话有没有自己的显示日志 —— 决定回放走日志还是回落到 transcript。 */
  countForSession(sessionId: string): number {
    try {
      const row = ensurePrepared().count!.get(sessionId) as { total?: number } | undefined;
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
      // 指纹一致(行数 + 最大 id 都没变)→ 直接返回上次解析好的数组,免掉整段
      // 读盘 + JSON.parse。注意返回缓存数组本体:上层只读不改(切片会自己拷),
      // 若未来有改数组的调用方,应在这里改成返回浅拷贝。
      const fingerprint = displayLogFingerprint(sessionId);
      const cached = parsedListCache.get(sessionId);
      if (cached && cached.fingerprint === fingerprint) {
        // 刷新 LRU 近度
        parsedListCache.delete(sessionId);
        parsedListCache.set(sessionId, cached);
        // 返回浅拷贝:防上层对数组做 in-place 改动污染缓存(省的是 JSON.parse,
        // 一次数组浅拷贝相对可忽略)。
        return [...cached.messages];
      }

      const rows = ensurePrepared().list!.all(sessionId) as DisplayMessageRow[];
      const messages: NormalizedMessage[] = [];
      for (const row of rows) {
        try {
          messages.push(JSON.parse(row.payload) as NormalizedMessage);
        } catch {
          // 单行坏了就跳过,不要让一条脏数据把整个会话读不出来。
        }
      }

      parsedListCache.set(sessionId, { fingerprint, messages });
      while (parsedListCache.size > PARSED_LIST_CACHE_MAX) {
        const oldest = parsedListCache.keys().next().value;
        if (oldest === undefined) break;
        parsedListCache.delete(oldest);
      }
      // 同 cache-hit 分支:返回浅拷贝,绝不把缓存持有的数组本体交出去。
      return [...messages];
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
      invalidateParsedList(sessionId);
    } catch (error) {
      console.warn('[display-log] delete failed:', (error as Error)?.message || error);
    }
  },
};
