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
};

type UserPublicRow = Pick<
  UserRow,
  'id' | 'username' | 'created_at' | 'last_login' | 'token_version' | 'approval_status'
>;

type UserGitConfig = {
  git_name: string | null;
  git_email: string | null;
};

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
   * Every account, newest first, for the root-only approval panel.
   * Left-joins the reviewer so the panel can show who approved whom.
   */
  listUsersForAdmin(): UserAdminRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT u.id, u.username, u.created_at, u.last_login, u.is_active,
                u.approval_status, u.approved_at, u.reviewed_by,
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
    const result = db
      .prepare(
        `UPDATE users
         SET approval_status = ?,
             approved_at = CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP ELSE NULL END,
             reviewed_by = ?
         WHERE id = ?`
      )
      .run(status, status, reviewedBy, userId);
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

  /** Stores the user's preferred git name and email. */
  updateGitConfig(
    userId: number,
    gitName: string,
    gitEmail: string
  ): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  /** Retrieves the user's git identity (name + email). */
  getGitConfig(userId: number): UserGitConfig | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as UserGitConfig | undefined;
  },

  /** Marks onboarding as complete for the given user. */
  completeOnboarding(userId: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET has_completed_onboarding = 1 WHERE id = ?'
    ).run(userId);
  },

  /** Returns true if the user has finished the onboarding flow. */
  hasCompletedOnboarding(userId: number): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as { has_completed_onboarding: number } | undefined;
    return row?.has_completed_onboarding === 1;
  },
};
