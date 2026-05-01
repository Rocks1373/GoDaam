const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { promisify } = require('util');

const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

function clean(v) {
  const s = String(v ?? '').trim();
  return s.length ? s : '';
}

function toBoolInt(v, def = 1) {
  if (v === undefined || v === null || v === '') return def;
  const x = String(v).trim().toLowerCase();
  if (x === '0' || x === 'false' || x === 'no' || x === 'inactive') return 0;
  return 1;
}

function normalizeVendor(payload = {}) {
  const vendor_number = clean(payload.vendor_number) || null;
  const vendor_name = clean(payload.vendor_name);
  if (!vendor_name) throw new Error('vendor_name is required');
  return {
    vendor_number,
    vendor_name,
    contact_person: clean(payload.contact_person) || null,
    phone_number: clean(payload.phone_number) || null,
    email: clean(payload.email) || null,
    remarks: clean(payload.remarks) || null,
    is_active: toBoolInt(payload.is_active, 1),
  };
}

const TEMPLATE_HEADERS = ['Vendor Number', 'Vendor Name', 'Contact Person', 'Phone Number', 'Email', 'Remarks'];

function templateRows() {
  return [
    {
      'Vendor Number': 'VEN001',
      'Vendor Name': 'CommScope',
      'Contact Person': 'Ahmed',
      'Phone Number': '+966500000000',
      Email: 'ahmed@commscope.com',
      Remarks: '',
    },
  ];
}

function pickRow(row, key) {
  if (!row) return '';
  const found = Object.keys(row).find((k) => String(k).trim().toLowerCase() === String(key).trim().toLowerCase());
  return found ? row[found] : '';
}

function mapExcelRow(row) {
  return {
    vendor_number: pickRow(row, 'Vendor Number'),
    vendor_name: pickRow(row, 'Vendor Name'),
    contact_person: pickRow(row, 'Contact Person'),
    phone_number: pickRow(row, 'Phone Number'),
    email: pickRow(row, 'Email'),
    remarks: pickRow(row, 'Remarks'),
  };
}

// GET /api/vendors?search=
router.get('/', async (req, res) => {
  try {
    const q = clean(req.query.search);
    const like = `%${q}%`;
    const rows = await dbAll(
      `SELECT * FROM vendors
       WHERE (? = '')
          OR vendor_number LIKE ?
          OR vendor_name LIKE ?
          OR contact_person LIKE ?
          OR phone_number LIKE ?
          OR email LIKE ?
       ORDER BY vendor_name ASC, id DESC
       LIMIT 1000`,
      [q, like, like, like, like, like]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vendors/template
router.get('/template', (_req, res) => {
  const ws = XLSX.utils.json_to_sheet(templateRows(), { header: TEMPLATE_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Vendors');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=\"vendors-template.xlsx\"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// GET /api/vendors/:id
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await dbGet(`SELECT * FROM vendors WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Vendor not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function upsertVendorOnDb(payload) {
  const p = normalizeVendor(payload);
  if (p.vendor_number) {
    const existing = await dbGet(`SELECT * FROM vendors WHERE TRIM(vendor_number) = ? LIMIT 1`, [p.vendor_number]);
    if (existing?.id) {
      await dbRun(
        `UPDATE vendors SET
          vendor_name = ?,
          contact_person = ?,
          phone_number = ?,
          email = ?,
          remarks = ?,
          is_active = ?,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [p.vendor_name, p.contact_person, p.phone_number, p.email, p.remarks, p.is_active, existing.id]
      );
      return await dbGet(`SELECT * FROM vendors WHERE id = ?`, [existing.id]);
    }
  }

  await dbRun(
    `INSERT INTO vendors
      (vendor_number, vendor_name, contact_person, phone_number, email, remarks, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [p.vendor_number, p.vendor_name, p.contact_person, p.phone_number, p.email, p.remarks, p.is_active]
  );
  return await dbGet(`SELECT * FROM vendors WHERE id = last_insert_rowid()`);
}

// POST /api/vendors  (admin only)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const row = await upsertVendorOnDb(req.body || {});
    res.status(201).json(row);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE constraint failed: vendors.vendor_number')) {
      return res.status(409).json({ error: 'vendor_number must be unique' });
    }
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/vendors/:id  (admin only)
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const p = normalizeVendor(req.body || {});
    const r = await dbRun(
      `UPDATE vendors SET
        vendor_number = ?,
        vendor_name = ?,
        contact_person = ?,
        phone_number = ?,
        email = ?,
        remarks = ?,
        is_active = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [p.vendor_number, p.vendor_name, p.contact_person, p.phone_number, p.email, p.remarks, p.is_active, id]
    );
    if (!r.changes) return res.status(404).json({ error: 'Vendor not found' });
    res.json(await dbGet(`SELECT * FROM vendors WHERE id = ?`, [id]));
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE constraint failed: vendors.vendor_number')) {
      return res.status(409).json({ error: 'vendor_number must be unique' });
    }
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/vendors/:id  (admin only) — deactivate
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await dbRun(`UPDATE vendors SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
    res.json({ ok: true, changes: r.changes || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vendors/bulk-paste (admin only)
router.post('/bulk-paste', requireAdmin, async (req, res) => {
  try {
    const data = req.body?.data;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'data must be an array' });
    const results = [];
    for (const row of data) {
      try {
        const out = await upsertVendorOnDb(row);
        results.push({ id: out.id, action: 'upserted' });
      } catch (e) {
        results.push({ error: e.message, row });
      }
    }
    res.json({ success: results.length - results.filter((x) => x.error).length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vendors/upload (admin only)
router.post('/upload', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'file is required' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const results = [];
    for (const r of rows) {
      try {
        const out = await upsertVendorOnDb(mapExcelRow(r));
        results.push({ id: out.id, action: 'upserted' });
      } catch (e) {
        results.push({ error: e.message, row: r });
      }
    }
    res.json({ success: results.length - results.filter((x) => x.error).length, total: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

