/**
 * gk:最近删除(会话回收站)的仓库层。
 *
 * 永久删除 = 把 `sessions` 行、显示日志、`session_display_log_state` **整体搬进**
 * `session_trash` / `session_trash_messages`;恢复 = 原样搬回;超期清扫 = 真删。
 * 这一层只管库,transcript 文件的搬运在 providers 的 session-trash.service 里。
 *
 * 搬进 / 搬回都是**一个事务**:活表与回收站表之间不存在"两边都有"或"两边都没有"
 * 的中间态 —— 那正是会话"凭空消失"这件事故里最难解释的部分。
 */

import { getConnection } from '@/modules/database/connection.js';
import { cachedPrepare } from '@/modules/database/prepared-cache.js';
import { buildProjectVisibilityClause, type VisibilityScope } from '@/modules/database/visibility-sql.js';
import { createLogger } from '@/shared/logger.js';

const log = createLogger('db');

export type TrashDeletedVia = 'session' | 'bulk' | 'empty_archived' | 'project' | 'retention' | 'api';

export type SessionTrashRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  custom_name: string | null;
  project_path: string | null;
  project_id: string | null;
  project_display_name: string | null;
  project_owner_user_id: number | null;
  project_visibility: string | null;
  jsonl_path: string | null;
  trash_jsonl_path: string | null;
  trash_dir_path: string | null;
  isArchived: number;
  display_log_trimmed: number;
  message_count: number;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string;
  deleted_by_user_id: number | null;
  deleted_by_username: string | null;
  deleted_via: string;
};

const TRASH_COLUMNS =
  'session_id, provider, provider_session_id, custom_name, project_path, project_id, project_display_name, '
  + 'project_owner_user_id, project_visibility, jsonl_path, trash_jsonl_path, trash_dir_path, isArchived, '
  + 'display_log_trimmed, message_count, created_at, updated_at, deleted_at, deleted_by_user_id, deleted_by_username, deleted_via';

export type MoveToTrashInput = {
  sessionId: string;
  deletedByUserId: number | null;
  deletedByUsername: string | null;
  deletedVia: TrashDeletedVia;
  /** 删除那一刻项目行的快照(项目行可能随后被删掉)。 */
  project: {
    projectId: string | null;
    displayName: string | null;
    ownerUserId: number | null;
    visibility: string | null;
  };
};

export type MoveToTrashResult = {
  moved: boolean;
  row: SessionTrashRow | null;
};

function normalizeSqliteTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function normalizeTrashRow<T extends SessionTrashRow | null | undefined>(row: T): T {
  if (!row) return row;
  return {
    ...row,
    created_at: normalizeSqliteTimestamp(row.created_at),
    updated_at: normalizeSqliteTimestamp(row.updated_at),
    deleted_at: normalizeSqliteTimestamp(row.deleted_at) ?? row.deleted_at,
  };
}

/**
 * 非 root 的可见范围:与活表同一条规则,但项目行可能已经不在了 ——
 * 那时回落到删除那一刻记下的 owner / visibility 快照。删的人自己也看得到自己删的。
 */
function buildTrashWhere(scope: VisibilityScope): { sql: string; params: unknown[] } {
  if (scope.kind === 'all') return { sql: '1 = 1', params: [] };
  const visibility = buildProjectVisibilityClause({
    userId: scope.userId,
    projectIdColumn: 'COALESCE(p.project_id, t.project_id)',
    ownerColumn: 'COALESCE(p.owner_user_id, t.project_owner_user_id)',
    visibilityColumn: 'COALESCE(p.visibility, t.project_visibility)',
    pathColumn: 't.project_path',
  });
  return {
    sql: `(t.deleted_by_user_id = ? OR (TRIM(COALESCE(t.project_path, '')) <> '' AND ${visibility.sql}))`,
    params: [scope.userId, ...visibility.params],
  };
}

export const sessionTrashDb = {
  /**
   * 把一条会话从活表搬进回收站。**一个事务**;活表里没有这一行时什么都不动。
   *
   * 返回搬完之后的回收站行(transcript 的回收站路径此时还是 NULL,文件搬完由
   * `recordFilePaths` 补上)。
   */
  moveToTrash(input: MoveToTrashInput): MoveToTrashResult {
    const db = getConnection();
    const move = db.transaction((): MoveToTrashResult => {
      const live = cachedPrepare(db,
        `SELECT session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at
         FROM sessions WHERE session_id = ?`,
      ).get(input.sessionId) as {
        session_id: string; provider: string; provider_session_id: string | null; custom_name: string | null;
        project_path: string | null; jsonl_path: string | null; isArchived: number; created_at: string | null; updated_at: string | null;
      } | undefined;
      if (!live) return { moved: false, row: null };

      const trimmedRow = cachedPrepare(db, 'SELECT trimmed FROM session_display_log_state WHERE session_id = ?')
        .get(input.sessionId) as { trimmed: number } | undefined;

      // 回收站里若还躺着同 id 的旧记录(理论上不该有:恢复/清扫都会删掉它),先让位。
      cachedPrepare(db, 'DELETE FROM session_trash_messages WHERE session_id = ?').run(input.sessionId);
      cachedPrepare(db, 'DELETE FROM session_trash WHERE session_id = ?').run(input.sessionId);

      const moved = cachedPrepare(db,
        `INSERT INTO session_trash_messages (id, session_id, message_id, kind, timestamp, payload, provider_assistant_uuid)
         SELECT id, session_id, message_id, kind, timestamp, payload, provider_assistant_uuid
         FROM session_display_messages WHERE session_id = ?`,
      ).run(input.sessionId).changes;

      cachedPrepare(db,
        `INSERT INTO session_trash (
           session_id, provider, provider_session_id, custom_name, project_path, project_id, project_display_name,
           project_owner_user_id, project_visibility, jsonl_path, trash_jsonl_path, trash_dir_path, isArchived,
           display_log_trimmed, message_count, created_at, updated_at, deleted_at, deleted_by_user_id, deleted_by_username, deleted_via
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
      ).run(
        live.session_id, live.provider, live.provider_session_id, live.custom_name, live.project_path,
        input.project.projectId, input.project.displayName, input.project.ownerUserId, input.project.visibility,
        live.jsonl_path, live.isArchived ? 1 : 0, trimmedRow?.trimmed ? 1 : 0, moved,
        live.created_at, live.updated_at, input.deletedByUserId, input.deletedByUsername, input.deletedVia,
      );

      cachedPrepare(db, 'DELETE FROM session_display_messages WHERE session_id = ?').run(input.sessionId);
      cachedPrepare(db, 'DELETE FROM session_display_log_state WHERE session_id = ?').run(input.sessionId);
      cachedPrepare(db, 'DELETE FROM sessions WHERE session_id = ?').run(input.sessionId);

      return { moved: true, row: sessionTrashDb.get(input.sessionId) };
    });
    return move();
  },

  /** transcript 搬完之后把回收站里的路径记上(搬失败就记 NULL,恢复时按原路径兜底找)。 */
  recordFilePaths(sessionId: string, paths: { trashJsonlPath: string | null; trashDirPath: string | null }): void {
    const db = getConnection();
    cachedPrepare(db,
      'UPDATE session_trash SET trash_jsonl_path = ?, trash_dir_path = ? WHERE session_id = ?',
    ).run(paths.trashJsonlPath, paths.trashDirPath, sessionId);
  },

  get(sessionId: string): SessionTrashRow | null {
    const db = getConnection();
    const row = cachedPrepare(db, `SELECT ${TRASH_COLUMNS} FROM session_trash WHERE session_id = ?`)
      .get(sessionId) as SessionTrashRow | undefined;
    return normalizeTrashRow(row) ?? null;
  },

  /** 监视器用:这个 provider id 的会话是不是正躺在回收站里(是就别再把它的 transcript 索引成新会话)。 */
  hasProviderSessionId(providerSessionId: string): boolean {
    if (!providerSessionId) return false;
    const db = getConnection();
    const row = cachedPrepare(db,
      'SELECT 1 AS hit FROM session_trash WHERE provider_session_id = ? OR session_id = ? LIMIT 1',
    ).get(providerSessionId, providerSessionId) as { hit: number } | undefined;
    return Boolean(row?.hit);
  },

  /** 分页列表,最近删除的在前。可见范围见 buildTrashWhere。 */
  listPage(scope: VisibilityScope, limit: number, offset: number): { rows: SessionTrashRow[]; total: number } {
    const db = getConnection();
    const where = buildTrashWhere(scope);
    const from = `FROM session_trash t LEFT JOIN projects p ON p.project_path = t.project_path WHERE ${where.sql}`;
    const prefixed = TRASH_COLUMNS.split(', ').map((column) => `t.${column}`).join(', ');
    // `deleted_at` 一律是 CURRENT_TIMESTAMP 写进去的 `YYYY-MM-DD HH:MM:SS`,
    // 字典序就是时间序 —— 不要包 `datetime()`,那会让 idx_session_trash_deleted_at 用不上。
    const rows = cachedPrepare(db,
      `SELECT ${prefixed} ${from} ORDER BY t.deleted_at DESC, t.session_id DESC LIMIT ? OFFSET ?`,
    ).all(...where.params, limit, offset) as SessionTrashRow[];
    const totalRow = cachedPrepare(db, `SELECT COUNT(*) AS count ${from}`).get(...where.params) as { count: number } | undefined;
    return { rows: rows.map((row) => normalizeTrashRow(row)), total: Number(totalRow?.count ?? 0) };
  },

  /** 这个访问者看不看得到这一条(与 listPage 同一条规则,单条判定)。 */
  isVisibleTo(sessionId: string, scope: VisibilityScope): boolean {
    const db = getConnection();
    const where = buildTrashWhere(scope);
    const row = cachedPrepare(db,
      `SELECT 1 AS hit FROM session_trash t LEFT JOIN projects p ON p.project_path = t.project_path
       WHERE t.session_id = ? AND ${where.sql} LIMIT 1`,
    ).get(sessionId, ...where.params) as { hit: number } | undefined;
    return Boolean(row?.hit);
  },

  /**
   * 从回收站搬回活表。**一个事务**。
   *
   * 活表里已经有同 id 的行(或同 provider id 的行)时拒绝 —— 那是另一段对话,
   * 不能把两份显示日志缝在一起。显示日志按**原 id** 写回。
   */
  restore(sessionId: string): { restored: boolean; reason?: 'not_in_trash' | 'conflict'; row: SessionTrashRow | null } {
    const db = getConnection();
    const restore = db.transaction(() => {
      const row = sessionTrashDb.get(sessionId);
      if (!row) return { restored: false, reason: 'not_in_trash' as const, row: null };

      const conflict = cachedPrepare(db,
        `SELECT session_id FROM sessions WHERE session_id = ? OR (provider_session_id IS NOT NULL AND provider_session_id = ?) LIMIT 1`,
      ).get(sessionId, row.provider_session_id ?? '') as { session_id: string } | undefined;
      if (conflict) return { restored: false, reason: 'conflict' as const, row };

      cachedPrepare(db,
        `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))`,
      ).run(
        row.session_id, row.provider, row.provider_session_id, row.custom_name, row.project_path, row.jsonl_path,
        row.isArchived ? 1 : 0, row.created_at, row.updated_at,
      );

      // 原 id 写回:AUTOINCREMENT 不会把删掉的 id 再分给别人,所以不会撞。
      cachedPrepare(db,
        `INSERT INTO session_display_messages (id, session_id, message_id, kind, timestamp, payload, provider_assistant_uuid)
         SELECT id, session_id, message_id, kind, timestamp, payload, provider_assistant_uuid
         FROM session_trash_messages WHERE session_id = ? ORDER BY id ASC`,
      ).run(sessionId);
      if (row.display_log_trimmed) {
        cachedPrepare(db,
          `INSERT INTO session_display_log_state (session_id, trimmed) VALUES (?, 1)
           ON CONFLICT(session_id) DO UPDATE SET trimmed = 1`,
        ).run(sessionId);
      }

      cachedPrepare(db, 'DELETE FROM session_trash_messages WHERE session_id = ?').run(sessionId);
      cachedPrepare(db, 'DELETE FROM session_trash WHERE session_id = ?').run(sessionId);
      return { restored: true, row };
    });
    try {
      return restore();
    } catch (error) {
      log.error('[trash] restore failed', { sessionId, error: (error as Error)?.message });
      throw error;
    }
  },

  /** 真删(清扫 / root 立即清除)。返回被删的行,给调用方去删文件。 */
  purge(sessionId: string): SessionTrashRow | null {
    const db = getConnection();
    const purge = db.transaction(() => {
      const row = sessionTrashDb.get(sessionId);
      if (!row) return null;
      cachedPrepare(db, 'DELETE FROM session_trash_messages WHERE session_id = ?').run(sessionId);
      cachedPrepare(db, 'DELETE FROM session_trash WHERE session_id = ?').run(sessionId);
      return row;
    });
    return purge();
  },

  /**
   * 超过保留期的(按删除时间),给清扫器;纯查询。
   *
   * 只把**参数**归一成 SQLite 的 `YYYY-MM-DD HH:MM:SS`(`datetime(?)`),列保持裸的 ——
   * 列上包函数索引就废了,清扫器每 6 小时全表扫一遍 + 临时排序。
   */
  listExpired(cutoffIso: string, limit: number): SessionTrashRow[] {
    const db = getConnection();
    const rows = cachedPrepare(db,
      `SELECT ${TRASH_COLUMNS} FROM session_trash
       WHERE deleted_at < datetime(?)
       ORDER BY deleted_at ASC LIMIT ?`,
    ).all(cutoffIso, limit) as SessionTrashRow[];
    return rows.map((row) => normalizeTrashRow(row));
  },

  count(): number {
    const db = getConnection();
    const row = cachedPrepare(db, 'SELECT COUNT(*) AS count FROM session_trash').get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  },
};
