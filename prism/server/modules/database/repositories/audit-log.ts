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
  | 'user_approved'
  | 'user_rejected'
  | 'project_owner_changed';

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
      console.error('Failed to write audit log entry', { error: message });
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
  list(limit = 100, offset = 0, userId: number | null = null): AuditRow[] {
    const db = getConnection();
    const safeLimit = Math.min(Math.max(1, limit), 500);
    const safeOffset = Math.max(0, offset);
    const columns = 'id, user_id, username, event, outcome, ip, user_agent, detail, created_at';

    if (userId === null) {
      return db
        .prepare(`SELECT ${columns} FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(safeLimit, safeOffset) as AuditRow[];
    }

    return db
      .prepare(`SELECT ${columns} FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(userId, safeLimit, safeOffset) as AuditRow[];
  },

  /** Total row count, for pagination. Same scoping contract as `list`. */
  count(userId: number | null = null): number {
    const db = getConnection();
    const row = userId === null
      ? db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as { count: number }
      : db.prepare('SELECT COUNT(*) as count FROM audit_log WHERE user_id = ?').get(userId) as { count: number };
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
      console.error('Failed to trim audit log', { error: message });
    }
  },
};
