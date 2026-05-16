const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const db = require('../db');
const {
  getConfiguredRootFolderId,
  ensureWarehouseFolder,
  ensureSalesOrderFolder,
  uploadDocument,
  replaceDocument,
  getWebLink,
  deleteTempFile,
} = require('./cloudStorage/cloudStorageProvider');
const { ensurePdfUploadPath } = require('./salesOrderDocumentPdf');
const { isGoogleDriveFolderAccessible } = require('./googleDriveSetupStatus');

const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

const DOC_TYPES = {
  CUSTOMER_PO: 'CUSTOMER_PO',
  INVOICE: 'INVOICE',
  DELIVERY_NOTE: 'DELIVERY_NOTE',
  POD: 'POD',
  SIGNED_POD: 'SIGNED_POD',
  ACCOUNTING_DOCUMENT: 'ACCOUNTING_DOCUMENT',
  OTHER: 'OTHER',
};

const CHECKLIST = {
  CUSTOMER_PO_UPLOADED: 'CUSTOMER_PO_UPLOADED',
  INVOICE_UPLOADED: 'INVOICE_UPLOADED',
  DN_UPLOADED: 'DN_UPLOADED',
  POD_UPLOADED: 'POD_UPLOADED',
  POD_VERIFIED: 'POD_VERIFIED',
  ORDER_CLOSED: 'ORDER_CLOSED',
  SALES_ORDER_COMPLETED: 'SALES_ORDER_COMPLETED',
  DOCUMENT_SCANNED: 'DOCUMENT_SCANNED',
  DOCUMENT_UPLOADED: 'DOCUMENT_UPLOADED',
};

function normSo(v) {
  return String(v ?? '').trim();
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Trio rule: uploaded INVOICE, DELIVERY_NOTE, and ACCOUNTING_DOCUMENT counts must match (1:1:1, 2:2:2, …).
 * CUSTOMER_PO is separate; when any trio file exists but no PO, a soft reminder is included.
 */
function computeParallelBundleStatus(documents) {
  const uploaded = (documents || []).filter(
    (d) => String(d.upload_status || '').toUpperCase() === 'UPLOADED'
  );
  const countType = (t) =>
    uploaded.filter((d) => String(d.document_type || '').toUpperCase() === t).length;
  const nInv = countType(DOC_TYPES.INVOICE);
  const nDn = countType(DOC_TYPES.DELIVERY_NOTE);
  const nAcc = countType(DOC_TYPES.ACCOUNTING_DOCUMENT);
  const nPo = countType(DOC_TYPES.CUSTOMER_PO);
  const m = Math.max(nInv, nDn, nAcc);
  const balanced = m === 0 || (nInv === m && nDn === m && nAcc === m);
  const reminders = [];
  if (m > 0 && !balanced) {
    reminders.push(
      `Parallel set incomplete: ${nInv} invoice file(s), ${nDn} delivery note file(s), ${nAcc} accounting file(s). All three counts must be equal (e.g. two invoices ⇒ two delivery notes and two accounting documents).`
    );
    if (nInv < m) reminders.push(`Add ${m - nInv} more invoice file(s).`);
    if (nDn < m) reminders.push(`Add ${m - nDn} more delivery note file(s).`);
    if (nAcc < m) reminders.push(`Add ${m - nAcc} more accounting file(s).`);
  }
  let customer_po_reminder = null;
  if (m > 0 && nPo === 0) {
    customer_po_reminder =
      'No customer PO uploaded yet — usually one customer PO PDF is kept with the sales order for customer view.';
  }
  const summary =
    m === 0
      ? 'No uploaded invoice / delivery note / accounting trio yet.'
      : balanced
        ? `Document trio complete (${m} parallel set(s)): ${nInv} invoice(s), ${nDn} delivery note(s), ${nAcc} accounting file(s).`
        : `Incomplete trio: ${nInv} invoice(s), ${nDn} delivery note(s), ${nAcc} accounting file(s).`;
  return {
    counts: {
      invoice: nInv,
      delivery_note: nDn,
      accounting_document: nAcc,
      customer_po: nPo,
    },
    parallel_complete: balanced,
    parallel_balanced: balanced,
    reminders,
    customer_po_reminder,
    summary,
  };
}

function isPg() {
  return db && db.dialect === 'postgres';
}

async function advisoryLockSalesOrder(warehouseId, salesOrderNumber) {
  if (!isPg()) return;
  const so = normSo(salesOrderNumber);
  const wid = Number(warehouseId);
  await dbRun(`SELECT pg_advisory_xact_lock(728443, hashtext(? || '|' || ?))`, [String(wid), so]);
}

async function loadWarehouse(warehouseId) {
  const row = await dbGet(`SELECT id, warehouse_code, warehouse_name, google_drive_folder_id FROM warehouses WHERE id = ?`, [
    Number(warehouseId),
  ]);
  return row;
}

async function ensureWarehouseDriveFolderId(warehouseRow) {
  if (!getConfiguredRootFolderId()) {
    throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured');
  }
  const existing = String(warehouseRow.google_drive_folder_id || '').trim();
  if (existing && (await isGoogleDriveFolderAccessible(existing))) {
    return existing;
  }
  const created = await ensureWarehouseFolder({ warehouse_code: warehouseRow.warehouse_code });
  await dbRun(`UPDATE warehouses SET google_drive_folder_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
    created.id,
    warehouseRow.id,
  ]);
  return created.id;
}

/**
 * Create or return sales_order_folders row with Drive structure.
 */
async function getOrEnsureSalesOrderFolder({
  warehouseId,
  salesOrderNumber,
  userId,
  gapp_po,
  customer_po_number,
  customer_name,
}) {
  const wid = Number(warehouseId);
  const so = normSo(salesOrderNumber);
  if (!wid || !so) throw new Error('warehouse_id and sales_order_number are required');

  await dbRun('BEGIN IMMEDIATE');
  try {
    await advisoryLockSalesOrder(wid, so);
    let row = await dbGet(
      `SELECT * FROM sales_order_folders WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) LIMIT 1`,
      [wid, so]
    );
    if (row && row.sales_order_folder_id) {
      const soFolderOk = await isGoogleDriveFolderAccessible(row.sales_order_folder_id);
      if (soFolderOk) {
        await dbRun('COMMIT');
        return row;
      }
      /* Stale Drive ids (e.g. after rotating service account) — rebuild tree below. */
    }

    const wh = await loadWarehouse(wid);
    if (!wh) throw new Error('Warehouse not found');

    const whFolderId = await ensureWarehouseDriveFolderId(wh);
    const tree = await ensureSalesOrderFolder({
      warehouseFolderId: whFolderId,
      warehouse_code: wh.warehouse_code,
      sales_order_number: so,
    });

    if (row?.id) {
      await dbRun(
        `UPDATE sales_order_folders SET
          warehouse_code = ?,
          gapp_po = COALESCE(?, gapp_po),
          customer_po_number = COALESCE(?, customer_po_number),
          customer_name = COALESCE(?, customer_name),
          storage_provider = ?,
          root_folder_id = ?,
          sales_order_folder_id = ?,
          sales_order_folder_name = ?,
          sales_order_folder_path = ?,
          customer_po_folder_id = ?,
          invoices_folder_id = ?,
          delivery_notes_folder_id = ?,
          pod_folder_id = ?,
          accounting_documents_folder_id = ?,
          other_folder_id = ?,
          folder_status = 'Active',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [
          wh.warehouse_code,
          gapp_po || null,
          customer_po_number || null,
          customer_name || null,
          tree.storage_provider,
          tree.root_folder_id,
          tree.sales_order_folder_id,
          tree.sales_order_folder_name,
          tree.sales_order_folder_path,
          tree.customer_po_folder_id,
          tree.invoices_folder_id,
          tree.delivery_notes_folder_id,
          tree.pod_folder_id,
          tree.accounting_documents_folder_id,
          tree.other_folder_id,
          row.id,
        ]
      );
    } else {
      await dbRun(
        `INSERT INTO sales_order_folders (
          warehouse_id, warehouse_code, sales_order_number, gapp_po, customer_po_number, customer_name,
          storage_provider, root_folder_id, sales_order_folder_id, sales_order_folder_name, sales_order_folder_path,
          customer_po_folder_id, invoices_folder_id, delivery_notes_folder_id, pod_folder_id,
          accounting_documents_folder_id, other_folder_id, folder_status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          wid,
          wh.warehouse_code,
          so,
          gapp_po || null,
          customer_po_number || null,
          customer_name || null,
          tree.storage_provider,
          tree.root_folder_id,
          tree.sales_order_folder_id,
          tree.sales_order_folder_name,
          tree.sales_order_folder_path,
          tree.customer_po_folder_id,
          tree.invoices_folder_id,
          tree.delivery_notes_folder_id,
          tree.pod_folder_id,
          tree.accounting_documents_folder_id,
          tree.other_folder_id,
          userId || null,
        ]
      );
    }

    row = await dbGet(
      `SELECT * FROM sales_order_folders WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) LIMIT 1`,
      [wid, so]
    );
    await dbRun('COMMIT');
    return row;
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }
}

function folderIdForDocType(folderRow, documentType) {
  const t = String(documentType || '').toUpperCase();
  if (t === DOC_TYPES.CUSTOMER_PO) return folderRow.customer_po_folder_id;
  if (t === DOC_TYPES.INVOICE) return folderRow.invoices_folder_id;
  if (t === DOC_TYPES.DELIVERY_NOTE) return folderRow.delivery_notes_folder_id;
  if (t === DOC_TYPES.POD || t === DOC_TYPES.SIGNED_POD) return folderRow.pod_folder_id;
  if (t === DOC_TYPES.ACCOUNTING_DOCUMENT) return folderRow.accounting_documents_folder_id;
  if (t === DOC_TYPES.OTHER) return folderRow.other_folder_id;
  return folderRow.other_folder_id;
}

function buildBaseFileName({
  documentType,
  sales_order_number,
  customer_po_number,
  invoice_number,
  outbound_number,
  dn_number,
  accounting_document_number,
}) {
  const t = String(documentType || '').toUpperCase();
  const so = normSo(sales_order_number);
  const cpo = normSo(customer_po_number);
  const inv = normSo(invoice_number);
  const ob = normSo(outbound_number);
  const dn = normSo(dn_number);
  const acc = normSo(accounting_document_number);
  const d = todayYmd();
  const uniq = String(Date.now()).slice(-6);

  if (t === DOC_TYPES.CUSTOMER_PO) return `Customer_PO_${cpo}.pdf`;
  if (t === DOC_TYPES.INVOICE) return `INV_${inv}.pdf`;
  if (t === DOC_TYPES.DELIVERY_NOTE) {
    if (ob && dn) return `DN_${ob}_${dn}.pdf`;
    return `DN_${so || 'SO'}_${d}_${uniq}.pdf`;
  }
  if (t === DOC_TYPES.POD) {
    if (ob) return `POD_${ob}_${d}.pdf`;
    return `POD_${so || 'SO'}_${d}_${uniq}.pdf`;
  }
  if (t === DOC_TYPES.SIGNED_POD) {
    if (ob) return `POD_SIGNED_${ob}_${d}.pdf`;
    return `POD_SIGNED_${so || 'SO'}_${d}_${uniq}.pdf`;
  }
  if (t === DOC_TYPES.ACCOUNTING_DOCUMENT) return `ACC_${acc}.pdf`;
  if (t === DOC_TYPES.OTHER) return `OTHER_${d}_${uniq}.pdf`;
  throw new Error('Invalid document_type');
}

async function findConflictingDocument(folderDbId, documentType, keys) {
  const t = String(documentType || '').toUpperCase();
  const clauses = [`sales_order_folder_id = ?`, `document_type = ?`, `upload_status = 'UPLOADED'`];
  const params = [Number(folderDbId), t];

  if (t === DOC_TYPES.CUSTOMER_PO) {
    clauses.push(`TRIM(COALESCE(customer_po_number,'')) = TRIM(?)`);
    params.push(normSo(keys.customer_po_number));
  } else if (t === DOC_TYPES.INVOICE) {
    clauses.push(`TRIM(COALESCE(invoice_number,'')) = TRIM(?)`);
    params.push(normSo(keys.invoice_number));
  } else if (t === DOC_TYPES.DELIVERY_NOTE) {
    const ob = normSo(keys.outbound_number);
    const dn = normSo(keys.dn_number);
    if (ob && dn) {
      clauses.push(`TRIM(COALESCE(outbound_number,'')) = TRIM(?)`);
      clauses.push(`TRIM(COALESCE(dn_number,'')) = TRIM(?)`);
      params.push(ob, dn);
    } else {
      return null;
    }
  } else if (t === DOC_TYPES.POD || t === DOC_TYPES.SIGNED_POD) {
    const ob = normSo(keys.outbound_number);
    if (ob) {
      clauses.push(`TRIM(COALESCE(outbound_number,'')) = TRIM(?)`);
      params.push(ob);
      clauses.push(`stored_file_name LIKE ?`);
      params.push(`POD${t === DOC_TYPES.SIGNED_POD ? '_SIGNED' : ''}_${ob}_%`);
    } else {
      return null;
    }
  } else if (t === DOC_TYPES.ACCOUNTING_DOCUMENT) {
    clauses.push(`TRIM(COALESCE(accounting_document_number,'')) = TRIM(?)`);
    params.push(normSo(keys.accounting_document_number));
  } else {
    return null;
  }

  const sql = `SELECT * FROM sales_order_documents WHERE ${clauses.join(' AND ')} ORDER BY version_no DESC, id DESC LIMIT 1`;
  return dbGet(sql, params);
}

async function recordChecklist({ warehouseId, key, salesOrderNumber, outboundNumber, documentId, userId, remarks }) {
  await dbRun(
    `INSERT INTO sales_order_checklist (warehouse_id, checklist_key, sales_order_number, outbound_number, document_id, completed_by, remarks)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(warehouseId),
      String(key),
      normSo(salesOrderNumber),
      outboundNumber ? normSo(outboundNumber) : null,
      documentId || null,
      userId || null,
      remarks || null,
    ]
  );
}

/** Checklist rows for successful Local Scanner Agent pipeline (scan + upload). */
async function recordScannerPipelineChecklists({ warehouseId, salesOrderNumber, outboundNumber, documentId, userId }) {
  await recordChecklist({
    warehouseId,
    key: CHECKLIST.DOCUMENT_SCANNED,
    salesOrderNumber,
    outboundNumber: outboundNumber || null,
    documentId: documentId || null,
    userId: userId || null,
    remarks: 'local_scanner_agent',
  });
  await recordChecklist({
    warehouseId,
    key: CHECKLIST.DOCUMENT_UPLOADED,
    salesOrderNumber,
    outboundNumber: outboundNumber || null,
    documentId: documentId || null,
    userId: userId || null,
    remarks: 'local_scanner_agent',
  });
}

async function recomputeSalesOrderFolderStatus(warehouseId, salesOrderNumber) {
  const wid = Number(warehouseId);
  const so = normSo(salesOrderNumber);
  const folder = await dbGet(
    `SELECT * FROM sales_order_folders WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) LIMIT 1`,
    [wid, so]
  );
  if (!folder?.id) return;

  const hasCustomerPo = await dbGet(
    `SELECT 1 AS ok FROM sales_order_documents
     WHERE sales_order_folder_id = ? AND document_type = 'CUSTOMER_PO' AND upload_status = 'UPLOADED' LIMIT 1`,
    [folder.id]
  );

  const outbounds = await dbAll(
    `SELECT DISTINCT TRIM(COALESCE(outbound_number,'')) AS ob
     FROM delivery_notes
     WHERE warehouse_id = ? AND (TRIM(COALESCE(gapp_po,'')) = TRIM(?) OR TRIM(COALESCE(sales_order_number,'')) = TRIM(?))
       AND TRIM(COALESCE(outbound_number,'')) != ''`,
    [wid, so, so]
  );
  const outFromOrders = await dbAll(
    `SELECT DISTINCT TRIM(COALESCE(outbound_number,'')) AS ob
     FROM outbound_orders
     WHERE warehouse_id = ? AND TRIM(COALESCE(sales_doc,'')) = TRIM(?)`,
    [wid, so]
  );
  const obSet = new Set();
  for (const r of [...(outbounds || []), ...(outFromOrders || [])]) {
    const x = normSo(r.ob);
    if (x) obSet.add(x);
  }
  const outboundList = [...obSet];

  let allComplete = !!(hasCustomerPo && hasCustomerPo.ok);
  if (!outboundList.length) {
    allComplete = false;
  }

  for (const ob of outboundList) {
    const hasDn = await dbGet(
      `SELECT 1 AS ok FROM sales_order_documents
       WHERE sales_order_folder_id = ? AND document_type = 'DELIVERY_NOTE' AND upload_status = 'UPLOADED'
         AND TRIM(COALESCE(outbound_number,'')) = TRIM(?) LIMIT 1`,
      [folder.id, ob]
    );
    const hasPod = await dbGet(
      `SELECT 1 AS ok FROM sales_order_documents
       WHERE sales_order_folder_id = ? AND document_type IN ('POD','SIGNED_POD') AND upload_status = 'UPLOADED'
         AND TRIM(COALESCE(outbound_number,'')) = TRIM(?) LIMIT 1`,
      [folder.id, ob]
    );
    const podVerified = await dbGet(
      `SELECT 1 AS ok FROM sales_order_documents
       WHERE sales_order_folder_id = ? AND document_type IN ('POD','SIGNED_POD') AND upload_status = 'UPLOADED'
         AND verification_status = 'APPROVED'
         AND TRIM(COALESCE(outbound_number,'')) = TRIM(?) LIMIT 1`,
      [folder.id, ob]
    );
    const ord = await dbGet(
      `SELECT status FROM outbound_orders WHERE warehouse_id = ? AND (outbound_number = ? OR delivery = ?) LIMIT 1`,
      [wid, ob, ob]
    );
    const delivered = String(ord?.status || '').toLowerCase() === 'delivered';

    if (!hasDn?.ok || !hasPod?.ok || !podVerified?.ok || !delivered) {
      allComplete = false;
      break;
    }
  }

  const nextStatus = allComplete && outboundList.length ? 'Completed' : folder.folder_status === 'Archived' ? 'Archived' : 'Active';
  await dbRun(`UPDATE sales_order_folders SET folder_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [nextStatus, folder.id]);
  if (nextStatus === 'Completed') {
    try {
      await recordChecklist({
        warehouseId: wid,
        key: CHECKLIST.SALES_ORDER_COMPLETED,
        salesOrderNumber: so,
        outboundNumber: null,
        documentId: null,
        userId: null,
        remarks: 'auto',
      });
    } catch {
      /* ignore duplicate noise */
    }
  }
}

async function uploadDocumentFlow({
  warehouseId,
  salesOrderNumber,
  documentType,
  localPath,
  originalName,
  mimeType,
  userId,
  outbound_number,
  dn_number,
  invoice_number,
  customer_po_number,
  accounting_document_number,
  gapp_po,
  customer_name,
  pod_type,
  duplicate_action,
}) {
  const folderRow = await getOrEnsureSalesOrderFolder({
    warehouseId,
    salesOrderNumber,
    userId,
    gapp_po,
    customer_po_number,
    customer_name,
  });

  const folderDbId = folderRow.id;
  const cloudFolderId = folderIdForDocType(folderRow, documentType);
  if (!cloudFolderId) throw new Error('Target folder missing — re-run folder ensure');

  let baseName = buildBaseFileName({
    documentType,
    sales_order_number: salesOrderNumber,
    customer_po_number,
    invoice_number,
    outbound_number,
    dn_number,
    accounting_document_number,
  });
  if (String(documentType).toUpperCase() === DOC_TYPES.OTHER && originalName) {
    const ext = path.extname(originalName) || '.bin';
    baseName = `OTHER_${todayYmd()}_${String(Date.now()).slice(-6)}${ext}`;
  }

  const conflict = await findConflictingDocument(folderDbId, documentType, {
    customer_po_number,
    invoice_number,
    outbound_number,
    dn_number,
    accounting_document_number,
  });

  if (conflict && !duplicate_action) {
    return {
      conflict: true,
      existing: {
        id: conflict.id,
        stored_file_name: conflict.stored_file_name,
        cloud_web_url: conflict.cloud_web_url,
        version_no: conflict.version_no,
      },
    };
  }

  let storedName = baseName;
  let versionNo = 1;
  let replacedId = null;

  if (conflict && duplicate_action === 'cancel') {
    return { cancelled: true };
  }
  if (conflict && duplicate_action === 'version') {
    versionNo = (Number(conflict.version_no) || 1) + 1;
    const stem = path.basename(baseName, '.pdf');
    storedName = `${stem}_v${versionNo}.pdf`;
    replacedId = conflict.id;
  }
  if (conflict && duplicate_action === 'replace') {
    replacedId = conflict.id;
    versionNo = Number(conflict.version_no) || 1;
    storedName = conflict.stored_file_name || baseName;
  }

  const pdfTarget = path.join(path.dirname(localPath), `${path.basename(localPath, path.extname(localPath))}_upload.pdf`);
  const prepared = await ensurePdfUploadPath(localPath, mimeType, pdfTarget);
  const uploadPath = prepared.filePath;
  const uploadMime = prepared.mimeType;

  let up;
  let ins;
  if (conflict && duplicate_action === 'replace' && conflict.cloud_file_id) {
    up = await replaceDocument({ fileId: conflict.cloud_file_id, filePath: uploadPath, mimeType: uploadMime });
    const links = await getWebLink(conflict.cloud_file_id);
    const stSize = (await fs.promises.stat(uploadPath).catch(() => null))?.size ?? null;
    const ver =
      String(documentType).toUpperCase() === DOC_TYPES.OTHER || String(documentType).toUpperCase() === DOC_TYPES.INVOICE
        ? 'NOT_REQUIRED'
        : 'PENDING';
    await dbRun(
      `UPDATE sales_order_documents SET
        original_file_name = ?,
        mime_type = ?,
        file_size = ?,
        cloud_web_url = ?,
        cloud_download_url = ?,
        temp_vps_path = ?,
        upload_status = 'UPLOADED',
        verification_status = ?,
        uploaded_by = ?,
        uploaded_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [
        originalName || null,
        uploadMime,
        stSize,
        links.webViewLink || up.webViewLink || null,
        links.webContentLink || up.webContentLink || null,
        localPath,
        ver,
        userId || null,
        conflict.id,
      ]
    );
    ins = await dbGet(`SELECT * FROM sales_order_documents WHERE id = ?`, [conflict.id]);
  } else {
    up = await uploadDocument({
      folderId: cloudFolderId,
      filePath: uploadPath,
      fileName: storedName,
      mimeType: uploadMime,
    });

    const links = await getWebLink(up.id);
    const relPath = `${folderRow.sales_order_folder_path || ''}/${path.basename(storedName)}`;

    await dbRun(
      `INSERT INTO sales_order_documents (
      warehouse_id, sales_order_folder_id, sales_order_number, outbound_number, dn_number, invoice_number,
      customer_po_number, accounting_document_number, document_type, document_title, original_file_name,
      stored_file_name, mime_type, file_size, storage_provider, cloud_file_id, cloud_folder_id, cloud_web_url,
      cloud_download_url, folder_relative_path, temp_vps_path, upload_status, sync_status, verification_status,
      uploaded_by, replaced_document_id, version_no, remarks, pod_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADED', 'SYNCED', ?, ?, ?, ?, ?, ?)`,
      [
        Number(warehouseId),
        Number(folderDbId),
        normSo(salesOrderNumber),
        outbound_number ? normSo(outbound_number) : null,
        dn_number ? normSo(dn_number) : null,
        invoice_number ? normSo(invoice_number) : null,
        customer_po_number ? normSo(customer_po_number) : null,
        accounting_document_number ? normSo(accounting_document_number) : null,
        String(documentType).toUpperCase(),
        storedName,
        originalName || null,
        storedName,
        uploadMime,
        (await fs.promises.stat(uploadPath).catch(() => null))?.size ?? null,
        folderRow.storage_provider || 'GOOGLE_DRIVE',
        up.id,
        cloudFolderId,
        links.webViewLink || up.webViewLink || null,
        links.webContentLink || up.webContentLink || null,
        relPath,
        localPath,
        documentType === DOC_TYPES.OTHER || documentType === DOC_TYPES.INVOICE ? 'NOT_REQUIRED' : 'PENDING',
        userId || null,
        replacedId,
        versionNo,
        null,
        pod_type || null,
      ]
    );

    ins = await dbGet(`SELECT * FROM sales_order_documents WHERE cloud_file_id = ? ORDER BY id DESC LIMIT 1`, [up.id]);
  }

  await deleteTempFile(localPath).catch(() => {});
  if (pdfTarget !== localPath) await deleteTempFile(pdfTarget).catch(() => {});

  if (String(documentType).toUpperCase() === DOC_TYPES.CUSTOMER_PO) {
    await recordChecklist({
      warehouseId,
      key: CHECKLIST.CUSTOMER_PO_UPLOADED,
      salesOrderNumber,
      outboundNumber: null,
      documentId: ins.id,
      userId,
      remarks: null,
    });
  } else if (String(documentType).toUpperCase() === DOC_TYPES.INVOICE) {
    await recordChecklist({
      warehouseId,
      key: CHECKLIST.INVOICE_UPLOADED,
      salesOrderNumber,
      outboundNumber: outbound_number || null,
      documentId: ins.id,
      userId,
      remarks: null,
    });
  } else if (String(documentType).toUpperCase() === DOC_TYPES.DELIVERY_NOTE) {
    await recordChecklist({
      warehouseId,
      key: CHECKLIST.DN_UPLOADED,
      salesOrderNumber,
      outboundNumber: outbound_number || null,
      documentId: ins.id,
      userId,
      remarks: null,
    });
  } else if (String(documentType).toUpperCase() === DOC_TYPES.POD || String(documentType).toUpperCase() === DOC_TYPES.SIGNED_POD) {
    await recordChecklist({
      warehouseId,
      key: CHECKLIST.POD_UPLOADED,
      salesOrderNumber,
      outboundNumber: outbound_number || null,
      documentId: ins.id,
      userId,
      remarks: pod_type || null,
    });
  }

  await recomputeSalesOrderFolderStatus(warehouseId, salesOrderNumber);

  return { document: ins, uploaded: true };
}

async function verifyDocument({ documentId, userId, status, remarks }) {
  const st = String(status || '').toUpperCase();
  if (!['APPROVED', 'REJECTED', 'NOT_REQUIRED', 'PENDING'].includes(st)) {
    throw new Error('Invalid verification status');
  }
  const row = await dbGet(`SELECT * FROM sales_order_documents WHERE id = ?`, [Number(documentId)]);
  if (!row) throw new Error('Document not found');
  await dbRun(
    `UPDATE sales_order_documents SET verification_status = ?, verified_by = ?, verified_at = CURRENT_TIMESTAMP, remarks = COALESCE(?, remarks) WHERE id = ?`,
    [st, userId || null, remarks || null, row.id]
  );
  if (st === 'APPROVED' && (row.document_type === 'POD' || row.document_type === 'SIGNED_POD')) {
    await recordChecklist({
      warehouseId: row.warehouse_id,
      key: CHECKLIST.POD_VERIFIED,
      salesOrderNumber: row.sales_order_number,
      outboundNumber: row.outbound_number,
      documentId: row.id,
      userId,
      remarks: remarks || null,
    });
  }
  await recomputeSalesOrderFolderStatus(row.warehouse_id, row.sales_order_number);
  return dbGet(`SELECT * FROM sales_order_documents WHERE id = ?`, [row.id]);
}

async function listDocumentsForSalesOrder(warehouseId, salesOrderNumber) {
  const wid = Number(warehouseId);
  const so = normSo(salesOrderNumber);
  return dbAll(
    `SELECT d.*, u.username AS uploaded_by_username, v.username AS verified_by_username
     FROM sales_order_documents d
     LEFT JOIN users u ON u.id = d.uploaded_by
     LEFT JOIN users v ON v.id = d.verified_by
     WHERE d.warehouse_id = ? AND TRIM(d.sales_order_number) = TRIM(?)
     ORDER BY d.uploaded_at DESC, d.id DESC`,
    [wid, so]
  );
}

/**
 * Numbers for uploads: prefer outbound, then delivery note, then folder row (after SO load).
 */
async function resolveUploadContextFromWarehouse(warehouseId, salesOrderNumber) {
  const wid = Number(warehouseId);
  const so = normSo(salesOrderNumber);
  const empty = {
    customer_po_number: null,
    invoice_number: null,
    outbound_number: null,
    dn_number: null,
    gapp_po: null,
    customer_name: null,
  };
  if (!wid || !so) return empty;

  const folder = await dbGet(
    `SELECT customer_po_number, gapp_po, customer_name FROM sales_order_folders
     WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) LIMIT 1`,
    [wid, so]
  );

  const obRow = await dbGet(
    `SELECT outbound_number, delivery, invoice_number, customer_po_number, sales_doc, sales_order_number, gapp_po, customer_name
     FROM outbound_orders
     WHERE warehouse_id = ?
       AND (
         TRIM(COALESCE(sales_doc, '')) = TRIM(?)
         OR TRIM(COALESCE(sales_order_number, '')) = TRIM(?)
         OR TRIM(COALESCE(gapp_po, '')) = TRIM(?)
         OR TRIM(COALESCE(outbound_number, '')) = TRIM(?)
         OR TRIM(COALESCE(delivery, '')) = TRIM(?)
       )
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [wid, so, so, so, so, so]
  );

  const dnRow = await dbGet(
    `SELECT dn.dn_number, dn.outbound_number, dn.invoice_number, dn.customer_po, dn.gapp_po, dn.sales_order_number, dn.customer_name
     FROM delivery_notes dn
     INNER JOIN outbound_orders o ON (
       TRIM(COALESCE(o.outbound_number, '')) = TRIM(COALESCE(dn.outbound_number, ''))
       OR TRIM(COALESCE(o.delivery, '')) = TRIM(COALESCE(dn.outbound_number, ''))
     )
     WHERE o.warehouse_id = ?
       AND (
         TRIM(COALESCE(dn.gapp_po, '')) = TRIM(?)
         OR TRIM(COALESCE(dn.sales_order_number, '')) = TRIM(?)
         OR TRIM(COALESCE(dn.outbound_number, '')) = TRIM(?)
       )
     ORDER BY dn.updated_at DESC NULLS LAST
     LIMIT 1`,
    [wid, so, so, so]
  );

  const outbound_number =
    normSo(obRow?.outbound_number || obRow?.delivery || dnRow?.outbound_number) || null;
  const dnNumRaw = normSo(dnRow?.dn_number) || null;
  const customer_po_number =
    normSo(obRow?.customer_po_number || dnRow?.customer_po || folder?.customer_po_number) || null;
  const invoice_number = normSo(obRow?.invoice_number || dnRow?.invoice_number) || null;
  const dn_number = dnNumRaw || outbound_number || null;
  const gapp_po =
    normSo(obRow?.gapp_po || obRow?.sales_doc || dnRow?.gapp_po || folder?.gapp_po) || null;
  const customer_name =
    normSo(obRow?.customer_name || dnRow?.customer_name || folder?.customer_name) || null;

  return {
    customer_po_number,
    invoice_number,
    outbound_number,
    dn_number,
    gapp_po,
    customer_name,
  };
}

async function getStatusPayload(warehouseId, salesOrderNumber) {
  const folder = await dbGet(
    `SELECT * FROM sales_order_folders WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) LIMIT 1`,
    [Number(warehouseId), normSo(salesOrderNumber)]
  );
  const docs = await listDocumentsForSalesOrder(warehouseId, salesOrderNumber);
  const checklist = await dbAll(
    `SELECT * FROM sales_order_checklist WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) ORDER BY completed_at DESC, id DESC LIMIT 200`,
    [Number(warehouseId), normSo(salesOrderNumber)]
  );
  await recomputeSalesOrderFolderStatus(warehouseId, salesOrderNumber);
  const folder2 = await dbGet(
    `SELECT * FROM sales_order_folders WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) LIMIT 1`,
    [Number(warehouseId), normSo(salesOrderNumber)]
  );
  const upload_context = await resolveUploadContextFromWarehouse(warehouseId, salesOrderNumber);
  const parallel_bundle = computeParallelBundleStatus(docs || []);
  return {
    folder: folder2 || folder,
    documents: docs || [],
    checklist: checklist || [],
    upload_context,
    parallel_bundle,
  };
}

async function exportManifest(warehouseId, salesOrderNumber) {
  const { folder, documents } = await getStatusPayload(warehouseId, salesOrderNumber);
  return {
    sales_order_number: normSo(salesOrderNumber),
    folder,
    files: (documents || []).map((d) => ({
      type: d.document_type,
      name: d.stored_file_name,
      link: d.cloud_web_url,
      verification_status: d.verification_status,
      uploaded_at: d.uploaded_at,
    })),
  };
}

async function fireAndForgetEnsureFromOutboundOrder(orderRow) {
  try {
    const so = normSo(orderRow.sales_doc || orderRow.sales_order_number || '');
    if (!so) return;
    await getOrEnsureSalesOrderFolder({
      warehouseId: orderRow.warehouse_id,
      salesOrderNumber: so,
      userId: orderRow.uploaded_by_user_id || null,
      gapp_po: orderRow.gapp_po || null,
      customer_po_number: orderRow.customer_po_number || null,
      customer_name: orderRow.customer_name || orderRow.name_1 || null,
    });
  } catch (e) {
    console.warn('[salesOrderDocuments] ensure from outbound:', e.message);
  }
}

async function fireAndForgetEnsureFromDeliveryNote(dnRow) {
  try {
    const so = normSo(dnRow.gapp_po || dnRow.sales_order_number || '');
    if (!so) return;
    await getOrEnsureSalesOrderFolder({
      warehouseId: dnRow.warehouse_id,
      salesOrderNumber: so,
      userId: null,
      gapp_po: dnRow.gapp_po || null,
      customer_po_number: dnRow.customer_po || null,
      customer_name: dnRow.customer_name || null,
    });
  } catch (e) {
    console.warn('[salesOrderDocuments] ensure from DN:', e.message);
  }
}

async function onOutboundMarkedDelivered(_dbConn, orderId, orderRow) {
  try {
    const so = normSo(orderRow.sales_doc || orderRow.sales_order_number || '');
    if (!so) return;
    await recordChecklist({
      warehouseId: orderRow.warehouse_id,
      key: CHECKLIST.ORDER_CLOSED,
      salesOrderNumber: so,
      outboundNumber: orderRow.outbound_number || orderRow.delivery,
      documentId: null,
      userId: null,
      remarks: `outbound_id:${orderId}`,
    });
    await recomputeSalesOrderFolderStatus(orderRow.warehouse_id, so);
  } catch (e) {
    console.warn('[salesOrderDocuments] onOutboundMarkedDelivered:', e.message);
  }
}

async function syncDriverPodFileToDrive({ dn, task, localAbsPath, originalName, mimeType, userId }) {
  const so = normSo(dn.gapp_po || dn.sales_order_number || '');
  const ob = normSo(dn.outbound_number || '');
  if (!so || !ob) return null;
  const wid = Number(dn.warehouse_id);
  if (!wid) return null;

  return uploadDocumentFlow({
    warehouseId: wid,
    salesOrderNumber: so,
    documentType: DOC_TYPES.POD,
    localPath: localAbsPath,
    originalName: originalName || 'pod.jpg',
    mimeType: mimeType || 'image/jpeg',
    userId,
    outbound_number: ob,
    dn_number: normSo(dn.dn_number) || ob,
    invoice_number: dn.invoice_number || null,
    customer_po_number: dn.customer_po || null,
    accounting_document_number: null,
    gapp_po: dn.gapp_po || null,
    customer_name: dn.customer_name || null,
    pod_type: 'driver_mobile',
    duplicate_action: 'version',
  });
}

module.exports = {
  DOC_TYPES,
  CHECKLIST,
  getOrEnsureSalesOrderFolder,
  uploadDocumentFlow,
  verifyDocument,
  listDocumentsForSalesOrder,
  getStatusPayload,
  exportManifest,
  findConflictingDocument,
  fireAndForgetEnsureFromOutboundOrder,
  fireAndForgetEnsureFromDeliveryNote,
  onOutboundMarkedDelivered,
  recomputeSalesOrderFolderStatus,
  syncDriverPodFileToDrive,
  recordScannerPipelineChecklists,
  computeParallelBundleStatus,
};
