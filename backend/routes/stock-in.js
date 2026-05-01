const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.DB_PATH || './warehouse.db';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

function openDb() {
  return new sqlite3.Database(DB_PATH);
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRow(row) {
  return {
    transaction_date: row.transaction_date,
    part_number: row.part_number,
    sap_part_number: row.sap_part_number || null,
    description: row.description || null,
    rack_location: row.rack_location,
    qty_in: toNumber(row.qty_in),
    source_type: row.source_type || null,
    reference_no: row.reference_no || null,
    remarks: row.remarks || null,
  };
}

async function applyStockIn(db, row, { updateExisting = false } = {}) {
  const r = normalizeRow(row);

  if (!r.transaction_date) throw new Error('transaction_date is required');
  if (!r.part_number) throw new Error('part_number is required');
  if (!r.rack_location) throw new Error('rack_location is required');
  if (!(r.qty_in > 0)) throw new Error('qty_in must be > 0');

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
       ORDER BY id DESC
       LIMIT 1`,
      [r.transaction_date, r.part_number, r.rack_location, r.source_type, r.reference_no],
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
          (transaction_date, part_number, sap_part_number, description, rack_location, qty_in, source_type, reference_no, remarks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
       WHERE part_number = ? AND rack_location = ?`,
      [r.part_number, r.rack_location],
      (err, found) => (err ? reject(err) : resolve(found || null))
    );
  });

  if (!current) {
    const initialIn = deltaQty;
    if (initialIn < 0) throw new Error('Cannot reduce stock that does not exist');

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stock_by_rack
          (part_number, sap_part_number, description, rack_location, total_in_qty, total_out_qty, available_qty, first_entry_date, last_updated)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)`,
        [
          r.part_number,
          r.sap_part_number,
          r.description,
          r.rack_location,
          initialIn,
          initialIn,
          r.transaction_date,
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

async function updateStockByRackInDelta(db, { part_number, rack_location, deltaQty, sap_part_number, description, transaction_date }) {
  const current = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id, total_in_qty, total_out_qty
       FROM stock_by_rack
       WHERE part_number = ? AND rack_location = ?`,
      [part_number, rack_location],
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
  } finally {
    db.close();
  }
});

// POST /api/stock-in (single entry)
router.post('/', async (req, res) => {
  const db = openDb();
  const updateExisting = !!req.body?.update_existing;
  try {
    await new Promise((resolve, reject) => db.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve())));
    const result = await applyStockIn(db, req.body, { updateExisting });
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
  } finally {
    db.close();
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
  } finally {
    db.close();
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
  } finally {
    db.close();
  }
});

// POST /api/stock-in/bulk-paste
router.post('/bulk-paste', async (req, res) => {
  const db = openDb();
  const updateExisting = !!req.body?.update_existing;
  try {
    const data = req.body?.data;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'data must be an array' });

    await new Promise((resolve, reject) => db.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve())));
    const results = [];
    for (let i = 0; i < data.length; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await applyStockIn(db, data[i], { updateExisting });
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
  } finally {
    db.close();
  }
});

// POST /api/stock-in/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  const db = openDb();
  const updateExisting = req.body?.update_existing === 'true' || req.body?.update_existing === true;
  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    await new Promise((resolve, reject) => db.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve())));
    const results = [];
    for (let i = 0; i < data.length; i += 1) {
      const row = data[i];
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await applyStockIn(db, row, { updateExisting });
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
  } finally {
    db.close();
  }
});

module.exports = router;
module.exports.applyStockIn = applyStockIn;

