const fs = require('fs');
const { resolveWarehouseIdForRequest, userHasWarehouseAccess } = require('../services/warehouseContext');
const salesOrderDocumentsService = require('../services/salesOrderDocumentsService');
const {
  uploadDocumentFlow,
  DOC_TYPES,
  recordScannerPipelineChecklists,
  listDocumentsForSalesOrder,
  computeParallelBundleStatus,
} = salesOrderDocumentsService;

function isScannerUpload(req) {
  const h = String(req.get('X-Upload-Source') || '').toLowerCase();
  const b = String(req.body?.upload_source || '').toLowerCase();
  return h === 'scanner' || b === 'scanner';
}

/**
 * Shared handler for POST multipart sales-order document upload (JWT or scanner agent).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ fromScannerAgent?: boolean }} opts
 */
async function handleSalesOrderDocumentUpload(req, res, opts = {}) {
  const fromScannerAgent = Boolean(opts.fromScannerAgent);
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required (field: file)' });

    const userId = Number(req.user.sub);
    let warehouseId;

    if (fromScannerAgent) {
      warehouseId = Number(req.body?.warehouse_id ?? req.get('X-Warehouse-Id'));
      if (!Number.isFinite(warehouseId) || warehouseId <= 0) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'warehouse_id is required for scanner agent upload' });
      }
      const allow = String(process.env.SCANNER_AGENT_WAREHOUSE_IDS || '').trim();
      if (allow) {
        const set = new Set(
          allow
            .split(',')
            .map((x) => Number(String(x).trim()))
            .filter((n) => Number.isFinite(n) && n > 0)
        );
        if (!set.has(warehouseId)) {
          fs.unlink(req.file.path, () => {});
          return res.status(403).json({ error: 'warehouse_id not permitted for scanner agent' });
        }
      }
    } else {
      warehouseId = await resolveWarehouseIdForRequest({
        userId,
        role: req.user.role,
        explicitWarehouseId: req.body?.warehouse_id ?? req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
      });
      if (!warehouseId) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'warehouse_id required' });
      }
      const okWh = await userHasWarehouseAccess(userId, req.user.role, warehouseId);
      if (String(req.user.role || '').toLowerCase() !== 'admin' && !okWh) {
        fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: 'Forbidden for this warehouse' });
      }
    }

    const sales_order_number = String(req.body.sales_order_number || '').trim();
    const document_type = String(req.body.document_type || '').trim().toUpperCase();
    const duplicate_action = String(req.body.duplicate_action || '').trim().toLowerCase() || null;

    if (!sales_order_number) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'sales_order_number is required' });
    }
    if (!Object.values(DOC_TYPES).includes(document_type)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Invalid document_type' });
    }

    const outbound_number = String(req.body.outbound_number || '').trim() || null;
    const dn_number = String(req.body.dn_number || '').trim() || null;
    const invoice_number = String(req.body.invoice_number || '').trim() || null;
    let customer_po_number = String(req.body.customer_po_number || '').trim() || null;
    const accounting_document_number = String(req.body.accounting_document_number || '').trim() || null;
    const gapp_po = String(req.body.gapp_po || '').trim() || null;
    const customer_name = String(req.body.customer_name || '').trim() || null;
    const pod_type = String(req.body.pod_type || '').trim() || null;

    if (document_type === DOC_TYPES.CUSTOMER_PO && !customer_po_number) {
      customer_po_number = sales_order_number;
    }
    if (document_type === DOC_TYPES.INVOICE) {
      if (!invoice_number) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'invoice_number is required' });
      }
    }
    if (document_type === DOC_TYPES.ACCOUNTING_DOCUMENT) {
      if (!accounting_document_number) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'accounting_document_number is required' });
      }
    }

    const result = await uploadDocumentFlow({
      warehouseId,
      salesOrderNumber: sales_order_number,
      documentType: document_type,
      localPath: req.file.path,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      userId,
      outbound_number,
      dn_number,
      invoice_number,
      customer_po_number,
      accounting_document_number,
      gapp_po,
      customer_name,
      pod_type: pod_type || (fromScannerAgent ? 'scanner_agent' : null),
      duplicate_action,
    });

    if (result.conflict) {
      return res.status(409).json(result);
    }
    if (result.cancelled) {
      return res.status(499).json({ cancelled: true });
    }

    const doc = result.document;
    const shouldRecordScannerChecklist = fromScannerAgent || isScannerUpload(req);
    if (shouldRecordScannerChecklist && doc?.id) {
      try {
        await recordScannerPipelineChecklists({
          warehouseId,
          salesOrderNumber: sales_order_number,
          outboundNumber: outbound_number || null,
          documentId: doc.id,
          userId,
        });
      } catch (e) {
        console.warn('[salesOrderDocuments] scanner checklist:', e.message);
      }
    }

    let parallel_bundle = null;
    try {
      const docs = await listDocumentsForSalesOrder(warehouseId, sales_order_number);
      parallel_bundle = computeParallelBundleStatus(docs);
    } catch (_) {
      /* non-fatal */
    }

    return res.status(201).json({ ok: true, document: doc, parallel_bundle });
  } catch (e) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    const code = /not configured|GOOGLE_DRIVE|credentials/i.test(String(e.message)) ? 503 : 400;
    return res.status(code).json({ error: e.message });
  }
}

module.exports = { handleSalesOrderDocumentUpload, isScannerUpload };
