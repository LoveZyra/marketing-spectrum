import type { Statement } from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import type { MessageKind, NormalizedMessage } from '@/shared/types.js';
import { generateMessageId } from '@/shared/utils.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('db');

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
  // dr:回合末的 checkpoint 改动清单。它是"这轮盘上多了哪些文件"的唯一
  // 权威事实(与写入手段无关 —— Bash/python 写的文件 Write 帧里没有),
  // 工作面板的产出提取靠它才能认出非 Write 写盘。落库前剥 diff(见 append)。
  'changed_files',
  // dt:回滚/单文件还原的反向帧 —— 不落它,产出面板就与磁盘永久漂移
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
};
const prepared: PreparedCache = {
  db: null, append: null, count: null, list: null, tailPage: null, fingerprint: null, trim: null,
  markTrimmed: null, clearTrimmed: null, readTrimmed: null, sessionTranscript: null,
};

/**
 * 每个会话最多留多少条显示日志。
 *
 * 这张表原来**只增不删**:没有 TTL、没有条数上限、没有孤儿清扫 —— 而 `audit_log`
 * 有 5000 行上限、`scheduled_task_runs` 有 50 条上限,唯独行数最大的这张什么都没有。
 * 实测 200 会话 × 400 条(payload 约 1.2 KB,tool_result 更大)= 8 万行 = **108 MB**;
 * 2000 会话按同密度约 1 GB,再乘每日备份保留 7 份 = 磁盘 ×8。
 *
 * 2000 条是按"回放够用"定的:前端首屏只取尾页,再往前靠分页;真要看全量历史,
 * transcript 文件才是权威来源。
 *
 * ## fj:这条回落此前**只写在这段注释里,代码里并不存在**
 *
 * `fetchHistory` 的判据是 `countForSession > 0` 就一律读日志,全文件没有任何
 * "被裁过就回落"的分支 —— 于是超过 2048 条的会话,早期几百上千条从界面永久消失。
 * 现在裁剪会在 `sessions.display_log_trimmed` 上盖戳,`fetchHistory` 认那个戳。
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
        (session_id, message_id, kind, timestamp, payload)
      VALUES (?, ?, ?, ?, ?)
    `);
    prepared.count = db.prepare('SELECT COUNT(*) AS total FROM session_display_messages WHERE session_id = ?');
    prepared.list = db.prepare('SELECT payload FROM session_display_messages WHERE session_id = ? ORDER BY id ASC');
    // dn-O1:尾页直接在 SQL 取(倒序 LIMIT/OFFSET 再反转),分页请求不再整段读出。
    prepared.tailPage = db.prepare('SELECT payload FROM session_display_messages WHERE session_id = ? ORDER BY id DESC LIMIT ? OFFSET ?');
    prepared.fingerprint = db.prepare('SELECT COUNT(*) AS c, MAX(id) AS m FROM session_display_messages WHERE session_id = ?');
    // 就地裁剪:留最新的 N 条(按自增 id),更早的删掉。
    // 与 scheduled_task_runs 的 finishRun 同一写法,索引 (session_id, id) 正好吃得到。
    // fj:裁剪盖戳 / seed 成功后清戳。UPSERT 而不是 UPDATE —— 显示日志可以早于
    // sessions 行存在,所以状态行也必须能凭空建出来,否则戳会写进空气里。
    prepared.markTrimmed = db.prepare(
      `INSERT INTO session_display_log_state (session_id, trimmed) VALUES (?, 1)
       ON CONFLICT(session_id) DO UPDATE SET trimmed = 1`,
    );
    prepared.clearTrimmed = db.prepare(
      `INSERT INTO session_display_log_state (session_id, trimmed) VALUES (?, 0)
       ON CONFLICT(session_id) DO UPDATE SET trimmed = 0`,
    );
    prepared.readTrimmed = db.prepare('SELECT trimmed FROM session_display_log_state WHERE session_id = ?');
    // fj:守门判据要用 —— 这个会话在磁盘上有没有 transcript。
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
 * (绝大多数时候一条都不用删)。所以只在**条数是 64 的倍数时**才真的去裁 ——
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
    // OFFSET limit-1 指向"保留窗口里最老的那条",<= 它的全删
    const result = cache.trim!.run(sessionId, sessionId, limit - 1);
    if (result.changes > 0) {
      invalidateParsedList(sessionId);
      /**
       * fj:盖戳。这一句是整条修复的关键 —— 删完不留痕迹,回放就无从知道
       * "日志已经不是完整记录了",于是继续拿它当权威,早期历史静默消失。
       */
      cache.markTrimmed!.run(sessionId);
    }
  } catch {
    /* 裁剪失败不打断写入 */
  }
}

/**
 * fj:写第一行之前的守门 —— 「要么日志完整,要么一行都没有」。
 *
 * `fetchHistory` 一看到日志有行就完全改读日志。所以**给一个已有 transcript、
 * 但日志还空着的会话写第一行**,等于把它几百条历史一次性从界面上抹掉,而且
 * `seedDisplayLogFromTranscript` 的 `countForSession > 0` 短路会让 seed 再也不
 * 重试 —— 从 UI 不可恢复。
 *
 * 此前这道门只写在 `chat-websocket.service.ts` 的 handler 里(先 seed 再写),
 * 而另外 6 个入口全都直接 `append`:定时任务的用户指令行与回执、外部 Agent API
 * 的同步/异步两条、优雅重启补的「回合被中断」、以及**检查点恢复**的
 * `files_reverted` 帧。任何一条先跑,那个会话的历史就没了。
 *
 * 守门放在写入层而不是靠每个调用方自觉 —— 前者漏一次要改一处,后者已经漏了六次。
 *
 * ## 为什么是「拒绝」而不是「就地 seed」
 *
 * 就地 seed 要 await(读 transcript),而 `append` 是同步的、且被同步路径调用。
 * 更重要的是**不需要**:被拒的这一轮,CLI 自己会把它写进 jsonl,所以下一次
 * `chat.send` 正常 seed 时它照样会被抄进来。拒绝只是把落库推迟到能做对的那一刻。
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
 * fj:真正把一行写进表里 —— 不守门、不裁剪。`append`(带守门+裁剪)和
 * `appendForSeed`(两样都不要)共用它,避免两条路的去重键/剥 diff 逻辑分叉。
 */
function writeDisplayRow(sessionId: string, message: NormalizedMessage): boolean {
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

  // dr:changed_files 落库前剥 diff —— 单文件 diff 可达 20KB,一回合一帧,
  // 留着会让日志白胖几个量级;产出提取只要 path/status/untracked 这几样。
  // 发给前端的那份(forward 的原对象)不动,卡片照常有 diff。
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
    );
    if (result.changes > 0) invalidateParsedList(sessionId);
    return result.changes > 0;
  } catch (error) {
    log.warn('[display-log] append failed:', (error as Error)?.message || error);
    return false;
  }
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
     * fj:唯一的守门点(见 `wouldOrphanExistingHistory`)。
     * seed 自己走 `appendMany`,那条路**刻意绕过**这道门 —— 它正是在补齐历史。
     */
    if (wouldOrphanExistingHistory(sessionId)) {
      log.warn(
        `[display-log] 拒绝写入 ${sessionId}:该会话已有 transcript 但显示日志为空,`
        + '先写会让历史从界面消失(等下一次 chat.send 抄完历史再落库)',
      );
      return false;
    }

    const written = writeDisplayRow(sessionId, message);
    if (written) trimSession(sessionId);
    return written;
  },

  /**
   * fj:seed 专用的写入 —— 绕过 `append` 的守门与逐条裁剪。
   *
   * 守门要绕开是显然的(seed 就是来补历史的)。**逐条裁剪必须绕开**才是这一条的
   * 重点:`appendMany` 原来逐条调 `append`,每 64 条触发一次 `trimSession`,于是
   * 一份 5000 条的老会话**在抄写过程中就把自己裁到了 2000**;而返回的 `seeded`
   * 计的是插入次数(5000),不是活下来的行数,所以 seed 报成功、从此永不重抄。
   */
  appendForSeed(sessionId: string, message: NormalizedMessage): boolean {
    if (!sessionId || !isDurableDisplayMessage(message)) return false;
    return writeDisplayRow(sessionId, message);
  },

  /**
   * 批量追加(老会话首次 seed 用),整批一个事务。
   *
   * 老会话第一条消息发送前要把几百上千条历史抄进日志,逐条 append 就是几百次
   * 独立的隐式事务(每次都 fsync),明显卡顿。用 better-sqlite3 的 transaction
   * 包起来,一次提交。返回真正写进去的行数(唯一键去重后)。永不抛。
   *
   * fj:走 `appendForSeed`(不守门、不逐条裁剪),整批结束后**才**裁一次;
   * 抄完清掉 `display_log_trimmed` —— 这一份是完整的,可以当权威。
   */
  appendMany(sessionId: string, messages: NormalizedMessage[]): number {
    if (!sessionId || !Array.isArray(messages) || messages.length === 0) return 0;
    try {
      const db = getConnection();
      let seeded = 0;
      const run = db.transaction((items: NormalizedMessage[]) => {
        for (const message of items) {
          if (sessionMessagesDb.appendForSeed(sessionId, message)) seeded += 1;
        }
        // 事务里先清戳:整批抄完的这一份是完整的。若随后的 trimSession 真的删了行,
        // 它会再把戳盖回去 —— 顺序是对的。
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
   * fj:这个会话的显示日志**被裁剪过**吗 —— 决定它还能不能当回放的权威。
   *
   * 裁过 = 早期消息已经物理删除 = 拿它当权威就等于告诉用户"你的对话只有这么多"。
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
      log.warn('[display-log] read failed:', (error as Error)?.message || error);
      return [];
    }
  },

  /**
   * dn-O1:尾页分页,直接在 SQL 里取。
   *
   * 语义与 `sliceTailPage(listForSession(...), limit, offset)` 逐字节一致:
   * `offset` 从**尾部**数(跳过最新 offset 条),再往前取 `limit` 条,按时间
   * 正序返回;`hasMore` = 更早的行还有没有。此前分页请求也要整段读出 + 全量
   * JSON.parse 再切片 —— 指纹缓存挡得住静止会话,挡不住活跃回合(每个 durable
   * 帧 append 都使缓存失效,每轮 complete 刷新都是一次全量重读)。
   *
   * 指纹缓存命中时仍优先用它切片(纯内存,比 SQL 更便宜);未命中的分页请求
   * 只取所需区间,**不**顺带构建全量缓存 —— 全量路径(limit=null)留给 listForSession。
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

  deleteForSession(sessionId: string): void {
    try {
      const db = getConnection();
      db.prepare('DELETE FROM session_display_messages WHERE session_id = ?').run(sessionId);
      // fj:状态行跟着日志一起走。留着的话,这个会话下次重抄之后仍会被判成"裁过",
      // 白白回落 transcript(终端接管释放时会故意清空日志等着重抄,就是这条路)。
      db.prepare('DELETE FROM session_display_log_state WHERE session_id = ?').run(sessionId);
      invalidateParsedList(sessionId);
    } catch (error) {
      log.warn('[display-log] delete failed:', (error as Error)?.message || error);
    }
  },
};
