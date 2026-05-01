const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

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
  requireMobileAccess,
  requireWebAccess,
  JWT_SECRET,
};

