import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { buildProjectVisibilityClause, type VisibilityScope } from '@/modules/database/visibility-sql.js';
import { normalizeProjectPath } from '@/shared/utils.js';

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

    const existing = db
      .prepare(
        `SELECT session_id FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`
      )
      .get(providerSessionId, provider) as { session_id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE sessions SET
           provider = ?,
           updated_at = COALESCE(?, CURRENT_TIMESTAMP),
           project_path = ?,
           jsonl_path = ?,
           isArchived = 0,
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
    db.prepare(
      `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         isArchived = 0,
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

    // owner 必须在这里落下去。`createProjectPath` 的第三参默认 null,而 null 的
    // 含义是"无主"(2026-08-14 起:非公共目录仅 root 可见,公共目录下全员可见)——
    // 少传这一个参数,新项目要么创建者自己都看不见,要么意外对全服务器公开。
    // 已存在的项目走 ON CONFLICT,owner 不会被改;所以**第一次落行就得带对 owner**。
    projectsDb.createProjectPath(normalizedProjectPath, null, ownerUserId);

    db.prepare(
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
   */
  assignProviderSessionId(sessionId: string, providerSessionId: string): void {
    const db = getConnection();

    const merge = db.transaction(() => {
      const duplicate = db
        .prepare(
          `SELECT ${SESSION_ROW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`
        )
        .get(providerSessionId, providerSessionId, sessionId) as SessionRow | undefined;

      if (duplicate) {
        db.prepare('DELETE FROM sessions WHERE session_id = ?').run(duplicate.session_id);
        db.prepare(
          `UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = COALESCE(jsonl_path, ?),
             custom_name = COALESCE(custom_name, ?),
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`
        ).run(providerSessionId, duplicate.jsonl_path, duplicate.custom_name, sessionId);
        return;
      }

      db.prepare(
        `UPDATE sessions SET
           provider_session_id = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`
      ).run(providerSessionId, sessionId);
    });

    merge();
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  getSessionById(sessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
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
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  getSessionByProviderSessionId(providerSessionId: string): SessionRow | null {
    const db = getConnection();
    const row = db
      .prepare(
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
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * 归档会话分页 + **可见性下推 SQL**(E10)。
   *
   * 原来是"全表捞回来 → 每行跑一次 canViewerSeeSession"。那一次判定自己又要
   * 三次查询(会话行 / 项目行 / 授权名单),归档攒到几百条,打开一次归档面板
   * 就是上千次查询;而且过滤发生在 JS 侧,根本没法分页 —— 先分页再过滤,每页
   * 剩几条全看运气。这里把同一条规则下推进 SQL(见 visibility-sql.ts),
   * 一次查询出页,一次查询出总数。
   *
   * 会话没有自己的 owner,它挂在项目上,所以 LEFT JOIN 项目行。项目行**可能
   * 不存在**(会话先被 watcher 索引、项目还没落行),此时 owner 为 NULL,判定
   * 回落到"会话自己记的路径在不在公共目录下" —— 与 JS 侧同义。会话路径为空
   * 时仅 root 可见,也与 JS 侧那条 `ownerUserId: -1` 同义。
   */
  getArchivedSessionsPage(
    scope: VisibilityScope,
    limit: number,
    offset: number,
  ): { rows: SessionRow[]; total: number } {
    const db = getConnection();

    let where = 's.isArchived = 1';
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

    const from = `FROM sessions s LEFT JOIN projects p ON p.project_path = s.project_path WHERE ${where}`;
    const prefixed = SESSION_ROW_COLUMNS.split(', ').map((column) => `s.${column}`).join(', ');
    const rows = db
      .prepare(
        `SELECT ${prefixed} ${from}
         ORDER BY datetime(COALESCE(s.updated_at, s.created_at)) DESC, s.session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as SessionRow[];
    const totalRow = db.prepare(`SELECT COUNT(*) AS count ${from}`).get(...params) as { count: number } | undefined;

    return { rows: normalizeSessionRows(rows), total: Number(totalRow?.count ?? 0) };
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = db
      .prepare(
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
    const rows = db
      .prepare(
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
    const rows = db
      .prepare(
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
   * 批量版:一次取**多个项目各自的首页会话**(E7)。
   *
   * 项目列表原来是每个项目三次查询(首页 / 计数 / 授权),项目一多就是典型的
   * N+1 —— 30 个项目 = 90 次 prepare+执行。这里用窗口函数
   * `ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY …)` 一次把所有项目的
   * 前 limit 条捞回来,排序与 `getSessionsByProjectPathPage` **逐字一致**。
   *
   * 只服务 offset=0(项目列表的默认形态);翻页仍走单项目那条,不做复杂化。
   */
  getFirstSessionsForProjectPaths(projectPaths: string[], limit: number): Map<string, SessionRow[]> {
    const out = new Map<string, SessionRow[]>();
    if (projectPaths.length === 0 || limit <= 0) return out;
    const db = getConnection();
    const normalized = projectPaths.map((p) => normalizeProjectPath(p));
    const placeholders = normalized.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT ${SESSION_ROW_COLUMNS} FROM (
           SELECT ${SESSION_ROW_COLUMNS},
                  ROW_NUMBER() OVER (
                    PARTITION BY project_path
                    ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
                  ) AS rn
           FROM sessions
           WHERE project_path IN (${placeholders})
             AND isArchived = 0
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

  /** 批量计数(E7):一次 GROUP BY 顶掉 N 次 COUNT。 */
  countSessionsByProjectPaths(projectPaths: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (projectPaths.length === 0) return out;
    const db = getConnection();
    const normalized = projectPaths.map((p) => normalizeProjectPath(p));
    const placeholders = normalized.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT project_path, COUNT(*) AS count
         FROM sessions
         WHERE project_path IN (${placeholders})
           AND isArchived = 0
         GROUP BY project_path`
      )
      .all(...normalized) as Array<{ project_path: string; count: number }>;
    for (const row of rows) out.set(row.project_path, Number(row.count) || 0);
    return out;
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
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
    db.prepare(`
            DELETE FROM session_display_messages
            WHERE session_id IN (SELECT session_id FROM sessions WHERE project_path = ?)
        `).run(normalizedProjectPath);
        db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
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
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    // 显示日志没有对 sessions 建外键(新会话的第一条消息可能早于 sessions 行落库),
    // 所以删会话时要显式清一遍,免得留下永远读不到的孤儿行。
    db.prepare('DELETE FROM session_display_messages WHERE session_id = ?').run(sessionId);
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },
};
