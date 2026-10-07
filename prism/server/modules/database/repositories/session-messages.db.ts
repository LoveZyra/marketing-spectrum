import type { Statement } from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import { forkAnchorUuid } from '@/shared/fork-anchor.js';
import type { MessageKind, NormalizedMessage } from '@/shared/types.js';
import { generateMessageId } from '@/shared/utils.js';
import { createLogger } from '@/shared/logger.js';

const log = createLogger('db');

type DisplayMessageRow = {
  payload: string;
};

/**
 * 会留在对话里的消息种类。
 *
 * 这份清单要和前端 `useChatRealtimeHandlers` 的 `shouldPersist` 对齐 ——
 * 那边决定"什么进 store",这边决定"什么进日志"。两边一致,刷新页面看到的
 * 才和刷新前一模一样。
 *
 * 用白名单而不是黑名单:新增一种 kind 时,默认不写日志是安全的
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
  // 回合末的 checkpoint 改动清单。它是"这轮盘上多了哪些文件"的唯一权威事实
  // (与写入手段无关,Bash / python 写的文件 Write 帧里没有),工作面板的产出提取靠它
  // 才能认出非 Write 写盘。落库前剥 diff(见 writeDisplayRow)。
  'changed_files',
  // 回滚 / 单文件还原的反向帧。不落它,产出面板就与磁盘永久漂移
  // (文件已被回滚删掉,面板还列着,点开 404)。
  'files_reverted',
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
  tailPage: Statement | null;
  fingerprint: Statement | null;
  trim: Statement | null;
  markTrimmed: Statement | null;
  clearTrimmed: Statement | null;
  readTrimmed: Statement | null;
  sessionTranscript: Statement | null;
  /** 按显示日志顺序往回找最近一个 assistant 原生 uuid(「编辑重跑」的分叉锚点)。 */
  forkAnchor: Statement | null;
  /** 目标消息在显示日志里的行号(自增 id,即写入顺序)。 */
  rowOfMessage: Statement | null;
};
const prepared: PreparedCache = {
  db: null, append: null, count: null, list: null, tailPage: null, fingerprint: null, trim: null,
  markTrimmed: null, clearTrimmed: null, readTrimmed: null, sessionTranscript: null,
  forkAnchor: null, rowOfMessage: null,
};

/**
 * 每个会话最多留多少条显示日志。
 *
 * 这是行数最大的一张表,必须有上限:200 会话 × 400 条(payload 约 1.2 KB,tool_result 更大)
 * 就是 8 万行、约 108 MB,还要再乘上备份保留的份数。
 *
 * 2000 条是按"回放够用"定的:前端首屏只取尾页,再往前靠分页;真要看全量历史,
 * transcript 文件才是权威来源。裁剪会在 `session_display_log_state.trimmed` 上盖戳,
 * `fetchHistory` 见到这个戳(且有 transcript)就回落到 transcript。
 *
 * 可以用 `PRISM_DISPLAY_LOG_MAX_PER_SESSION` 调,0 或负数表示不裁剪。
 */
const displayLogLimit = (): number => {
  const raw = Number(process.env.PRISM_DISPLAY_LOG_MAX_PER_SESSION);
  if (!Number.isFinite(raw)) return 2000;
  return Math.trunc(raw);
};

function ensurePrepared() {
  const db = getConnection();
  if (prepared.db !== db) {
    prepared.db = db;
    prepared.append = db.prepare(`
      INSERT OR IGNORE INTO session_display_messages
        (session_id, message_id, kind, timestamp, payload, provider_assistant_uuid)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    // 分叉锚点查询。`id < ?` 走 (session_id, id) 索引,不需要给 provider_assistant_uuid
    // 单独建索引:一条会话里有值的行本来就密。
    prepared.rowOfMessage = db.prepare(
      'SELECT id FROM session_display_messages WHERE session_id = ? AND message_id = ?',
    );
    prepared.forkAnchor = db.prepare(`
      SELECT provider_assistant_uuid AS uuid
        FROM session_display_messages
       WHERE session_id = ? AND id < ? AND provider_assistant_uuid IS NOT NULL
       ORDER BY id DESC
       LIMIT 1
    `);
    prepared.count = db.prepare('SELECT COUNT(*) AS total FROM session_display_messages WHERE session_id = ?');
    prepared.list = db.prepare('SELECT payload FROM session_display_messages WHERE session_id = ? ORDER BY id ASC');
    // dn-O1:尾页直接在 SQL 取(倒序 LIMIT/OFFSET 再反转),分页请求不再整段读出。
    prepared.tailPage = db.prepare('SELECT payload FROM session_display_messages WHERE session_id = ? ORDER BY id DESC LIMIT ? OFFSET ?');
    prepared.fingerprint = db.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM session_display_messages WHERE session_id = ?');
    // 盖戳 / 清戳(裁剪后盖,seed 成功后清)。用 UPSERT 而不是 UPDATE:显示日志可以早于
    // sessions 行存在,状态行也必须能凭空建出来。
    // 最后的 `trim` 是就地裁剪:留最新的 N 条(按自增 id),更早的删掉;与 scheduled_task_runs
    // 的 finishRun 同一写法,索引 (session_id, id) 正好吃得到。
    prepared.markTrimmed = db.prepare(
      `INSERT INTO session_display_log_state (session_id, trimmed) VALUES (?, 1)
       ON CONFLICT(session_id) DO UPDATE SET trimmed = 1`,
    );
    prepared.clearTrimmed = db.prepare(
      `INSERT INTO session_display_log_state (session_id, trimmed) VALUES (?, 0)
       ON CONFLICT(session_id) DO UPDATE SET trimmed = 0`,
    );
    prepared.readTrimmed = db.prepare('SELECT trimmed FROM session_display_log_state WHERE session_id = ?');
    // 守门判据(wouldOrphanExistingHistory)要用:这个会话在磁盘上有没有 transcript。
    prepared.sessionTranscript = db.prepare('SELECT provider_session_id FROM sessions WHERE session_id = ?');
    prepared.trim = db.prepare(`
      DELETE FROM session_display_messages
      WHERE session_id = ?
        AND id <= (
          SELECT id FROM session_display_messages
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT 1 OFFSET ?
        )
    `);
  }
  return prepared;
}

/**
 * 把一个会话的显示日志裁到上限以内。
 *
 * ## 为什么不是每条都裁
 *
 * 裁剪本身要跑一次带子查询的 DELETE。每条消息都跑一次,在长回合里就是几百次无用功
 * (绝大多数时候一条都不用删)。所以只在条数是 64 的倍数时才真的去裁 ——
 * 上限是 2000,64 的步长意味着最多超出 63 条,而检查成本降到 1/64。
 * `audit_log` 用的是同一个思路(每 100 次写触发一次 trim)。
 *
 * 计数走已缓存的 `count` 语句,命中的是 `(session_id, id)` 覆盖索引,很便宜。
 *
 * ## 永不抛
 *
 * 裁剪失败不该影响"这条消息有没有存下来"—— 那才是调用方关心的事。
 */
function trimSession(sessionId: string): void {
  const limit = displayLogLimit();
  if (limit <= 0) return; // 显式关掉裁剪
  try {
    const cache = ensurePrepared();
    const row = cache.count!.get(sessionId) as { total?: number } | undefined;
    const total = Number(row?.total || 0);
    if (total <= limit || total % 64 !== 0) return;
    /**
     * 传 `OFFSET limit`,不是 `limit - 1`:语句是"删掉 id <= 第 N 新的那条",要保住最新的
     * `limit` 条,N 必须是第 limit+1 新的那条。
     */
    const result = cache.trim!.run(sessionId, sessionId, limit);
    if (result.changes > 0) {
      invalidateParsedList(sessionId);
      /**
       * 盖戳:删完不留痕迹的话,回放无从知道日志已经不是完整记录,会继续拿它当权威,
       * 早期历史静默消失。
       */
      cache.markTrimmed!.run(sessionId);
    }
  } catch {
    /* 裁剪失败不打断写入 */
  }
}

/**
 * 写第一行之前的守门:「要么日志完整,要么一行都没有」。
 *
 * `fetchHistory` 一看到日志有行就完全改读日志。给一个已有 transcript、但日志还空着的会话
 * 写第一行,等于把它的历史一次性从界面上抹掉,而且 `seedDisplayLogFromTranscript` 的
 * `countForSession > 0` 短路会让 seed 再也不重试,从 UI 不可恢复。
 *
 * 直接 `append` 的入口很多(定时任务的指令行与回执、外部 Agent API、优雅重启补的「回合被中断」、
 * 检查点恢复的 `files_reverted` 帧等),所以守门放在写入层,而不是靠每个调用方先 seed。
 *
 * 拒绝而不是就地 seed:就地 seed 要 await(读 transcript),而 `append` 是同步的、且被同步路径
 * 调用。也不需要:被拒的这一轮 CLI 自己会写进 jsonl,下一次 `chat.send` 正常 seed 时照样会被
 * 抄进来,拒绝只是把落库推迟到能做对的那一刻。
 */
function wouldOrphanExistingHistory(sessionId: string): boolean {
  try {
    const cache = ensurePrepared();
    const row = cache.count!.get(sessionId) as { total?: number } | undefined;
    if (Number(row?.total || 0) > 0) return false; // 日志已经在用了,写就是了
    const session = cache.sessionTranscript!.get(sessionId) as { provider_session_id?: string } | undefined;
    return Boolean(session?.provider_session_id);
  } catch {
    // 判不出来就放行 —— 守门失败不该让消息落不了库。
    return false;
  }
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

/**
 * writeDisplayRow:真正把一行写进表里,不守门、不裁剪。`append`(带守门 + 裁剪)和
 * `appendForSeed`(两样都不要)共用它,避免两条路的去重键 / 剥 diff 逻辑分叉。
 */
type WriteOutcome = 'inserted' | 'duplicate' | 'failed';

function writeDisplayRow(sessionId: string, message: NormalizedMessage): WriteOutcome {
  /**
   * 去重键。
   *
   * 正常情况下每条规范化消息都带 `id`(transcript 行用 `uuid`,流式消息用
   * `uuid_块序号`),重复推送靠唯一键幂等吞掉。极少数没有 id 的消息不能
   * 一律记成空串 —— 那样第二条起会被唯一键当成重复丢掉,日志直接少内容。
   * 没 id 就临时造一个:失去幂等,但绝不丢行。丢行是真错,重复是小错。
   */
  const messageId = typeof message.id === 'string' && message.id
    ? message.id
    : generateMessageId('display');

  // changed_files 落库前剥 diff:单文件 diff 可达 20KB,留着会让日志胖几个量级,产出提取
  // 用不到它。发给前端的那份(forward 的原对象)不动,卡片照常有 diff。
  const rawFiles = (message as { files?: unknown }).files;
  const persisted = message.kind === 'changed_files' && Array.isArray(rawFiles)
    ? {
      ...message,
      files: rawFiles.map((entry) => {
        const file = entry as Record<string, unknown>;
        return {
          path: file.path,
          oldPath: file.oldPath,
          status: file.status,
          untracked: file.untracked,
          additions: file.additions,
          deletions: file.deletions,
        };
      }),
    }
    : message;

  try {
    const result = ensurePrepared().append!.run(
      sessionId,
      messageId,
      String(persisted.kind),
      String(persisted.timestamp || new Date().toISOString()),
      JSON.stringify(persisted),
      // assistant 侧的行顺手记下自己的原生 uuid,作「编辑重跑」的分叉锚点。
      // 判据在 shared/fork-anchor.ts,落库与端点共用同一个。
      forkAnchorUuid({ id: messageId, kind: persisted.kind, role: (persisted as { role?: unknown }).role }),
    );
    if (result.changes > 0) invalidateParsedList(sessionId);
    /**
     * "重复"与"失败"要分得开:seed 据此判断抄成功没有。真正的写入失败(磁盘满、SQLITE_BUSY)
     * 若与"这条本来就抄过了"混为一谈,部分成功的日志会被判成 ready,而 `countForSession > 0`
     * 让它永远不再重抄。
     */
    return result.changes > 0 ? 'inserted' : 'duplicate';
  } catch (error) {
    log.warn('[display-log] append failed:', (error as Error)?.message || error);
    return 'failed';
  }
}

export const sessionMessagesDb = {
  /**
   * 追加一条显示日志。
   *
   * 永不抛异常 —— 写日志失败绝不能把正在进行的回合带崩。同一条消息重复推送
   * (重连补发之类)靠 `(session_id, message_id)` 唯一键幂等吞掉。
   */
  append(sessionId: string, message: NormalizedMessage): boolean {
    if (!sessionId || !isDurableDisplayMessage(message)) {
      return false;
    }

    /**
     * 唯一的守门点(见 `wouldOrphanExistingHistory`)。seed 走 `appendMany`,刻意绕过这道门:
     * 它正是在补齐历史。
     */
    if (wouldOrphanExistingHistory(sessionId)) {
      log.warn(
        `[display-log] 拒绝写入 ${sessionId}:该会话已有 transcript 但显示日志为空,`
        + '先写会让历史从界面消失(等下一次 chat.send 抄完历史再落库)',
      );
      return false;
    }

    const outcome = writeDisplayRow(sessionId, message);
    if (outcome === 'inserted') trimSession(sessionId);
    return outcome === 'inserted';
  },

  /**
   * seed 专用的写入:绕过 `append` 的守门与逐条裁剪。
   *
   * 守门要绕开是显然的(seed 就是来补历史的)。逐条裁剪也必须绕开:否则每 64 条触发一次
   * `trimSession`,一份 5000 条的老会话在抄写过程中就会被裁掉一大半,而 `seeded` 计的是插入次数,
   * 不是活下来的行数,seed 会报成功、从此永不重抄。
   */
  appendForSeed(sessionId: string, message: NormalizedMessage): WriteOutcome {
    if (!sessionId || !isDurableDisplayMessage(message)) return 'duplicate';
    return writeDisplayRow(sessionId, message);
  },

  /**
   * 批量追加(老会话首次 seed 用),整批一个事务。
   *
   * 老会话第一条消息发送前要把几百上千条历史抄进日志,逐条 append 就是几百次独立的隐式事务
   * (每次都 fsync),明显卡顿。用 better-sqlite3 的 transaction 包起来,一次提交。
   * 返回真正写进去的行数(唯一键去重后)。永不抛。
   *
   * 逐条走 `appendForSeed`(不守门、不逐条裁剪),整批结束后才交给 `trimSession`;
   * 抄完清掉裁剪戳(`session_display_log_state`),这一份是完整的,可以当权威。
   */
  appendMany(sessionId: string, messages: NormalizedMessage[]): number {
    if (!sessionId || !Array.isArray(messages) || messages.length === 0) return 0;
    try {
      const db = getConnection();
      let seeded = 0;
      let failed = 0;
      const run = db.transaction((items: NormalizedMessage[]) => {
        for (const message of items) {
          const outcome = sessionMessagesDb.appendForSeed(sessionId, message);
          if (outcome === 'inserted') seeded += 1;
          else if (outcome === 'failed') failed += 1;
        }
        /**
         * 一条都没失败才清戳。`writeDisplayRow` 内部 catch 了异常,事务不会因为单行失败而回滚;
         * 无条件清戳的话,部分成功的日志会被标成"完整",回放从此拿它当权威,缺掉的那些永远补不回来
         * (`countForSession > 0` 让 seed 也不会再抄一次)。
         *
         * 所以有失败就抛出去让事务回滚:整批要么都在,要么一行都不写,守住"要么日志完整、要么没有"。
         */
        if (failed > 0) {
          throw new Error(`display-log seed: ${failed} 行写入失败,整批回滚`);
        }
        try { ensurePrepared().clearTrimmed!.run(sessionId); } catch { /* 清戳失败不回滚整批 */ }
      });
      run(messages);
      trimSession(sessionId);
      return seeded;
    } catch (error) {
      log.warn('[display-log] appendMany failed:', (error as Error)?.message || error);
      return 0;
    }
  },

  /**
   * 这个会话的显示日志被裁剪过吗:决定它还能不能当回放的权威。
   *
   * 裁过 = 早期消息已经物理删除,拿它当权威就等于告诉用户"你的对话只有这么多"。
   * `fetchHistory` 据此回落到 transcript。
   */
  isTrimmed(sessionId: string): boolean {
    try {
      const row = ensurePrepared().readTrimmed!.get(sessionId) as { trimmed?: number } | undefined;
      return Number(row?.trimmed || 0) > 0;
    } catch {
      // 读不出来按"没裁过"处理:错判成完整只是维持现状,错判成不完整会让所有
      // 会话白白回落到 transcript(而那条路正是这张表要取代的)。
      return false;
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
      // 指纹一致(行数 + 最大 id 都没变)→ 用上次解析好的数组,免掉整段读盘 + JSON.parse。
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
      log.warn('[display-log] read failed:', (error as Error)?.message || error);
      return [];
    }
  },

  /**
   * 尾页分页,直接在 SQL 里取。
   *
   * 语义与 `sliceTailPage(listForSession(...), limit, offset)` 逐字节一致:`offset` 从尾部数
   * (跳过最新 offset 条),再往前取 `limit` 条,按时间正序返回;`hasMore` = 更早的行还有没有。
   * 不整段读出再切:指纹缓存挡得住静止会话,挡不住活跃回合(每个 durable 帧 append 都使缓存失效)。
   *
   * 指纹缓存命中时仍优先用它切片(纯内存,比 SQL 更便宜);未命中的分页请求只取所需区间,
   * 不顺带构建全量缓存,全量路径(limit=null)留给 listForSession。
   */
  listTailPage(sessionId: string, limit: number, offset: number): {
    messages: NormalizedMessage[];
    total: number;
    hasMore: boolean;
  } {
    // 不用 `this`:调用方可能解构方法,直接走 prepared 语句拿行数。
    let total = 0;
    try {
      const row = ensurePrepared().count!.get(sessionId) as { total?: number } | undefined;
      total = Number(row?.total || 0);
    } catch {
      total = 0;
    }
    const normalizedOffset = Math.max(0, Math.floor(offset));
    const normalizedLimit = Math.max(0, Math.floor(limit));

    try {
      const fingerprint = displayLogFingerprint(sessionId);
      const cached = parsedListCache.get(sessionId);
      if (cached && cached.fingerprint === fingerprint) {
        const end = Math.max(0, cached.messages.length - normalizedOffset);
        const start = Math.max(0, end - normalizedLimit);
        return { messages: cached.messages.slice(start, end), total, hasMore: start > 0 };
      }

      const rows = ensurePrepared().tailPage!.all(sessionId, normalizedLimit, normalizedOffset) as DisplayMessageRow[];
      const messages: NormalizedMessage[] = [];
      for (const row of rows) {
        try {
          messages.push(JSON.parse(row.payload) as NormalizedMessage);
        } catch {
          // 单行坏了就跳过 —— 与 listForSession 同一条规则。
        }
      }
      messages.reverse();
      return {
        messages,
        total,
        hasMore: total - normalizedOffset - messages.length > 0,
      };
    } catch (error) {
      log.warn('[display-log] tail-page read failed:', (error as Error)?.message || error);
      return { messages: [], total, hasMore: false };
    }
  },

  /**
   * 「编辑重跑」的分叉锚点:这条消息之前最后一个原生 assistant uuid。
   *
   * 返回值三态,调用方要分得开:
   * - `string`:找到了,直接拿去 SDK 的 `resumeSessionAt`;
   * - `null`:日志里有这一行,但它之前没有任何 assistant 行(会话的第一句);
   * - `undefined`:日志里没有这一行(老会话、或被 trim 掉了),调用方应当退回扫 jsonl,
   *   而不是当成"没有锚点"。
   *
   * 不能把这三种揉成一个 null,那会让调用方静默降级。
   */
  forkAnchorFor(sessionId: string, messageId: string): string | null | undefined {
    if (!sessionId || !messageId) return undefined;
    try {
      const cache = ensurePrepared();
      const row = cache.rowOfMessage!.get(sessionId, messageId) as { id?: number } | undefined;
      if (!row || typeof row.id !== 'number') return undefined;
      const anchor = cache.forkAnchor!.get(sessionId, row.id) as { uuid?: string } | undefined;
      return typeof anchor?.uuid === 'string' && anchor.uuid ? anchor.uuid : null;
    } catch (error) {
      log.warn('[display-log] fork anchor lookup failed:', (error as Error)?.message || error);
      return undefined;
    }
  },

  /**
   * 让这条会话的解析缓存失效。回收站搬进 / 搬回是绕过这个仓库直接动表的(整体 INSERT … SELECT),
   * 缓存不知道;不失效的话,恢复出来的会话可能读到删除前那份陈旧的解析结果。
   */
  invalidateCache(sessionId: string): void {
    invalidateParsedList(sessionId);
  },

  /**
   * 合流消息没执行就被撤掉了:那一行标 `withdrawn: true`,刷新后照样画成置灰的"已撤回"。
   * 只改这一行的 payload,不动顺序与分叉锚点。永不抛。
   */
  markWithdrawn(sessionId: string, messageId: string): boolean {
    if (!sessionId || !messageId) return false;
    try {
      const db = getConnection();
      const result = db
        .prepare("UPDATE session_display_messages SET payload = json_set(payload, '$.withdrawn', json('true')) WHERE session_id = ? AND message_id = ?")
        .run(sessionId, messageId);
      if (result.changes > 0) invalidateParsedList(sessionId);
      return result.changes > 0;
    } catch (error) {
      log.warn('[display-log] markWithdrawn failed:', (error as Error)?.message || error);
      return false;
    }
  },

  deleteForSession(sessionId: string): void {
    try {
      const db = getConnection();
      db.prepare('DELETE FROM session_display_messages WHERE session_id = ?').run(sessionId);
      // 状态行跟着日志一起删:日志清空后要等重抄(终端接管释放时就会这样做),
      // 残留的"裁过"标记不能留给重抄出来的新日志,否则它会白白回落 transcript。
      db.prepare('DELETE FROM session_display_log_state WHERE session_id = ?').run(sessionId);
      invalidateParsedList(sessionId);
    } catch (error) {
      log.warn('[display-log] delete failed:', (error as Error)?.message || error);
    }
  },
};
