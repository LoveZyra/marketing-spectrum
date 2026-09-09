import express from 'express';
import bcrypt from 'bcrypt';

import { createLogger } from '@/shared/logger.js';

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
import { broadcastPendingApprovalCount } from '../modules/websocket/index.js';

const log = createLogger('auth');

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
    log.error('Auth status error:', error);
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
    const { username: rawUsername, password } = req.body;

    // Validate input
    if (!rawUsername || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    /**
     * 前后空格必须在**进库之前**去掉。
     *
     * 大小写那一半由 `users.username` 的 `COLLATE NOCASE UNIQUE` 兜住(见 schema.ts
     * 上的注释:那是安全属性,不是便利属性)。但排序规则管不了空白 ——
     * `" alice "` 与 `"alice"` 在 NOCASE 下**仍然是两行**,而 `isRootUser()` 会
     * 先 `trim()` 再比对,于是 `" alice "` 照样判定为 root。同一个提权的空白变体。
     *
     * 只 trim 不 lower:大小写唯一性归排序规则管,展示时保留用户自己选的写法。
     */
    const username = String(rawUsername).trim();
    if (!username) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
    }

    // 先算哈希,再开事务。
    //
    // 原来的顺序是 BEGIN → await bcrypt.hash(~300ms) → COMMIT。better-sqlite3 是
    // 单连接同步的,这 300ms 内其它请求的写会并进这个事务:用户名重复回滚时会把
    // 无关的写一起丢掉;两个注册重叠时第二个 BEGIN 直接抛
    // "cannot start a transaction within a transaction",它的 catch 执行 ROLLBACK
    // 又杀掉第一个的事务,两边都 500。
    //
    // bcrypt 不碰数据库,没有任何理由待在事务里。挪出来之后事务体全同步,
    // better-sqlite3 的单连接语义下它本身就是原子的。
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    let user;
    let approvalStatus;
    const createAccount = db.transaction(() => {
      // The first account on a fresh install is the setup account.
      const isFirstAccount = !userDb.hasUsers();
      const status =
        isFirstAccount || isRootUser(username) || !isApprovalRequired()
          ? 'approved'
          : 'pending';
      return { created: userDb.createUser(username, passwordHash, status), status };
    });

    {
      const outcome = createAccount();
      user = outcome.created;
      approvalStatus = outcome.status;
    }

    if (approvalStatus !== 'approved') {
      auditLogDb.record({
        ...auditContext(req),
        userId: Number(user.id),
        username: user.username,
        event: 'register_pending',
      });

      // 新注册进了待审队列:立刻把最新待审数推给在线的 root(设置入口红点)。
      broadcastPendingApprovalCount();

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
    log.error('Registration error:', error);
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

    // 与注册同一口径:去掉前后空格再查。大小写由列上的 COLLATE NOCASE 兜住,
    // 这里只需要把空白抹平 —— 否则用户复制粘贴带了个空格就登不进去。
    const user = userDb.getUserByUsername(String(username).trim());
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
    log.error('Login error:', error);
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
      // ec:这里以前回 401。可这条路走的是带 Bearer 的 authenticatedFetch,
      // 前端把登录态下的任何 401 一律当"会话失效" —— 当前密码打错一个字,
      // 整个人被踢回登录页(实测)。调用方明明是已认证的,错的是**表单里的
      // 一个字段**,那是 403/400 的事,不是 401 的事。
      return res.status(403).json({ error: '当前密码不正确', code: 'CURRENT_PASSWORD_INCORRECT' });
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
    log.error('Change password error:', error);
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
  // fj:把签发时的 token_version 一起带上 —— 消费时要比对(见 ws-tickets.js)。
  const ticket = issueTicket(req.user.id, userDb.getUserById(req.user.id)?.token_version ?? 0);
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
    // Root reads the whole log; everyone else reads only their own rows.
    // Unscoped, this endpoint is an account directory: usernames, login times
    // and IPs for every colleague on the server, readable by any account.
    const scopeUserId = req.user?.isRoot ? null : (req.user?.id ?? -1);

    /*
     * ff:筛选。事件类型现在有 27 种,纯倒序分页答不了"上周三谁把那个项目删了"。
     *
     * 三个条件都是**在 scopeUserId 划定的范围之内**再缩小的 —— 拼 WHERE 的地方
     * (`buildAuditWhere`)把 `user_id = ?` 放在最前面且不受 filters 影响。
     * 尤其 `username`:非 root 传别人的名字得到的是空结果,不是别人的行。
     */
    const rawEvents = req.query.events;
    const events = (typeof rawEvents === 'string' ? rawEvents.split(',') : Array.isArray(rawEvents) ? rawEvents : [])
      .map((value) => String(value).trim())
      .filter(Boolean)
      .slice(0, 40);           // 事件类型总共二十几种,40 是防止有人拿超长 IN 打库
    const outcome = req.query.outcome === 'success' || req.query.outcome === 'failure'
      ? req.query.outcome
      : undefined;
    const usernameLike = typeof req.query.username === 'string'
      ? req.query.username.slice(0, 100)
      : undefined;
    const filters = { events, outcome, usernameLike };

    res.json({
      entries: auditLogDb.list(limit, offset, scopeUserId, filters),
      total: auditLogDb.count(scopeUserId, filters),
    });
  } catch (error) {
    log.error('Audit log error:', error);
    res.status(500).json({ error: 'Failed to read audit log' });
  }
});

export default router;
