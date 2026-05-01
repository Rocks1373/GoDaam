const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const MainStock = require('../models/MainStock');
const { promisify } = require('util');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const mainStock = new MainStock();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

function pick(row, ...names) {
  for (const n of names) {
    const kn = Object.keys(row || {}).find((x) => String(x).trim().toLowerCase() === String(n).trim().toLowerCase());
    if (kn !== undefined && row[kn] !== undefined && row[kn] !== null && String(row[kn]).trim() !== '')
      return row[kn];
    if (row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') return row[n];
  }
  return '';
}

function toNum(v) {
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Normalize Excel / paste row → MainStock.upsert fields */
function normalizeMainStockRow(row) {
  if (!row || typeof row !== 'object') return null;
  const part_number = String(pick(row, 'Part Number', 'part_number')).trim();
  if (!part_number) return null;

  const sold_out_qty = toNum(pick(row, 'Sold Out Qty', 'sold_out_qty', 'issued_qty'));
  const legacyIssued = toNum(pick(row, 'issued_qty'));

  return {
    product: pick(row, 'Product', 'product') || null,
    vendor_name: pick(row, 'Vendor Name', 'vendor_name') || null,
    vendor_number: pick(row, 'Vendor Number', 'vendor_number') || null,
    sap_part_number: pick(row, 'SAP Part Number', 'sap_part_number') || null,
    sap_qty: pick(row, 'SAP Qty', 'sap_qty') === '' ? undefined : toNum(pick(row, 'SAP Qty', 'sap_qty')),
    part_number,
    description: pick(row, 'Description', 'description') || '',
    received_qty: toNum(pick(row, 'Received Qty', 'received_qty')),
    sold_out_qty: sold_out_qty || legacyIssued,
    pending_delivery_qty: toNum(pick(row, 'Pending Delivery Qty', 'pending_delivery_qty')),
    uom: pick(row, 'UOM', 'uom') || null,
    remarks: pick(row, 'Remarks', 'remarks') || null,
  };
}

function mainStockTemplateRows() {
  return [
    {
      'Vendor Number': 'VEN001',
      'Vendor Name': 'CommScope',
      'SAP Part Number': 'SAP-PN-100',
      'Part Number': 'PN-100',
      Description: 'Patch Cord',
      'Received Qty': 100,
      'Sold Out Qty': 20,
      'Pending Delivery Qty': 10,
      'Available Qty': 70,
      UOM: 'PCS',
      Remarks: 'Opening balance',
    },
  ];
}

function trimStr(v) {
  const s = String(v ?? '').trim();
  return s.length ? s : '';
}

/**
 * Resolve or create vendor for Main Stock upload.
 * - Non-blank Vendor Number: match by number; else insert with Vendor Name (fallback: number).
 * - Blank number + Vendor Name: match by case-insensitive trimmed name; else insert with NULL number.
 * - Both blank: null (vendor_id stays null).
 */
async function resolveOrCreateVendorForUpload(vendor_number, vendor_name) {
  const vn = trimStr(vendor_number);
  const name = trimStr(vendor_name);

  if (vn) {
    let row = await dbGet(`SELECT * FROM vendors WHERE TRIM(vendor_number) = ? LIMIT 1`, [vn]);
    if (row?.id) return row;
    const insertName = name || vn;
    try {
      await dbRun(
        `INSERT INTO vendors (vendor_number, vendor_name, is_active, created_at, updated_at)
         VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [vn, insertName]
      );
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE constraint')) {
        row = await dbGet(`SELECT * FROM vendors WHERE TRIM(vendor_number) = ? LIMIT 1`, [vn]);
        if (row?.id) return row;
      }
      throw e;
    }
    row = await dbGet(`SELECT * FROM vendors WHERE id = last_insert_rowid()`);
    return row;
  }

  if (name) {
    let row = await dbGet(`SELECT * FROM vendors WHERE LOWER(TRIM(vendor_name)) = LOWER(?) LIMIT 1`, [name]);
    if (row?.id) return row;
    await dbRun(
      `INSERT INTO vendors (vendor_number, vendor_name, is_active, created_at, updated_at)
       VALUES (NULL, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [name]
    );
    row = await dbGet(`SELECT * FROM vendors WHERE id = last_insert_rowid()`);
    return row;
  }

  return null;
}

/** One row: vendors (+ vendor_items + main_stock) in a single DB transaction. Computed available_qty overrides sheet "Available Qty". */
async function applyMainStockUploadRow(norm) {
  const part_number = trimStr(norm?.part_number);
  if (!part_number) throw new Error('part_number is required');

  const description = trimStr(norm?.description);
  if (!description) throw new Error('Description is required');

  const received_qty = Number(norm.received_qty) || 0;
  const sold_out_qty = Number(norm.sold_out_qty ?? norm.issued_qty) || 0;
  const pending_delivery_qty = Number(norm.pending_delivery_qty) || 0;
  const available_qty = received_qty - sold_out_qty - pending_delivery_qty;
  if (available_qty < 0) {
    throw new Error('available_qty cannot be negative (received_qty − sold_out_qty − pending_delivery_qty)');
  }

  await dbRun('BEGIN IMMEDIATE');
  try {
    const vendorRow = await resolveOrCreateVendorForUpload(norm.vendor_number, norm.vendor_name);
    const vid = vendorRow?.id ?? null;
    const vnum = trimStr(vendorRow?.vendor_number ?? norm.vendor_number) || null;
    const vname = trimStr(vendorRow?.vendor_name ?? norm.vendor_name) || null;

    const sap = trimStr(norm.sap_part_number) || null;
    const uom = trimStr(norm.uom) || null;
    const remarks = norm.remarks != null && String(norm.remarks).trim() !== '' ? String(norm.remarks).trim() : null;

    const existingItem = await dbGet(
      `SELECT * FROM vendor_items WHERE COALESCE(vendor_id, -1) = COALESCE(?, -1) AND TRIM(part_number) = TRIM(?) LIMIT 1`,
      [vid, part_number]
    );
    if (existingItem?.id) {
      await dbRun(
        `UPDATE vendor_items SET
          vendor_id = ?,
          vendor_number = ?,
          vendor_name = ?,
          sap_part_number = ?,
          description = ?,
          uom = ?,
          remarks = ?,
          is_active = 1,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [vid, vnum, vname, sap, description, uom, remarks, existingItem.id]
      );
    } else {
      await dbRun(
        `INSERT INTO vendor_items
          (vendor_id, vendor_number, vendor_name, sap_part_number, part_number, description, uom, remarks, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [vid, vnum, vname, sap, part_number, description, uom, remarks]
      );
    }

    const sap_qty =
      norm.sap_qty === undefined || norm.sap_qty === null || norm.sap_qty === ''
        ? null
        : Number(String(norm.sap_qty).replace(/,/g, ''));
    const sapQtyParam = sap_qty != null && Number.isFinite(sap_qty) ? sap_qty : null;

    await dbRun(
      `INSERT INTO main_stock (
        product, vendor_id, vendor_number, vendor_name, sap_part_number, sap_qty, part_number,
        description, received_qty, issued_qty, sold_out_qty, pending_delivery_qty, available_qty,
        uom, remarks, last_updated, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(part_number) DO UPDATE SET
        product = excluded.product,
        vendor_id = excluded.vendor_id,
        vendor_number = excluded.vendor_number,
        vendor_name = excluded.vendor_name,
        sap_part_number = excluded.sap_part_number,
        sap_qty = COALESCE(excluded.sap_qty, main_stock.sap_qty),
        description = excluded.description,
        received_qty = excluded.received_qty,
        issued_qty = excluded.issued_qty,
        sold_out_qty = excluded.sold_out_qty,
        pending_delivery_qty = excluded.pending_delivery_qty,
        available_qty = excluded.available_qty,
        uom = excluded.uom,
        remarks = excluded.remarks,
        last_updated = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP`,
      [
        norm.product ?? null,
        vid,
        vnum,
        vname,
        sap,
        sapQtyParam,
        part_number,
        description,
        received_qty,
        sold_out_qty,
        sold_out_qty,
        pending_delivery_qty,
        available_qty,
        uom,
        remarks,
      ]
    );

    const ms = await dbGet(`SELECT * FROM main_stock WHERE TRIM(part_number) = TRIM(?) LIMIT 1`, [part_number]);
    await dbRun('COMMIT');
    return { part_number, available_qty, vendor_id: vid, main_stock: ms };
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }
}

router.get('/', async (req, res) => {
  try {
    const { search = '', page = 1, limit = 500 } = req.query;
    const stocks = await mainStock.findAll({
      search,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 500,
    });
    res.json(stocks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/main-stock/search?q=
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const like = `%${q}%`;
    const rows = await dbAll(
      `SELECT id, part_number, sap_part_number, description, uom, vendor_id, vendor_number, vendor_name
       FROM main_stock
       WHERE part_number LIKE ?
          OR COALESCE(sap_part_number,'') LIKE ?
          OR COALESCE(description,'') LIKE ?
          OR COALESCE(vendor_name,'') LIKE ?
       ORDER BY id DESC
       LIMIT 30`,
      [like, like, like, like]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/main-stock/add-new-part (admin only)
router.post('/add-new-part', requireAdmin, async (req, res) => {
  try {
    const vendor_id = req.body?.vendor_id != null && req.body.vendor_id !== '' ? Number(req.body.vendor_id) : null;
    const part_number = String(req.body?.part_number || '').trim();
    const description = String(req.body?.description || '').trim();
    if (!part_number) return res.status(400).json({ error: 'part_number is required' });
    if (!description) return res.status(400).json({ error: 'description is required' });

    const vendor =
      vendor_id != null && Number.isFinite(vendor_id) ? await dbGet(`SELECT * FROM vendors WHERE id = ? LIMIT 1`, [vendor_id]) : null;
    const vendor_number = String(req.body?.vendor_number || vendor?.vendor_number || '').trim() || null;
    const vendor_name = String(req.body?.vendor_name || vendor?.vendor_name || '').trim() || null;
    const sap_part_number = String(req.body?.sap_part_number || '').trim() || null;
    const uom = String(req.body?.uom || '').trim() || null;
    const remarks = String(req.body?.remarks || '').trim() || null;

    await dbRun('BEGIN IMMEDIATE');
    try {
      // Upsert vendor_items on (vendor_id, part_number)
      const existingItem = await dbGet(
        `SELECT * FROM vendor_items WHERE COALESCE(vendor_id,-1) = COALESCE(?, -1) AND TRIM(part_number) = TRIM(?) LIMIT 1`,
        [vendor?.id ?? vendor_id ?? null, part_number]
      );
      if (existingItem?.id) {
        await dbRun(
          `UPDATE vendor_items SET
            vendor_id = ?,
            vendor_number = ?,
            vendor_name = ?,
            sap_part_number = ?,
            description = ?,
            uom = ?,
            remarks = ?,
            is_active = 1,
            updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [vendor?.id ?? vendor_id ?? null, vendor_number, vendor_name, sap_part_number, description, uom, remarks, existingItem.id]
        );
      } else {
        await dbRun(
          `INSERT INTO vendor_items
            (vendor_id, vendor_number, vendor_name, sap_part_number, part_number, description, uom, remarks, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [vendor?.id ?? vendor_id ?? null, vendor_number, vendor_name, sap_part_number, part_number, description, uom, remarks]
        );
      }
      const itemRow = await dbGet(`SELECT * FROM vendor_items WHERE id = COALESCE(?, last_insert_rowid())`, [
        existingItem?.id ?? null,
      ]);

      // Create main_stock row if missing (opening qty = 0)
      const ms = await dbGet(`SELECT * FROM main_stock WHERE TRIM(part_number) = TRIM(?) LIMIT 1`, [part_number]);
      if (!ms?.id) {
        await dbRun(
          `INSERT INTO main_stock
            (product, vendor_id, vendor_number, vendor_name, sap_part_number, part_number, description,
             received_qty, sold_out_qty, pending_delivery_qty, available_qty, sap_qty, uom, remarks,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [null, vendor?.id ?? vendor_id ?? null, vendor_number, vendor_name, sap_part_number, part_number, description, uom, remarks]
        );
      } else {
        // Backfill vendor/uom/desc if missing
        await dbRun(
          `UPDATE main_stock SET
            vendor_id = COALESCE(vendor_id, ?),
            vendor_number = COALESCE(NULLIF(vendor_number,''), ?),
            vendor_name = COALESCE(NULLIF(vendor_name,''), ?),
            sap_part_number = COALESCE(NULLIF(sap_part_number,''), ?),
            description = COALESCE(NULLIF(description,''), ?),
            uom = COALESCE(NULLIF(uom,''), ?),
            updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [vendor?.id ?? vendor_id ?? null, vendor_number, vendor_name, sap_part_number, description, uom, ms.id]
        );
      }
      const msRow = await dbGet(`SELECT * FROM main_stock WHERE TRIM(part_number) = TRIM(?) LIMIT 1`, [part_number]);
      await dbRun('COMMIT');
      res.status(201).json({ vendor_item: itemRow, main_stock: msRow });
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Duplicate vendor item for this vendor + part number' });
    }
    res.status(400).json({ error: e.message });
  }
});

// POST /api/main-stock/manual-stock-in (admin only)
router.post('/manual-stock-in', requireAdmin, async (req, res) => {
  try {
    const part_number = String(req.body?.part_number || '').trim();
    const description = String(req.body?.description || '').trim();
    const qty_in = Number(String(req.body?.qty_in ?? req.body?.inbound_qty ?? '').replace(/,/g, ''));
    if (!part_number) return res.status(400).json({ error: 'part_number is required' });
    if (!Number.isFinite(qty_in) || qty_in <= 0) return res.status(400).json({ error: 'qty_in must be > 0' });
    if (!description) return res.status(400).json({ error: 'description is required' });

    const vendor_id = req.body?.vendor_id != null && req.body.vendor_id !== '' ? Number(req.body.vendor_id) : null;
    const vendor_number = String(req.body?.vendor_number || '').trim() || null;
    const vendor_name = String(req.body?.vendor_name || '').trim() || null;
    const sap_part_number = String(req.body?.sap_part_number || '').trim() || null;
    const reference_no = String(req.body?.reference_no || '').trim() || null;
    const remarks = String(req.body?.remarks || '').trim() || null;
    const transaction_date = String(req.body?.transaction_date || new Date().toISOString().slice(0, 10)).trim();

    const ms = await dbGet(`SELECT * FROM main_stock WHERE TRIM(part_number) = TRIM(?) LIMIT 1`, [part_number]);
    if (!ms?.id) return res.status(404).json({ error: 'Part Number not found in Main Stock. Use Add New Part Number first.' });

    await dbRun('BEGIN IMMEDIATE');
    try {
      await dbRun(
        `INSERT INTO inbound_receiving
          (transaction_date, batch_vendor_name, vendor_id, vendor_number, vendor_name, invoice_no, po_number,
           part_number, sap_part_number, description, inbound_qty, reference_no, remarks, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          transaction_date,
          'Manual Stock In',
          Number.isFinite(vendor_id) ? vendor_id : ms.vendor_id ?? null,
          vendor_number || ms.vendor_number || null,
          vendor_name || ms.vendor_name || null,
          null,
          null,
          part_number,
          sap_part_number || ms.sap_part_number || null,
          description,
          qty_in,
          reference_no,
          remarks,
          req.user?.id || null,
        ]
      );

      const nextReceived = (Number(ms.received_qty) || 0) + qty_in;
      const sold = Number(ms.sold_out_qty) || 0;
      const pending = Number(ms.pending_delivery_qty) || 0;
      const nextAvail = nextReceived - sold - pending;

      await dbRun(
        `UPDATE main_stock SET
          received_qty = ?,
          available_qty = ?,
          vendor_id = COALESCE(vendor_id, ?),
          vendor_number = COALESCE(NULLIF(vendor_number,''), ?),
          vendor_name = COALESCE(NULLIF(vendor_name,''), ?),
          sap_part_number = COALESCE(NULLIF(sap_part_number,''), ?),
          description = COALESCE(NULLIF(description,''), ?),
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          nextReceived,
          nextAvail,
          Number.isFinite(vendor_id) ? vendor_id : null,
          vendor_number,
          vendor_name,
          sap_part_number,
          description,
          ms.id,
        ]
      );

      await dbRun('COMMIT');
      const msRow = await dbGet(`SELECT * FROM main_stock WHERE id = ?`, [ms.id]);
      res.json({ ok: true, main_stock: msRow });
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/template', (_req, res) => {
  const ws = XLSX.utils.json_to_sheet(mainStockTemplateRows());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Main Stock');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="main-stock-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.post('/', async (req, res) => {
  try {
    const payload = normalizeMainStockRow(req.body);
    if (!payload) return res.status(400).json({ error: 'Part Number is required' });
    const result = await applyMainStockUploadRow(payload);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'file is required' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const results = [];
    for (const row of data) {
      try {
        const norm = normalizeMainStockRow(row);
        if (!norm) {
          results.push({ error: 'Missing Part Number', row });
          continue;
        }
        const result = await applyMainStockUploadRow(norm);
        results.push(result);
      } catch (err) {
        results.push({ error: err.message, row });
      }
    }

    res.json({
      success: results.length - results.filter((r) => r.error).length,
      total: results.length,
      results,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/bulk-paste', async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'data must be an array of row objects' });
    const results = [];

    for (const row of data) {
      try {
        const norm = normalizeMainStockRow(row);
        if (!norm) {
          results.push({ error: 'Missing Part Number', row });
          continue;
        }
        const result = await applyMainStockUploadRow(norm);
        results.push(result);
      } catch (err) {
        results.push({ error: err.message, row });
      }
    }

    res.json({
      success: results.length - results.filter((r) => r.error).length,
      results,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/update-existing', async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'data must be an array' });
    const results = [];
    for (const row of data) {
      try {
        const norm = normalizeMainStockRow(row);
        if (!norm) {
          results.push({ error: 'Missing Part Number', row });
          continue;
        }
        const result = await applyMainStockUploadRow(norm);
        results.push(result);
      } catch (err) {
        results.push({ error: err.message, row });
      }
    }
    res.json({
      success: results.length - results.filter((r) => r.error).length,
      results,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const result = await mainStock.updateById(req.params.id, req.body);
    if (!result.changes) return res.status(404).json({ error: 'Stock not found' });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await mainStock.deleteById(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:partNumber', async (req, res) => {
  try {
    const stock = await mainStock.findByPartNumber(req.params.partNumber);
    if (!stock) return res.status(404).json({ error: 'Stock not found' });
    res.json(stock);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
