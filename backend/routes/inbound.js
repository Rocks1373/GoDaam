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

async function processInboundRows(rows, uploadedBy) {
  const results = [];
  for (const raw of rows) {
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

    try {
      await dbRun('BEGIN IMMEDIATE');
      await dbRun(
        `INSERT INTO inbound_receiving
          (batch_vendor_name, invoice_no, po_number, part_number, sap_part_number, description,
           inbound_qty, received_date, remarks, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batch_vendor_name || null,
          invoice_no || null,
          po_number || null,
          part_number,
          sap_part_number || null,
          description || null,
          inbound_qty,
          received_date || null,
          remarks || null,
          uploadedBy || null,
        ]
      );
      await incrementReceivedOnDb(db, part_number, inbound_qty, {
        vendor_name: batch_vendor_name || null,
        sap_part_number: sap_part_number || part_number,
        description: description || '',
        remarks: remarks || null,
      });
      await dbRun('COMMIT');
      results.push({ ok: true, part_number, inbound_qty });
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => {});
      results.push({ ok: false, error: err.message, part_number });
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

module.exports = router;
