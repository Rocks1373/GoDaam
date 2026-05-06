const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { promisify } = require('util');
const db = require('../db');
const { excelDateToJSDate, formatYYYYMMDD } = require('../utils/excelDates');
const { refreshMainStockSapQtyFromBatch } = require('../services/stockComparisonService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

const COL = {
  vendor: 0,
  material: 1,
  description: 2,
  storageLoc: 4,
  storageLocDesc: 5,
  stock: 6,
  storageDoc: 8,
  batch: 9,
  unrestricted: 10,
  uom: 11,
  value: 12,
  materialGroup: 17,
};

function maybeExcelSerialToDateString(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 20000 || v > 800000) return null;
  const d = excelDateToJSDate(v);
  if (!d) return null;
  return formatYYYYMMDD(d);
}

function cellText(v, { allowDate = true } = {}) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && allowDate) {
    const ds = maybeExcelSerialToDateString(v);
    if (ds) return ds;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return formatYYYYMMDD(v);
  return String(v).trim();
}

function cellNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function getLatestProcessedBatchId() {
  const row = await dbGet(
    `SELECT id FROM sap_stock_upload_batches WHERE status = 'Processed' ORDER BY id DESC LIMIT 1`
  );
  return row?.id ?? null;
}

/** Effective SAP qty for a row (unrestricted preferred) */
function effectiveQty(unrestricted, stock) {
  if (unrestricted !== null && unrestricted !== undefined && String(unrestricted).trim() !== '') {
    const n = Number(unrestricted);
    if (Number.isFinite(n)) return n;
  }
  const s = Number(stock);
  return Number.isFinite(s) ? s : 0;
}

function normStorageLoc(raw) {
  let s = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '');
  if (!s) return '';
  const stripped = s.replace(/^0+/, '') || s;
  if (['1002', '1004', '1007'].includes(stripped)) return stripped;
  return stripped;
}

router.get('/upload-history', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT b.*, u.username AS uploaded_by_username
       FROM sap_stock_upload_batches b
       LEFT JOIN users u ON u.id = b.uploaded_by
       ORDER BY b.id DESC
       LIMIT 200`
    );
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const batchId = Number(req.query.batch_id) || (await getLatestProcessedBatchId());
    if (!batchId) return res.json({ rows: [], batch_id: null });

    const rows = await dbAll(
      `
      SELECT
        TRIM(material) AS material,
        MAX(description) AS description,
        MAX(base_uom) AS base_uom,
        MAX(material_group) AS material_group,
        SUM(CASE WHEN TRIM(COALESCE(storage_location,'')) = '1002' THEN COALESCE(unrestricted_qty, stock_qty) ELSE 0 END) AS qty_1002,
        SUM(CASE WHEN TRIM(COALESCE(storage_location,'')) = '1004' THEN COALESCE(unrestricted_qty, stock_qty) ELSE 0 END) AS qty_1004,
        SUM(CASE WHEN TRIM(COALESCE(storage_location,'')) = '1007' THEN COALESCE(unrestricted_qty, stock_qty) ELSE 0 END) AS qty_1007
      FROM sap_stock
      WHERE upload_batch_id = ?
      GROUP BY TRIM(material)
      ORDER BY material
      `,
      [batchId]
    );
    const out = (rows || []).map((r) => {
      const q2 = Number(r.qty_1002) || 0;
      const q4 = Number(r.qty_1004) || 0;
      const q7 = Number(r.qty_1007) || 0;
      return {
        ...r,
        qty_1002: q2,
        qty_1004: q4,
        qty_1007: q7,
        sap_physical_qty: q4 + q7,
        sap_total_qty: q2 + q4 + q7,
      };
    });
    res.json({ rows: out, batch_id: batchId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/template', async (_req, res) => {
  try {
    const headers = [
      'Vendor Number',
      'Material',
      'Description',
      '(D)',
      'Storage Location',
      'Storage Location Description',
      'Stock',
      '(H)',
      'Storage Document',
      'Batch',
      'Unrestricted Qty',
      'Base Unit of Measurement',
      'Value',
      '(N)',
      '(O)',
      '(P)',
      '(Q)',
      'Material Group',
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'SAP Stock');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sap-stock-upload-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const batchId = Number(req.query.batch_id) || (await getLatestProcessedBatchId());
    if (!batchId) return res.json({ rows: [], batch_id: null, total: 0 });

    const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 2000));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const search = String(req.query.search || '').trim();
    const params = [batchId];
    let where = 'WHERE s.upload_batch_id = ?';
    if (search) {
      where += ` AND (
        TRIM(s.material) LIKE ? OR TRIM(s.description) LIKE ? OR TRIM(s.vendor_number) LIKE ?
        OR TRIM(s.material_group) LIKE ? OR TRIM(s.storage_location) LIKE ?
      )`;
      const p = `%${search}%`;
      params.push(p, p, p, p, p);
    }

    const totalRow = await dbGet(`SELECT COUNT(1) AS c FROM sap_stock s ${where}`, params);
    const total = Number(totalRow?.c) || 0;

    const rows = await dbAll(
      `SELECT
        s.vendor_number,
        s.material,
        s.sap_part_number,
        s.description,
        s.storage_location,
        s.storage_location_description,
        COALESCE(s.unrestricted_qty, s.stock_qty) AS sap_qty,
        s.base_uom,
        s.material_group,
        s.id
      FROM sap_stock s
      ${where}
      ORDER BY s.material, s.storage_location
      LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({ rows, batch_id: batchId, total, limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/export', async (req, res) => {
  try {
    const batchId = Number(req.query.batch_id) || (await getLatestProcessedBatchId());
    if (!batchId) return res.status(404).json({ error: 'No SAP upload data' });

    const rows = await dbAll(
      `SELECT vendor_number, material, description, storage_location, storage_location_description,
              stock_qty, storage_document, batch, unrestricted_qty, base_uom, value_amount, material_group
       FROM sap_stock WHERE upload_batch_id = ? ORDER BY material, storage_location`,
      [batchId]
    );
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'SAP Stock');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sap-stock-export.xlsx"');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'file is required' });
    const userId = req.user?.sub ?? null;
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return res.status(400).json({ error: 'Empty workbook' });

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    const uploadDate = new Date().toISOString().slice(0, 10);
    const fileName = req.file.originalname || 'sap-stock.xlsx';

    let batchId;
    await dbRun('BEGIN');
    try {
      await dbRun(
        `INSERT INTO sap_stock_upload_batches (file_name, upload_date, uploaded_by, total_rows, status, remarks)
         VALUES (?, ?, ?, 0, 'Uploaded', NULL)`,
        [fileName, uploadDate, userId]
      );
      batchId = (await dbGet('SELECT last_insert_rowid() AS id'))?.id;
      if (!batchId) throw new Error('Failed to create batch');

      let inserted = 0;
      const uniqMat = new Set();
      let sum1002 = 0;
      let sum1004 = 0;
      let sum1007 = 0;

      for (let i = 0; i < rows.length; i += 1) {
        const line = rows[i];
        if (!Array.isArray(line)) continue;
        const material = cellText(line[COL.material], { allowDate: false });
        if (!material) continue;
        if (i === 0 && /material/i.test(material)) continue;

        const vendor_number = cellText(line[COL.vendor], { allowDate: true });
        const description = cellText(line[COL.description], { allowDate: true });
        const storage_location = normStorageLoc(cellText(line[COL.storageLoc], { allowDate: false }));
        const storage_location_description = cellText(line[COL.storageLocDesc], { allowDate: true });
        const stock_qty = cellNum(line[COL.stock]);
        const storage_document = cellText(line[COL.storageDoc], { allowDate: true });
        const batchNo = cellText(line[COL.batch], { allowDate: true });
        const unrestricted_raw = cellNum(line[COL.unrestricted]);
        const base_uom = cellText(line[COL.uom], { allowDate: false });
        const value_amount = cellNum(line[COL.value]);
        const material_group = cellText(line[COL.materialGroup], { allowDate: true });

        const unrestricted_qty = unrestricted_raw;
        const eff = effectiveQty(unrestricted_qty, stock_qty ?? 0);

        uniqMat.add(material.trim().toLowerCase());
        if (storage_location === '1002') sum1002 += eff;
        if (storage_location === '1004') sum1004 += eff;
        if (storage_location === '1007') sum1007 += eff;

        await dbRun(
          `INSERT INTO sap_stock (
            upload_batch_id, vendor_number, material, sap_part_number, description,
            storage_location, storage_location_description, stock_qty, storage_document, "batch",
            unrestricted_qty, base_uom, value_amount, material_group, uploaded_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            batchId,
            vendor_number || null,
            material,
            material,
            description || null,
            storage_location || null,
            storage_location_description || null,
            stock_qty,
            storage_document || null,
            batchNo || null,
            unrestricted_qty,
            base_uom || null,
            value_amount,
            material_group || null,
            userId,
          ]
        );
        inserted += 1;
      }

      await dbRun(
        `UPDATE sap_stock_upload_batches SET total_rows = ?, status = 'Processed', remarks = NULL WHERE id = ?`,
        [inserted, batchId]
      );
      await dbRun('COMMIT');

      await refreshMainStockSapQtyFromBatch(db, batchId);

      res.json({
        ok: true,
        batch_id: batchId,
        total_rows: inserted,
        unique_materials: uniqMat.size,
        qty_1002: sum1002,
        qty_1004: sum1004,
        qty_1007: sum1007,
      });
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/update-main-stock-sap-qty', async (req, res) => {
  try {
    const batchId = Number(req.body?.batch_id) || (await getLatestProcessedBatchId());
    if (!batchId) return res.status(400).json({ error: 'No processed SAP batch' });
    await refreshMainStockSapQtyFromBatch(db, batchId);
    res.json({ ok: true, batch_id: batchId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:material/details', async (req, res) => {
  try {
    const material = decodeURIComponent(String(req.params.material || '')).trim();
    if (!material || /^(upload-history|summary|template|export)$/i.test(material)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const batchId = Number(req.query.batch_id) || (await getLatestProcessedBatchId());
    if (!batchId) return res.json({ rows: [], batch_id: null });

    const rows = await dbAll(
      `SELECT s.*, b.file_name AS batch_file_name, b.upload_date AS batch_upload_date, b.id AS upload_batch_id
       FROM sap_stock s
       JOIN sap_stock_upload_batches b ON b.id = s.upload_batch_id
       WHERE s.upload_batch_id = ? AND TRIM(s.material) = ?
       ORDER BY s.storage_location, s.id`,
      [batchId, material]
    );
    res.json({ rows, batch_id: batchId, material });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/clear-latest-upload', async (_req, res) => {
  try {
    const row = await dbGet(`SELECT id FROM sap_stock_upload_batches ORDER BY id DESC LIMIT 1`);
    if (!row?.id) return res.json({ ok: true, deleted_batch_id: null });

    const batchId = row.id;
    await dbRun('BEGIN');
    try {
      await dbRun(`DELETE FROM sap_stock WHERE upload_batch_id = ?`, [batchId]);
      await dbRun(`DELETE FROM sap_stock_upload_batches WHERE id = ?`, [batchId]);
      await dbRun('COMMIT');
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }

    const nextBatch = await getLatestProcessedBatchId();
    if (nextBatch) await refreshMainStockSapQtyFromBatch(db, nextBatch);
    else {
      await dbRun(`UPDATE main_stock SET sap_qty = 0, updated_at = CURRENT_TIMESTAMP WHERE 1=1`);
    }

    res.json({ ok: true, deleted_batch_id: batchId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
