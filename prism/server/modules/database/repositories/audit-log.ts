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
  | 'skill_removed'
  /*
   * gk:会话与项目的删除 / 归档 / 恢复。
   *
   * 2026-09-14 生产上一条跑了一天的会话被人永久删除,事后**查不出是谁、从哪个入口**:
   * 25 个审计事件里没有一个是会话级的,单个删项目也没记。这里把"东西没了"这一类
   * 全部补齐,detail 是一段 JSON(见 sessions.service 的 auditDetail),前端渲染成人话。
   */
  | 'session_deleted'
  | 'session_archived'
  | 'sessions_bulk_deleted'
  | 'sessions_bulk_archived'
  | 'archived_sessions_emptied'
  | 'project_deleted'
  | 'project_archived'
  | 'session_trash_restored'
  | 'session_trash_purged';

/**
 * gk:这几类事件不参与"只留最新 5000 行"的常规裁剪 —— `ws_ticket_issued` 每次
 * 连 WebSocket 都记一条,几天就能把 5000 行冲满,而"上个月谁删了我的会话"正是
 * 审计日志最该答得上的问题。它们另有一个宽得多的上限(见 trim)。
 */
export const DURABLE_AUDIT_EVENTS: readonly AuditEvent[] = [
  'session_deleted',
  'sessions_bulk_deleted',
  'archived_sessions_emptied',
  'project_deleted',
  'projects_bulk_deleted',
  'session_trash_restored',
  'session_trash_purged',
];

export type AuditOutcome = 'success' | 'failure';

export type AuditEntry = {
  userId?: number | null;
  username?: string | null;
  event: AuditEvent;
  outcome?: AuditOutcome;
  ip?: string | null;
  userAgent?: string | null;
  detail?: string | null;
  /** gk:这条记录**对谁做的**(被删会话所属项目的 owner)。见 buildAuditWhere。 */
  targetUserId?: number | null;
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
  target_user_id: number | null;
  created_at: string;
};

/**
 * Keep the table from growing without bound on a long-lived install.
 *
 * 两个上限都在 `trim()` 里**每次读** —— 不是模块加载时读一次。裁剪每 100 次写
 * 才跑一次,读两个环境变量的代价可以忽略;而写死在模块顶层的值没法在测试里换,
 * 于是"第二档到底裁不裁"这件事就只能不测(审计里正是这么漏掉的)。
 */
const maxRows = (): number => Number.parseInt(process.env.PRISM_AUDIT_LOG_MAX_ROWS ?? '', 10) || 5000;
// gk:删除类事件的独立上限 —— 一条删除记录只有几百字节,两万条也不到 10 MB。
const maxDurableRows = (): number => Number.parseInt(process.env.PRISM_AUDIT_LOG_MAX_DURABLE_ROWS ?? '', 10) || 20000;

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
  //
  // gk:范围从"我做的"扩成"我做的 OR **对我做的**"(target_user_id = 我)。
  // 被删会话所属项目的 owner 要能看到"谁删了我的会话" —— 否则删除记了也等于白记:
  // 只有删的人自己看得到。对我做的那些行,ip / user_agent 在 list 里脱敏(那是别人的)。
  if (userId !== null) {
    clauses.push('(user_id = ? OR target_user_id = ?)');
    params.push(userId, userId);
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
        `INSERT INTO audit_log (user_id, username, event, outcome, ip, user_agent, detail, target_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.userId ?? null,
        entry.username ?? null,
        entry.event,
        entry.outcome ?? 'success',
        entry.ip ?? null,
        // User agents are attacker-controlled and unbounded; cap them.
        entry.userAgent ? entry.userAgent.slice(0, 300) : null,
        entry.detail ? entry.detail.slice(0, 1000) : null,
        typeof entry.targetUserId === 'number' && Number.isFinite(entry.targetUserId) ? entry.targetUserId : null,
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
    const columns = 'id, user_id, username, event, outcome, ip, user_agent, detail, target_user_id, created_at';
    const { sql: whereSql, params } = buildAuditWhere(userId, filters);

    const rows = db
      .prepare(`SELECT ${columns} FROM audit_log${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, safeLimit, safeOffset) as AuditRow[];

    // gk:非 root 拿到的"对我做的"行,ip / user_agent 是**别人的**,抹掉。
    // 操作者用户名保留 —— "谁删的"正是这条记录存在的意义。
    if (userId === null) return rows;
    return rows.map((row) => (
      row.user_id !== null && String(row.user_id) === String(userId)
        ? row
        : { ...row, ip: null, user_agent: null }
    ));
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

  /**
   * Drops the oldest rows beyond MAX_ROWS.
   *
   * gk:分两档。常规事件仍是"只留最新 MAX_ROWS 行";删除类事件(DURABLE_AUDIT_EVENTS)
   * 不进这一刀,另按 MAX_DURABLE_ROWS 裁 —— 否则一周的 ws_ticket_issued 就能把
   * 上个月那条删除记录挤出去。
   */
  trim(): void {
    try {
      const db = getConnection();
      const durablePlaceholders = DURABLE_AUDIT_EVENTS.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM audit_log WHERE event NOT IN (${durablePlaceholders}) AND id NOT IN (
           SELECT id FROM audit_log WHERE event NOT IN (${durablePlaceholders}) ORDER BY id DESC LIMIT ?
         )`
      ).run(...DURABLE_AUDIT_EVENTS, ...DURABLE_AUDIT_EVENTS, maxRows());
      db.prepare(
        `DELETE FROM audit_log WHERE event IN (${durablePlaceholders}) AND id NOT IN (
           SELECT id FROM audit_log WHERE event IN (${durablePlaceholders}) ORDER BY id DESC LIMIT ?
         )`
      ).run(...DURABLE_AUDIT_EVENTS, ...DURABLE_AUDIT_EVENTS, maxDurableRows());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to trim audit log', { error: message });
    }
  },
};
