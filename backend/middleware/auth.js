const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

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

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
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

module.exports = {
  requireAuth,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
  requireMobileAccess,
  requireWebAccess,
  requireMobileAppKey,
  JWT_SECRET,
};

