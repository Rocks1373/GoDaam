const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const {
  normCarrierType,
  toLegacyCarrier,
  toLegacyDriver,
  computeAutoWarning,
  parseVehicleToFields,
} = require('../services/transportationService');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

// GET /api/carriers?search=  — legacy shape for Delivery Note & clients (backed by transportation_carriers)
router.get('/', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    let rows = await dbAll(
      `SELECT * FROM transportation_carriers
       ORDER BY CASE status WHEN 'Active' THEN 0 ELSE 1 END, carrier_type ASC, carrier_name ASC`
    );
    if (search) {
      rows = rows.filter((r) => String(r.carrier_name || '').toLowerCase().includes(search));
    }
    res.json(rows.map(toLegacyCarrier));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/carriers
router.post('/', requireAdmin, async (req, res) => {
  try {
    const carrier_name = String(req.body?.carrier_name || '').trim();
    const carrier_type = normCarrierType(req.body?.carrier_type);
    const is_active = req.body?.is_active === undefined ? 1 : req.body.is_active ? 1 : 0;
    const status = is_active ? 'Active' : 'Inactive';

    if (!carrier_name) return res.status(400).json({ error: 'carrier_name is required' });
    if (!carrier_type) return res.status(400).json({ error: 'carrier_type is required' });

    await dbRun(
      `INSERT INTO transportation_carriers (carrier_name, carrier_type, status, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [carrier_name, carrier_type, status]
    );
    const row = await dbGet(`SELECT * FROM transportation_carriers WHERE id = last_insert_rowid()`);
    res.status(201).json(toLegacyCarrier(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/carriers/:id
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const existing = await dbGet(`SELECT * FROM transportation_carriers WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Carrier not found' });

    const carrier_name = req.body?.carrier_name !== undefined ? String(req.body.carrier_name || '').trim() : existing.carrier_name;
    const carrier_type = req.body?.carrier_type !== undefined ? normType(req.body.carrier_type) : existing.carrier_type;
    const is_active = req.body?.is_active === undefined ? (existing.status === 'Active' ? 1 : 0) : req.body.is_active ? 1 : 0;
    const status = is_active ? 'Active' : 'Inactive';

    if (!carrier_name) return res.status(400).json({ error: 'carrier_name is required' });
    if (!carrier_type) return res.status(400).json({ error: 'carrier_type is required' });

    await dbRun(
      `UPDATE transportation_carriers
       SET carrier_name = ?, carrier_type = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [carrier_name, carrier_type, status, id]
    );
    await dbRun(
      `UPDATE transportation_drivers SET carrier_type = ?, carrier_name = ?, updated_at = CURRENT_TIMESTAMP WHERE carrier_id = ?`,
      [carrier_type, carrier_name, id]
    );
    const row = await dbGet(`SELECT * FROM transportation_carriers WHERE id = ?`, [id]);
    res.json(toLegacyCarrier(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function normType(t) {
  return normCarrierType(t);
}

// DELETE /api/carriers/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const drivers = await dbAll(`SELECT id FROM transportation_drivers WHERE carrier_id = ?`, [id]);
    const fs = require('fs');
    const path = require('path');
    for (const d of drivers) {
      const atts = await dbAll(`SELECT file_path FROM transportation_driver_attachments WHERE driver_id = ?`, [d.id]);
      for (const a of atts) {
        const fp = path.join(__dirname, '..', String(a.file_path || '').replace(/^\//, ''));
        try {
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch {
          // ignore
        }
      }
      await dbRun(`DELETE FROM transportation_driver_attachments WHERE driver_id = ?`, [d.id]);
      await dbRun(`DELETE FROM transportation_drivers WHERE id = ?`, [d.id]);
    }
    const r = await dbRun(`DELETE FROM transportation_carriers WHERE id = ?`, [id]);
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
      `SELECT * FROM transportation_drivers WHERE carrier_id = ?
       ORDER BY CASE status WHEN 'Active' THEN 0 ELSE 1 END, driver_name ASC`,
      [carrier_id]
    );
    res.json(rows.map((d) => toLegacyDriver(d)));
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

    const c = await dbGet(`SELECT * FROM transportation_carriers WHERE id = ?`, [carrier_id]);
    if (!c) return res.status(404).json({ error: 'Carrier not found' });
    const { vehicle_type, vehicle_number } = parseVehicleToFields(vehicle);
    const status = is_active ? 'Active' : 'Inactive';
    const draft = {
      carrier_id,
      carrier_type: c.carrier_type,
      carrier_name: c.carrier_name,
      driver_name,
      driver_phone: phone_number,
      vehicle_type,
      vehicle_number,
      iqama_expiry: null,
      license_expiry: null,
      vehicle_document_expiry: null,
      insurance_expiry: null,
      fahas_expiry: null,
    };
    const auto_warning = computeAutoWarning(draft);

    await dbRun(
      `INSERT INTO transportation_drivers (
        carrier_id, carrier_type, carrier_name, driver_name, driver_phone,
        vehicle_number, vehicle_type, status, auto_warning, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [carrier_id, c.carrier_type, c.carrier_name, driver_name, phone_number || '', vehicle_number, vehicle_type, status, auto_warning]
    );
    const row = await dbGet(`SELECT * FROM transportation_drivers WHERE id = last_insert_rowid()`);
    res.status(201).json(toLegacyDriver(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
