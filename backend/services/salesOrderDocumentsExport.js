const { promisify } = require('util');
const archiver = require('archiver');
const { PDFDocument } = require('pdf-lib');

const db = require('../db');
const { downloadDocument } = require('./cloudStorage/cloudStorageProvider');

const dbAll = promisify(db.all.bind(db));

/** Merge order: accounting → invoice → delivery note → customer PO → POD (parallel business trio first). */
const DOCUMENT_TYPE_RANK = [
  'ACCOUNTING_DOCUMENT',
  'INVOICE',
  'DELIVERY_NOTE',
  'CUSTOMER_PO',
  'POD',
  'SIGNED_POD',
  'OTHER',
];

function typeRank(documentType) {
  const u = String(documentType || '').toUpperCase();
  const i = DOCUMENT_TYPE_RANK.indexOf(u);
  return i === -1 ? 999 : i;
}

async function listExportableDocuments(warehouseId, salesOrderNumber) {
  const wid = Number(warehouseId);
  const so = String(salesOrderNumber || '').trim();
  const rows = await dbAll(
    `SELECT d.*
     FROM sales_order_documents d
     WHERE d.warehouse_id = ?
       AND TRIM(d.sales_order_number) = TRIM(?)
       AND d.upload_status = 'UPLOADED'
       AND TRIM(COALESCE(d.cloud_file_id, '')) != ''`,
    [wid, so]
  );
  const list = rows || [];
  list.sort((a, b) => {
    const tr = typeRank(a.document_type) - typeRank(b.document_type);
    if (tr !== 0) return tr;
    const da = String(a.uploaded_at || '');
    const db_ = String(b.uploaded_at || '');
    if (da !== db_) return da < db_ ? -1 : da > db_ ? 1 : 0;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
  return list;
}

function isPdfMime(mimeType) {
  return String(mimeType || '').toLowerCase().split(';')[0].trim() === 'application/pdf';
}

function looksLikePdfBuffer(buf) {
  if (!buf || buf.length < 5) return false;
  return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

async function mergePdfBuffers(buffers) {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  const bytes = await out.save();
  return Buffer.from(bytes);
}

/**
 * @returns {Promise<{ buffer: Buffer, mergedCount: number, skippedNonPdf: number }>}
 */
async function buildCombinedPdfForSalesOrder(warehouseId, salesOrderNumber) {
  const docs = await listExportableDocuments(warehouseId, salesOrderNumber);
  if (!docs.length) {
    const err = new Error('No uploaded documents with a cloud file to export.');
    err.code = 'NO_DOCS';
    throw err;
  }
  const pdfBuffers = [];
  let skippedNonPdf = 0;
  for (const d of docs) {
    const buf = await downloadDocument(d.cloud_file_id);
    if (isPdfMime(d.mime_type) || looksLikePdfBuffer(buf)) {
      pdfBuffers.push(buf);
    } else {
      skippedNonPdf += 1;
    }
  }
  if (!pdfBuffers.length) {
    const err = new Error('No PDF files found to merge (non-PDF documents were skipped).');
    err.code = 'NO_PDF';
    throw err;
  }
  const buffer = await mergePdfBuffers(pdfBuffers);
  return { buffer, mergedCount: pdfBuffers.length, skippedNonPdf, totalListed: docs.length };
}

function safeZipEntryName(storedFileName, id) {
  let s = String(storedFileName || 'document').replace(/[/\\]/g, '_').replace(/\.\./g, '_');
  s = s.slice(0, 200) || `doc_${id}`;
  return s;
}

/**
 * Pipe a ZIP of all exportable files to Express res (set headers before calling).
 * @returns {Promise<{ entryCount: number }>}
 */
async function streamIndividualZipForSalesOrder(warehouseId, salesOrderNumber, res, filenameBase) {
  const docs = await listExportableDocuments(warehouseId, salesOrderNumber);
  if (!docs.length) {
    const err = new Error('No uploaded documents with a cloud file to export.');
    err.code = 'NO_DOCS';
    throw err;
  }

  const usedNames = new Set();
  const entries = [];
  for (const d of docs) {
    try {
      const buf = await downloadDocument(d.cloud_file_id);
      let name = safeZipEntryName(d.stored_file_name, d.id);
      let candidate = name;
      let n = 0;
      while (usedNames.has(candidate)) {
        n += 1;
        candidate = `${d.id}_${n}_${name}`;
      }
      usedNames.add(candidate);
      entries.push({ name: candidate, buf });
    } catch {
      /* skip file on download failure */
    }
  }
  if (!entries.length) {
    const err = new Error('All document downloads failed.');
    err.code = 'NO_ENTRIES';
    throw err;
  }

  const base =
    String(filenameBase || 'SO')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 140) || 'SO';
  const zipName = `${base}_documents.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${zipName}"; filename*=UTF-8''${encodeURIComponent(zipName)}`
  );

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', () => {
    try {
      if (!res.headersSent) res.status(500).end();
    } catch {
      /* ignore */
    }
  });

  archive.pipe(res);
  for (const e of entries) {
    archive.append(e.buf, { name: e.name });
  }
  await archive.finalize();
  return { entryCount: entries.length };
}

module.exports = {
  listExportableDocuments,
  buildCombinedPdfForSalesOrder,
  streamIndividualZipForSalesOrder,
  mergePdfBuffers,
  isPdfMime,
  looksLikePdfBuffer,
  DOCUMENT_TYPE_RANK,
};
