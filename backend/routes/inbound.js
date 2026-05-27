const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { promisify } = require('util');

const db = require('../db');
const { incrementReceivedOnDb } = require('../services/mainStockSharedSql');
const { resolveWarehouseIdForRequest } = require('../services/warehouseContext');
const { logAudit } = require('../services/auditLogger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const { applyStockIn } = require('./stock-in');
const { normalizeExcelRows } = require('../utils/excelDates');
const { notifyInboundPutaway } = require('../services/notificationService');
const {
  REJECT_MESSAGE,
  runInboundUploadValidation,
  buildMissingPartsWorkbook,
  newValidationId,
  saveValidationRecord,
  loadValidationRecord,
  assertValidationApproved,
  revalidateStoredRows,
  validatedRowsToProcessInput,
} = require('../services/inboundUploadValidation');

function pick(row, ...names) {
  for (const n of names) {
    const k = Object.keys(row || {}).find((x) => String(x).trim().toLowerCase() === String(n).trim().toLowerCase());
    if (k !== undefined && row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '')
      return row[k];
    if (row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') return row[n];
  }
  return '';
}

function toNum(v) {
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Primary inbound upload template (validated against item_master / main_stock). */
const INBOUND_TEMPLATE_HEADERS = [
  'vendor_number',
  'vendor_name',
  'part_number',
  'description',
  'quantity',
  'uom',
  'size',
  'weight',
  'local_po',
  'vendor_invoice',
  'sap_bill',
];

/** Legacy shipment columns still accepted when present on same sheet. */
const INBOUND_LEGACY_HEADERS = [
  'Batch/Vendor Name',
  'Local PO',
  'SAP PO',
  'SAP Invoice Number',
  'SAP Part Number',
  'Received Date',
  'Remarks',
];

function templateRows() {
  return [
    {
      vendor_number: 'C779-C788',
      vendor_name: 'Schneider',
      part_number: '760241056',
      description: 'O-012-LN-8W-M12BK/2C',
      quantity: 2046,
      uom: 'PC',
      size: '',
      weight: '',
      local_po: 'LPO-2026-001',
      vendor_invoice: 'VI-2026-4400',
      sap_bill: '5500001206',
    },
  ];
}

router.get('/template', (_req, res) => {
  const ws = XLSX.utils.json_to_sheet(templateRows(), { header: INBOUND_TEMPLATE_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inbound');
  const note = XLSX.utils.aoa_to_sheet([
    ['Inbound upload rules'],
    ['All part numbers must exist in item_master or main_stock before upload.'],
    ['Required: vendor_number, vendor_name, part_number, description, quantity (>0), uom'],
    ['Optional: size, weight, local_po, vendor_invoice, sap_bill (stored on inbound batch)'],
    ['Legacy column names still accepted: Local PO, Vendor Invoice, SAP Bill, SAP PO, SAP Invoice Number, etc.'],
  ]);
  XLSX.utils.book_append_sheet(wb, note, 'ReadMe');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="inbound-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

function readUploadRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

async function handleValidateInbound(req, res, rows) {
    const userId = req.user?.sub ?? null;
    const warehouseId = await resolveWarehouseIdForRequest({
      userId,
      role: req.user?.role,
      explicitWarehouseId: req.body?.warehouse_id ?? req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id could not be resolved' });

    if (!rows.length) return res.status(400).json({ error: 'Empty sheet or paste data' });

    const result = await runInboundUploadValidation(normalizeExcelRows(rows), { warehouseId });
    const validationId = newValidationId();
    const status = result.valid ? 'approved' : 'rejected';

    await saveValidationRecord({
      validationId,
      warehouseId,
      userId,
      filename: req.file?.originalname || req.body?.filename || 'inbound-rows.json',
      result,
      status,
    });

    logAudit({
      warehouse_id: warehouseId,
      user: req.user,
      req,
      module_name: 'INBOUND',
      action_type: result.valid ? 'INBOUND_VALIDATE_OK' : 'INBOUND_VALIDATE_REJECTED',
      reference_type: 'inbound_upload_validation',
      reference_id: validationId,
      reference_number: req.file?.originalname || req.body?.filename || validationId,
      status_after: status,
      remarks: result.valid
        ? `Validated ${result.total_rows} row(s)`
        : `${result.missing_parts_count} missing part(s)`,
      new_value: {
        total_rows: result.total_rows,
        missing_parts_count: result.missing_parts_count,
        valid: result.valid,
      },
    });

    const payload = {
      valid: result.valid,
      validation_id: validationId,
      total_rows: result.total_rows,
      valid_rows: result.valid_rows,
      missing_parts_count: result.missing_parts_count,
      missing_parts: result.missing_parts,
      duplicate_warnings: result.duplicate_warnings || [],
      errors: result.errors,
      reject_message: result.valid ? null : REJECT_MESSAGE,
      download_url: result.valid ? '' : `/api/inbound/missing-parts-template/${validationId}`,
    };

    if (!result.valid) return res.status(400).json(payload);
    return res.json(payload);
}

router.post('/validate-upload', upload.single('file'), async (req, res) => {
  try {
    let rows = [];
    if (req.file?.buffer) {
      rows = readUploadRows(req.file.buffer);
    } else if (Array.isArray(req.body?.rows)) {
      rows = req.body.rows;
    } else {
      return res.status(400).json({ error: 'file or rows[] is required' });
    }
    await handleValidateInbound(req, res, rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/missing-parts-template/:validationId', async (req, res) => {
  try {
    const validationId = String(req.params.validationId || '').trim();
    if (!validationId) return res.status(400).json({ error: 'validation_id is required' });

    const rec = await loadValidationRecord(validationId);
    if (!rec) return res.status(404).json({ error: 'Validation session not found' });

    let missing = [];
    try {
      const payload = JSON.parse(rec.payload_json || '{}');
      missing = payload.missing_parts || [];
    } catch {
      missing = [];
    }
    if (!missing.length) return res.status(404).json({ error: 'No missing parts for this validation' });

    const buf = buildMissingPartsWorkbook(missing);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="inbound-missing-parts-${validationId.slice(0, 8)}.xlsx"`
    );
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function receivingListFilters(query) {
  const clauses = [];
  const params = [];
  const lpo = String(query.lpo || '').trim();
  const sap_po = String(query.sap_po || '').trim();
  const invoice = String(query.invoice || query.invoice_number || '').trim();
  const part_number = String(query.part_number || query.part || '').trim();
  if (lpo) {
    clauses.push(`COALESCE(lpo,'') LIKE ?`);
    params.push(`%${lpo}%`);
  }
  if (sap_po) {
    clauses.push(`(COALESCE(sap_po,'') LIKE ? OR COALESCE(po_number,'') LIKE ?)`);
    params.push(`%${sap_po}%`, `%${sap_po}%`);
  }
  if (invoice) {
    clauses.push(`COALESCE(invoice_no,'') LIKE ?`);
    params.push(`%${invoice}%`);
  }
  if (part_number) {
    clauses.push(`part_number LIKE ?`);
    params.push(`%${part_number}%`);
  }
  return { clauses, params };
}

async function receivingFilterSuggestions(field, q, limit) {
  const lim = Math.min(50, Math.max(1, limit || 30));
  const like = q ? `%${q}%` : '%';
  if (field === 'lpo') {
    const rows = await dbAll(
      `SELECT DISTINCT TRIM(lpo) AS v FROM inbound_receiving
       WHERE TRIM(COALESCE(lpo,'')) != '' AND lpo LIKE ?
       ORDER BY v LIMIT ?`,
      [like, lim]
    );
    return (rows || []).map((r) => r.v).filter(Boolean);
  }
  if (field === 'sap_po') {
    const rows = await dbAll(
      `SELECT DISTINCT v FROM (
         SELECT TRIM(sap_po) AS v FROM inbound_receiving
         WHERE TRIM(COALESCE(sap_po,'')) != '' AND sap_po LIKE ?
         UNION
         SELECT TRIM(po_number) AS v FROM inbound_receiving
         WHERE TRIM(COALESCE(po_number,'')) != '' AND po_number LIKE ?
       ) u WHERE TRIM(COALESCE(v,'')) != ''
       ORDER BY v LIMIT ?`,
      [like, like, lim]
    );
    return (rows || []).map((r) => r.v).filter(Boolean);
  }
  if (field === 'invoice') {
    const rows = await dbAll(
      `SELECT DISTINCT TRIM(invoice_no) AS v FROM inbound_receiving
       WHERE TRIM(COALESCE(invoice_no,'')) != '' AND invoice_no LIKE ?
       ORDER BY v LIMIT ?`,
      [like, lim]
    );
    return (rows || []).map((r) => r.v).filter(Boolean);
  }
  if (field === 'part') {
    const rows = await dbAll(
      `SELECT DISTINCT TRIM(part_number) AS v FROM inbound_receiving
       WHERE TRIM(COALESCE(part_number,'')) != '' AND part_number LIKE ?
       ORDER BY v LIMIT ?`,
      [like, lim]
    );
    return (rows || []).map((r) => r.v).filter(Boolean);
  }
  return null;
}

router.get('/filter-suggestions', async (req, res) => {
  try {
    const field = String(req.query.field || '').trim().toLowerCase();
    const q = String(req.query.q || '').trim();
    const lim = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const values = await receivingFilterSuggestions(field, q, lim);
    if (values === null) return res.status(400).json({ error: 'field must be lpo, sap_po, invoice, or part' });
    res.json(values);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
    const { clauses, params } = receivingListFilters(req.query);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await dbAll(
      `SELECT * FROM inbound_receiving ${where} ORDER BY id DESC LIMIT ?`,
      [...params, limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Split "C779-C788 | Schneider" → batch + vendor */
function splitBatchVendor(batchVendorRaw) {
  const s = String(batchVendorRaw || '').trim();
  if (!s) return { batchKey: '—', batch_name: '—', vendor_name: '' };
  if (s.includes('|')) {
    const parts = s.split('|').map((x) => x.trim()).filter(Boolean);
    return {
      batchKey: s,
      batch_name: parts[0] || '—',
      vendor_name: parts.slice(1).join(' | ') || '',
    };
  }
  return { batchKey: s, batch_name: s, vendor_name: '' };
}

function shipmentFromRow(raw) {
  const lpo = String(
    pick(raw, 'Local PO', 'local po', 'local_po', 'LPO', 'lpo')
  ).trim();
  const sap_po = String(
    pick(
      raw,
      'SAP PO',
      'SAP PO.',
      'sap_po',
      'SAP Bill',
      'SAP Bill No.',
      'SAP Bill Number',
      'sap_bill',
      'PO Number',
      'po_number'
    )
  ).trim();
  const invoice_number = String(
    pick(
      raw,
      'Vendor Invoice',
      'Vendor Invoice Number',
      'Vendor Invoice No.',
      'vendor_invoice',
      'SAP Invoice Number',
      'SAP Invoice No.',
      'SAP Invoice No',
      'Invoice Number',
      'Invoice No.',
      'Invoice No',
      'invoice_no',
      'invoice_number'
    )
  ).trim();
  return {
    lpo: lpo || null,
    sap_po: sap_po || null,
    invoice_number: invoice_number || null,
  };
}

async function insertInboundBatchRow({
  batch_name,
  vendor_name,
  upload_date,
  created_by,
  warehouse_id,
  lpo,
  sap_po,
  invoice_number,
}) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO inbound_batches (
         batch_name, vendor_name, upload_date, status, created_by, warehouse_id, lpo, sap_po, invoice_number, created_at
       ) VALUES (?, ?, ?, 'Pending', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        batch_name,
        vendor_name || null,
        upload_date,
        created_by || null,
        warehouse_id || null,
        lpo || null,
        sap_po || null,
        invoice_number || null,
      ],
      function onInsert(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * Group rows by Batch/Vendor Name, unique part numbers with summed qty per group.
 * Creates inbound_batches + inbound_items; audit rows in inbound_receiving; updates main_stock once per part qty.
 */
async function processInboundRows(rows, uploadedBy, warehouseId, req = null) {
  const results = [];
  const normalized = [];
  for (const raw of normalizeExcelRows(rows || [])) {
    const batch_vendor_name = String(pick(raw, 'Batch/Vendor Name', 'batch_vendor_name')).trim();
    const ship = shipmentFromRow(raw);
    const invoice_no = ship.invoice_number || '';
    const po_number = ship.sap_po || '';
    const part_number = String(pick(raw, 'Part Number', 'part_number')).trim();
    const sap_part_number = String(pick(raw, 'SAP Part Number', 'sap_part_number')).trim();
    const description = String(pick(raw, 'Description', 'description')).trim();
    const inbound_qty = toNum(pick(raw, 'Inbound Qty', 'inbound_qty'));
    const received_date = String(pick(raw, 'Received Date', 'received_date')).trim();
    const remarks = String(pick(raw, 'Remarks', 'remarks')).trim();

    if (!part_number) {
      results.push({ ok: false, error: 'Missing Part Number', raw });
      continue;
    }
    if (!(inbound_qty > 0)) {
      results.push({ ok: false, error: 'Inbound Qty must be > 0', part_number });
      continue;
    }
    normalized.push({
      batch_vendor_name: batch_vendor_name || '—',
      lpo: ship.lpo || '',
      sap_po: ship.sap_po || '',
      invoice_no,
      po_number,
      part_number,
      sap_part_number,
      description,
      inbound_qty,
      received_date,
      remarks,
    });
  }

  const groups = new Map();
  for (const r of normalized) {
    const key = r.batch_vendor_name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const upload_date = new Date().toISOString().slice(0, 10);

  for (const [batchKey, groupRows] of groups) {
    const { batch_name, vendor_name } = splitBatchVendor(batchKey);

    const partMap = new Map();
    for (const r of groupRows) {
      const pn = r.part_number;
      const cur = partMap.get(pn);
      if (!cur) {
        partMap.set(pn, {
          part_number: pn,
          sap_part_number: r.sap_part_number,
          description: r.description,
          inbound_qty: r.inbound_qty,
          lpo: r.lpo,
          sap_po: r.sap_po,
          invoice_no: r.invoice_no,
          po_number: r.po_number,
          received_date: r.received_date,
          remarks: r.remarks,
        });
      } else {
        cur.inbound_qty += r.inbound_qty;
        if (!cur.sap_part_number && r.sap_part_number) cur.sap_part_number = r.sap_part_number;
        if (!cur.description && r.description) cur.description = r.description;
      }
    }

    const headRow = groupRows[0] || {};
    const batchShipment = {
      lpo: headRow.lpo || null,
      sap_po: headRow.sap_po || null,
      invoice_number: headRow.invoice_no || null,
    };

    try {
      await dbRun('BEGIN IMMEDIATE');
      const batchId = await insertInboundBatchRow({
        batch_name,
        vendor_name,
        upload_date,
        created_by: uploadedBy,
        warehouse_id: warehouseId,
        ...batchShipment,
      });
      if (!batchId) throw new Error('Failed to create inbound batch');

      for (const agg of partMap.values()) {
        const totalQty = agg.inbound_qty;
        const sap = String(agg.sap_part_number || '').trim() || agg.part_number;
        const desc = String(agg.description || '').trim();

        await dbRun(
          `INSERT INTO inbound_items
            (inbound_batch_id, part_number, sap_part_number, description, total_qty, putaway_qty, remaining_qty, status, created_at, updated_at, warehouse_id)
           VALUES (?, ?, ?, ?, ?, 0, ?, 'Pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
          [batchId, agg.part_number, sap || null, desc || null, totalQty, totalQty, warehouseId]
        );

        await dbRun(
          `INSERT INTO inbound_receiving
            (batch_vendor_name, lpo, sap_po, invoice_no, po_number, part_number, sap_part_number, description,
             inbound_qty, received_date, remarks, uploaded_by, warehouse_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            batchKey,
            agg.lpo || batchShipment.lpo || null,
            agg.sap_po || batchShipment.sap_po || null,
            agg.invoice_no || batchShipment.invoice_number || null,
            agg.po_number || batchShipment.sap_po || null,
            agg.part_number,
            sap || null,
            desc || null,
            totalQty,
            agg.received_date || null,
            agg.remarks || null,
            uploadedBy || null,
            warehouseId,
          ]
        );

        await incrementReceivedOnDb(db, agg.part_number, totalQty, {
          vendor_name: vendor_name || batch_name || null,
          sap_part_number: sap,
          description: desc,
          remarks: agg.remarks || null,
          warehouse_id: warehouseId,
        });

        results.push({
          ok: true,
          part_number: agg.part_number,
          inbound_qty: totalQty,
          inbound_batch_id: batchId,
          batch_name,
          vendor_name,
        });
      }

      await dbRun('COMMIT');

      const partCount = partMap.size;
      const label = [batch_name, vendor_name].filter(Boolean).join(' | ') || batchKey;
      const body = `${label} — ${partCount} part line(s) ready for rack putaway.`;
      logAudit({
        warehouse_id: warehouseId,
        user: req?.user || (uploadedBy ? { sub: uploadedBy } : null),
        req,
        module_name: 'INBOUND',
        action_type: 'INBOUND_UPLOADED',
        reference_type: 'inbound_batch',
        reference_id: batchId,
        reference_number: label,
        status_after: 'Pending',
        new_value: { parts: partCount, batch_name, vendor_name: vendor_name || null },
      });
      try {
        await notifyInboundPutaway('New inbound — putaway', body, {
          type: 'inbound_putaway',
          inbound_batch_id: batchId,
          batch_name,
          vendor_name: vendor_name || '',
          warehouse_id: warehouseId,
        });
      } catch (notifyErr) {
        console.error('Inbound putaway notification:', notifyErr?.message || notifyErr);
      }
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => {});
      for (const agg of partMap.values()) {
        results.push({ ok: false, error: err.message, part_number: agg.part_number, batch: batchKey });
      }
    }
  }

  return results;
}

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const validationId = String(req.body?.validation_id || '').trim();
    if (!validationId) {
      return res.status(400).json({
        error: 'validation_id is required. Validate the file first (POST /api/inbound/validate-upload).',
        reject_message: REJECT_MESSAGE,
      });
    }

    const userId = req.user?.sub ?? null;
    const warehouseId = await resolveWarehouseIdForRequest({
      userId,
      role: req.user?.role,
      explicitWarehouseId: req.body?.warehouse_id ?? req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id could not be resolved' });

    const { payload } = await assertValidationApproved(validationId, { userId, warehouseId });
    await revalidateStoredRows(payload, warehouseId);

    const rows = validatedRowsToProcessInput(payload.rows);
    if (!rows.length) return res.status(400).json({ error: 'No rows in validated session' });

    const results = await processInboundRows(rows, userId, warehouseId, req);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      return res.status(400).json({
        error: 'Inbound processing failed for some rows',
        success: results.filter((r) => r.ok).length,
        total: results.length,
        results,
      });
    }

    await dbRun(
      `UPDATE inbound_upload_validations SET status = 'consumed' WHERE validation_id = ?`,
      [validationId]
    );

    const ok = results.filter((r) => r.ok).length;
    res.json({ success: ok, total: results.length, results, validation_id: validationId });
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({
      error: e.message,
      reject_message: e.validation ? REJECT_MESSAGE : undefined,
      validation: e.validation || undefined,
    });
  }
});

router.post('/bulk-paste', async (req, res) => {
  try {
    const validationId = String(req.body?.validation_id || '').trim();
    if (!validationId) {
      return res.status(400).json({
        error: 'validation_id is required. Validate paste data first (POST /api/inbound/validate-upload with file or validate client-side).',
      });
    }

    const userId = req.user?.sub ?? null;
    const warehouseId = await resolveWarehouseIdForRequest({
      userId,
      role: req.user?.role,
      explicitWarehouseId: req.body?.warehouse_id ?? req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id could not be resolved' });

    const { payload } = await assertValidationApproved(validationId, { userId, warehouseId });
    await revalidateStoredRows(payload, warehouseId);
    const rows = validatedRowsToProcessInput(payload.rows);
    const results = await processInboundRows(rows, userId, warehouseId, req);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      return res.status(400).json({ error: 'Inbound processing failed', results });
    }
    await dbRun(
      `UPDATE inbound_upload_validations SET status = 'consumed' WHERE validation_id = ?`,
      [validationId]
    );
    const ok = results.filter((r) => r.ok).length;
    res.json({ success: ok, total: results.length, results });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

router.get('/putaway-report', async (req, res) => {
  try {
    const { batch, vendor, from, to, status } = req.query;
    const params = [];
    let sql = `
      SELECT
        b.id AS batch_id,
        b.batch_name,
        b.vendor_name,
        b.upload_date,
        b.status AS batch_status,
        b.lpo,
        b.sap_po,
        b.invoice_number,
        i.id AS inbound_item_id,
        i.part_number,
        i.sap_part_number,
        i.description,
        i.total_qty,
        i.putaway_qty,
        i.remaining_qty,
        i.status AS item_status,
        i.updated_at AS last_updated,
        (SELECT COUNT(*) FROM inbound_putaway_lines pl WHERE pl.inbound_item_id = i.id AND pl.applied_to_rack = 0) AS pending_lines
      FROM inbound_items i
      JOIN inbound_batches b ON b.id = i.inbound_batch_id
      WHERE 1=1
    `;
    if (batch) {
      sql += ` AND (b.batch_name LIKE ? OR CAST(b.id AS TEXT) = ?)`;
      params.push(`%${String(batch).trim()}%`, String(batch).trim());
    }
    if (vendor) {
      sql += ` AND COALESCE(b.vendor_name,'') LIKE ?`;
      params.push(`%${String(vendor).trim()}%`);
    }
    if (from) {
      sql += ` AND date(COALESCE(b.upload_date, b.created_at)) >= date(?)`;
      params.push(from);
    }
    if (to) {
      sql += ` AND date(COALESCE(b.upload_date, b.created_at)) <= date(?)`;
      params.push(to);
    }
    if (status) {
      sql += ` AND i.status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY b.id DESC, i.part_number`;
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/apply-putaway-to-rack', async (req, res) => {
  try {
    const ids = req.body?.inbound_item_ids;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'inbound_item_ids required' });

    let applied = 0;
    await dbRun('BEGIN IMMEDIATE');
    for (const rawId of ids) {
      const item = await dbGet(`SELECT * FROM inbound_items WHERE id = ?`, [Number(rawId)]);
      if (!item) continue;
      const lines = await dbAll(
        `SELECT * FROM inbound_putaway_lines WHERE inbound_item_id = ? AND applied_to_rack = 0 ORDER BY id`,
        [item.id]
      );
      for (const line of lines) {
        await applyStockIn(
          db,
          {
            transaction_date: line.transaction_date,
            part_number: line.part_number,
            sap_part_number: item.sap_part_number,
            description: item.description || '',
            rack_location: line.rack_location,
            qty_in: line.qty,
            source_type: 'putaway_inbound',
            reference_no: `INB-${item.inbound_batch_id}-IT-${item.id}`,
            remarks: line.remarks || '',
          },
          { updateExisting: false }
        );
        await dbRun(`UPDATE inbound_putaway_lines SET applied_to_rack = 1 WHERE id = ?`, [line.id]);
        applied += 1;
      }
    }
    await dbRun('COMMIT');
    let whPut = null;
    const firstId = ids.map(Number).find((n) => n > 0);
    if (firstId) {
      const it0 = await dbGet(`SELECT ib.warehouse_id FROM inbound_items ii JOIN inbound_batches ib ON ib.id = ii.inbound_batch_id WHERE ii.id = ?`, [firstId]);
      whPut = it0?.warehouse_id ?? null;
    }
    logAudit({
      warehouse_id: whPut,
      req,
      module_name: 'PUTAWAY',
      action_type: 'PUTAWAY_COMPLETED',
      reference_type: 'inbound_batch',
      reference_id: null,
      reference_number: `lines:${applied}`,
      remarks: `apply_putaway_to_rack items=${ids.length}`,
      new_value: { inbound_item_ids: ids.slice(0, 50), lines_applied: applied },
    });
    res.json({ ok: true, lines_applied: applied });
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
