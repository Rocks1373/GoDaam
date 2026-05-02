const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

function normType(t) {
  const v = String(t || '').trim();
  const low = v.toLowerCase();
  if (low === 'own' || low === 'gapp') return 'GAPP';
  if (low === 'rental') return 'Rental';
  if (low === 'courier') return 'Courier';
  if (low === 'self collection' || low === 'selfcollection') return 'Self Collection';
  return v;
}

// GET /api/carriers?search=
router.get('/', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    let rows = await dbAll(
      `SELECT * FROM carriers ORDER BY is_active DESC, carrier_type ASC, carrier_name ASC`
    );
    if (search) {
      rows = rows.filter((r) => String(r.carrier_name || '').toLowerCase().includes(search));
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/carriers
router.post('/', requireAdmin, async (req, res) => {
  try {
    const carrier_name = String(req.body?.carrier_name || '').trim();
    const carrier_type = normType(req.body?.carrier_type);
    const is_active = req.body?.is_active === undefined ? 1 : req.body.is_active ? 1 : 0;

    if (!carrier_name) return res.status(400).json({ error: 'carrier_name is required' });
    if (!carrier_type) return res.status(400).json({ error: 'carrier_type is required' });

    await dbRun(
      `INSERT INTO carriers (carrier_name, carrier_type, is_active, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [carrier_name, carrier_type, is_active]
    );
    const row = await dbGet(`SELECT * FROM carriers WHERE id = last_insert_rowid()`);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/carriers/:id
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const existing = await dbGet(`SELECT * FROM carriers WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Carrier not found' });

    const carrier_name = req.body?.carrier_name !== undefined ? String(req.body.carrier_name || '').trim() : existing.carrier_name;
    const carrier_type = req.body?.carrier_type !== undefined ? normType(req.body.carrier_type) : existing.carrier_type;
    const is_active = req.body?.is_active === undefined ? existing.is_active : req.body.is_active ? 1 : 0;

    if (!carrier_name) return res.status(400).json({ error: 'carrier_name is required' });
    if (!carrier_type) return res.status(400).json({ error: 'carrier_type is required' });

    await dbRun(
      `UPDATE carriers
       SET carrier_name = ?, carrier_type = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [carrier_name, carrier_type, is_active, id]
    );
    const row = await dbGet(`SELECT * FROM carriers WHERE id = ?`, [id]);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/carriers/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    await dbRun(`DELETE FROM carrier_drivers WHERE carrier_id = ?`, [id]);
    const r = await dbRun(`DELETE FROM carriers WHERE id = ?`, [id]);
    res.json({ ok: true, deleted: r?.changes || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/carriers/:carrier_id/drivers
router.get('/:carrier_id/drivers', async (req, res) => {
  try {
    const carrier_id = Number(req.params.carrier_id);
    if (!Number.isFinite(carrier_id)) return res.status(400).json({ error: 'Invalid carrier_id' });
    const rows = await dbAll(
      `SELECT * FROM carrier_drivers WHERE carrier_id = ? ORDER BY is_active DESC, driver_name ASC`,
      [carrier_id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/carriers/:carrier_id/drivers
router.post('/:carrier_id/drivers', requireAdmin, async (req, res) => {
  try {
    const carrier_id = Number(req.params.carrier_id);
    if (!Number.isFinite(carrier_id)) return res.status(400).json({ error: 'Invalid carrier_id' });
    const driver_name = String(req.body?.driver_name || '').trim();
    const phone_number = String(req.body?.phone_number || '').trim();
    const vehicle = String(req.body?.vehicle || '').trim();
    const is_active = req.body?.is_active === undefined ? 1 : req.body.is_active ? 1 : 0;
    if (!driver_name) return res.status(400).json({ error: 'driver_name is required' });

    await dbRun(
      `INSERT INTO carrier_drivers (carrier_id, driver_name, phone_number, vehicle, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [carrier_id, driver_name, phone_number || null, vehicle || null, is_active]
    );
    const row = await dbGet(`SELECT * FROM carrier_drivers WHERE id = last_insert_rowid()`);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

