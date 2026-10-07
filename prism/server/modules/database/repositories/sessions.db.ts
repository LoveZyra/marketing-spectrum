import fs from 'node:fs';

import { getConnection } from '@/modules/database/connection.js';
import { cachedPrepare } from '@/modules/database/prepared-cache.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { buildProjectVisibilityClause, type VisibilityScope } from '@/modules/database/visibility-sql.js';
import { createLogger } from '@/shared/logger.js';
import { normalizeProjectPath } from '@/shared/utils.js';

const log = createLogger('db');

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at';

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * 同一个项目可能写成两个不同的字符串:app 行存的是调用方给的路径,监视器那一行取的是
 * CLI 子进程的 `process.cwd()`,符号链接已被内核解析掉。项目路径里只要有一段是软链
 * (`/home` → `/var/home`、macOS 的 `/tmp`、工作区挂载到别处),原样字符串比就会把真正的
 * 监视器合并误判成跨项目:`provider_session_id` 一直是 NULL,每一轮都是没有上文的新对话,
 * 工具审批、预热、终端接管、编辑重跑全部失效,用户侧没有任何提示。
 *
 * 所以先规范化字符串,再落盘解一次软链;路径不存在(测试、项目已删)时 realpath 会抛,
 * 退回规范化后的字符串比。两个真正不同的项目不会因此被判成相等。
 */
function realProjectPath(projectPath: string): string {
  try {
    return fs.realpathSync.native(projectPath);
  } catch {
    return projectPath;
  }
}

function isSameProjectPath(a: string | null, b: string | null): boolean {
  // 任一侧为空就不算同一项目:两个还没归属的行不该因为都是空被并成一行。
  if (!a || !b) return false;
  if (a === b) return true;
  const normalizedA = normalizeProjectPath(a);
  const normalizedB = normalizeProjectPath(b);
  if (normalizedA === normalizedB) return true;
  return realProjectPath(normalizedA) === realProjectPath(normalizedB);
}

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

export const sessionsDb = {
  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row.
   */
  createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPath(projectPath);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    projectsDb.createProjectPath(normalizedProjectPath);

    const existing = cachedPrepare(db,
        `SELECT session_id FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { session_id: string } | undefined;

    if (existing) {
      /**
       * 这里不碰 `isArchived`。这是"磁盘发现会话"的 upsert,watcher 的每个 `change` 事件都会
       * 走到这里;若顺手解档,归档就形同虚设:
       *   1. 打开归档会话 400ms 后会 prewarm,`claude --resume` 会碰 JSONL 的 mtime 却不追加
       *      消息 → chokidar `change` → 这里 → 会话自己跑回活跃列表;
       *   2. 正在流式输出的会话被归档后,transcript 持续追加,很快就会被重新索引解档。
       * 解档由调用方显式调 `updateSessionIsArchived(id, false)`,与 `projectsDb.createProjectPath`
       * 的 ON CONFLICT 写法一致。
       */
      cachedPrepare(db,
        `UPDATE sessions SET
           provider = ?,
           updated_at = COALESCE(?, CURRENT_TIMESTAMP),
           project_path = ?,
           jsonl_path = ?,
           custom_name = COALESCE(?, custom_name)
         WHERE session_id = ?`
      ).run(
        provider,
        updatedAtValue,
        normalizedProjectPath,
        jsonlPath ?? null,
        customName ?? null,
        existing.session_id
      );

      return existing.session_id;
    }

    // Sessions created outside the app (directly via the provider CLI) are
    // keyed by the provider-native id for both columns. The ON CONFLICT path
    // covers legacy rows that predate the provider_session_id mapping.
    cachedPrepare(db,
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         custom_name = COALESCE(excluded.custom_name, sessions.custom_name)`
    ).run(
      providerSessionId,
      provider,
      providerSessionId,
      customName ?? null,
      normalizedProjectPath,
      jsonlPath ?? null,
      createdAtValue,
      updatedAtValue
    );

    return providerSessionId;
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping.
   */
  createAppSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    ownerUserId: number | null = null,
  ): string {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);

    // owner 必须在这里落下去。`createProjectPath` 的第三参默认 null,即"无主"(非公共目录
    // 仅 root 可见,公共目录下全员可见);少传它,新项目要么创建者自己看不见,要么对全服务器公开。
    // 已存在的项目走 ON CONFLICT,owner 不会被改,所以第一次落行就得带对 owner。
    projectsDb.createProjectPath(normalizedProjectPath, null, ownerUserId);

    cachedPrepare(db,
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(sessionId, provider, normalizedProjectPath);

    return sessionId;
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path and name
   * are adopted and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   *
   * 返回值表示映射是否真的落库:合并守卫拒绝时返回 false 而不是抛异常,调用方
   * (`recordProviderSessionId`)据此决定是否改内存,避免内存里认了映射而库里还是 NULL。
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): boolean {
    const db = getConnection();

    const merge = db.transaction(() => {
      const duplicate = cachedPrepare(db,
          `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      /**
       * 合并只允许发生在同一个项目里。
       *
       * 监视器抢先索引的那一行必然与本行同项目(transcript 就落在项目目录下)。不校验的话,
       * 这里的 DELETE 就是越权删除的落点:伪造的会话 id 被运行时回灌上来,别人那一行会被删掉,
       * 其 transcript 路径和名字并进本行。跨项目正是这种攻击的必要条件(同项目会被 CLI 的
       * "already in use" 挡掉),所以"同项目才合并"既堵住它,又不影响真正的监视器场景。
       * 入口一侧由 pickClientRuntimeOptions 收窄,两处缺一不可。
       */
      const current = cachedPrepare(db, 'SELECT project_path FROM sessions WHERE session_id = ?')
        .get(sessionId) as { project_path?: string | null } | undefined;
      // 软链会让同一个项目写成两个字符串,见 isSameProjectPath。
      const samePath = isSameProjectPath(duplicate?.project_path ?? null, current?.project_path ?? null);

      if (duplicate && !samePath) {
        // 不删、不并、也不认领这个 provider id —— 让本行保持没有映射的状态,
        // 好过悄悄把两段无关的对话缝在一起。
        log.warn(
          `[sessions] 拒绝跨项目合并 provider 会话映射:${sessionId} 想认领 ${providerSessionId},`
          + ' 但那个 id 属于另一个项目的会话行',
        );
        return false;
      }

      /**
       * 只吞"监视器裸行"。监视器抢先建的那一行样子固定:`session_id = provider_session_id`
       * (按 provider id 建键),且没有任何显示日志;有人聊过的真会话不长这样。
       * 只看"是不是另一行"的话,同项目里任何一条被认领 id 的会话都会被连行删掉,显示日志成了孤儿。
       * 不满足条件的一律不删、不并、不认领,只打 warn,与跨项目的处理一致。
       */
      if (duplicate) {
        const bareWatcherRow = duplicate.session_id === duplicate.provider_session_id;
        const historyRow = cachedPrepare(db,
          'SELECT COUNT(*) AS count FROM session_display_messages WHERE session_id = ?',
        ).get(duplicate.session_id) as { count: number } | undefined;
        const hasHistory = Number(historyRow?.count ?? 0) > 0;
        if (!bareWatcherRow || hasHistory) {
          log.warn(
            `[sessions] 拒绝合并 provider 会话映射:${sessionId} 想认领 ${providerSessionId},`
            + ` 但那个 id 对应的是一条有历史的真会话行(${duplicate.session_id}),不是监视器裸行`,
          );
          return false;
        }
        cachedPrepare(db, 'DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        cachedPrepare(db,
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = COALESCE(jsonl_path, ?),
             custom_name = COALESCE(custom_name, ?),
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        ).run(providerSessionId, duplicate.jsonl_path, duplicate.custom_name, sessionId);
        return true;
      }

      cachedPrepare(db,
        `UPDATE sessions SET
           provider_session_id = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(providerSessionId, sessionId);
      return true;
    });

    return merge();
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    cachedPrepare(db,
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  /**
   * 只给还没名字的会话落名 —— 名字是首条消息时客户端随 options 带来的
   * sessionSummary(技能调用会被换成「技能名:参数」)。已有名字(用户改过、
   * 或早前落过)一律不动,所以永远不会覆盖人工命名。
   */
  setSessionCustomNameIfEmpty(sessionId: string, customName: string): void {
    const db = getConnection();
    cachedPrepare(db,
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?
         AND (custom_name IS NULL OR custom_name = '')`
    ).run(customName, sessionId);
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = cachedPrepare(db,
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * 这条会话的发起人:显示日志里第一条用户消息的 `senderUserId`。
   *
   * `sessions` 表没有创建者一列(会话的归属看项目),而归档 / 还原 / 永久删除需要区分
   * "是不是我自己开的对话"。显示日志的用户行(网页 `origin:'web'`、外部 API `origin:'api'`)
   * 都带发送者 id,从这里反查,不用加列。磁盘上发现的会话没有显示日志,返回 null
   * (权限回落到 owner / root)。
   *
   * 只扫最前面几十行:第一条用户消息一定在开头。
   *
   * 日志被裁剪过(最早那批已物理删除)时也返回 null:剩下的"第一条用户消息"可能是协作者
   * 中途发的,拿它当发起人等于把永久删除权交给了他。
   */
  getSessionInitiatorUserId(sessionId: string): number | null {
    const db = getConnection();
    try {
      const state = cachedPrepare(db,
        'SELECT trimmed FROM session_display_log_state WHERE session_id = ?',
      ).get(sessionId) as { trimmed?: number } | undefined;
      if (Number(state?.trimmed || 0) > 0) return null;
    } catch {
      // 标记表还没建(测试里的裸库):当作没裁过
    }
    let rows: Array<{ payload: string }> = [];
    try {
      rows = cachedPrepare(db,
        `SELECT payload FROM session_display_messages
         WHERE session_id = ? AND kind = 'text'
         ORDER BY id ASC
         LIMIT 40`,
      ).all(sessionId) as Array<{ payload: string }>;
    } catch {
      return null; // 表还没建(测试里的裸库)当作没有显示日志
    }
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as { role?: unknown; senderUserId?: unknown };
        if (parsed?.role !== 'user') continue;
        const raw = parsed.senderUserId;
        const id = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
        return Number.isInteger(id) && id > 0 ? id : null;
      } catch {
        // 单行坏了就看下一行
      }
    }
    return null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = cachedPrepare(db,
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(providerSessionId) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    const rows = cachedPrepare(db,
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * 超过保留期的归档会话,最旧的在前,供归档保留期清扫使用。
   * 判据下推到 SQL:取最新的一页回来再按 cutoff 过滤,永远够不到该清的那些
   * (见 archive-retention.service 的说明)。
   *
   * 到期起点取归档时间与最后活动时间中较晚的那个:刚归档的旧会话也至少留满保留期,
   * 归档前还在聊的会话按最后活动算。两列可能一个是 `YYYY-MM-DD HH:MM:SS`、一个是 ISO 串,
   * 先各自 `datetime()` 归一再取 MAX,否则会按字符串比;没有归档时间的行回落到最后活动时间。
   */
  getExpiredArchivedSessions(cutoffIso: string, limit: number): string[] {
    const db = getConnection();
    const anchor = "MAX(COALESCE(datetime(archived_at), ''), datetime(COALESCE(updated_at, created_at)))";
    const rows = cachedPrepare(db,
      `SELECT session_id FROM sessions
       WHERE isArchived = 1
         AND ${anchor} < datetime(?)
       ORDER BY ${anchor} ASC, session_id ASC
       LIMIT ?`
    ).all(cutoffIso, limit) as Array<{ session_id: string }>;
    return rows.map((row) => row.session_id);
  },

  getArchivedSessionsPage(
    scope: VisibilityScope,
    limit: number,
    offset: number,
  ): { rows: SessionRow[]; total: number } {
    return sessionsDb.getVisibleSessionsPage(scope, limit, offset, { archived: 'only' });
  },

  /**
   * 可见会话的分页查询,归档面板与外部 API 共用。
   *
   * `archived` 三档:`'only'`(归档面板)、`'exclude'`(默认列表)、
   * `'include'`(外部 API 的 `?includeArchived=1`)。
   *
   * 可见性规则下推进 SQL(见 visibility-sql.ts),一次查询出页、一次 COUNT 出总数。
   * 不能整表取回再逐行 `canViewerSeeSession()`:它每行都要查库,而 better-sqlite3 是同步的,
   * 几千条会话就会把事件循环按住几百毫秒;先取后滤也没法正确分页。
   *
   * 会话没有自己的 owner,归属看项目,所以 LEFT JOIN 项目行。项目行可能还不存在
   * (会话先被 watcher 索引),此时 owner 为 NULL,判定回落到会话路径是否在公共目录下;
   * 会话路径为空时仅 root 可见。两条都与 JS 侧(`canViewerSeeSession`)同义。
   *
   * `projectPath` 非空时只取这个项目的会话(定时任务表单的会话下拉用),与可见性叠加;
   * 比较前按落库时的口径规范化。
   */
  getVisibleSessionsPage(
    scope: VisibilityScope,
    limit: number,
    offset: number,
    options: { archived?: 'only' | 'exclude' | 'include'; projectPath?: string } = {},
  ): { rows: SessionRow[]; total: number } {
    const db = getConnection();

    const archived = options.archived ?? 'exclude';
    let where = archived === 'only'
      ? 's.isArchived = 1'
      : archived === 'exclude' ? 's.isArchived = 0' : '1 = 1';
    let params: unknown[] = [];
    if (scope.kind === 'user') {
      const visibility = buildProjectVisibilityClause({
        userId: scope.userId,
        projectIdColumn: 'p.project_id',
        ownerColumn: 'p.owner_user_id',
        visibilityColumn: 'p.visibility',
        pathColumn: 's.project_path',
      });
      where += ` AND TRIM(COALESCE(s.project_path, '')) <> '' AND ${visibility.sql}`;
      params = visibility.params;
    }
    const projectPath = normalizeProjectPath(options.projectPath ?? '');
    if (projectPath) {
      where += ' AND s.project_path = ?';
      params = [...params, projectPath];
    }

    const from = `FROM sessions s LEFT JOIN projects p ON p.project_path = s.project_path WHERE ${where}`;
    const prefixed = SESSION_ROW_COLUMNS.split(', ').map((column) => `s.${column}`).join(', ');
    const rows = cachedPrepare(db,
        `SELECT ${prefixed} ${from}
         ORDER BY datetime(COALESCE(s.updated_at, s.created_at)) DESC, s.session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as SessionRow[];
    const totalRow = cachedPrepare(db, `SELECT COUNT(*) AS count ${from}`).get(...params) as { count: number } | undefined;

    return { rows: normalizeSessionRows(rows), total: Number(totalRow?.count ?? 0) };
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = cachedPrepare(db,
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = cachedPrepare(db,
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = cachedPrepare(db,
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, limit, offset) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * 批量取多个项目各自的首页会话,避免项目列表逐个项目查询(N+1)。
   * 用窗口函数 `ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY …)` 一次取回所有项目的
   * 前 limit 条,排序与 `getSessionsByProjectPathPage` 逐字一致。
   *
   * 只服务 offset=0(项目列表的默认形态);翻页仍走单项目那条。
   *
   * `includeArchived` 给归档项目列表用。归档与非归档只差 WHERE 里一句,所以用参数区分,
   * 不另写一份批量方法:同一条判据写两份,迟早漂开。
   */
  getFirstSessionsForProjectPaths(
    projectPaths: string[],
    limit: number,
    options: { includeArchived?: boolean } = {},
  ): Map<string, SessionRow[]> {
    const out = new Map<string, SessionRow[]>();
    if (projectPaths.length === 0 || limit <= 0) return out;
    const db = getConnection();
    const normalized = projectPaths.map((p) => normalizeProjectPath(p));
    const placeholders = normalized.map(() => '?').join(',');
    // 两个变体是两条不同的 SQL 字符串,cachedPrepare 各缓存各的,互不影响。
    const archivedClause = options.includeArchived === true ? '' : '\n             AND isArchived = 0';
    const rows = cachedPrepare(db,
        `SELECT ${SESSION_ROW_COLUMNS} FROM (
           SELECT ${SESSION_ROW_COLUMNS},
                  ROW_NUMBER() OVER (
                    PARTITION BY project_path
                    ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
                  ) AS rn
           FROM sessions
           WHERE project_path IN (${placeholders})${archivedClause}
         ) WHERE rn <= ?`
      )
      .all(...normalized, limit) as SessionRow[];

    for (const row of normalizeSessionRows(rows)) {
      // WHERE project_path IN (…) 已经把 NULL 挡在外面,这里的守卫只为收窄类型。
      const key = row.project_path;
      if (!key) continue;
      const bucket = out.get(key);
      if (bucket) bucket.push(row);
      else out.set(key, [row]);
    }
    return out;
  },

  /** 批量计数(E7):一次 GROUP BY 顶掉 N 次 COUNT。`includeArchived` 见上一个方法。 */
  countSessionsByProjectPaths(
    projectPaths: string[],
    options: { includeArchived?: boolean } = {},
  ): Map<string, number> {
    const out = new Map<string, number>();
    if (projectPaths.length === 0) return out;
    const db = getConnection();
    const normalized = projectPaths.map((p) => normalizeProjectPath(p));
    const placeholders = normalized.map(() => '?').join(',');
    const archivedClause = options.includeArchived === true ? '' : '\n           AND isArchived = 0';
    const rows = cachedPrepare(db,
        `SELECT project_path, COUNT(*) AS count
         FROM sessions
         WHERE project_path IN (${placeholders})${archivedClause}
         GROUP BY project_path`
      )
      .all(...normalized) as Array<{ project_path: string; count: number }>;
    for (const row of rows) out.set(row.project_path, Number(row.count) || 0);
    return out;
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = cachedPrepare(db,
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .get(normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    cachedPrepare(db, `
            DELETE FROM session_display_messages
            WHERE session_id IN (SELECT session_id FROM sessions WHERE project_path = ?)
        `).run(normalizedProjectPath);
        cachedPrepare(db, `DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = cachedPrepare(db,
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   *
   * 归档时记下 `archived_at`(已经是归档状态的再归档一次不刷新,保留期不因重复操作延长),
   * 解档时置 NULL。SET 里的 CASE 读的是改之前的 isArchived / archived_at。
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    const flag = isArchived ? 1 : 0;
    cachedPrepare(db,
      `UPDATE sessions
       SET isArchived = ?,
           archived_at = CASE
             WHEN ? = 0 THEN NULL
             WHEN isArchived = 1 AND archived_at IS NOT NULL THEN archived_at
             ELSE CURRENT_TIMESTAMP
           END
       WHERE session_id = ?`
    ).run(flag, flag, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    // 显示日志没有对 sessions 建外键(新会话的第一条消息可能早于 sessions 行落库),
    // 所以删会话时要显式清一遍,免得留下永远读不到的孤儿行。
    cachedPrepare(db, 'DELETE FROM session_display_messages WHERE session_id = ?').run(sessionId);
    return cachedPrepare(db, 'DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },
};
