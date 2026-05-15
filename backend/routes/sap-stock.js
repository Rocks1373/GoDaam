const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { promisify } = require('util');
const db = require('../db');
const { excelDateToJSDate, formatYYYYMMDD } = require('../utils/excelDates');
const { normalizeSapStorageLoc } = require('../utils/sapStorageLoc');
const { refreshMainStockSapQtyFromBatch } = require('../services/stockComparisonService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

/** Legacy narrow template (Vendor Number, Material, …) — column indices */
const LEGACY_COL = {
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
  const parse = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return NaN;
    return Number(String(v).replace(/,/g, '').trim());
  };
  const u = parse(unrestricted);
  if (Number.isFinite(u)) return u;
  const s = parse(stock);
  return Number.isFinite(s) ? s : 0;
}

function normStorageLoc(raw) {
  return normalizeSapStorageLoc(raw);
}

/** Quantity cells often contain commas / formatting */
function parseQtyCell(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return null;
  if (v && typeof v === 'object' && typeof v.v === 'number' && Number.isFinite(v.v)) return v.v;
  const s = String(v)
    .replace(/,/g, '')
    .replace(/\u00a0/g, '')
    .trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeHeaderKey(v) {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ');
}

function headerNormRow(headerRow) {
  return (headerRow || []).map(normalizeHeaderKey);
}

/** Left-to-right: exact "unrestricted", then fuzzy (never "Value unrestricted"). */
function pickUnrestrictedColumnIndex(headerRow) {
  const norm = headerNormRow(headerRow);
  const exact = norm.indexOf('unrestricted');
  if (exact >= 0) return exact;
  for (let i = 0; i < norm.length; i += 1) {
    const h = norm[i];
    if (!h) continue;
    if (h === 'value unrestricted') continue;
    if (h.includes('value') && h.includes('unrestricted')) continue;
    if (h === 'unrestricted use stock') continue;
    if (/^unrestrict/.test(h)) return i;
  }
  return -1;
}

function pickMaterialGroupColumnIndex(headerRow) {
  const norm = headerNormRow(headerRow);
  const candidates = ['material group', 'matl group', 'material grp', 'materialgrp'];
  for (const c of candidates) {
    const i = norm.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

function pickUomColumnIndex(headerRow) {
  const norm = headerNormRow(headerRow);
  const candidates = ['base unit of measure', 'unit of measure', 'base unit', 'uom', 'bun'];
  for (const c of candidates) {
    const i = norm.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

/** Column A in MB52-style exports: Item (SD). */
function pickItemSdColumnIndex(headerRow) {
  const norm = headerNormRow(headerRow);
  const aliases = ['item (sd)', 'item sd', 'sd item'];
  for (const a of aliases) {
    const i = norm.indexOf(a);
    if (i >= 0) return i;
  }
  for (let i = 0; i < Math.min(norm.length, 4); i += 1) {
    if (norm[i] === 'item') return i;
  }
  return -1;
}

/** Narrow vendor template (fixed columns): column A vendor-ish, column B material. */
function looksLikeLegacyNarrowHeader(row) {
  if (!Array.isArray(row) || row.length < 2) return false;
  const a = normalizeHeaderKey(row[0]);
  const b = normalizeHeaderKey(row[1]);
  return a.includes('vendor') && (b === 'material' || b.includes('material'));
}

/** Find header row when SAP adds title rows above column labels. */
function findSapHeaderRowIndex(rows, maxScan = 30) {
  for (let i = 0; i < Math.min(maxScan, rows.length); i += 1) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length < 5) continue;
    const norm = headerNormRow(row);
    if (norm.indexOf('material') < 0) continue;
    if (norm.indexOf('storage location') < 0) continue;
    if (pickUnrestrictedColumnIndex(row) < 0 && norm.indexOf('stock') < 0) continue;
    return i;
  }
  return 0;
}

/**
 * Wide SAP export (e.g. MB52-style): resolve columns by header names (K/L/R), not fixed indices.
 * Material group is optional — requiring it forced legacy mode on valid exports with alternate MG labels.
 */
function buildLayoutFromSapExportHeaders(headerRow) {
  const norm = headerNormRow(headerRow);
  const col = (label) => norm.indexOf(label);

  const material = col('material');
  const storageLocation = col('storage location');
  let unrestricted = pickUnrestrictedColumnIndex(headerRow);
  if (unrestricted < 0) {
    const stockIdx = col('stock');
    if (stockIdx >= 0) unrestricted = stockIdx;
  }

  if (material < 0 || storageLocation < 0 || unrestricted < 0) return null;

  let storageLocDesc = col('descr of storage loc');
  if (storageLocDesc < 0) storageLocDesc = col('storage location description');

  const mg = pickMaterialGroupColumnIndex(headerRow);
  const uom = pickUomColumnIndex(headerRow);
  const itemSd = pickItemSdColumnIndex(headerRow);
  const salesDocument = col('sales document');

  return {
    itemSd: itemSd >= 0 ? itemSd : -1,
    material,
    description: col('material description'),
    plant: col('plant'),
    storageLocation,
    storageLocDesc: storageLocDesc >= 0 ? storageLocDesc : -1,
    batch: col('batch'),
    salesDocument: salesDocument >= 0 ? salesDocument : -1,
    unrestricted,
    stock: col('stock'),
    uom: uom >= 0 ? uom : -1,
    materialGroup: mg >= 0 ? mg : -1,
    materialDocument: col('material document'),
    valueAmount: col('value unrestricted'),
    vendorNumber: col('vendor number'),
  };
}

function legacySapLayout() {
  return {
    dataStart: 0,
    layoutMode: 'legacy',
    headerRowIndex: 0,
    itemSd: -1,
    salesDocument: -1,
    material: LEGACY_COL.material,
    description: LEGACY_COL.description,
    storageLocation: LEGACY_COL.storageLoc,
    storageLocDesc: LEGACY_COL.storageLocDesc,
    batch: LEGACY_COL.batch,
    unrestricted: LEGACY_COL.unrestricted,
    stock: LEGACY_COL.stock,
    uom: LEGACY_COL.uom,
    materialGroup: LEGACY_COL.materialGroup,
    materialDocument: LEGACY_COL.storageDoc,
    valueAmount: LEGACY_COL.value,
    vendorNumber: LEGACY_COL.vendor,
    plant: -1,
  };
}

function resolveSapUploadLayout(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return legacySapLayout();

  const hi = findSapHeaderRowIndex(rows);
  const headerRow = rows[hi] || [];
  const wide = buildLayoutFromSapExportHeaders(headerRow);
  if (wide) {
    return {
      ...wide,
      dataStart: hi + 1,
      layoutMode: 'wide',
      headerRowIndex: hi,
    };
  }

  const first = rows[0];
  if (looksLikeLegacyNarrowHeader(first)) return legacySapLayout();

  return legacySapLayout();
}

/** Column letters for upload diagnostics (0 → A). */
function columnLetter(idx) {
  if (idx == null || idx < 0) return null;
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function lineText(line, idx, opts = {}) {
  if (idx == null || idx < 0 || !Array.isArray(line)) return '';
  return cellText(line[idx], opts);
}

function lineQty(line, idx) {
  if (idx == null || idx < 0 || !Array.isArray(line)) return null;
  return parseQtyCell(line[idx]);
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
        SUM(CASE WHEN TRIM(COALESCE(storage_location,'')) = '1001' THEN COALESCE(unrestricted_qty, stock_qty) ELSE 0 END) AS qty_1001,
        SUM(CASE WHEN TRIM(COALESCE(storage_location,'')) = '1002' THEN COALESCE(unrestricted_qty, stock_qty) ELSE 0 END) AS qty_1002,
        SUM(CASE WHEN TRIM(COALESCE(storage_location,'')) = '1003' THEN COALESCE(unrestricted_qty, stock_qty) ELSE 0 END) AS qty_1003,
        SUM(CASE WHEN TRIM(COALESCE(storage_location,'')) = '1004' THEN COALESCE(unrestricted_qty, stock_qty) ELSE 0 END) AS qty_1004,
        SUM(CASE WHEN TRIM(COALESCE(storage_location,'')) = '1005' THEN COALESCE(unrestricted_qty, stock_qty) ELSE 0 END) AS qty_1005,
        SUM(CASE WHEN TRIM(COALESCE(storage_location,'')) = '1007' THEN COALESCE(unrestricted_qty, stock_qty) ELSE 0 END) AS qty_1007
      FROM sap_stock
      WHERE upload_batch_id = ?
      GROUP BY TRIM(material)
      ORDER BY material
      `,
      [batchId]
    );
    const out = (rows || []).map((r) => {
      const q1 = Number(r.qty_1001) || 0;
      const q2 = Number(r.qty_1002) || 0;
      const q3 = Number(r.qty_1003) || 0;
      const q4 = Number(r.qty_1004) || 0;
      const q5 = Number(r.qty_1005) || 0;
      const q7 = Number(r.qty_1007) || 0;
      return {
        ...r,
        qty_1001: q1,
        qty_1002: q2,
        qty_1003: q3,
        qty_1004: q4,
        qty_1005: q5,
        qty_1007: q7,
        sap_physical_qty: q4 + q7,
        sap_total_qty: q1 + q2 + q3 + q4 + q5 + q7,
      };
    });
    res.json({ rows: out, batch_id: batchId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/template', async (_req, res) => {
  try {
    /* Matches SAP MB52-style export; legacy narrow template still parses if row 1 column A contains "Vendor". */
    const headers = [
      'Item (SD)',
      'Material',
      'Material description',
      'Plant',
      'Storage location',
      'Descr. of Storage Loc.',
      'Special Stock',
      'Spec. stk valuation',
      'Sales document',
      'Batch',
      'Unrestricted',
      'Base Unit of Measure',
      'Value Unrestricted',
      'Currency',
      'Movement Type',
      'Posting Date',
      'Material Document',
      'Material Group',
      'Material type',
      'Quantities Allocated',
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
    const storageLocationFilter = String(req.query.storage_location || '').trim();
    const materialGroupFilter = String(req.query.material_group || '').trim();
    const materialFilter = String(req.query.material || '').trim();

    const params = [batchId];
    let where = 'WHERE s.upload_batch_id = ?';

    if (storageLocationFilter) {
      const loc = normStorageLoc(storageLocationFilter) || storageLocationFilter.replace(/\s+/g, '');
      const p = `%${loc}%`;
      where += ` AND (
        TRIM(COALESCE(s.storage_location,'')) LIKE ?
        OR TRIM(COALESCE(s.storage_location_description,'')) LIKE ?
      )`;
      params.push(p, p);
    }
    if (materialGroupFilter) {
      where += ` AND TRIM(COALESCE(s.material_group,'')) LIKE ?`;
      params.push(`%${materialGroupFilter}%`);
    }
    if (materialFilter) {
      where += ` AND (
        TRIM(COALESCE(s.material,'')) LIKE ?
        OR TRIM(COALESCE(s.sap_part_number,'')) LIKE ?
      )`;
      const p = `%${materialFilter}%`;
      params.push(p, p);
    }
    if (search) {
      where += ` AND (
        TRIM(s.material) LIKE ? OR TRIM(s.description) LIKE ? OR TRIM(s.vendor_number) LIKE ?
        OR TRIM(s.material_group) LIKE ? OR TRIM(s.storage_location) LIKE ?
        OR TRIM(COALESCE(s.batch,'')) LIKE ?
        OR TRIM(COALESCE(s.sales_document,'')) LIKE ?
        OR TRIM(COALESCE(s.item_sd,'')) LIKE ?
      )`;
      const p = `%${search}%`;
      params.push(p, p, p, p, p, p, p, p);
    }

    const totalRow = await dbGet(`SELECT COUNT(1) AS c FROM sap_stock s ${where}`, params);
    const total = Number(totalRow?.c) || 0;

    const rows = await dbAll(
      `SELECT
        s.vendor_number,
        s.material,
        s.sap_part_number,
        s.description,
        s.item_sd,
        s.sales_document,
        s.storage_location,
        s.storage_location_description,
        s.batch,
        s.unrestricted_qty,
        s.unrestricted_qty AS quantity,
        s.stock_qty,
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
      `SELECT vendor_number, material, description, item_sd, sales_document, storage_location, storage_location_description,
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
    /* cellDates:false keeps numeric qty columns as numbers (cellDates can mis-classify in rare sheets). */
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
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
      batchId = (
        await dbGet(
          `SELECT id FROM sap_stock_upload_batches
           WHERE file_name = ? AND upload_date = ? AND COALESCE(uploaded_by, -1) = COALESCE(?, -1)
           ORDER BY id DESC LIMIT 1`,
          [fileName, uploadDate, userId]
        )
      )?.id;
      if (!batchId) throw new Error('Failed to create batch');

      const L = resolveSapUploadLayout(rows);

      const layout_columns =
        L.layoutMode === 'wide'
          ? {
              item_sd: columnLetter(L.itemSd),
              sales_document: columnLetter(L.salesDocument),
              batch: columnLetter(L.batch),
              unrestricted: columnLetter(L.unrestricted),
              material: columnLetter(L.material),
              storage_location: columnLetter(L.storageLocation),
              material_group: columnLetter(L.materialGroup),
              base_uom: columnLetter(L.uom),
              header_row_1based: (L.headerRowIndex ?? 0) + 1,
            }
          : { mode: 'legacy_fixed_indices' };

      let inserted = 0;
      const uniqMat = new Set();
      let sum1001 = 0;
      let sum1002 = 0;
      let sum1003 = 0;
      let sum1004 = 0;
      let sum1005 = 0;
      let sum1007 = 0;

      for (let i = L.dataStart; i < rows.length; i += 1) {
        const line = rows[i];
        if (!Array.isArray(line)) continue;
        const material = lineText(line, L.material, { allowDate: false });
        if (!material) continue;
        if (L.dataStart === 0 && i === 0 && /material/i.test(material)) continue;

        const material_group = lineText(line, L.materialGroup, { allowDate: true });
        const vendor_from_col = lineText(line, L.vendorNumber, { allowDate: true });
        const vendor_number = vendor_from_col || material_group || null;
        const description = lineText(line, L.description, { allowDate: true });
        const storage_location = normStorageLoc(lineText(line, L.storageLocation, { allowDate: false }));
        const storage_location_description = lineText(line, L.storageLocDesc, { allowDate: true });
        const stock_qty = L.stock >= 0 ? lineQty(line, L.stock) : null;
        const storage_document = lineText(line, L.materialDocument, { allowDate: true });
        const item_sd = lineText(line, L.itemSd, { allowDate: false });
        const sales_document = lineText(line, L.salesDocument, { allowDate: true });
        const batchNo = lineText(line, L.batch, { allowDate: true });
        const unrestricted_raw = lineQty(line, L.unrestricted);
        const base_uom = lineText(line, L.uom, { allowDate: false });
        const value_amount = L.valueAmount >= 0 ? lineQty(line, L.valueAmount) : null;

        const unrestricted_qty = unrestricted_raw;
        const eff = effectiveQty(unrestricted_qty, stock_qty ?? 0);

        uniqMat.add(material.trim().toLowerCase());
        if (storage_location === '1001') sum1001 += eff;
        if (storage_location === '1002') sum1002 += eff;
        if (storage_location === '1003') sum1003 += eff;
        if (storage_location === '1004') sum1004 += eff;
        if (storage_location === '1005') sum1005 += eff;
        if (storage_location === '1007') sum1007 += eff;

        await dbRun(
          `INSERT INTO sap_stock (
            upload_batch_id, vendor_number, material, sap_part_number, description,
            storage_location, storage_location_description, stock_qty, storage_document, "batch",
            item_sd, sales_document,
            unrestricted_qty, base_uom, value_amount, material_group, uploaded_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            item_sd || null,
            sales_document || null,
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
        qty_1001: sum1001,
        qty_1002: sum1002,
        qty_1003: sum1003,
        qty_1004: sum1004,
        qty_1005: sum1005,
        qty_1007: sum1007,
        layout_mode: L.layoutMode ?? 'legacy',
        layout_columns,
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
