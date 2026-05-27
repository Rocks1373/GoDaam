const express = require('express');
const { promisify } = require('util');
const db = require('../db');
const { requireAdmin, requireAuth } = require('../middleware/auth');
const { listWarehousesForUser, userHasWarehouseAccess } = require('../services/warehouseContext');
const { assignWarehouseManager, listWarehouseStaff } = require('../services/warehouseManager');
const { assertWarehouseUnique, normCode } = require('../services/warehouseValidation');

const router = express.Router();
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

const WAREHOUSE_SELECT = `SELECT w.id, w.warehouse_code, w.warehouse_name, w.warehouse_number, w.location,
       w.manager_name, w.manager_user_id, w.remarks, w.is_active, w.created_at, w.updated_at,
       u.username AS manager_username, u.full_name AS manager_full_name, u.email AS manager_email
       FROM warehouses w
       LEFT JOIN users u ON u.id = w.manager_user_id`;

/** Current user: warehouses they may operate in (for web/mobile selector). */
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const role = req.user.role;
    const rows = await listWarehousesForUser(userId, role);
    const u = await dbGet(`SELECT default_warehouse_id, role FROM users WHERE id = ?`, [userId]);
    res.json({
      warehouses: rows || [],
      default_warehouse_id: u?.default_warehouse_id ?? null,
      role: String(u?.role || role || '').toLowerCase(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const rows = await dbAll(`${WAREHOUSE_SELECT} ORDER BY w.warehouse_code`);
    res.json(rows || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/staff', requireAuth, requireAdmin, async (req, res) => {
  try {
    const warehouseId = Number(req.params.id);
    if (!warehouseId) return res.status(400).json({ error: 'Invalid id' });
    const staff = await listWarehouseStaff(warehouseId);
    const wh = await dbGet(`${WAREHOUSE_SELECT} WHERE w.id = ?`, [warehouseId]);
    res.json({ warehouse: wh, staff: staff || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { warehouse_code, warehouse_name, warehouse_number, location, manager_name, remarks, is_active } = req.body || {};
    const name = String(warehouse_name || '').trim();
    const regNo = warehouse_number != null && String(warehouse_number).trim() !== '' ? String(warehouse_number).trim() : null;
    const unique = await assertWarehouseUnique({ warehouse_code, warehouse_name: name });
    if (!unique.ok) return res.status(unique.status).json({ error: unique.error });
    const code = unique.code;
    await dbRun(
      `INSERT INTO warehouses (warehouse_code, warehouse_name, warehouse_number, location, manager_name, remarks, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 1), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [code, name, regNo, location || null, manager_name || null, remarks || null, is_active != null ? (is_active ? 1 : 0) : 1]
    );
    const row = await dbGet(
      `${WAREHOUSE_SELECT} WHERE lower(trim(w.warehouse_code)) = lower(trim(?)) ORDER BY w.id DESC LIMIT 1`,
      [code]
    );
    res.status(201).json(row);
  } catch (e) {
    const msg = String(e.message || '');
    if (/unique|duplicate/i.test(msg)) {
      return res.status(409).json({ error: 'Warehouse code or name already exists.' });
    }
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { warehouse_code, warehouse_name, warehouse_number, location, manager_name, remarks, is_active } =
      req.body || {};
    const existing = await dbGet(`SELECT id, warehouse_code, warehouse_name FROM warehouses WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Warehouse not found' });

    const nextCode =
      warehouse_code != null && String(warehouse_code).trim() !== ''
        ? normCode(warehouse_code)
        : normCode(existing.warehouse_code);
    const nextName =
      warehouse_name != null && String(warehouse_name).trim() !== ''
        ? String(warehouse_name).trim()
        : String(existing.warehouse_name || '').trim();

    const unique = await assertWarehouseUnique({
      warehouse_code: nextCode,
      warehouse_name: nextName,
      excludeId: id,
    });
    if (!unique.ok) return res.status(unique.status).json({ error: unique.error });

    const regNo =
      warehouse_number === undefined
        ? null
        : warehouse_number != null && String(warehouse_number).trim() !== ''
          ? String(warehouse_number).trim()
          : null;
    await dbRun(
      `UPDATE warehouses SET
         warehouse_code = ?,
         warehouse_name = ?,
         warehouse_number = CASE WHEN ? = 1 THEN ? ELSE warehouse_number END,
         location = COALESCE(?, location),
         manager_name = COALESCE(?, manager_name),
         remarks = COALESCE(?, remarks),
         is_active = COALESCE(?, is_active),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        nextCode,
        nextName,
        warehouse_number !== undefined ? 1 : 0,
        regNo,
        location !== undefined ? location : null,
        manager_name !== undefined ? manager_name : null,
        remarks !== undefined ? remarks : null,
        is_active != null ? (is_active ? 1 : 0) : null,
        id,
      ]
    );
    const row = await dbGet(`${WAREHOUSE_SELECT} WHERE w.id = ?`, [id]);
    res.json(row);
  } catch (e) {
    const msg = String(e.message || '');
    if (/unique|duplicate/i.test(msg)) {
      return res.status(409).json({ error: 'Warehouse code or name already exists.' });
    }
    res.status(400).json({ error: e.message });
  }
});

/** Assign manager user to warehouse (admin). Body: { user_id } */
router.post('/:id/manager', requireAuth, requireAdmin, async (req, res) => {
  try {
    const warehouseId = Number(req.params.id);
    const uid = Number(req.body?.user_id);
    if (!warehouseId || !uid) return res.status(400).json({ error: 'warehouse id and user_id required' });
    const row = await assignWarehouseManager(warehouseId, uid);
    const staff = await listWarehouseStaff(warehouseId);
    res.json({ ok: true, warehouse: row, staff });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Assign user to warehouse (admin). Body: { user_id, role_in_warehouse?, is_default? } */
router.post('/:id/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const warehouseId = Number(req.params.id);
    const { user_id, role_in_warehouse, is_default } = req.body || {};
    const uid = Number(user_id);
    if (!warehouseId || !uid) return res.status(400).json({ error: 'warehouse id and user_id required' });
    await dbRun(
      `INSERT OR IGNORE INTO user_warehouses (user_id, warehouse_id, role_in_warehouse, is_default)
       VALUES (?, ?, ?, COALESCE(?, 0))`,
      [uid, warehouseId, role_in_warehouse || null, is_default ? 1 : 0]
    );
    if (is_default) {
      await dbRun(`UPDATE user_warehouses SET is_default = 0 WHERE user_id = ? AND warehouse_id != ?`, [
        uid,
        warehouseId,
      ]);
      await dbRun(`UPDATE user_warehouses SET is_default = 1 WHERE user_id = ? AND warehouse_id = ?`, [
        uid,
        warehouseId,
      ]);
      await dbRun(`UPDATE users SET default_warehouse_id = ? WHERE id = ?`, [warehouseId, uid]);
    }
    const rows = await dbAll(`SELECT * FROM user_warehouses WHERE warehouse_id = ?`, [warehouseId]);
    res.json({ ok: true, assignments: rows });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
