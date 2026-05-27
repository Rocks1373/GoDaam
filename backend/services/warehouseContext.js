const { promisify } = require('util');
const db = require('../db');

const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

async function getDefaultWarehouseId() {
  const wh2 = await dbGet(`SELECT id FROM warehouses WHERE lower(warehouse_code) = 'wh2' ORDER BY id LIMIT 1`);
  if (wh2?.id) return Number(wh2.id);
  const wh1 = await dbGet(`SELECT id FROM warehouses WHERE lower(warehouse_code) = 'wh1' ORDER BY id LIMIT 1`);
  if (wh1?.id) return Number(wh1.id);
  const any = await dbGet(`SELECT id FROM warehouses WHERE COALESCE(is_active,1) = 1 ORDER BY id LIMIT 1`);
  return Number(any?.id) || null;
}

async function listWarehousesForUser(userId, role) {
  const r = String(role || '').toLowerCase();
  if (r === 'admin') {
    return dbAll(
      `SELECT id, warehouse_code, warehouse_name, location, is_active, warehouse_number
       FROM warehouses
       WHERE COALESCE(is_active,1) = 1
       ORDER BY warehouse_code`
    );
  }
  return dbAll(
    `SELECT w.id, w.warehouse_code, w.warehouse_name, w.location, w.is_active
     FROM warehouses w
     JOIN user_warehouses uw ON uw.warehouse_id = w.id
     WHERE uw.user_id = ? AND COALESCE(w.is_active,1) = 1
     ORDER BY w.warehouse_code`,
    [userId]
  );
}

async function userHasWarehouseAccess(userId, role, warehouseId) {
  const wid = Number(warehouseId);
  if (!wid) return false;
  if ((String(role || '').toLowerCase()) === 'admin') return true;
  const row = await dbGet(
    `SELECT 1 AS ok FROM user_warehouses WHERE user_id = ? AND warehouse_id = ? LIMIT 1`,
    [userId, wid]
  );
  return !!row;
}

/**
 * Resolve warehouse for a write operation: explicit body/query wins, else user's default_warehouse_id, else WH1.
 */
async function resolveWarehouseIdForRequest({ userId, role, explicitWarehouseId }) {
  const ex = explicitWarehouseId;
  let wid = ex != null && ex !== '' ? Number(ex) : null;
  if (wid && (await userHasWarehouseAccess(userId, role, wid))) return wid;
  if (wid && (String(role || '').toLowerCase()) === 'admin') return wid;

  const row = await dbGet(`SELECT default_warehouse_id FROM users WHERE id = ?`, [userId]);
  wid = Number(row?.default_warehouse_id) || null;
  if (wid && (await userHasWarehouseAccess(userId, role, wid))) return wid;
  if (wid && (String(role || '').toLowerCase()) === 'admin') return wid;

  return getDefaultWarehouseId();
}

/**
 * If the client sent a concrete warehouse id (query or X-Warehouse-Id), non-admins must be assigned to it.
 * Prevents silent fallback to default warehouse when probing another site.
 */
async function assertExplicitWarehouseParamAllowed(req) {
  const raw = req.query?.warehouse_id ?? (typeof req.get === 'function' ? req.get('X-Warehouse-Id') : '');
  const s = String(raw ?? '').trim();
  if (!s || s.toLowerCase() === 'all') return { ok: true };
  const wid = Number(s);
  if (!Number.isFinite(wid) || wid <= 0) return { ok: true };
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'admin') return { ok: true };
  const ok = await userHasWarehouseAccess(req.user.sub, role, wid);
  return ok ? { ok: true } : { ok: false, status: 403, message: 'Forbidden for this warehouse' };
}

/**
 * List/dashboard reads: admin may pass warehouse_id=all (no warehouse filter).
 * Otherwise returns a single warehouse id from explicit header/query, user default, or WH1.
 */
async function resolveReadWarehouseScope(req) {
  const userId = req.user?.sub;
  const role = req.user?.role;
  const raw = req.query?.warehouse_id ?? (typeof req.get === 'function' ? req.get('X-Warehouse-Id') : null);
  const isAdmin = String(role || '').toLowerCase() === 'admin';
  if (isAdmin && String(raw ?? '').trim().toLowerCase() === 'all') {
    return { mode: 'all', warehouseId: null };
  }
  const warehouseId = await resolveWarehouseIdForRequest({
    userId,
    role,
    explicitWarehouseId: raw,
  });
  return { mode: 'one', warehouseId: warehouseId ?? null };
}

/**
 * Inbound putaway list: show batches for every warehouse the user is assigned to
 * (unless they sent an explicit X-Warehouse-Id to filter one site).
 * Avoids empty Receiving when web upload used a different warehouse than mobile default.
 */
async function resolveInboundBatchListScope(req) {
  const userId = req.user?.sub;
  const role = req.user?.role;
  const raw = req.query?.warehouse_id ?? (typeof req.get === 'function' ? req.get('X-Warehouse-Id') : null);
  const rawS = String(raw ?? '').trim();

  if (rawS && rawS.toLowerCase() !== 'all') {
    const warehouseId = await resolveWarehouseIdForRequest({
      userId,
      role,
      explicitWarehouseId: raw,
    });
    return { mode: 'one', warehouseId: warehouseId ?? null };
  }

  const isAdmin = String(role || '').toLowerCase() === 'admin';
  if (isAdmin) {
    return { mode: 'all', warehouseId: null };
  }

  const warehouses = await listWarehousesForUser(userId, role);
  const ids = (warehouses || []).map((w) => Number(w.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) {
    const warehouseId = await resolveWarehouseIdForRequest({ userId, role });
    return { mode: 'one', warehouseId: warehouseId ?? null };
  }
  if (ids.length === 1) {
    return { mode: 'one', warehouseId: ids[0] };
  }
  return { mode: 'many', warehouseIds: ids };
}

function inboundBatchWhereClause(scope) {
  if (scope.mode === 'all') return { sql: '', params: [] };
  if (scope.mode === 'many') {
    const ph = scope.warehouseIds.map(() => '?').join(',');
    return { sql: ` WHERE b.warehouse_id IN (${ph}) `, params: [...scope.warehouseIds] };
  }
  if (scope.warehouseId) {
    return { sql: ' WHERE b.warehouse_id = ? ', params: [scope.warehouseId] };
  }
  return { sql: '', params: [] };
}

function inboundBatchAccessAllowed(scope, batchWarehouseId) {
  const bw = Number(batchWarehouseId);
  if (!Number.isFinite(bw) || bw <= 0) return scope.mode === 'all';
  if (scope.mode === 'all') return true;
  if (scope.mode === 'many') return scope.warehouseIds.includes(bw);
  return Number(scope.warehouseId) === bw;
}

module.exports = {
  getDefaultWarehouseId,
  listWarehousesForUser,
  userHasWarehouseAccess,
  resolveWarehouseIdForRequest,
  assertExplicitWarehouseParamAllowed,
  resolveReadWarehouseScope,
  resolveInboundBatchListScope,
  inboundBatchWhereClause,
  inboundBatchAccessAllowed,
};
