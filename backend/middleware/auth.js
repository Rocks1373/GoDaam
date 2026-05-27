const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { promisify } = require('util');
const { getPermissionMapForUserId } = require('../services/permissionService');

/**
 * JWT_SECRET hardening.
 *
 * In production we refuse to boot with a missing, short, or known-placeholder secret.
 * In NODE_ENV=development we still require the variable, but allow shorter values
 * to make first-time setup ergonomic.
 *
 * Generate one with:
 *   openssl rand -hex 64
 */
const PLACEHOLDER_SECRETS = new Set([
  'dev-secret-change-me',
  'replace-with-long-random-string',
  'change-me',
  'changeme',
  'secret',
]);

const NODE_ENV = String(process.env.NODE_ENV || 'development').toLowerCase();
const RAW_JWT_SECRET = String(process.env.JWT_SECRET || '').trim();

if (!RAW_JWT_SECRET) {
  console.error(
    'FATAL: JWT_SECRET is not set. Generate one with `openssl rand -hex 64` and put it in backend/.env (never commit).'
  );
  process.exit(1);
}
if (PLACEHOLDER_SECRETS.has(RAW_JWT_SECRET.toLowerCase())) {
  console.error('FATAL: JWT_SECRET is set to a known placeholder. Rotate it before starting the server.');
  process.exit(1);
}
if (NODE_ENV === 'production' && RAW_JWT_SECRET.length < 32) {
  console.error(
    `FATAL: JWT_SECRET is too short (${RAW_JWT_SECRET.length} chars). Production requires at least 32 chars of entropy. ` +
      `Generate one with: openssl rand -hex 64`
  );
  process.exit(1);
}

const JWT_SECRET = RAW_JWT_SECRET;

/**
 * Maximum lifetime of a JWT issued by this server, in seconds.
 * Default 7 days. Configurable via JWT_MAX_LIFETIME_DAYS (clamped to 30 to prevent
 * accidental year-long tokens that defeat rotation).
 */
const JWT_MAX_LIFETIME_SECONDS = (() => {
  const days = Number(process.env.JWT_MAX_LIFETIME_DAYS || 7);
  const clamped = Math.min(Math.max(Number.isFinite(days) ? days : 7, 1), 30);
  return clamped * 86400;
})();

/**
 * Optional shared secret for native app builds (header X-Mobile-Api-Key).
 * Set MOBILE_APP_API_KEY on the server; embed the same value in the app as EXPO_PUBLIC_MOBILE_API_KEY at build time.
 * Not a substitute for JWT login — reduces casual abuse of /api/mobile/*. Secrets in APK can be extracted.
 */
function requireMobileAppKey(req, res, next) {
  const expected = process.env.MOBILE_APP_API_KEY;
  if (!expected || !String(expected).trim()) return next();

  const expStr = String(expected).trim();
  const gotRaw = req.headers['x-mobile-api-key'] ?? req.headers['x-api-key'] ?? '';
  const gotStr = String(gotRaw).trim();

  const expBuf = Buffer.from(expStr, 'utf8');
  const gotBuf = Buffer.from(gotStr, 'utf8');
  let ok = expBuf.length === gotBuf.length;
  if (ok && expBuf.length > 0) {
    try {
      ok = crypto.timingSafeEqual(expBuf, gotBuf);
    } catch {
      ok = false;
    }
  } else {
    ok = false;
  }

  if (!ok) {
    return res.status(403).json({ error: 'Invalid or missing mobile app key' });
  }
  return next();
}

let _dbGet;
function dbGet(sql, params) {
  if (!_dbGet) {
    const db = require('../db');
    _dbGet = promisify(db.get.bind(db));
  }
  return _dbGet(sql, params);
}

/**
 * JWT auth + optional revocation check (tokens with `jti` after logout).
 * Async DB path is wrapped so Express 4 forwards rejections to the error handler.
 */
function requireAuth(req, res, next) {
  void requireAuthAsync(req, res, next).catch(next);
}

async function requireAuthAsync(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload && payload.jti) {
      const hit = await dbGet('SELECT 1 AS x FROM revoked_tokens WHERE jti = ?', [String(payload.jti)]);
      if (hit && hit.x != null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const role = String(req.user.role || '').toLowerCase();
  if (role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  return next();
}

function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const role = String(req.user.role || '').toLowerCase();
    if (role === 'admin') return next();
    const perms = req.user.permissions || {};
    if (perms[key]) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}

/** True if the user has at least one of the given permission keys (admin always passes). */
function requireAnyPermission(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const role = String(req.user.role || '').toLowerCase();
    if (role === 'admin') return next();
    const perms = req.user.permissions || {};
    for (const k of list) {
      if (perms[k]) return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  };
}

/** Mobile routes: must allow mobile access (JWT snapshot). Admin passes. */
function requireMobileAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'admin') return next();
  const perms = req.user.permissions || {};
  if (perms.can_access_mobile) return next();
  return res.status(403).json({ error: 'Forbidden', detail: 'Mobile access disabled' });
}

/** Web routes — Viewer workflow uses permissive checks per-route; block obvious mobile-only roles without web */
function requireWebAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'admin') return next();
  const perms = req.user.permissions || {};
  if (perms.can_access_web) return next();
  return res.status(403).json({ error: 'Forbidden', detail: 'Web access disabled' });
}

/** Re-check DB: approved, active, not blocked (invalidates JWT for blocked/pending users). */
function requireApprovedAccount(req, res, next) {
  void requireApprovedAccountAsync(req, res, next).catch(next);
}

async function requireApprovedAccountAsync(req, res, next) {
  if (!req.user?.sub) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const mapped = await getPermissionMapForUserId(req.user.sub);
  if (!mapped) {
    res.status(403).json({
      error: 'Account not approved or access revoked',
      status: 'ACCESS_DENIED',
    });
    return;
  }
  next();
}

module.exports = {
  requireAuth,
  requireApprovedAccount,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
  requireMobileAccess,
  requireWebAccess,
  requireMobileAppKey,
  JWT_SECRET,
  JWT_MAX_LIFETIME_SECONDS,
};
