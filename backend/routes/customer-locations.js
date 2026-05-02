const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

function clean(v) {
  const s = String(v ?? '').trim();
  return s.length ? s : '';
}

// GET /api/customers/:customer_number/locations
router.get('/customers/:customer_number/locations', async (req, res) => {
  try {
    const customer_number = clean(req.params.customer_number);
    if (!customer_number) return res.status(400).json({ error: 'customer_number is required' });
    const c = await dbGet(`SELECT * FROM customers WHERE TRIM(customer_number) = ? LIMIT 1`, [customer_number]);
    if (!c) {
      return res.json({
        customer: null,
        locations: [],
        customer_number,
        master_missing: true,
      });
    }
    const locs = await dbAll(
      `SELECT * FROM customer_locations WHERE customer_id = ? AND is_active = 1 ORDER BY id DESC`,
      [c.id]
    );
    res.json({
      customer: c,
      locations: locs,
      customer_number,
      master_missing: false,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/customers/:customer_number/locations (permanent)
router.post('/customers/:customer_number/locations', requirePermission('can_access_web'), async (req, res) => {
  try {
    const customer_number = clean(req.params.customer_number);
    if (!customer_number) return res.status(400).json({ error: 'customer_number is required' });
    const c = await dbGet(`SELECT * FROM customers WHERE TRIM(customer_number) = ? LIMIT 1`, [customer_number]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });

    const label = clean(req.body?.label);
    const address = clean(req.body?.address);
    const gps = clean(req.body?.gps);
    const contact_person = clean(req.body?.contact_person);
    const contact_number = clean(req.body?.contact_number);
    const contact_person_2 = clean(req.body?.contact_person_2);
    const contact_number_2 = clean(req.body?.contact_number_2);

    if (!address) return res.status(400).json({ error: 'address is required' });

    await dbRun(
      `INSERT INTO customer_locations
        (customer_id, label, address, gps, contact_person, contact_number, contact_person_2, contact_number_2, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [c.id, label || null, address, gps || null, contact_person || null, contact_number || null, contact_person_2 || null, contact_number_2 || null]
    );

    const row = await dbGet(`SELECT * FROM customer_locations WHERE id = last_insert_rowid()`);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

