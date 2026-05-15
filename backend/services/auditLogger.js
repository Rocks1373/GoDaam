/**
 * Smart audit log — fire-and-forget; failures must not affect business transactions.
 */
const { promisify } = require('util');
const db = require('../db');

const dbRun = promisify(db.run.bind(db));
const MAX_JSON = 12000;

function isPg() {
  return db && db.dialect === 'postgres';
}

function safeJson(obj) {
  if (obj == null) return null;
  try {
    let s = JSON.stringify(obj);
    if (s.length > MAX_JSON) s = `${s.slice(0, MAX_JSON)}…[truncated]`;
    return s;
  } catch {
    return '{"_error":"non-serializable"}';
  }
}

function clientIp(req) {
  if (!req) return null;
  const xff = req.headers?.['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim().slice(0, 128);
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress;
  return ip ? String(ip).slice(0, 128) : null;
}

function deviceInfo(req) {
  if (!req?.headers) return null;
  const ua = req.headers['user-agent'];
  const dev = req.headers['x-device-id'] || req.headers['x-mobile-device'];
  const parts = [];
  if (ua) parts.push(`UA:${String(ua).slice(0, 240)}`);
  if (dev) parts.push(`device:${String(dev).slice(0, 120)}`);
  return parts.join(' | ').slice(0, 512) || null;
}

function normalizeUser(user, req) {
  const u = user && typeof user === 'object' ? user : {};
  const fromReq = req?.user || {};
  const id = u.sub ?? u.id ?? fromReq.sub ?? fromReq.id ?? null;
  const name = String(u.full_name || u.username || fromReq.username || '').trim() || null;
  const role = String(u.role || fromReq.role || '').trim().toLowerCase() || null;
  return {
    user_id: id != null && Number.isFinite(Number(id)) ? Number(id) : null,
    user_name: name ? name.slice(0, 200) : null,
    user_role: role ? role.slice(0, 64) : null,
  };
}

async function insertAuditRow(payload) {
  const {
    warehouse_id,
    user,
    module_name,
    action_type,
    reference_type,
    reference_id,
    reference_number,
    status_before,
    status_after,
    old_value,
    new_value,
    remarks,
    req,
  } = payload;

  const nu = normalizeUser(user, req);
  await dbRun(
    `INSERT INTO audit_logs (
      warehouse_id, user_id, user_name, user_role, module_name, action_type,
      reference_type, reference_id, reference_number, status_before, status_after,
      old_value_json, new_value_json, remarks, ip_address, device_info, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      warehouse_id != null && warehouse_id !== '' ? Number(warehouse_id) : null,
      nu.user_id,
      nu.user_name,
      nu.user_role,
      String(module_name || 'UNKNOWN').slice(0, 64),
      String(action_type || 'UNKNOWN').slice(0, 64),
      reference_type != null ? String(reference_type).slice(0, 64) : null,
      reference_id != null && reference_id !== '' && Number.isFinite(Number(reference_id)) ? Number(reference_id) : null,
      reference_number != null ? String(reference_number).slice(0, 256) : null,
      status_before != null ? String(status_before).slice(0, 128) : null,
      status_after != null ? String(status_after).slice(0, 128) : null,
      safeJson(old_value),
      safeJson(new_value),
      remarks != null ? String(remarks).slice(0, 2000) : null,
      clientIp(req),
      deviceInfo(req),
    ]
  );
}

/**
 * @param {object} payload
 * @param {number|null} [payload.warehouse_id]
 * @param {object} [payload.user] — defaults to req.user
 * @param {string} payload.module_name
 * @param {string} payload.action_type
 * @param {string} [payload.reference_type]
 * @param {number|string} [payload.reference_id]
 * @param {string} [payload.reference_number]
 * @param {string} [payload.status_before]
 * @param {string} [payload.status_after]
 * @param {object} [payload.old_value] — small JSON-serializable snapshot
 * @param {object} [payload.new_value]
 * @param {string} [payload.remarks]
 * @param {import('express').Request} [payload.req]
 */
function logAudit(payload) {
  insertAuditRow(payload).catch((e) => {
    console.error('[audit]', e.message || e);
  });
}

module.exports = { logAudit, insertAuditRow, safeJson };
