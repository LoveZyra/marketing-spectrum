/**
 * Security audit log repository.
 *
 * Records authentication, credential, account-administration and destructive
 * events (deletions, archives, skill / model / gateway changes) so an operator
 * can answer "did anyone else get in?" or "who deleted this?" after the fact.
 * Prism listens on 0.0.0.0 by default, so the answer is not always obvious
 * from the outside.
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
  // 项目的批量删除/归档。不可逆,事后"谁把那批项目删了"要查得到
  | 'projects_bulk_deleted'
  | 'projects_bulk_archived'
  /*
   * 技能的装/卸。
   *
   * 技能目录是服务进程自己的 home,一台机器上所有用户共用同一份 —— 不像项目
   * 那样属于谁。所以 B 卸掉 A 装的技能,A 的所有会话行为会静默改变:某个
   * `/xxx` 命令突然不存在了,或者同名技能换成了另一份内容。
   * 共享技能库是产品设计,但"这技能谁卸的"必须可追溯。
   */
  | 'skill_installed'
  | 'skill_removed'
  /*
   * 会话与项目的删除 / 归档 / 恢复 —— "东西没了"这一类,事后必须查得出是谁、从哪个入口。
   * detail 是一段 JSON(见 sessions.service 的 recordSessionAudit),前端渲染成人话。
   */
  | 'session_deleted'
  | 'session_archived'
  | 'sessions_bulk_deleted'
  | 'sessions_bulk_archived'
  | 'archived_sessions_emptied'
  | 'project_deleted'
  | 'project_archived'
  | 'session_trash_restored'
  | 'session_trash_purged'
  /*
   * 技能优化(SkillWhet)。message_feedback 是用户反馈本身,低频,不进耐久档;
   * 其余动作的权限见 skillwhet.routes.ts,只有 root 专属的进耐久档。
   */
  | 'message_feedback'
  | 'skillwhet_import'
  | 'skillwhet_upload'
  | 'skillwhet_remove'
  | 'skillwhet_bootstrap'
  | 'skillwhet_tasks_add'
  | 'skillwhet_tasks_derive'
  | 'skillwhet_job_start'
  | 'skillwhet_job_cancel'
  | 'skillwhet_adopt'
  | 'skillwhet_publish'
  | 'skillwhet_rollback'
  | 'skillwhet_feedback_accept'
  // 从会话挖任务 / 挖出的任务入库 / 一次性留出集评估
  | 'skillwhet_harvest'
  | 'skillwhet_harvest_import'
  | 'skillwhet_release_eval'
  | 'skillwhet_feedback_overlay'
  // 夜训 —— 纳入 / 移出 / 连续无收益自动暂停(调度器以系统身份记,user 为空)
  | 'skillwhet_nightly_enroll'
  | 'skillwhet_nightly_unenroll'
  | 'skillwhet_nightly_autopause'
  // 模型目录(root)与别名映射(PUT model-config)
  | 'model_catalog_created'
  | 'model_catalog_updated'
  | 'model_catalog_deleted'
  | 'model_config_updated'
  // 子代理模型(root)
  | 'subagent_model_updated'
  // 共享网关(root)—— 增删改、默认 key、替人填 / 清 key、私有网关总开关
  | 'model_gateway_created'
  | 'model_gateway_updated'
  | 'model_gateway_deleted'
  | 'gateway_default_key_set'
  | 'gateway_default_key_cleared'
  | 'gateway_key_set_by_root'
  | 'gateway_key_cleared_by_root'
  | 'private_gateways_toggled'
  // 本人 —— 个人 key、私有网关、私有模型(值从不进审计)
  | 'gateway_key_set'
  | 'gateway_key_cleared'
  | 'private_gateway_created'
  | 'private_gateway_updated'
  | 'private_gateway_deleted'
  | 'private_gateway_key_set'
  | 'user_model_created'
  | 'user_model_updated'
  | 'user_model_deleted';

/**
 * 耐久档:不参与"只留最新 5000 行"的常规裁剪,另按一个宽得多的上限裁(见 trim)。
 *
 * 常规档很容易被冲满:`ws_ticket_issued` 每次连 WebSocket 都记一条,任何登录用户每换一张
 * 票写一行(限流允许 600 次/分),几分钟就能把「上个月谁删了我的会话 / 谁驳回了谁 /
 * 谁重置了谁的密码 / 谁发布了技能」挤出去 —— 而这些正是审计日志最该答得上的问题。
 *
 * 只收普通用户无法廉价刷量的事件:删除 / 恢复类与 root 专属的管理类。普通用户能高频触发的
 * (开关 API key、归档、装技能、上传副本……)留在常规档,否则耐久档也会被刷满。
 */
export const DURABLE_AUDIT_EVENTS: readonly AuditEvent[] = [
  'session_deleted',
  'sessions_bulk_deleted',
  'archived_sessions_emptied',
  'project_deleted',
  'projects_bulk_deleted',
  'session_trash_restored',
  'session_trash_purged',
  // root 专属的管理类
  'password_reset_by_admin',
  'user_deactivated',
  'user_activated',
  'user_approved',
  'user_rejected',
  'project_owner_changed',
  'attachment_quota_changed',
  'skillwhet_import',
  'skillwhet_adopt',
  'skillwhet_publish',
  'skillwhet_rollback',
  'skillwhet_nightly_enroll',
  'skillwhet_nightly_unenroll',
  'skillwhet_nightly_autopause',
  // 模型目录与别名映射都只有 root 能改
  'model_catalog_created',
  'model_catalog_updated',
  'model_catalog_deleted',
  'model_config_updated',
  // 子代理模型同样只有 root 能改
  'subagent_model_updated',
  // 共享网关与 key 的 root 动作(本人的 key / 私有网关普通用户刷得动,留在常规一档)
  'model_gateway_created',
  'model_gateway_updated',
  'model_gateway_deleted',
  'gateway_default_key_set',
  'gateway_default_key_cleared',
  'gateway_key_set_by_root',
  'gateway_key_cleared_by_root',
  'private_gateways_toggled',
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
  /** 这条记录对谁做的(如被删会话所属项目的 owner、被管理操作的账号)。见 buildAuditWhere。 */
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
 * 两个上限都在 `trim()` 里每次读,而不是模块加载时读一次:裁剪每 100 次写
 * 才跑一次,读两个环境变量的代价可以忽略;写死在模块顶层的值没法在测试里换,
 * 耐久档裁不裁就测不到。
 */
const maxRows = (): number => Number.parseInt(process.env.PRISM_AUDIT_LOG_MAX_ROWS ?? '', 10) || 5000;
// 耐久档(DURABLE_AUDIT_EVENTS)的独立上限 —— 一条记录只有几百字节,两万条也不到 10 MB。
const maxDurableRows = (): number => Number.parseInt(process.env.PRISM_AUDIT_LOG_MAX_DURABLE_ROWS ?? '', 10) || 20000;

let writesSinceTrim = 0;
const TRIM_EVERY = 100;

/**
 * 审计日志的筛选条件。
 *
 * 事件类型很多,而列表是纯倒序分页 —— 不能筛的话,想回答"上周三谁把那个项目删了"
 * 只能一页一页翻。
 */
export type AuditFilters = {
  /** 只看这几类事件。空数组和不传都表示"不筛"。 */
  events?: readonly string[];
  outcome?: AuditOutcome;
  /** 用户名模糊匹配(大小写不敏感)。不改变可见范围,见下面的注释。 */
  usernameLike?: string;
};

/**
 * 拼 WHERE。
 *
 * 唯一要紧的一件事:`userId` 的作用域是闸门,不是筛选条件。
 *
 * 非 root 调用者只能看见自己做的、或对自己做的那些行 —— 这不是"默认筛选",是权限边界:
 * 这些行带着用户名、登录时间和客户端 IP,不设防的话任何账号都能把同事的
 * 作息拉一遍。
 *
 * 所以作用域子句先拼上去,且任何 filters 都去不掉。`usernameLike` 是在这个范围之内
 * 再缩小,不是另一条并列的路 —— 传 `usernameLike=别人` 得到的是空结果,不是别人的行
 * (`audit-filter.test.ts` 里专门有一条钉这个)。
 */
const buildAuditWhere = (
  userId: number | null,
  filters: AuditFilters,
): { sql: string; params: unknown[] } => {
  const clauses: string[] = [];
  const params: unknown[] = [];

  // 闸门先拼。位置在前不影响 SQL 语义,但读代码的人一眼能看出它不受下面影响。
  //
  // 范围是"我做的 OR 对我做的"(target_user_id = 我):被删会话所属项目的 owner 要能看到
  // "谁删了我的会话",否则删除记了也只有删的人自己看得到。对我做的那些行,
  // ip / user_agent 在 list 里脱敏(那是别人的)。
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
    // LIKE 的通配符要转义 —— 用户输入里的 % 和 _ 不该当成通配符
    // (别假设用户数据里不会出现元字符)。
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
        // 登录失败会把客户端提交的原始用户名写进来,不截断的话一个 5MB 的
        // 用户名就是一行 5MB,拖垮审计页。正常用户名 ≤ 64(注册时校验)。
        entry.username ? String(entry.username).slice(0, 128) : null,
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

    // 非 root 拿到的"对我做的"行,ip / user_agent 是别人的,抹掉。
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
   * Drops the oldest rows, in two tiers.
   *
   * 常规事件只留最新 maxRows() 行;耐久档(DURABLE_AUDIT_EVENTS)不进这一刀,另按
   * maxDurableRows() 裁 —— 否则一周的 ws_ticket_issued 就能把上个月那条删除记录挤出去。
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
