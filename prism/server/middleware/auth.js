import crypto from 'crypto';

import jwt from 'jsonwebtoken';

import { createLogger } from '@/shared/logger.js';

import { userDb, appConfigDb, apiKeysDb } from '../modules/database/index.js';
import { IS_PLATFORM } from '../constants/config.js';
import { isRootUser } from '../shared/root-users.js';
import { consumeSseTicket, SSE_TICKET_PATHS } from '../shared/sse-tickets.js';
import { isAccountUsable } from '../shared/account-usable.js';

const log = createLogger('auth');

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Platform mode bypasses every auth check in this module (JWT and WebSocket
// validation both short-circuit to the first DB user). Warn once at module
// init so operators know the deployment MUST sit behind an external auth
// proxy — Prism itself performs no authentication in this mode.
if (IS_PLATFORM) {
  log.warn(
    'IS_PLATFORM is enabled: all Prism authentication is bypassed. ' +
    'An external authentication proxy in front of this server is required.'
  );
}

// Optional API-key gate for every /api route.
//
// Deliberately reads PRISM_API_KEY — never the generic API_KEY, which is
// commonly inherited from unrelated tooling (e.g. Claude Code's proxy) and
// previously caused spurious 401s on Prism's own REST routes.
//
// - PRISM_API_KEY unset/empty  -> pass-through (JWT auth still applies per route)
// - PRISM_API_KEY set          -> require matching `x-prism-api-key` header
const validateApiKey = (req, res, next) => {
  const configuredKey = process.env.PRISM_API_KEY;
  if (!configuredKey) {
    return next();
  }

  // hj(审计 P2-2):浏览器导航(下载)和 EventSource(会话搜索)**带不上自定义请求头**。
  // 这两条口各有自己的短命票据(单目标、分用途、比对 token_version),不需要这道闸;
  // 不豁免的话,配了 PRISM_API_KEY 的部署里下载与搜索会全部静默 401。
  const fullPath = `${req.baseUrl || ''}${req.path || ''}`;
  if (req.method === 'GET' && req.query?.ticket
    && (fullPath.startsWith('/api/downloads/') || SSE_TICKET_PATHS.has(fullPath))) {
    return next();
  }

  const providedKey = req.headers['x-prism-api-key'];
  if (typeof providedKey === 'string' && providedKey.length > 0) {
    // Compare fixed-length sha256 digests so timingSafeEqual never throws on
    // length mismatch and the comparison leaks no timing information.
    const expectedDigest = crypto.createHash('sha256').update(configuredKey).digest();
    const providedDigest = crypto.createHash('sha256').update(providedKey).digest();
    if (crypto.timingSafeEqual(expectedDigest, providedDigest)) {
      return next();
    }
  }

  return res.status(401).json({ error: 'Invalid API key' });
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Platform mode:  use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = withRootFlag(user);
      return next();
    } catch (error) {
      log.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // SSE(EventSource)设不了 Authorization 头,只能把凭据放 URL 里。**别放 JWT** ——
  // URL 会进反代日志和浏览器历史。放一张短命票据:泄了 60 秒后也就废了。
  //
  // hj(审计 P1-1):**只在 SSE 票据的专用路径上认票**,其余路由一律不认(当作没带凭据)。
  // 原来这里对所有路由生效:搜索用的票能换 WS 票开 shell、能建永久 API key。
  // 另外比对签发时的 token_version、审批状态 ——「退出所有设备」/ 驳回之后票立刻作废。
  if (!token && req.query.ticket && req.method === 'GET'
    && SSE_TICKET_PATHS.has(`${req.baseUrl || ''}${req.path || ''}`)) {
    const consumed = consumeSseTicket(req.query.ticket);
    if (consumed) {
      const user = userDb.getUserById(consumed.userId); // getUserById 只返回 is_active 用户
      if (isAccountUsable(user, { tokenVersion: consumed.tokenVersion })) {
        req.user = withRootFlag(user);
        return next();
      }
    }
    return res.status(401).json({ error: '票据无效或已过期,请重试。' });
  }

  // 遗留的 `?token=<JWT>`:默认**不再接受**(这正是 SSE 票据要替换掉的泄漏面)。
  // 只有显式设了 PRISM_ALLOW_QUERY_TOKEN=1 的部署才放行,与 WS 升级那边一致。
  if (!token && req.query.token && process.env.PRISM_ALLOW_QUERY_TOKEN === '1') {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token. User not found.' });
    }

    // Revocation check. Tokens live 7 days, so without this a leaked token
    // stays valid for its full lifetime with no way to recall it. Logout-all
    // and password changes bump users.token_version; a token minted under an
    // older version no longer matches.
    //
    // Tokens issued before this field existed carry no `tv` claim — those are
    // accepted only while the user is still at version 0.
    const currentVersion = user.token_version ?? 0;
    const tokenVersion = typeof decoded.tv === 'number' ? decoded.tv : 0;
    if (tokenVersion !== currentVersion) {
      return res.status(401).json({ error: 'Token revoked. Please sign in again.' });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = withRootFlag(user);
    next();
  } catch (error) {
    log.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

/**
 * hj(审计 P2-3):这个请求**像不像**带着有效凭据 —— 只给「请求体大小上限」用,不是鉴权。
 *
 * 全局 `express.json` 原来是 50MB、而且排在限流和鉴权之前:一个未登录的请求就能让服务器
 * 解析 50MB 的 JSON(实测 34MB 对象体阻塞事件循环 1.25 秒)。大请求体只有登录用户才有
 * 正当用途(保存大文件、长对话)。这里只做**不碰库的 JWT 验签**(签名 + 未过期)与 API key
 * 的哈希查找,真正的鉴权照旧由各路由的 authenticateToken 负责。
 */
const hasVerifiableCredential = (req) => {
  if (IS_PLATFORM) return true;
  // 与 authenticateToken 同口径:取头里的第二段,不挑 scheme 的大小写。
  const authHeader = req.headers['authorization'];
  const token = typeof authHeader === 'string' ? authHeader.trim().split(/\s+/)[1] || null : null;
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET);
      return true;
    } catch {
      return false;
    }
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0 && apiKey.length <= 256) {
    try {
      return Boolean(apiKeysDb.validateApiKey(apiKey));
    } catch {
      return false;
    }
  }
  return false;
};

// Gate for root-only routes. Kept next to authenticateToken because it is only
// meaningful after it has run — mounting requireRoot on its own would read an
// undefined req.user and reject everyone, which looks like a config problem
// rather than a wiring mistake.
const requireRoot = (req, res, next) => {
  if (req.user?.isRoot) {
    return next();
  }

  return res.status(403).json({ error: 'Administrator access required' });
};

// Rootness is computed per request from PRISM_ROOT_USERS, never read from a
// column. One source of truth: changing the env and restarting is the whole of
// granting or revoking admin rights, with no stale row to reconcile.
const withRootFlag = (user) => ({ ...user, isRoot: isRootUser(user.username) });

// Generate JWT token
//
// `tv` pins the token to the user's current token_version so it can be
// revoked server-side (see authenticateToken). Callers that already hold a
// fresh user row pass it through; otherwise the version is read here.
const generateToken = (user) => {
  const tokenVersion =
    typeof user.token_version === 'number'
      ? user.token_version
      : userDb.getTokenVersion(user.id);

  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      tv: tokenVersion
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      log.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    // Same revocation check as the REST path — a revoked token must not be
    // able to open a shell or chat socket either.
    const currentVersion = user.token_version ?? 0;
    const tokenVersion = typeof decoded.tv === 'number' ? decoded.tv : 0;
    if (tokenVersion !== currentVersion) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    log.error('WebSocket token verification error:', error);
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  hasVerifiableCredential,
  requireRoot,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};
