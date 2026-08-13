import crypto from 'crypto';

import jwt from 'jsonwebtoken';

import { userDb, appConfigDb } from '../modules/database/index.js';
import { IS_PLATFORM } from '../constants/config.js';
import { isRootUser } from '../shared/root-users.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Platform mode bypasses every auth check in this module (JWT and WebSocket
// validation both short-circuit to the first DB user). Warn once at module
// init so operators know the deployment MUST sit behind an external auth
// proxy — Prism itself performs no authentication in this mode.
if (IS_PLATFORM) {
  console.warn(
    '[WARN] IS_PLATFORM is enabled: all Prism authentication is bypassed. ' +
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
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
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
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
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
      console.error('Platform mode WebSocket error:', error);
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
    console.error('WebSocket token verification error:', error);
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  requireRoot,
  generateToken,
  authenticateWebSocket,
  JWT_SECRET
};
