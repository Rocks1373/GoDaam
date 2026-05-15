const express = require('express');
const { promisify } = require('util');
const db = require('../db');
const { requireAdmin, requireAuth } = require('../middleware/auth');
const { listWarehousesForUser, userHasWarehouseAccess } = require('../services/warehouseContext');

const router = express.Router();
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

/** Current user: warehouses they may operate in (for web/mobile selector). */
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const role = req.user.role;
    const rows = await listWarehousesForUser(userId, role);
    const u = await dbGet(`SELECT default_warehouse_id FROM users WHERE id = ?`, [userId]);
    res.json({ warehouses: rows || [], default_warehouse_id: u?.default_warehouse_id ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, warehouse_code, warehouse_name, warehouse_number, location, manager_name, remarks, is_active, created_at, updated_at
       FROM warehouses ORDER BY warehouse_code`
    );
    res.json(rows || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { warehouse_code, warehouse_name, warehouse_number, location, manager_name, remarks, is_active } = req.body || {};
    const code = String(warehouse_code || '').trim();
    const name = String(warehouse_name || '').trim();
    const regNo = warehouse_number != null && String(warehouse_number).trim() !== '' ? String(warehouse_number).trim() : null;
    if (!code || !name) return res.status(400).json({ error: 'warehouse_code and warehouse_name are required' });
    await dbRun(
      `INSERT INTO warehouses (warehouse_code, warehouse_name, warehouse_number, location, manager_name, remarks, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 1), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [code, name, regNo, location || null, manager_name || null, remarks || null, is_active != null ? (is_active ? 1 : 0) : 1]
    );
    const row = await dbGet(`SELECT * FROM warehouses WHERE warehouse_code = ?`, [code]);
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const { warehouse_name, warehouse_number, location, manager_name, remarks, is_active } = req.body || {};
    const regNo =
      warehouse_number === undefined
        ? null
        : warehouse_number != null && String(warehouse_number).trim() !== ''
          ? String(warehouse_number).trim()
          : null;
    await dbRun(
      `UPDATE warehouses SET
         warehouse_name = COALESCE(?, warehouse_name),
         warehouse_number = CASE WHEN ? = 1 THEN ? ELSE warehouse_number END,
         location = COALESCE(?, location),
         manager_name = COALESCE(?, manager_name),
         remarks = COALESCE(?, remarks),
         is_active = COALESCE(?, is_active),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        warehouse_name != null ? String(warehouse_name) : null,
        warehouse_number !== undefined ? 1 : 0,
        regNo,
        location !== undefined ? location : null,
        manager_name !== undefined ? manager_name : null,
        remarks !== undefined ? remarks : null,
        is_active != null ? (is_active ? 1 : 0) : null,
        id,
      ]
    );
    const row = await dbGet(`SELECT * FROM warehouses WHERE id = ?`, [id]);
    res.json(row);
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
