const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const { promisify } = require('util');

const db = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

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

function normStatus(s) {
  return String(s || '').trim().toLowerCase();
}

function makeDedupeKey(parts) {
  const base = parts.map((x) => String(x ?? '').trim()).join('|');
  return `sold-out:${crypto.createHash('sha256').update(base).digest('hex').slice(0, 48)}`;
}

function templateRows() {
  return [
    {
      DATE: '2023-07-18',
      PO: '15001789',
      'CUSTOMER PO': '3419',
      'Invoice No.': '90005242',
      Invoice: '90005242',
      'Customer Name': 'Madar Information',
      'Delivery Address': 'Makkah - Jeddah',
      GPS: 'https://goo.gl/example',
      'Part Number': '1671000-8',
      'SAP Part Number': '1671000-8',
      Description: '10ENC_SLID',
      'Outbound Qty': 10,
      Delivery: '80019130',
      'Sales Doc': '50012345',
      Status: 'Delivered',
      Remarks: '-',
    },
  ];
}

router.get('/template', (_req, res) => {
  const ws = XLSX.utils.json_to_sheet(templateRows());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Outbound');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="outbound-sold-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(3000, Math.max(1, Number(req.query.limit) || 1000));
    const rows = await dbAll(`SELECT * FROM sold_out ORDER BY id DESC LIMIT ?`, [limit]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function applyDeliveredDeduction(part_number, outboundQty, shortageWarnings) {
  const pn = String(part_number || '').trim();
  const qty = toNum(outboundQty);
  if (!pn || !(qty > 0)) return false;

  const ms = await dbGet('SELECT * FROM main_stock WHERE part_number = ?', [pn]);
  const avail = ms ? toNum(ms.available_qty) : 0;
  if (avail < qty) {
    shortageWarnings.push({ part_number: pn, outbound_qty: qty, available_qty: avail, shortage_qty: qty - avail });
    return false;
  }

  await dbRun(
    `UPDATE main_stock SET
       sold_out_qty = COALESCE(sold_out_qty, 0) + ?,
       issued_qty = COALESCE(issued_qty, 0) + ?,
       available_qty = received_qty - (COALESCE(sold_out_qty, 0) + ?) - COALESCE(pending_delivery_qty, 0),
       last_updated = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     WHERE part_number = ?`,
    [qty, qty, qty, pn]
  );
  return true;
}

async function processSoldOutRows(rows, { applyDelivered = true } = {}) {
  const results = [];
  const shortageWarnings = [];

  for (const raw of rows) {
    const date = String(pick(raw, 'DATE', 'date')).trim();
    const po = String(pick(raw, 'PO', 'po')).trim();
    const customer_po = String(pick(raw, 'CUSTOMER PO', 'Customer PO', 'customer_po')).trim();
    const invoice_no = String(pick(raw, 'Invoice No.', 'Invoice No', 'invoice_no')).trim();
    const invoice = String(pick(raw, 'Invoice', 'invoice')).trim();
    const customer_name = String(pick(raw, 'Customer Name', 'customer_name')).trim();
    const delivery_address = String(pick(raw, 'Delivery Address', 'delivery_address')).trim();
    const gps = String(pick(raw, 'GPS', 'gps')).trim();
    const part_number = String(pick(raw, 'Part Number', 'part_number')).trim();
    const sap_part_number = String(pick(raw, 'SAP Part Number', 'sap_part_number')).trim();
    const description = String(pick(raw, 'Description', 'description')).trim();
    const outbound_qty = toNum(pick(raw, 'Outbound Qty', 'outbound_qty'));
    const delivery = String(pick(raw, 'Delivery', 'delivery')).trim();
    const sales_doc = String(pick(raw, 'Sales Doc', 'Sales Doc.', 'sales_doc')).trim();
    const statusRaw = String(pick(raw, 'Status', 'status')).trim();
    const remarks = String(pick(raw, 'Remarks', 'remarks')).trim();

    if (!part_number) {
      results.push({ ok: false, error: 'Missing Part Number', raw });
      continue;
    }
    if (!(outbound_qty > 0)) {
      results.push({ ok: false, error: 'Outbound Qty must be > 0', part_number });
      continue;
    }

    const dedupeKey = makeDedupeKey([date, po, customer_po, invoice_no, part_number, outbound_qty, delivery, sales_doc, statusRaw]);

    const dup = await dbGet('SELECT id FROM sold_out WHERE dedupe_key = ?', [dedupeKey]);
    if (dup?.id) {
      results.push({ ok: false, skipped: true, reason: 'duplicate row (dedupe_key)', part_number });
      continue;
    }

    try {
      await dbRun('BEGIN IMMEDIATE');
      await dbRun(
        `INSERT INTO sold_out
          (date, po, gapp_po, customer_po, invoice_number, invoice, customer_name, delivery_address, gps,
           part_number, sap_part_number, description, sold_qty, outbound_qty, delivery, sales_doc, status, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          date || null,
          po || null,
          po || null,
          customer_po || null,
          invoice_no || null,
          invoice || invoice_no || null,
          customer_name || null,
          delivery_address || null,
          gps || null,
          part_number,
          sap_part_number || null,
          description || null,
          outbound_qty,
          outbound_qty,
          delivery || null,
          sales_doc || null,
          statusRaw || null,
          dedupeKey,
        ]
      );

      let deducted = false;
      if (applyDelivered && normStatus(statusRaw) === 'delivered') {
        deducted = await applyDeliveredDeduction(part_number, outbound_qty, shortageWarnings);
      }

      await dbRun('COMMIT');
      results.push({ ok: true, part_number, outbound_qty, status: statusRaw, main_stock_deducted: deducted });
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => {});
      results.push({ ok: false, error: err.message, part_number });
    }
  }

  return { results, shortageWarnings };
}

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'file is required' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return res.status(400).json({ error: 'Empty sheet' });
    const { results, shortageWarnings } = await processSoldOutRows(rows);
    const ok = results.filter((r) => r.ok).length;
    res.json({
      success: ok,
      total: results.length,
      results,
      shortage_warnings: shortageWarnings.length ? shortageWarnings : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/bulk-paste', async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'data must be an array of rows' });
    const { results, shortageWarnings } = await processSoldOutRows(data);
    const ok = results.filter((r) => r.ok).length;
    res.json({
      success: ok,
      total: results.length,
      results,
      shortage_warnings: shortageWarnings.length ? shortageWarnings : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
