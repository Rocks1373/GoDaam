const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { promisify } = require('util');

const db = require('../db');
const { requireAnyPermission } = require('../middleware/auth');
const { requireWarehouseAccess } = require('../middleware/warehouseAccess');
const { resolveWarehouseIdForRequest, userHasWarehouseAccess } = require('../services/warehouseContext');
const {
  uploadDocumentFlow,
  verifyDocument,
  getStatusPayload,
  saveDeliveryNotePdfToDrive,
  listDocumentsByOutbound,
  listDocumentsByInvoice,
  buildDownloadOptions,
  exportManifest,
  DOC_TYPES,
} = require('../services/salesOrderDocumentsService');
const { mapDocumentWithValidation } = require('../services/salesOrderDocumentValidation');
const { handleSalesOrderDocumentUpload } = require('../lib/salesOrderDocumentUploadHandler');
const {
  buildCombinedPdfForSalesOrder,
  streamIndividualZipForSalesOrder,
} = require('../services/salesOrderDocumentsExport');

const router = express.Router();
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

const TEMP_ROOT = path.join(__dirname, '..', 'uploads', 'sales-order-docs-temp');
if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });

const upload = multer({ dest: TEMP_ROOT, limits: { fileSize: 25 * 1024 * 1024 } });

function decodeSoParam(raw) {
  try {
    return decodeURIComponent(String(raw || '').trim());
  } catch {
    return String(raw || '').trim();
  }
}

function exportAttachmentBaseName(salesOrderNumber) {
  return (
    decodeSoParam(salesOrderNumber)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 80) || 'SO'
  );
}

function combinedExportBaseName(salesOrderNumber, customerPoNumber) {
  const so = exportAttachmentBaseName(salesOrderNumber);
  const po = String(customerPoNumber || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 60);
  if (po) return `${so}_PO_${po}`;
  return so;
}

function canVerifyDocuments(req) {
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'checker') return true;
  return !!(req.user?.permissions && req.user.permissions.can_confirm_picked);
}

router.use(requireAnyPermission(['can_view_orders', 'can_upload_outbound', 'can_confirm_picked']));

router.post(
  '/upload',
  requireAnyPermission(['can_upload_outbound', 'can_confirm_picked']),
  upload.single('file'),
  async (req, res) => {
    await handleSalesOrderDocumentUpload(req, res, { fromScannerAgent: false });
  }
);

router.get(
  '/report',
  requireWarehouseAccess((req) =>
    resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    })
  ),
  async (req, res) => {
    try {
      const wid = Number(
        await resolveWarehouseIdForRequest({
          userId: req.user.sub,
          role: req.user.role,
          explicitWarehouseId: req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
        })
      );
      const clauses = ['d.warehouse_id = ?'];
      const params = [wid];
      const q = (k) => String(req.query[k] || '').trim();

      if (q('sales_order_number')) {
        clauses.push(`TRIM(d.sales_order_number) = TRIM(?)`);
        params.push(q('sales_order_number'));
      }
      if (q('outbound_number')) {
        clauses.push(`TRIM(COALESCE(d.outbound_number,'')) LIKE ?`);
        params.push(`%${q('outbound_number')}%`);
      }
      if (q('invoice_number')) {
        clauses.push(`TRIM(COALESCE(d.invoice_number,'')) LIKE ?`);
        params.push(`%${q('invoice_number')}%`);
      }
      if (q('dn_number')) {
        clauses.push(`TRIM(COALESCE(d.dn_number,'')) LIKE ?`);
        params.push(`%${q('dn_number')}%`);
      }
      if (q('customer_po_number')) {
        clauses.push(`TRIM(COALESCE(d.customer_po_number,'')) LIKE ?`);
        params.push(`%${q('customer_po_number')}%`);
      }
      if (q('document_type')) {
        clauses.push(`d.document_type = ?`);
        params.push(q('document_type').toUpperCase());
      }
      if (q('upload_status')) {
        clauses.push(`d.upload_status = ?`);
        params.push(q('upload_status').toUpperCase());
      }
      if (q('verification_status')) {
        clauses.push(`d.verification_status = ?`);
        params.push(q('verification_status').toUpperCase());
      }
      if (q('date_from')) {
        clauses.push(`d.uploaded_at >= ?`);
        params.push(q('date_from'));
      }
      if (q('date_to')) {
        clauses.push(`d.uploaded_at <= ?`);
        params.push(`${q('date_to')}T23:59:59.999Z`);
      }
      if (req.query.missing_only === '1' || String(req.query.missing_only).toLowerCase() === 'true') {
        clauses.push(`d.upload_status != 'UPLOADED'`);
      }

      const sql = `SELECT d.*, u.username AS uploaded_by_username
         FROM sales_order_documents d
         LEFT JOIN users u ON u.id = d.uploaded_by
         WHERE ${clauses.join(' AND ')}
         ORDER BY d.uploaded_at DESC NULLS LAST, d.id DESC
         LIMIT 2000`;

      const rows = await dbAll(sql, params);
      res.json({ rows: rows || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

router.post('/save-dn-pdf', requireAnyPermission(['can_upload_delivery_note', 'can_upload_outbound', 'can_confirm_picked']), async (req, res) => {
  try {
    const delivery_note_id = Number(req.body.delivery_note_id);
    if (!Number.isFinite(delivery_note_id)) return res.status(400).json({ error: 'delivery_note_id is required' });
    const duplicate_action = String(req.body.duplicate_action || '').trim().toLowerCase() || null;
    const result = await saveDeliveryNotePdfToDrive({
      deliveryNoteId: delivery_note_id,
      userId: Number(req.user.sub),
      duplicate_action: duplicate_action || null,
    });
    if (result.conflict) return res.status(409).json({ conflict: true, existing: result.existing });
    if (result.cancelled) return res.json({ cancelled: true });
    res.json({ ok: true, document: result.document });
  } catch (e) {
    const code = /not configured|GOOGLE_DRIVE|credentials/i.test(String(e.message)) ? 503 : 400;
    res.status(code).json({ error: e.message });
  }
});

router.get('/by-outbound/:outbound_number', async (req, res) => {
  try {
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const ob = decodeSoParam(req.params.outbound_number);
    const payload = await listDocumentsByOutbound(warehouseId, ob);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/by-invoice/:invoice_number', async (req, res) => {
  try {
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const inv = decodeSoParam(req.params.invoice_number);
    const payload = await listDocumentsByInvoice(warehouseId, inv);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/download-options', async (req, res) => {
  try {
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.body?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const sales_order_number = String(req.body.sales_order_number || '').trim();
    if (!sales_order_number) return res.status(400).json({ error: 'sales_order_number is required' });
    const manifest = await buildDownloadOptions({
      warehouseId,
      salesOrderNumber: sales_order_number,
      outboundNumber: req.body.outbound_number || null,
      scope: req.body.scope || 'full_so',
    });
    res.json(manifest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/export-package-manifest', async (req, res) => {
  try {
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.body?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const sales_order_number = String(req.body.sales_order_number || '').trim();
    if (!sales_order_number) return res.status(400).json({ error: 'sales_order_number is required' });
    const manifest = await exportManifest(warehouseId, sales_order_number);
    res.json(manifest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:salesOrderNumber/export-combined.pdf', async (req, res) => {
  try {
    const so = decodeSoParam(req.params.salesOrderNumber);
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const { buffer, skippedNonPdf, mergedCount, totalListed } = await buildCombinedPdfForSalesOrder(warehouseId, so);
    const folderRow = await dbGet(
      `SELECT customer_po_number FROM sales_order_folders WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) LIMIT 1`,
      [Number(warehouseId), so]
    );
    const base = combinedExportBaseName(so, folderRow?.customer_po_number);
    const filename = `${base}_combined.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    if (skippedNonPdf > 0) res.setHeader('X-Export-Skipped-NonPdf', String(skippedNonPdf));
    res.setHeader('X-Export-Merged-Pdf-Count', String(mergedCount));
    res.setHeader('X-Export-Total-Documents', String(totalListed));
    res.send(buffer);
  } catch (e) {
    if (e.code === 'EXPORT_NOT_IMPLEMENTED') return res.status(501).json({ error: e.message });
    if (e.code === 'NO_DOCS' || e.code === 'NO_PDF') return res.status(404).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.get('/:salesOrderNumber/export-individual.zip', async (req, res) => {
  try {
    const so = decodeSoParam(req.params.salesOrderNumber);
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const folderRow = await dbGet(
      `SELECT customer_po_number FROM sales_order_folders WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) LIMIT 1`,
      [Number(warehouseId), so]
    );
    const base = combinedExportBaseName(so, folderRow?.customer_po_number);
    await streamIndividualZipForSalesOrder(warehouseId, so, res, base);
  } catch (e) {
    if (e.code === 'EXPORT_NOT_IMPLEMENTED') return res.status(501).json({ error: e.message });
    if (e.code === 'NO_DOCS' || e.code === 'NO_ENTRIES') return res.status(404).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.get('/by-id/:id/open-link', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await dbGet(`SELECT cloud_web_url, warehouse_id FROM sales_order_documents WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, row.warehouse_id);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    res.json({ url: row.cloud_web_url || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/by-id/:id/replace', requireAnyPermission(['can_upload_outbound', 'can_confirm_picked']), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const id = Number(req.params.id);
    const row = await dbGet(`SELECT * FROM sales_order_documents WHERE id = ?`, [id]);
    if (!row) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Not found' });
    }
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, row.warehouse_id);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const result = await uploadDocumentFlow({
      warehouseId: row.warehouse_id,
      salesOrderNumber: row.sales_order_number,
      documentType: row.document_type,
      localPath: req.file.path,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      userId: Number(req.user.sub),
      outbound_number: row.outbound_number,
      dn_number: row.dn_number,
      invoice_number: row.invoice_number,
      customer_po_number: row.customer_po_number,
      accounting_document_number: row.accounting_document_number,
      gapp_po: null,
      customer_name: null,
      pod_type: row.pod_type,
      duplicate_action: 'replace',
    });
    res.json({ ok: true, document: result.document });
  } catch (e) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: e.message });
  }
});

router.post('/by-id/:id/verify', async (req, res) => {
  try {
    if (!canVerifyDocuments(req)) return res.status(403).json({ error: 'Forbidden' });
    const id = Number(req.params.id);
    const row = await dbGet(`SELECT * FROM sales_order_documents WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, row.warehouse_id);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const status = String(req.body?.status || '').trim();
    const remarks = String(req.body?.remarks || '').trim() || null;
    const doc = await verifyDocument({ documentId: id, userId: Number(req.user.sub), status, remarks });
    res.json({ ok: true, document: doc });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:salesOrderNumber/status', async (req, res) => {
  try {
    const so = decodeSoParam(req.params.salesOrderNumber);
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const payload = await getStatusPayload(warehouseId, so);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:salesOrderNumber', async (req, res) => {
  try {
    const so = decodeSoParam(req.params.salesOrderNumber);
    if (String(req.params.salesOrderNumber || '').toLowerCase() === 'report') return res.status(404).json({ error: 'Not found' });
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const folder = await dbGet(
      `SELECT * FROM sales_order_folders WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) LIMIT 1`,
      [warehouseId, so]
    );
    const documents = await dbAll(
      `SELECT d.*, u.username AS uploaded_by_username, v.username AS verified_by_username
       FROM sales_order_documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
       LEFT JOIN users v ON v.id = d.verified_by
       WHERE d.warehouse_id = ? AND TRIM(d.sales_order_number) = TRIM(?)
       ORDER BY d.uploaded_at DESC, d.id DESC`,
      [warehouseId, so]
    );
    res.json({ folder, documents: (documents || []).map(mapDocumentWithValidation) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
