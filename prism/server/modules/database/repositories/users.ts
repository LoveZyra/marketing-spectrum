/**
 * User repository.
 *
 * Prism used to be single-user; it now holds one account per colleague, each
 * gated by an approval status a root account sets. Root itself is never stored
 * here — it is computed from `PRISM_ROOT_USERS` (see server/shared/root-users.js)
 * so there is one source of truth and no drift between env and database.
 */

import { getConnection } from '@/modules/database/connection.js';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
  token_version: number;
  approval_status: ApprovalStatus;
  approved_at: string | null;
  reviewed_by: number | null;
};

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** One row of the root-only account list. Never carries the password hash. */
export type UserAdminRow = {
  id: number;
  username: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  approval_status: ApprovalStatus;
  approved_at: string | null;
  reviewed_by: number | null;
  reviewed_by_username: string | null;
  /** F6:附件配额的每用户覆盖(MB)。null = 跟随全局默认。 */
  attachment_quota_mb: number | null;
};

type UserPublicRow = Pick<
  UserRow,
  'id' | 'username' | 'created_at' | 'last_login' | 'token_version' | 'approval_status'
>;

type CreateUserResult = {
  id: number | bigint;
  username: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const userDb = {
  /** Returns true if at least one user exists in the database. */
  hasUsers(): boolean {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    return row.count > 0;
  },

  /**
   * Inserts a new user and returns the created ID + username.
   *
   * `approvalStatus` is explicit rather than defaulted so the caller has to
   * decide: self-registration passes 'pending', the root account and the
   * first-run setup pass 'approved'.
   */
  createUser(
    username: string,
    passwordHash: string,
    approvalStatus: ApprovalStatus = 'approved'
  ): CreateUserResult {
    const db = getConnection();
    const result = db
      .prepare(
        'INSERT INTO users (username, password_hash, approval_status, approved_at) VALUES (?, ?, ?, ?)'
      )
      .run(
        username,
        passwordHash,
        approvalStatus,
        approvalStatus === 'approved' ? new Date().toISOString() : null
      );
    return { id: result.lastInsertRowid, username };
  },

  /**
   * Looks up an active user by username.
   * Returns the full row (including password hash) for auth verification.
   */
  getUserByUsername(username: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(username) as UserRow | undefined;
  },

  /** Updates the last_login timestamp. Non-fatal — logs but does not throw. */
  updateLastLogin(userId: number): void {
    try {
      const db = getConnection();
      db.prepare(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to update last login', { error: message });
    }
  },

  /** Returns public user fields by ID (no password hash). */
  getUserById(userId: number): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, token_version, approval_status FROM users WHERE id = ? AND is_active = 1'
      )
      .get(userId) as UserPublicRow | undefined;
  },

  /**
   * 最小用户名录(id + username),给「指定用户」授权选择器用。
   * 只含 active 且已批准的账号;不带任何敏感字段,普通登录用户可见 ——
   * 在这个多用户协作工具里,同事的用户名本就互相可见(会话/项目侧栏)。
   */
  listBasicUsers(): Array<{ id: number; username: string }> {
    const db = getConnection();
    return db
      .prepare(
        `SELECT id, username FROM users
         WHERE is_active = 1 AND approval_status = 'approved'
         ORDER BY username COLLATE NOCASE`
      )
      .all() as Array<{ id: number; username: string }>;
  },

  /**
   * Every account, newest first, for the root-only approval panel.
   * Left-joins the reviewer so the panel can show who approved whom.
   */
  listUsersForAdmin(): UserAdminRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT u.id, u.username, u.created_at, u.last_login, u.is_active,
                u.approval_status, u.approved_at, u.reviewed_by,
                u.attachment_quota_mb,
                r.username AS reviewed_by_username
         FROM users u
         LEFT JOIN users r ON r.id = u.reviewed_by
         ORDER BY
           CASE u.approval_status WHEN 'pending' THEN 0 ELSE 1 END,
           u.created_at DESC`
      )
      .all() as UserAdminRow[];
  },

  /**
   * F6:读一个账号的附件配额覆盖(MB)。null = 没设过,跟随全局默认。
   *
   * 单独一条查询而不是塞进 listUsersForAdmin —— 这条在**每次附件提交**的热路径上
   * 被调用(见 attachment-storage.ts),不能顺带把全表用户捞回来。
   */
  getAttachmentQuotaMb(userId: number): number | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT attachment_quota_mb FROM users WHERE id = ?')
      .get(userId) as { attachment_quota_mb: number | null } | undefined;
    const value = row?.attachment_quota_mb ?? null;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  },

  /**
   * F6:设置/清除某账号的附件配额覆盖。传 null 即回到全局默认。
   *
   * **0 和负数一律当成"清除覆盖"**,不是"覆盖成 0"。把某人的配额设成 0 意味着
   * 他一个字节都传不了,那应该是另一个开关(停用附件),不该是配额输入框手滑
   * 的后果。路由那层已经把 <1 挡成 400,这里是第二道。
   *
   * 返回 false 表示 id 不存在 —— 路由据此答 404,而不是对着打错的 id 报成功。
   */
  setAttachmentQuotaMb(userId: number, quotaMb: number | null): boolean {
    const db = getConnection();
    const normalized = quotaMb === null || !Number.isFinite(quotaMb) || quotaMb < 1
      ? null
      : Math.floor(quotaMb);
    const result = db
      .prepare('UPDATE users SET attachment_quota_mb = ? WHERE id = ?')
      .run(normalized, userId);
    return result.changes > 0;
  },

  /**
   * Records an approval decision and stamps who made it.
   *
   * Returns false when the id matches no row, so the route can answer 404
   * instead of silently reporting success on a typo'd id.
   */
  setApprovalStatus(
    userId: number,
    status: ApprovalStatus,
    reviewedBy: number | null
  ): boolean {
    const db = getConnection();
    // 不再是 approved 时必须顶掉已签发的 token。
    //
    // 鉴权中间件查的是账号存在性和 token_version,**从不查 approval_status**
    // (它甚至被 select 出来然后丢掉了)。审批闸门只拦登录接口,所以 root 拒绝
    // 一个正在线上的用户之后,那个人手里 7 天有效期的 JWT 会一直好用到过期 ——
    // "拒绝"在界面上生效了,在会话层面没有。
    const result = db
      .prepare(
        `UPDATE users
         SET approval_status = ?,
             approved_at = CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP ELSE NULL END,
             reviewed_by = ?,
             token_version = CASE WHEN ? = 'approved' THEN token_version ELSE token_version + 1 END
         WHERE id = ?`
      )
      .run(status, status, reviewedBy, status, userId);
    return result.changes > 0;
  },

  /** Approval status by id, or undefined when the user is gone. */
  getApprovalStatus(userId: number): ApprovalStatus | undefined {
    const db = getConnection();
    const row = db
      .prepare('SELECT approval_status FROM users WHERE id = ?')
      .get(userId) as { approval_status: ApprovalStatus } | undefined;
    return row?.approval_status;
  },

  /** Resolves a username to its id, case-insensitively. Used by the owner backfill. */
  findIdByUsername(username: string): number | undefined {
    const db = getConnection();
    const row = db
      .prepare('SELECT id FROM users WHERE lower(username) = lower(?)')
      .get(username) as { id: number } | undefined;
    return row?.id;
  },

  /** Returns the first active user. Used for platform-mode lookups. */
  getFirstUser(): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, token_version, approval_status FROM users WHERE is_active = 1 LIMIT 1'
      )
      .get() as UserPublicRow | undefined;
  },

  /**
   * Invalidates every JWT already issued to this user by advancing the
   * version their tokens were signed with. Used by "log out everywhere" and
   * by password changes — a stolen 7-day token is otherwise valid for its
   * full lifetime with no way to recall it.
   *
   * Returns the new version.
   */
  bumpTokenVersion(userId: number): number {
    const db = getConnection();
    const row = db
      .prepare(
        'UPDATE users SET token_version = token_version + 1 WHERE id = ? RETURNING token_version'
      )
      .get(userId) as { token_version: number } | undefined;
    return row?.token_version ?? 0;
  },

  /** Current token version, or 0 when the user is gone. */
  getTokenVersion(userId: number): number {
    const db = getConnection();
    const row = db
      .prepare('SELECT token_version FROM users WHERE id = ?')
      .get(userId) as { token_version: number } | undefined;
    return row?.token_version ?? 0;
  },

  /** Replaces the stored bcrypt hash and revokes existing tokens. */
  updatePassword(userId: number, passwordHash: string): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'
    ).run(passwordHash, userId);
  },

  /**
   * 启用/停用账号。停用同时递增 token_version —— is_active 只拦得住新登录
   * (getUserByUsername 带 is_active=1),已签发的 JWT 要靠版本号立刻作废。
   */
  setActive(userId: number, active: boolean): boolean {
    const db = getConnection();
    const result = active
      ? db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(userId)
      : db.prepare(
          'UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?'
        ).run(userId);
    return result.changes > 0;
  },

};

/*
 * Removed accessors, and why the columns they addressed are still here:
 *
 * - `updateGitConfig` / `getGitConfig` went with the git surface.
 * - `completeOnboarding` / `hasCompletedOnboarding` went with the onboarding
 *   screen — Claude Code is the only agent, so there was nothing to choose.
 *
 * `git_name`, `git_email` and `has_completed_onboarding` stay in the table.
 * Older SQLite builds have no DROP COLUMN, and a destructive migration to
 * rebuild the table would risk live account rows to reclaim three unread
 * fields. They are written by nothing and read by nothing.
 */
