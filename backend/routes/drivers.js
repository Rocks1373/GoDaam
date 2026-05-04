const express = require('express');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { toLegacyDriver, computeAutoWarning, parseVehicleToFields } = require('../services/transportationService');

const router = express.Router();
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

// PUT /api/drivers/:id — legacy shape (transportation_drivers)
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const existing = await dbGet(`SELECT * FROM transportation_drivers WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Driver not found' });

    const driver_name = req.body?.driver_name !== undefined ? String(req.body.driver_name || '').trim() : existing.driver_name;
    const phone_number = req.body?.phone_number !== undefined ? String(req.body.phone_number || '').trim() : existing.driver_phone;
    const vehicle = req.body?.vehicle !== undefined ? String(req.body.vehicle || '').trim() : legacyVehicleFromRow(existing);
    const is_active = req.body?.is_active === undefined ? (existing.status === 'Active' ? 1 : 0) : req.body.is_active ? 1 : 0;
    const { vehicle_type, vehicle_number } = parseVehicleToFields(vehicle);

    if (!driver_name) return res.status(400).json({ error: 'driver_name is required' });

    const c = await dbGet(`SELECT * FROM transportation_carriers WHERE id = ?`, [existing.carrier_id]);
    const carrier_type = c?.carrier_type || existing.carrier_type;
    const carrier_name = c?.carrier_name || existing.carrier_name;

    const draft = {
      ...existing,
      driver_name,
      driver_phone: phone_number,
      vehicle_type: vehicle_type != null ? vehicle_type : existing.vehicle_type,
      vehicle_number: vehicle_number != null ? vehicle_number : existing.vehicle_number,
      carrier_type,
      carrier_name,
    };
    const auto_warning = computeAutoWarning(draft);
    const status = is_active ? 'Active' : 'Inactive';

    await dbRun(
      `UPDATE transportation_drivers
       SET driver_name = ?, driver_phone = ?, vehicle_type = ?, vehicle_number = ?, status = ?, auto_warning = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [driver_name, phone_number || '', vehicle_type, vehicle_number, status, auto_warning, id]
    );
    const row = await dbGet(`SELECT * FROM transportation_drivers WHERE id = ?`, [id]);
    res.json(toLegacyDriver(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function legacyVehicleFromRow(d) {
  const a = String(d.vehicle_type || '').trim();
  const b = String(d.vehicle_number || '').trim();
  if (a && b) return `${a} / ${b}`;
  return b || a || '';
}

// DELETE /api/drivers/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const rows = await dbAll(`SELECT file_path FROM transportation_driver_attachments WHERE driver_id = ?`, [id]);
    for (const a of rows || []) {
      const fp = path.join(__dirname, '..', String(a.file_path || '').replace(/^\//, ''));
      try {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch {
        // ignore
      }
    }
    await dbRun(`DELETE FROM transportation_driver_attachments WHERE driver_id = ?`, [id]);
    const r = await dbRun(`DELETE FROM transportation_drivers WHERE id = ?`, [id]);
    res.json({ ok: true, deleted: r?.changes || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
