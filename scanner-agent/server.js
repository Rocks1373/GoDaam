/**
 * Local Scanner Agent — runs on the PC attached to the scanner.
 *
 * - Listens only on 127.0.0.1 (browser on same machine POSTs scan jobs).
 * - Does not store SCANNER_AGENT_TOKEN in the web app; configure .env here only.
 *
 * Configure:
 *   GODAM_API_BASE=https://your-server.example.com/api
 *   SCANNER_AGENT_TOKEN=<same as server SCANNER_AGENT_TOKEN>
 *   GODAM_SCAN_COMMAND=... command that produces a PDF at {output}, e.g. NAPS2 CLI
 *   Or GODAM_ALLOW_MOCK_SCAN=1 for a blank one-page PDF (dev only)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const FormData = require('form-data');

const execP = promisify(exec);

const PORT = Number(process.env.GODAM_SCANNER_LISTEN_PORT || 38471);
const API_BASE = String(process.env.GODAM_API_BASE || '').replace(/\/$/, '');
const TOKEN = String(process.env.SCANNER_AGENT_TOKEN || '').trim();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'godam-scanner-agent', hasToken: Boolean(TOKEN), hasApiBase: Boolean(API_BASE) });
});

app.post('/v1/scan-job', async (req, res) => {
  if (!API_BASE || !TOKEN) {
    return res.status(503).json({ error: 'Set GODAM_API_BASE and SCANNER_AGENT_TOKEN in scanner-agent/.env' });
  }
  const body = req.body || {};
  const warehouse_id = body.warehouse_id;
  const sales_order_number = String(body.sales_order_number || '').trim();
  const document_type = String(body.document_type || '').trim().toUpperCase();
  if (warehouse_id == null || warehouse_id === '' || !sales_order_number || !document_type) {
    return res.status(400).json({ error: 'warehouse_id, sales_order_number, and document_type are required' });
  }

  let pdfPath;
  try {
    pdfPath = await runScanToPdf();
  } catch (e) {
    return res.status(500).json({ error: 'Scan failed: ' + e.message });
  }

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(pdfPath), { filename: 'scan.pdf', contentType: 'application/pdf' });
    form.append('warehouse_id', String(warehouse_id));
    form.append('sales_order_number', sales_order_number);
    form.append('document_type', document_type);
    form.append('upload_source', 'scanner');

    const optFields = [
      'outbound_number',
      'dn_number',
      'invoice_number',
      'customer_po_number',
      'accounting_document_number',
      'gapp_po',
      'customer_name',
      'pod_type',
    ];
    for (const k of optFields) {
      if (body[k] != null && String(body[k]).trim() !== '') {
        form.append(k, String(body[k]).trim());
      }
    }

    const uploadUrl = `${API_BASE}/scanner-agent/sales-order-documents/upload`;
    const r = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        'X-Scanner-Agent-Token': TOKEN,
        'X-Upload-Source': 'scanner',
      },
      body: form,
    });
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      j = { error: text || r.statusText };
    }
    if (!r.ok) {
      return res.status(r.status).json(j);
    }
    return res.status(201).json({ ok: true, backend: j });
  } finally {
    try {
      fs.unlinkSync(pdfPath);
    } catch {
      /* ignore */
    }
  }
});

async function runScanToPdf() {
  const outDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPdf = path.join(outDir, `scan-${Date.now()}.pdf`);

  const cmdTpl = String(process.env.GODAM_SCAN_COMMAND || '').trim();
  if (cmdTpl) {
    const cmd = cmdTpl.includes('{output}') ? cmdTpl.replace(/\{output\}/g, outPdf) : `${cmdTpl} "${outPdf}"`;
    await execP(cmd, { timeout: 180000, maxBuffer: 50 * 1024 * 1024 });
    if (!fs.existsSync(outPdf)) {
      throw new Error('GODAM_SCAN_COMMAND did not create output PDF: ' + outPdf);
    }
    return outPdf;
  }

  if (String(process.env.GODAM_ALLOW_MOCK_SCAN) === '1') {
    const { PDFDocument } = require('pdf-lib');
    const pdf = await PDFDocument.create();
    pdf.addPage([595.28, 841.89]);
    const bytes = await pdf.save();
    fs.writeFileSync(outPdf, Buffer.from(bytes));
    return outPdf;
  }

  throw new Error(
    'Set GODAM_SCAN_COMMAND (shell; use {output} for PDF path) or GODAM_ALLOW_MOCK_SCAN=1. See README.'
  );
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`GoDam scanner agent on http://127.0.0.1:${PORT} (health: /health)`);
});
