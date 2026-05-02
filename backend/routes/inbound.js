const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { promisify } = require('util');

const db = require('../db');
const { incrementReceivedOnDb } = require('../services/mainStockSharedSql');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const { applyStockIn } = require('./stock-in');
const { normalizeExcelRows } = require('../utils/excelDates');
const { notifyInboundPutaway } = require('../services/notificationService');

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

function templateRows() {
  return [
    {
      'Batch/Vendor Name': 'C779-C788',
      'Invoice No.': '9010104400',
      'PO Number': '5500001206',
      'Part Number': '760241056',
      'SAP Part Number': '760241056',
      Description: 'O-012-LN-8W-M12BK/2C',
      'Inbound Qty': 2046,
      'Received Date': '2026-05-01',
      Remarks: 'Receiving upload',
    },
  ];
}

router.get('/template', (_req, res) => {
  const ws = XLSX.utils.json_to_sheet(templateRows());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inbound');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="inbound-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
    const rows = await dbAll(`SELECT * FROM inbound_receiving ORDER BY id DESC LIMIT ?`, [limit]);
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

async function insertInboundBatchRow({ batch_name, vendor_name, upload_date, created_by }) {
  await dbRun(
    `INSERT INTO inbound_batches (batch_name, vendor_name, upload_date, status, created_by, created_at)
     VALUES (?, ?, ?, 'Pending', ?, CURRENT_TIMESTAMP)`,
    [batch_name, vendor_name || null, upload_date, created_by || null]
  );
  const row = await dbGet('SELECT last_insert_rowid() AS id');
  return row?.id;
}

/**
 * Group rows by Batch/Vendor Name, unique part numbers with summed qty per group.
 * Creates inbound_batches + inbound_items; audit rows in inbound_receiving; updates main_stock once per part qty.
 */
async function processInboundRows(rows, uploadedBy) {
  const results = [];
  const normalized = [];
  for (const raw of normalizeExcelRows(rows || [])) {
    const batch_vendor_name = String(pick(raw, 'Batch/Vendor Name', 'batch_vendor_name')).trim();
    const invoice_no = String(pick(raw, 'Invoice No.', 'Invoice No', 'invoice_no')).trim();
    const po_number = String(pick(raw, 'PO Number', 'po_number')).trim();
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

    try {
      await dbRun('BEGIN IMMEDIATE');
      const batchId = await insertInboundBatchRow({
        batch_name,
        vendor_name,
        upload_date,
        created_by: uploadedBy,
      });
      if (!batchId) throw new Error('Failed to create inbound batch');

      for (const agg of partMap.values()) {
        const totalQty = agg.inbound_qty;
        const sap = String(agg.sap_part_number || '').trim() || agg.part_number;
        const desc = String(agg.description || '').trim();

        await dbRun(
          `INSERT INTO inbound_items
            (inbound_batch_id, part_number, sap_part_number, description, total_qty, putaway_qty, remaining_qty, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, 'Pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [batchId, agg.part_number, sap || null, desc || null, totalQty, totalQty]
        );

        await dbRun(
          `INSERT INTO inbound_receiving
            (batch_vendor_name, invoice_no, po_number, part_number, sap_part_number, description,
             inbound_qty, received_date, remarks, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            batchKey,
            agg.invoice_no || null,
            agg.po_number || null,
            agg.part_number,
            sap || null,
            desc || null,
            totalQty,
            agg.received_date || null,
            agg.remarks || null,
            uploadedBy || null,
          ]
        );

        await incrementReceivedOnDb(db, agg.part_number, totalQty, {
          vendor_name: vendor_name || batch_name || null,
          sap_part_number: sap,
          description: desc,
          remarks: agg.remarks || null,
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
      try {
        await notifyInboundPutaway('New inbound — putaway', body, {
          type: 'inbound_putaway',
          inbound_batch_id: batchId,
          batch_name,
          vendor_name: vendor_name || '',
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
    if (!req.file?.buffer) return res.status(400).json({ error: 'file is required' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'Empty sheet' });
    const userId = req.user?.sub ?? null;
    const results = await processInboundRows(rows, userId);
    const ok = results.filter((r) => r.ok).length;
    res.json({ success: ok, total: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/bulk-paste', async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'data must be an array of rows' });
    const userId = req.user?.sub ?? null;
    const results = await processInboundRows(data, userId);
    const ok = results.filter((r) => r.ok).length;
    res.json({ success: ok, total: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.json({ ok: true, lines_applied: applied });
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
