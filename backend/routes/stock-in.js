const express = require('express');
const multer = require('multer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const { normalizeExcelRows } = require('../utils/excelDates');
const { readFirstSheetAsObjects } = require('../utils/readXlsxFirstSheetExceljs');
const { resolveWarehouseIdForRequest } = require('../services/warehouseContext');

function pick(row, ...names) {
  for (const n of names) {
    const kn = Object.keys(row || {}).find((x) => String(x).trim().toLowerCase() === String(n).trim().toLowerCase());
    if (kn !== undefined && row[kn] !== undefined && row[kn] !== null && String(row[kn]).trim() !== '')
      return row[kn];
    if (row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') return row[n];
  }
  return '';
}

function openDb() {
  // Shared warehouse Postgres pool (`backend/db`). Never call `db.close()` per request — it runs `pool.end()` and breaks all later requests (including JWT revocation checks in `requireAuth`).
  return require('../db');
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRow(row) {
  const transaction_date =
    pick(row, 'transaction_date', 'Transaction Date', 'Date', 'TXN Date') || row.transaction_date;
  const part_number = pick(row, 'part_number', 'Part Number') || row.part_number;
  const sap_part_number = pick(row, 'sap_part_number', 'SAP Part Number') || row.sap_part_number;
  const description = pick(row, 'description', 'Description') || row.description;
  const rack_location = pick(row, 'rack_location', 'Rack Location', 'Rack') || row.rack_location;
  const qty_in = pick(row, 'qty_in', 'Qty In', 'Qty') ?? row.qty_in;
  const source_type = pick(row, 'source_type', 'Source Type') || row.source_type;
  const reference_no = pick(row, 'reference_no', 'Reference No', 'Reference') || row.reference_no;
  const remarks = pick(row, 'remarks', 'Remarks') || row.remarks;

  const td =
    transaction_date !== undefined && transaction_date !== null && transaction_date !== ''
      ? String(transaction_date).trim().slice(0, 10)
      : '';

  return {
    transaction_date: td,
    part_number,
    sap_part_number: sap_part_number || null,
    description: description || null,
    rack_location,
    qty_in: toNumber(qty_in),
    source_type: source_type || null,
    reference_no: reference_no || null,
    remarks: remarks || null,
    warehouse_id: Number(pick(row, 'warehouse_id', 'Warehouse ID', 'Warehouse Id') || row.warehouse_id) || null,
  };
}

async function resolveStockInWarehouseId(req) {
  return resolveWarehouseIdForRequest({
    userId: req.user?.sub,
    role: req.user?.role,
    explicitWarehouseId: req.body?.warehouse_id ?? req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
  });
}

async function applyStockIn(db, row, { updateExisting = false } = {}) {
  const r = normalizeRow(row);

  if (!r.transaction_date) throw new Error('transaction_date is required');
  if (!r.part_number) throw new Error('part_number is required');
  if (!r.rack_location) throw new Error('rack_location is required');
  if (!(r.qty_in > 0)) throw new Error('qty_in must be > 0');
  if (!r.warehouse_id) {
    r.warehouse_id = await new Promise((resolve, reject) => {
      db.get(`SELECT id FROM warehouses ORDER BY id LIMIT 1`, [], (err, found) =>
        err ? reject(err) : resolve(Number(found?.id) || null)
      );
    });
  }
  if (!r.warehouse_id) throw new Error('warehouse_id is required');

  const existing = await new Promise((resolve, reject) => {
    if (!updateExisting) return resolve(null);
    db.get(
      `SELECT id, qty_in
       FROM stock_in
       WHERE transaction_date = ?
         AND part_number = ?
         AND rack_location = ?
         AND COALESCE(source_type,'') = COALESCE(?, '')
         AND COALESCE(reference_no,'') = COALESCE(?, '')
         AND warehouse_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [r.transaction_date, r.part_number, r.rack_location, r.source_type, r.reference_no, r.warehouse_id],
      (err, found) => (err ? reject(err) : resolve(found || null))
    );
  });

  const deltaQty = existing ? r.qty_in - toNumber(existing.qty_in) : r.qty_in;
  if (!(deltaQty > 0) && !(deltaQty < 0) && !(deltaQty === 0)) throw new Error('Invalid qty delta');

  if (existing) {
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE stock_in
         SET sap_part_number = ?,
             description = ?,
             qty_in = ?,
             source_type = ?,
             reference_no = ?,
             remarks = ?
         WHERE id = ?`,
        [
          r.sap_part_number,
          r.description,
          r.qty_in,
          r.source_type,
          r.reference_no,
          r.remarks,
          existing.id,
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });
  } else {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stock_in
          (transaction_date, part_number, sap_part_number, description, rack_location, qty_in, source_type, reference_no, remarks, warehouse_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.transaction_date,
          r.part_number,
          r.sap_part_number,
          r.description,
          r.rack_location,
          r.qty_in,
          r.source_type,
          r.reference_no,
          r.remarks,
          r.warehouse_id,
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  // Upsert into summary table
  const current = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id, total_in_qty, total_out_qty, available_qty, first_entry_date
       FROM stock_by_rack
       WHERE part_number = ? AND rack_location = ? AND warehouse_id = ?`,
      [r.part_number, r.rack_location, r.warehouse_id],
      (err, found) => (err ? reject(err) : resolve(found || null))
    );
  });

  if (!current) {
    const initialIn = deltaQty;
    if (initialIn < 0) throw new Error('Cannot reduce stock that does not exist');

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stock_by_rack
          (part_number, sap_part_number, description, rack_location, total_in_qty, total_out_qty, available_qty, first_entry_date, last_updated, warehouse_id)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
          r.part_number,
          r.sap_part_number,
          r.description,
          r.rack_location,
          initialIn,
          initialIn,
          r.transaction_date,
          r.warehouse_id,
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });
  } else {
    const nextTotalIn = toNumber(current.total_in_qty) + deltaQty;
    const totalOut = toNumber(current.total_out_qty);
    const nextAvailable = nextTotalIn - totalOut;
    if (nextTotalIn < 0) throw new Error('total_in_qty cannot be negative');
    if (nextAvailable < 0) throw new Error('available_qty cannot be negative');

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE stock_by_rack
         SET sap_part_number = COALESCE(?, sap_part_number),
             description = COALESCE(?, description),
             total_in_qty = ?,
             available_qty = ?,
             first_entry_date = COALESCE(first_entry_date, ?),
             last_updated = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          r.sap_part_number,
          r.description,
          nextTotalIn,
          nextAvailable,
          r.transaction_date,
          current.id,
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  return { ok: true, part_number: r.part_number, rack_location: r.rack_location, qty_in: r.qty_in, updated: !!existing };
}

async function getStockInById(db, id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM stock_in WHERE id = ?', [id], (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

async function updateStockByRackInDelta(db, { part_number, rack_location, warehouse_id, deltaQty, sap_part_number, description, transaction_date }) {
  const current = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id, total_in_qty, total_out_qty
       FROM stock_by_rack
       WHERE part_number = ? AND rack_location = ? AND warehouse_id = ?`,
      [part_number, rack_location, warehouse_id],
      (err, found) => (err ? reject(err) : resolve(found || null))
    );
  });

  if (!current) throw new Error('Rack summary not found');

  const nextTotalIn = toNumber(current.total_in_qty) + deltaQty;
  const totalOut = toNumber(current.total_out_qty);
  const nextAvailable = nextTotalIn - totalOut;

  if (nextTotalIn < 0) throw new Error('total_in_qty cannot be negative');
  if (nextAvailable < 0) throw new Error('available_qty cannot be negative');

  await new Promise((resolve, reject) => {
    db.run(
      `UPDATE stock_by_rack
       SET sap_part_number = COALESCE(?, sap_part_number),
           description = COALESCE(?, description),
           total_in_qty = ?,
           available_qty = ?,
           first_entry_date = COALESCE(first_entry_date, ?),
           last_updated = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [sap_part_number || null, description || null, nextTotalIn, nextAvailable, transaction_date || null, current.id],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

// GET /api/stock-in
router.get('/', async (req, res) => {
  const db = openDb();
  try {
    const { limit = 200, offset = 0 } = req.query;
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT *
         FROM stock_in
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [Number(limit) || 200, Number(offset) || 0],
        (err, r) => (err ? reject(err) : resolve(r || []))
      );
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stock-in (single entry)
router.post('/', async (req, res) => {
  const db = openDb();
  const updateExisting = !!req.body?.update_existing;
  try {
    const warehouseId = await resolveStockInWarehouseId(req);
    await new Promise((resolve, reject) => db.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve())));
    const result = await applyStockIn(db, { ...req.body, warehouse_id: warehouseId }, { updateExisting });
    await new Promise((resolve, reject) => db.run('COMMIT', (err) => (err ? reject(err) : resolve())));
    res.status(201).json(result);
  } catch (e) {
    try {
      // best-effort rollback
      await new Promise((resolve) => db.run('ROLLBACK', () => resolve()));
    } catch {
      // ignore
    }
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/stock-in/:id (edit movement)
router.put('/:id', async (req, res) => {
  const db = openDb();
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const existing = await getStockInById(db, id);
    if (!existing) return res.status(404).json({ error: 'Stock In row not found' });

    const updated = normalizeRow({ ...existing, ...req.body });
    if (!updated.transaction_date) return res.status(400).json({ error: 'transaction_date is required' });
    if (!updated.part_number) return res.status(400).json({ error: 'part_number is required' });
    if (!updated.rack_location) return res.status(400).json({ error: 'rack_location is required' });
    if (!(updated.qty_in > 0)) return res.status(400).json({ error: 'qty_in must be > 0' });

    await new Promise((resolve, reject) => db.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve())));

    // Only support edits within the same part_number + rack_location (keeps logic safe)
    if (existing.part_number !== updated.part_number || existing.rack_location !== updated.rack_location) {
      throw new Error('Editing part_number or rack_location is not allowed. Delete and re-add.');
    }

    const deltaQty = toNumber(updated.qty_in) - toNumber(existing.qty_in);

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE stock_in
         SET transaction_date = ?,
             sap_part_number = ?,
             description = ?,
             qty_in = ?,
             source_type = ?,
             reference_no = ?,
             remarks = ?
         WHERE id = ?`,
        [
          updated.transaction_date,
          updated.sap_part_number,
          updated.description,
          updated.qty_in,
          updated.source_type,
          updated.reference_no,
          updated.remarks,
          id,
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });

    await updateStockByRackInDelta(db, {
      part_number: updated.part_number,
      rack_location: updated.rack_location,
      warehouse_id: existing.warehouse_id,
      deltaQty,
      sap_part_number: updated.sap_part_number,
      description: updated.description,
      transaction_date: updated.transaction_date,
    });

    await new Promise((resolve, reject) => db.run('COMMIT', (err) => (err ? reject(err) : resolve())));
    res.json({ ok: true, id, updated: true });
  } catch (e) {
    try {
      await new Promise((resolve) => db.run('ROLLBACK', () => resolve()));
    } catch {
      // ignore
    }
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/stock-in/:id (delete movement)
router.delete('/:id', async (req, res) => {
  const db = openDb();
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });

    const existing = await getStockInById(db, id);
    if (!existing) return res.status(404).json({ error: 'Stock In row not found' });

    await new Promise((resolve, reject) => db.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve())));

    await new Promise((resolve, reject) => {
      db.run('DELETE FROM stock_in WHERE id = ?', [id], (err) => (err ? reject(err) : resolve()));
    });

    await updateStockByRackInDelta(db, {
      part_number: existing.part_number,
      rack_location: existing.rack_location,
      warehouse_id: existing.warehouse_id,
      deltaQty: -toNumber(existing.qty_in),
      sap_part_number: existing.sap_part_number,
      description: existing.description,
      transaction_date: existing.transaction_date,
    });

    await new Promise((resolve, reject) => db.run('COMMIT', (err) => (err ? reject(err) : resolve())));
    res.json({ ok: true, id, deleted: true });
  } catch (e) {
    try {
      await new Promise((resolve) => db.run('ROLLBACK', () => resolve()));
    } catch {
      // ignore
    }
    res.status(400).json({ error: e.message });
  }
});

// POST /api/stock-in/bulk-paste
router.post('/bulk-paste', async (req, res) => {
  const db = openDb();
  const updateExisting = !!req.body?.update_existing;
  try {
    if (!Array.isArray(req.body?.data)) return res.status(400).json({ error: 'data must be an array' });
    const warehouseId = await resolveStockInWarehouseId(req);
    const data = normalizeExcelRows(req.body.data);

    await new Promise((resolve, reject) => db.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve())));
    const results = [];
    for (let i = 0; i < data.length; i += 1) {
      try {
        const r = await applyStockIn(db, { ...data[i], warehouse_id: warehouseId }, { updateExisting });
        results.push({ ...r, row_index: i });
      } catch (e) {
        results.push({ error: e.message, row_index: i, row: data[i] });
      }
    }
    const failed = results.filter((r) => r.error);
    if (failed.length) {
      await new Promise((resolve) => db.run('ROLLBACK', () => resolve()));
      return res.status(400).json({ error: `Bulk import failed (${failed.length} rows)`, results });
    }
    await new Promise((resolve, reject) => db.run('COMMIT', (err) => (err ? reject(err) : resolve())));

    res.json({ success: results.length, results });
  } catch (e) {
    try {
      await new Promise((resolve) => db.run('ROLLBACK', () => resolve()));
    } catch {
      // ignore
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stock-in/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  const db = openDb();
  const updateExisting = req.body?.update_existing === 'true' || req.body?.update_existing === true;
  try {
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'file is required (multipart field: file)' });
    }
    const warehouseId = await resolveStockInWarehouseId(req);
    const rawRows = await readFirstSheetAsObjects(req.file.buffer);
    const data = normalizeExcelRows(rawRows);

    await new Promise((resolve, reject) => db.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve())));
    const results = [];
    for (let i = 0; i < data.length; i += 1) {
      const row = data[i];
      try {
        const r = await applyStockIn(db, { ...row, warehouse_id: warehouseId }, { updateExisting });
        results.push({ ...r, row_index: i });
      } catch (e) {
        results.push({ error: e.message, row_index: i, row });
      }
    }

    const failed = results.filter((r) => r.error);
    if (failed.length) {
      await new Promise((resolve) => db.run('ROLLBACK', () => resolve()));
      return res.status(400).json({ error: `Upload import failed (${failed.length} rows)`, results });
    }

    await new Promise((resolve, reject) => db.run('COMMIT', (err) => (err ? reject(err) : resolve())));
    res.json({ success: results.length, results });
  } catch (e) {
    try {
      await new Promise((resolve) => db.run('ROLLBACK', () => resolve()));
    } catch {
      // ignore
    }
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.applyStockIn = applyStockIn;
