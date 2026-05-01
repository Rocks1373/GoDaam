const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

// PUT /api/drivers/:id
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const existing = await dbGet(`SELECT * FROM carrier_drivers WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Driver not found' });

    const driver_name = req.body?.driver_name !== undefined ? String(req.body.driver_name || '').trim() : existing.driver_name;
    const phone_number = req.body?.phone_number !== undefined ? String(req.body.phone_number || '').trim() : existing.phone_number;
    const vehicle = req.body?.vehicle !== undefined ? String(req.body.vehicle || '').trim() : existing.vehicle;
    const is_active = req.body?.is_active === undefined ? existing.is_active : req.body.is_active ? 1 : 0;

    if (!driver_name) return res.status(400).json({ error: 'driver_name is required' });

    await dbRun(
      `UPDATE carrier_drivers
       SET driver_name = ?, phone_number = ?, vehicle = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [driver_name, phone_number || null, vehicle || null, is_active, id]
    );
    const row = await dbGet(`SELECT * FROM carrier_drivers WHERE id = ?`, [id]);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/drivers/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await dbRun(`DELETE FROM carrier_drivers WHERE id = ?`, [id]);
    res.json({ ok: true, deleted: r?.changes || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

