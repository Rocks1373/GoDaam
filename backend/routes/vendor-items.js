const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { promisify } = require('util');

const db = require('../db');

const { normalizeExcelRows } = require('../utils/excelDates');

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

function normalizeItem(payload = {}) {
  const vendor_id = payload.vendor_id == null || payload.vendor_id === '' ? null : Number(payload.vendor_id);
  if (vendor_id != null && !Number.isFinite(vendor_id)) throw new Error('vendor_id must be a number');

  const part_number = clean(payload.part_number);
  const description = clean(payload.description);
  if (!part_number) throw new Error('part_number is required');
  if (!description) throw new Error('description is required');

  return {
    vendor_id,
    vendor_number: clean(payload.vendor_number) || null,
    vendor_name: clean(payload.vendor_name) || null,
    sap_part_number: clean(payload.sap_part_number) || null,
    part_number,
    description,
    uom: clean(payload.uom) || null,
    remarks: clean(payload.remarks) || null,
    is_active: toBoolInt(payload.is_active, 1),
  };
}

const TEMPLATE_HEADERS = ['Vendor Number', 'Vendor Name', 'SAP Part Number', 'Part Number', 'Description', 'UOM', 'Remarks'];

function templateRows() {
  return [
    {
      'Vendor Number': 'VEN001',
      'Vendor Name': 'CommScope',
      'SAP Part Number': 'SAP100',
      'Part Number': 'PN100',
      Description: 'Patch Cord',
      UOM: 'PCS',
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
    sap_part_number: pickRow(row, 'SAP Part Number'),
    part_number: pickRow(row, 'Part Number'),
    description: pickRow(row, 'Description'),
    uom: pickRow(row, 'UOM'),
    remarks: pickRow(row, 'Remarks'),
  };
}

async function resolveVendorForRow({ vendor_id, vendor_number, vendor_name }) {
  if (vendor_id != null) {
    const v = await dbGet(`SELECT * FROM vendors WHERE id = ? LIMIT 1`, [vendor_id]);
    if (v) return v;
  }
  const vn = clean(vendor_number);
  if (vn) {
    const v = await dbGet(`SELECT * FROM vendors WHERE TRIM(vendor_number) = ? LIMIT 1`, [vn]);
    if (v) return v;
  }
  const name = clean(vendor_name);
  if (name) {
    const v = await dbGet(`SELECT * FROM vendors WHERE vendor_name = ? LIMIT 1`, [name]);
    if (v) return v;
  }
  return null;
}

async function upsertItemOnDb(payload) {
  const p = normalizeItem(payload);
  const vendor = await resolveVendorForRow(p);
  const vid = vendor?.id ?? p.vendor_id ?? null;
  const vnum = vendor?.vendor_number ?? p.vendor_number ?? null;
  const vname = vendor?.vendor_name ?? p.vendor_name ?? null;

  const existing = await dbGet(
    `SELECT * FROM vendor_items WHERE COALESCE(vendor_id, -1) = COALESCE(?, -1) AND TRIM(part_number) = TRIM(?) LIMIT 1`,
    [vid, p.part_number]
  );

  if (existing?.id) {
    await dbRun(
      `UPDATE vendor_items SET
        vendor_id = ?,
        vendor_number = ?,
        vendor_name = ?,
        sap_part_number = ?,
        description = ?,
        uom = ?,
        remarks = ?,
        is_active = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [vid, vnum, vname, p.sap_part_number, p.description, p.uom, p.remarks, p.is_active, existing.id]
    );
    return await dbGet(`SELECT * FROM vendor_items WHERE id = ?`, [existing.id]);
  }

  await dbRun(
    `INSERT INTO vendor_items
      (vendor_id, vendor_number, vendor_name, sap_part_number, part_number, description, uom, remarks, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [vid, vnum, vname, p.sap_part_number, p.part_number, p.description, p.uom, p.remarks, p.is_active]
  );
  return await dbGet(
    `SELECT * FROM vendor_items
     WHERE COALESCE(vendor_id, -1) = COALESCE(?, -1) AND TRIM(part_number) = TRIM(?)
     ORDER BY id DESC LIMIT 1`,
    [vid, p.part_number]
  );
}

// GET /api/vendor-items?search=&vendor_id=
router.get('/', async (req, res) => {
  try {
    const q = clean(req.query.search);
    const vendor_id = req.query.vendor_id != null && req.query.vendor_id !== '' ? Number(req.query.vendor_id) : null;
    const like = `%${q}%`;
    const rows = await dbAll(
      `SELECT * FROM vendor_items
       WHERE (? = '')
          OR part_number LIKE ?
          OR COALESCE(sap_part_number,'') LIKE ?
          OR COALESCE(description,'') LIKE ?
          OR COALESCE(vendor_name,'') LIKE ?
          OR COALESCE(vendor_number,'') LIKE ?
       ${vendor_id != null && Number.isFinite(vendor_id) ? 'AND vendor_id = ?' : ''}
       ORDER BY id DESC
       LIMIT 2000`,
      vendor_id != null && Number.isFinite(vendor_id)
        ? [q, like, like, like, like, like, vendor_id]
        : [q, like, like, like, like, like]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vendor-items/search?q=
router.get('/search', async (req, res) => {
  try {
    const q = clean(req.query.q);
    if (!q) return res.json([]);
    const like = `%${q}%`;
    const rows = await dbAll(
      `SELECT * FROM vendor_items
       WHERE is_active = 1
         AND (
           part_number LIKE ?
           OR COALESCE(sap_part_number,'') LIKE ?
           OR COALESCE(description,'') LIKE ?
           OR COALESCE(vendor_name,'') LIKE ?
         )
       ORDER BY id DESC
       LIMIT 50`,
      [like, like, like, like]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vendor-items/template
router.get('/template', (_req, res) => {
  const ws = XLSX.utils.json_to_sheet(templateRows(), { header: TEMPLATE_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Vendor Items');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=\"vendor-items-template.xlsx\"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// POST /api/vendor-items
router.post('/', async (req, res) => {
  try {
    const row = await upsertItemOnDb(req.body || {});
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/vendor-items/:id — part_number cannot be changed (immutable spare part number).
router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const existingRow = await dbGet(`SELECT * FROM vendor_items WHERE id = ?`, [id]);
    if (!existingRow) return res.status(404).json({ error: 'Vendor item not found' });
    const body = { ...(req.body || {}), part_number: existingRow.part_number };
    const p = normalizeItem(body);
    const vendor = await resolveVendorForRow(p);
    const vid = vendor?.id ?? p.vendor_id ?? null;
    const vnum = vendor?.vendor_number ?? p.vendor_number ?? null;
    const vname = vendor?.vendor_name ?? p.vendor_name ?? null;

    const r = await dbRun(
      `UPDATE vendor_items SET
        vendor_id = ?,
        vendor_number = ?,
        vendor_name = ?,
        sap_part_number = ?,
        part_number = ?,
        description = ?,
        uom = ?,
        remarks = ?,
        is_active = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [vid, vnum, vname, p.sap_part_number, p.part_number, p.description, p.uom, p.remarks, p.is_active, id]
    );
    if (!r.changes) return res.status(404).json({ error: 'Vendor item not found' });
    res.json(await dbGet(`SELECT * FROM vendor_items WHERE id = ?`, [id]));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/vendor-items/:id — deactivate
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const r = await dbRun(`UPDATE vendor_items SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
    res.json({ ok: true, changes: r.changes || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vendor-items/bulk-paste
router.post('/bulk-paste', async (req, res) => {
  try {
    const data = req.body?.data;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'data must be an array' });
    const results = [];
    for (const row of data) {
      try {
        const out = await upsertItemOnDb(row);
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

// POST /api/vendor-items/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'file is required' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = normalizeExcelRows(XLSX.utils.sheet_to_json(ws, { defval: '' }));
    const results = [];
    for (const r of rows) {
      try {
        const out = await upsertItemOnDb(mapExcelRow(r));
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
