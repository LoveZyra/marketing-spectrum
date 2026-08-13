import express from 'express';
import bcrypt from 'bcrypt';

import { userDb, auditLogDb } from '../modules/database/index.js';
import { getConnection } from '../modules/database/connection.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import {
  authRateLimiter,
  clearLoginFailures,
  clientIp,
  loginLockout,
  recordLoginFailure,
} from '../middleware/rate-limit.js';
import { issueTicket, WS_TICKET_TTL_MS } from '../shared/ws-tickets.js';
import { isApprovalRequired, isRootUser } from '../shared/root-users.js';

const router = express.Router();
const db = getConnection();

/** Shared context for every audit entry written from this router. */
const auditContext = (req) => ({
  ip: clientIp(req),
  userAgent: req.headers['user-agent'] ?? null,
});

// Check auth status and setup requirements
router.get('/status', async (req, res) => {
  try {
    const hasUsers = await userDb.hasUsers();
    res.json({
      needsSetup: !hasUsers,
      isAuthenticated: false // Will be overridden by frontend if token exists
    });
  } catch (error) {
    console.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Registration.
//
// Prism used to allow exactly one account and refuse every later signup. It now
// accepts one account per colleague, but a new account arrives `pending` and
// cannot log in until a root user approves it. Two exceptions get `approved`
// immediately, and both are deliberate:
//
//   - the very first account on a fresh install — there is nobody to approve it
//     yet, and refusing would leave the instance unusable;
//   - any username listed in PRISM_ROOT_USERS — root must never be able to lock
//     itself out of its own approval queue.
router.post('/register', authRateLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
    }

    // Use a transaction to prevent race conditions
    db.prepare('BEGIN').run();
    let user;
    let approvalStatus;
    try {
      // The first account on a fresh install is the setup account.
      const isFirstAccount = !userDb.hasUsers();
      approvalStatus =
        isFirstAccount || isRootUser(username) || !isApprovalRequired()
          ? 'approved'
          : 'pending';

      // Hash password
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      user = userDb.createUser(username, passwordHash, approvalStatus);

      db.prepare('COMMIT').run();
    } catch (error) {
      db.prepare('ROLLBACK').run();
      throw error;
    }

    if (approvalStatus !== 'approved') {
      auditLogDb.record({
        ...auditContext(req),
        userId: Number(user.id),
        username: user.username,
        event: 'register_pending',
      });

      // No token: an account that cannot log in must not be handed a session.
      // The message has to be explicit, or the user reads the success flag and
      // reports "registered but login is broken".
      return res.json({
        success: true,
        pendingApproval: true,
        user: { id: user.id, username: user.username },
        message: '注册申请已提交,等待管理员审批通过后即可登录。',
      });
    }

    const token = generateToken(user);

    // Update last login (non-fatal, outside transaction)
    userDb.updateLastLogin(user.id);

    auditLogDb.record({
      ...auditContext(req),
      userId: Number(user.id),
      username: user.username,
      event: 'register',
    });

    res.json({
      success: true,
      pendingApproval: false,
      user: { id: user.id, username: user.username },
      token
    });

  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// User login
//
// Two independent guards, because they stop different attacks: authRateLimiter
// caps attempts per IP (username spraying, where every request uses a new
// username and so never trips a single identity's counter), while loginLockout
// escalates per (IP, username) (password guessing against one account).
router.post('/login', authRateLimiter, loginLockout, async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Get user from database
    const user = userDb.getUserByUsername(username);
    if (!user) {
      const failure = recordLoginFailure(req);
      auditLogDb.record({
        ...auditContext(req),
        username,
        event: failure?.lockedUntil ? 'login_locked' : 'login_failed',
        outcome: 'failure',
        detail: 'unknown user',
      });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      const failure = recordLoginFailure(req);
      auditLogDb.record({
        ...auditContext(req),
        userId: user.id,
        username: user.username,
        event: failure?.lockedUntil ? 'login_locked' : 'login_failed',
        outcome: 'failure',
        detail: 'bad password',
      });
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Approval gate. Order matters, and each step exists to avoid a specific
    // way of locking people out:
    //   1. root bypasses the check entirely — if the approval logic is wrong,
    //      whoever is named in PRISM_ROOT_USERS can still get in and fix it;
    //   2. PRISM_APPROVAL_REQUIRED=0 disables the gate wholesale, which is the
    //      escape hatch for reverting to the previous behaviour without a
    //      code rollback;
    //   3. only then is the account's own status consulted.
    // Note this runs *after* the password check, so it leaks nothing about
    // which usernames exist.
    if (!isRootUser(user.username) && isApprovalRequired()) {
      const status = user.approval_status ?? 'approved';

      if (status !== 'approved') {
        auditLogDb.record({
          ...auditContext(req),
          userId: user.id,
          username: user.username,
          event: 'login_unapproved',
          outcome: 'failure',
          detail: status,
        });

        // Distinct wording per status: "waiting" and "declined" call for very
        // different follow-up from the person reading it.
        return res.status(403).json({
          error: status === 'rejected'
            ? '注册申请未通过,如有疑问请联系管理员。'
            : '账号待管理员审批,通过后即可登录。',
          approvalStatus: status,
        });
      }
    }

    // Generate token
    const token = generateToken(user);

    // Update last login
    userDb.updateLastLogin(user.id);
    clearLoginFailures(req);

    auditLogDb.record({
      ...auditContext(req),
      userId: user.id,
      username: user.username,
      event: 'login',
    });

    res.json({
      success: true,
      user: { id: user.id, username: user.username, isRoot: isRootUser(user.username) },
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user (protected route)
router.get('/user', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});

// Logout.
//
// JWTs cannot be un-issued, so `all: true` bumps the user's token_version,
// which invalidates every token minted before this call — the recovery path
// after a token leaks. A plain logout stays client-side, as before.
router.post('/logout', authenticateToken, (req, res) => {
  const revokeAll = req.body?.all === true;

  if (revokeAll) {
    userDb.bumpTokenVersion(req.user.id);
    auditLogDb.record({
      ...auditContext(req),
      userId: req.user.id,
      username: req.user.username,
      event: 'token_revoked',
      detail: 'logout all sessions',
    });
    return res.json({ success: true, message: 'All sessions revoked', revokedAll: true });
  }

  auditLogDb.record({
    ...auditContext(req),
    userId: req.user.id,
    username: req.user.username,
    event: 'logout',
  });
  res.json({ success: true, message: 'Logged out successfully' });
});

// Change password. Rotates token_version, so every other session is signed
// out — the expected behavior after a suspected compromise.
router.post('/change-password', authenticateToken, authRateLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const user = userDb.getUserByUsername(req.user.username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      auditLogDb.record({
        ...auditContext(req),
        userId: user.id,
        username: user.username,
        event: 'login_failed',
        outcome: 'failure',
        detail: 'change-password: wrong current password',
      });
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    userDb.updatePassword(user.id, passwordHash);

    auditLogDb.record({
      ...auditContext(req),
      userId: user.id,
      username: user.username,
      event: 'token_revoked',
      detail: 'password changed',
    });

    // Issue a fresh token so the caller is not signed out of their own session.
    const token = generateToken(userDb.getUserById(user.id));
    res.json({ success: true, token });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Single-use WebSocket upgrade ticket.
//
// Browsers cannot set headers on a WebSocket handshake, so the token used to
// be passed as ?token=, where it landed in proxy and server access logs with
// its full 7-day lifetime intact. A ticket is 60s, one-use, and useless once
// redeemed. See server/shared/ws-tickets.js.
router.post('/ws-ticket', authenticateToken, (req, res) => {
  const ticket = issueTicket(req.user.id);
  auditLogDb.record({
    ...auditContext(req),
    userId: req.user.id,
    username: req.user.username,
    event: 'ws_ticket_issued',
  });
  res.json({ ticket, expiresInMs: WS_TICKET_TTL_MS });
});

// Security audit log for the signed-in user.
router.get('/audit-log', authenticateToken, (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit ?? '', 10) || 100;
    const offset = Number.parseInt(req.query.offset ?? '', 10) || 0;
    res.json({
      entries: auditLogDb.list(limit, offset),
      total: auditLogDb.count(),
    });
  } catch (error) {
    console.error('Audit log error:', error);
    res.status(500).json({ error: 'Failed to read audit log' });
  }
});

export default router;
