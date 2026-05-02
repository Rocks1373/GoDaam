const { promisify } = require('util');
const db = require('../db');
const { PERMISSION_DEFS } = require('../schema-migrate');

function allPermissionsTrue() {
  const o = {};
  for (const [k] of PERMISSION_DEFS) {
    o[k] = true;
  }
  return o;
}

async function getUserRow(userId) {
  const get = promisify(db.get.bind(db));
  return get(
    `SELECT id, username, role, full_name, mobile_number, email, is_active,
            token_expiry_days, can_access_web, can_access_mobile
     FROM users WHERE id = ?`,
    [userId]
  );
}

/**
 * Effective permission map for JWT and /me.
 */
async function getPermissionMapForUserId(userId) {
  const user = await getUserRow(userId);
  if (!user) return null;
  // Only treat explicit 0/false as inactive; NULL defaults to active (SQLite / legacy rows).
  if (user.is_active != null && Number(user.is_active) === 0) return null;

  const role = String(user.role || '').toLowerCase();
  let map = {};

  if (role === 'admin') {
    map = allPermissionsTrue();
    map.can_access_web = true;
    map.can_access_mobile = Number(user.can_access_mobile) !== 0;
  } else {
    const all = promisify(db.all.bind(db));
    const rows = await all(
      `SELECT permission_key, is_enabled FROM role_permissions WHERE lower(role) = ?`,
      [role]
    );
    for (const [key] of PERMISSION_DEFS) {
      map[key] = false;
    }
    for (const r of rows || []) {
      map[r.permission_key] = Number(r.is_enabled) === 1;
    }
    map.can_access_web = !!map.can_access_web && Number(user.can_access_web) !== 0;
    map.can_access_mobile = !!map.can_access_mobile && Number(user.can_access_mobile) !== 0;
  }

  return { user, permissions: map };
}

function requirePermissionKey(req, key) {
  if (!req.user) return { ok: false, status: 401, error: 'Unauthorized' };
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'admin') return { ok: true };
  const perms = req.user.permissions || {};
  if (perms[key]) return { ok: true };
  return { ok: false, status: 403, error: 'Forbidden' };
}

module.exports = {
  getPermissionMapForUserId,
  getUserRow,
  requirePermissionKey,
  allPermissionsTrue,
  PERMISSION_DEFS,
};
