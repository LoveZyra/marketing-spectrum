/**
 * Security audit log repository.
 *
 * Records authentication and credential-management events so an operator can
 * answer "did anyone else get in?" after the fact. Prism listens on 0.0.0.0
 * by default, so the answer is not always obvious from the outside.
 *
 * Writes are best-effort: an audit failure must never block the operation it
 * was describing, or a full disk would lock the owner out of their own tool.
 */

import { getConnection } from '@/modules/database/connection.js';
import { createLogger } from '@/shared/logger.js';
const log = createLogger('db');

export type AuditEvent =
  | 'login'
  | 'login_failed'
  | 'login_locked'
  | 'logout'
  | 'register'
  | 'token_revoked'
  | 'api_key_created'
  | 'api_key_deleted'
  | 'api_key_toggled'
  | 'credential_created'
  | 'credential_deleted'
  | 'ws_ticket_issued'
  | 'register_pending'
  | 'login_unapproved'
  | 'password_reset_by_admin'
  | 'user_deactivated'
  | 'user_activated'
  | 'user_approved'
  | 'user_rejected'
  | 'project_owner_changed'
  | 'attachment_quota_changed'
  // eo:项目的批量删除/归档。不可逆,事后"谁把那批项目删了"要查得到
  | 'projects_bulk_deleted'
  | 'projects_bulk_archived'
  /*
   * fd:技能的装/卸。
   *
   * 技能目录是**服务进程自己的 home**,一台机器上所有用户共用同一份 —— 不像项目
   * 那样属于谁。所以 B 卸掉 A 装的技能,A 的所有会话行为会静默改变:某个
   * `/xxx` 命令突然不存在了,或者同名技能换成了另一份内容。
   *
   * 这件事本身是产品设计(共享技能库),不改。但它此前**不留任何痕迹**——
   * 25 个审计事件里一个 skill 都没有,事后没法回答"这技能谁卸的"。补上两条,
   * 至少让它可追溯。
   */
  | 'skill_installed'
  | 'skill_removed';

export type AuditOutcome = 'success' | 'failure';

export type AuditEntry = {
  userId?: number | null;
  username?: string | null;
  event: AuditEvent;
  outcome?: AuditOutcome;
  ip?: string | null;
  userAgent?: string | null;
  detail?: string | null;
};

export type AuditRow = {
  id: number;
  user_id: number | null;
  username: string | null;
  event: string;
  outcome: string;
  ip: string | null;
  user_agent: string | null;
  detail: string | null;
  created_at: string;
};

// Keep the table from growing without bound on a long-lived install.
const MAX_ROWS = Number.parseInt(process.env.PRISM_AUDIT_LOG_MAX_ROWS ?? '', 10) || 5000;

let writesSinceTrim = 0;
const TRIM_EVERY = 100;

/**
 * 审计日志的筛选条件(ff 轮)。
 *
 * 事件类型现在有 27 种,而列表是纯倒序分页 —— 想回答"上周三谁把那个项目删了",
 * 只能一页一页翻。审计报告里把这条记成"现在能回答'有没有别人登进来过',
 * 答不了'上周三谁把那个模型文件覆盖了'"。
 */
export type AuditFilters = {
  /** 只看这几类事件。空数组和不传都表示"不筛"。 */
  events?: readonly string[];
  outcome?: AuditOutcome;
  /** 用户名模糊匹配(大小写不敏感)。**不改变可见范围**,见下面的注释。 */
  usernameLike?: string;
};

/**
 * 拼 WHERE。
 *
 * ## 这里唯一要紧的一件事:`userId` 的作用域是**闸门**,不是筛选条件
 *
 * 非 root 调用者只能看见自己那些行 —— 这不是"默认筛选",是权限边界:
 * 这些行带着用户名、登录时间和客户端 IP,不设防的话任何账号都能把同事的
 * 作息拉一遍。
 *
 * 所以 `user_id = ?` 这一条是**先拼上去、且任何 filters 都去不掉的**。
 * `usernameLike` 是在这个范围**之内**再缩小,不是另一条并列的路 ——
 * 传 `usernameLike=别人` 得到的是空结果,不是别人的行。
 * (`audit-filter.test.ts` 里专门有一条钉这个。)
 */
const buildAuditWhere = (
  userId: number | null,
  filters: AuditFilters,
): { sql: string; params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];

  // 闸门先拼。位置在前不影响 SQL 语义,但读代码的人一眼能看出它不受下面影响。
  if (userId !== null) {
    clauses.push('user_id = ?');
    params.push(userId);
  }

  const events = (filters.events ?? []).filter((event) => typeof event === 'string' && event.length > 0);
  if (events.length > 0) {
    clauses.push(`event IN (${events.map(() => '?').join(',')})`);
    params.push(...events);
  }

  if (filters.outcome === 'success' || filters.outcome === 'failure') {
    clauses.push('outcome = ?');
    params.push(filters.outcome);
  }

  const usernameLike = filters.usernameLike?.trim();
  if (usernameLike) {
    // LIKE 的通配符要转义 —— 用户输入里的 % 和 _ 不该当成通配符。
    // 这个仓库在 P0-6 上栽过一次(附件台账的 LIKE 把兄弟目录一起删了),
    // 那次的教训就是"别假设用户数据里不会出现元字符"。
    const escaped = usernameLike.replace(/[\\%_]/g, (char) => `\\${char}`);
    clauses.push("username LIKE ? ESCAPE '\\'");
    params.push(`%${escaped}%`);
  }

  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
};

export const auditLogDb = {
  /** Appends an entry. Never throws. */
  record(entry: AuditEntry): void {
    try {
      const db = getConnection();
      db.prepare(
        `INSERT INTO audit_log (user_id, username, event, outcome, ip, user_agent, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.userId ?? null,
        entry.username ?? null,
        entry.event,
        entry.outcome ?? 'success',
        entry.ip ?? null,
        // User agents are attacker-controlled and unbounded; cap them.
        entry.userAgent ? entry.userAgent.slice(0, 300) : null,
        entry.detail ? entry.detail.slice(0, 1000) : null
      );

      if (++writesSinceTrim >= TRIM_EVERY) {
        writesSinceTrim = 0;
        auditLogDb.trim();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to write audit log entry', { error: message });
    }
  },

  /**
   * Most recent entries first. `limit` is clamped to 500.
   *
   * `userId` scopes the result to one account. The route passes it for
   * everyone except root: these rows carry usernames, login times and client
   * IPs, so an unscoped read lets any account enumerate who else exists on the
   * server and when they work. Root still sees everything — that is the point
   * of an audit log.
   */
  list(
    limit = 100,
    offset = 0,
    userId: number | null = null,
    filters: AuditFilters = {},
  ): AuditRow[] {
    const db = getConnection();
    const safeLimit = Math.min(Math.max(1, limit), 500);
    const safeOffset = Math.max(0, offset);
    const columns = 'id, user_id, username, event, outcome, ip, user_agent, detail, created_at';
    const { sql: whereSql, params } = buildAuditWhere(userId, filters);

    return db
      .prepare(`SELECT ${columns} FROM audit_log${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, safeLimit, safeOffset) as AuditRow[];
  },

  /** Total row count, for pagination. Same scoping contract as `list`. */
  count(userId: number | null = null, filters: AuditFilters = {}): number {
    const db = getConnection();
    const { sql: whereSql, params } = buildAuditWhere(userId, filters);
    const row = db
      .prepare(`SELECT COUNT(*) as count FROM audit_log${whereSql}`)
      .get(...params) as { count: number };
    return row.count;
  },

  /** Drops the oldest rows beyond MAX_ROWS. */
  trim(): void {
    try {
      const db = getConnection();
      db.prepare(
        `DELETE FROM audit_log WHERE id NOT IN (
           SELECT id FROM audit_log ORDER BY id DESC LIMIT ?
         )`
      ).run(MAX_ROWS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to trim audit log', { error: message });
    }
  },
};
