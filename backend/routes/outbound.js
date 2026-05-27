const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { promisify } = require('util');
const { z } = require('zod');

const db = require('../db');
const { requirePermission, requireAdmin, requireAnyPermission } = require('../middleware/auth');
const { requireUploadOutbound, requireMarkDelivered } = require('../middleware/outboundAccess');
const { zodValidate } = require('../middleware/zodValidate');
const MainStock = require('../models/MainStock');
const OutboundOrder = require('../models/OutboundOrder');
const OutboundItem = require('../models/OutboundItem');
const { generateFifoForOutboundOrder, listFifoForOrder } = require('../services/godamFifo');
const { fifoDateOrderExpr } = require('../lib/safeDateSql');
const { notifyPickProgress } = require('../services/notificationService');
const { sendOutboundOrderForPick } = require('../services/outboundSendForPick');
const { normalizeExcelRows } = require('../utils/excelDates');
const { markOutboundDelivered, reverseOutboundDelivered } = require('../services/markOutboundDelivered');
const { reversePickedOrder } = require('../services/reversePickedOrder');
const {
  expandOutboundBomForOrder,
  refreshAllOutboundItemsStock,
  listBomRequirementsForOrder,
  syncBomRequirementPickedFromTransactions,
  recomputeParentPickedFromBom,
  outboundItemLineIsFullyPicked,
} = require('../services/bomOutboundService');
const { resolveWarehouseIdForRequest, assertExplicitWarehouseParamAllowed, resolveReadWarehouseScope, userHasWarehouseAccess } = require('../services/warehouseContext');
const { logAudit } = require('../services/auditLogger');
const { loadOutboundPickFootprint } = require('../services/outboundPickFootprint');
const { pickedOrderInsertFields, requireOutboundWarehouseId } = require('../services/pickedOrderWrite');
const { resolvePickWarehouseId } = require('../lib/pickWarehouseId');
const { insertPickStockOut } = require('../lib/pickStockOut');
const { uploadDocumentFlow, DOC_TYPES } = require('../services/salesOrderDocumentsService');
const { ensureWorkflowForOutbound } = require('../services/outboundDocumentWorkflowService');
const { reassignOutboundWarehouse } = require('../services/outboundWarehouseReassign');

const router = express.Router();
const EPS = 1e-6;
const outboundOrder = new OutboundOrder();
const outboundItem = new OutboundItem();
const mainStock = new MainStock();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const QTY_EPS = 1e-6;

/** Admin manual pick / confirm: ensure picked_orders row exists (Postgres-safe upsert). */
async function upsertPickedOrderRow(dbRun, dbGet, { orderId, order, userId, confirmedByName }) {
  const existing = await dbGet(`SELECT id FROM picked_orders WHERE outbound_order_id = ? ORDER BY id DESC LIMIT 1`, [
    orderId,
  ]);
  const { warehouseId, delivery, salesDoc, customerRef, soldTo, name1 } = pickedOrderInsertFields(order);
  const byName = confirmedByName || 'Admin Manual';

  if (existing?.id) {
    await dbRun(
      `UPDATE picked_orders SET
        warehouse_id = ?, delivery = ?, sales_doc = ?, customer_reference = ?, sold_to = ?, name_1 = ?,
        confirmed_by_user_id = ?, confirmed_by_user_name = ?, confirmed_at = CURRENT_TIMESTAMP, status = 'Picked'
       WHERE id = ?`,
      [warehouseId, delivery, salesDoc, customerRef, soldTo, name1, userId, byName, existing.id]
    );
    return;
  }

  await dbRun(
    `INSERT INTO picked_orders (
      outbound_order_id, warehouse_id, delivery, sales_doc, customer_reference, sold_to, name_1,
      confirmed_by_user_id, confirmed_by_user_name, confirmed_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'Picked')`,
    [orderId, warehouseId, delivery, salesDoc, customerRef, soldTo, name1, userId, byName]
  );
}

/** When admin override is on, mark line qty columns fully picked (physical txs may be partial). */
async function forceOutboundLinesFullyPickedForAdminOverride(dbRun, dbGet, dbAll, orderId) {
  const items = await dbAll(`SELECT id, required_qty FROM outbound_items WHERE outbound_id = ?`, [orderId]);
  for (const it of items) {
    const bom = await dbGet(`SELECT 1 AS x FROM outbound_bom_requirements WHERE outbound_item_id = ? LIMIT 1`, [it.id]);
    if (bom?.x != null) {
      const obrList = await dbAll(
        `SELECT id, required_child_qty FROM outbound_bom_requirements WHERE outbound_item_id = ? ORDER BY id`,
        [it.id]
      );
      for (const br of obrList) {
        const reqC = Number(br.required_child_qty) || 0;
        await dbRun(
          `UPDATE outbound_bom_requirements SET picked_child_qty = ?, status = 'Picked', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [reqC, br.id]
        );
      }
      await recomputeParentPickedFromBom(dbGet, dbAll, dbRun, it.id);
    } else {
      await dbRun(`UPDATE outbound_items SET picked_qty = ? WHERE id = ?`, [Number(it.required_qty) || 0, it.id]);
    }
  }
}

const OUTBOUND_DOC_STAGE_PRESETS = new Set(['sales_order', 'order_created', 'post_delivery', 'other']);

const UPLOAD_DOC_REL = 'uploads/outbound-documents';
const UPLOAD_DOC_ABS = path.join(__dirname, '..', UPLOAD_DOC_REL);

const orderDocumentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(UPLOAD_DOC_ABS, { recursive: true });
      } catch (e) {
        return cb(e);
      }
      cb(null, UPLOAD_DOC_ABS);
    },
    filename: (req, file, cb) => {
      const oid = Number(req.params.id);
      const ext = path.extname(file.originalname || '') || '';
      cb(null, `ob_${Number.isFinite(oid) ? oid : 0}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
});

function normalizeOutboundDocStage(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (OUTBOUND_DOC_STAGE_PRESETS.has(s)) return s;
  if (!s) return 'sales_order';
  if (/^[a-z][a-z0-9_]{0,39}$/.test(s)) return s.slice(0, 40);
  return 'other';
}

function unlinkOutboundStoredFile(relPath) {
  const rel = String(relPath || '')
    .replace(/^\//, '')
    .replace(/\\/g, '/');
  if (!rel.startsWith('uploads/')) return;
  const abs = path.join(__dirname, '..', rel);
  fs.unlink(abs, () => {});
}

async function assertOutboundWarehouseReadable(req, orderRow) {
  if (!orderRow) return { ok: false, status: 404, message: 'Order not found' };
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'admin') return { ok: true };
  const wid = Number(orderRow.warehouse_id);
  const ok = await userHasWarehouseAccess(req.user.sub, req.user.role, wid);
  if (!ok) return { ok: false, status: 403, message: 'Forbidden for this warehouse' };
  return { ok: true };
}

async function listOutboundOrderDocuments(orderId) {
  return dbAll(
    `SELECT d.id, d.outbound_order_id, d.upload_stage, d.file_name, d.file_path, d.file_mime_type,
            d.uploaded_at, d.uploaded_by, u.username AS uploaded_by_username
       FROM outbound_order_documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.outbound_order_id = ?
   ORDER BY CASE d.upload_stage WHEN 'sales_order' THEN 0 WHEN 'order_created' THEN 1 WHEN 'post_delivery' THEN 2 ELSE 3 END,
            d.uploaded_at ASC, d.id ASC`,
    [orderId]
  );
}

const changePickBodySchema = z.object({
  fifo_suggestion_id: z.coerce.number().int().positive(),
  stock_by_rack_id: z.coerce.number().int().positive(),
});

function pick(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') return row[n];
  }
  return '';
}

/** One row per merged material/SAP key — sums Delivery quantity */
function mergeLinesForDelivery(rows) {
  const map = new Map();
  for (const row of rows) {
    const material = String(pick(row, 'Material', 'material')).trim();
    const sap = String(pick(row, 'SAP Part Number', 'SAP Part number')).trim();
    const desc = String(pick(row, 'Description', 'description')).trim();
    const qty = Number(pick(row, 'Delivery quantity', 'Delivery Quantity')) || 0;
    const key = sap || material;
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        material,
        sap_part_number: sap || material,
        description: desc,
        required_qty: 0,
      });
    }
    const ex = map.get(key);
    ex.required_qty += qty;
    if (!ex.description && desc) ex.description = desc;
    if (!ex.material && material) ex.material = material;
  }
  return [...map.values()];
}

function headerFromRows(rows) {
  const r0 = rows[0] || {};
  return {
    delivery: String(pick(r0, 'Delivery', 'delivery')).trim(),
    sales_doc: String(pick(r0, 'Sales Doc.', 'Sales Doc', 'sales_doc')).trim(),
    customer_reference: String(pick(r0, 'Customer Reference', 'customer_reference')).trim(),
    sold_to: String(pick(r0, 'Sold-to', 'Sold-To', 'sold_to')).trim(),
    name_1: String(pick(r0, 'Name 1', 'Name1', 'name_1')).trim(),
    invoice_number: String(pick(r0, 'Invoice', 'Invoice Number', 'invoice_number')).trim() || null,
  };
}

/** Legacy dedupe for POST / body.items */
function dedupeOutboundItems(items) {
  if (!Array.isArray(items) || !items.length) return [];
  const map = new Map();
  for (const raw of items) {
    const part_number = String(raw.part_number ?? '').trim();
    if (!part_number) continue;
    const required_qty = Number(raw.required_qty) || 0;
    if (map.has(part_number)) {
      map.get(part_number).required_qty += required_qty;
    } else {
      map.set(part_number, { ...raw, part_number, required_qty });
    }
  }
  return [...map.values()];
}

// --- GoDam: Excel upload (before /:id routes) ---
router.post('/upload', requireUploadOutbound, upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'file is required' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = normalizeExcelRows(XLSX.utils.sheet_to_json(sheet, { defval: '' }));
    if (!rows.length) return res.status(400).json({ error: 'Empty sheet' });

    const byDelivery = new Map();
    for (const row of rows) {
      const delivery = String(pick(row, 'Delivery', 'delivery')).trim();
      if (!delivery) continue;
      if (!byDelivery.has(delivery)) byDelivery.set(delivery, []);
      byDelivery.get(delivery).push(row);
    }

    if (!byDelivery.size) return res.status(400).json({ error: 'No Delivery column values found' });

    const userId = req.user?.sub || null;
    const warehouseId = await resolveWarehouseIdForRequest({
      userId,
      role: req.user?.role,
      explicitWarehouseId: req.body?.warehouse_id ?? req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id could not be resolved for this upload' });
    const created = [];
    const results = [];
    const { ensureWorkflowForOutbound } = require('../services/outboundDocumentWorkflowService');

    for (const [, groupRows] of byDelivery) {
      const head = headerFromRows(groupRows);
      const items = mergeLinesForDelivery(groupRows);
      if (!items.length) {
        results.push({
          ok: false,
          error: 'No valid item rows found for this delivery',
          delivery: head.delivery || String(pick(groupRows[0], 'Delivery')).trim(),
          row: groupRows[0],
        });
        continue;
      }

      const deliveryKey = head.delivery || String(pick(groupRows[0], 'Delivery')).trim();

      await dbRun('BEGIN IMMEDIATE');
      try {
        const existing = await dbGet(
          `SELECT id, status FROM outbound_orders
           WHERE warehouse_id = ?
             AND (TRIM(COALESCE(outbound_number, '')) = TRIM(?) OR TRIM(COALESCE(delivery, '')) = TRIM(?))
           LIMIT 1`,
          [warehouseId, deliveryKey, deliveryKey]
        );

        if (existing?.id) {
          throw new Error('Uploaded delivery is already processed.');
        }

        const orderId = await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO outbound_orders (
              outbound_number, delivery, sales_doc, gapp_po, customer_reference, sold_to, name_1,
              sales_order_number, customer_po_number, customer_name, vendor_name,
              status, uploaded_by_user_id, warehouse_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Uploaded', ?, ?, CURRENT_TIMESTAMP)`,
            [
              deliveryKey,
              deliveryKey,
              head.sales_doc,
              head.sales_doc,
              head.customer_reference,
              head.sold_to,
              head.name_1,
              head.sales_doc,
              head.customer_reference,
              head.name_1,
              head.sold_to,
              userId,
              warehouseId,
            ],
            function (err) {
              if (err) reject(err);
              else resolve(this.lastID);
            }
          );
        });

        for (const it of items) {
          const pn = it.material || it.sap_part_number;
          await dbRun(
            `INSERT INTO outbound_items (
              outbound_id, part_number, sap_part_number, material, description,
              required_qty, picked_qty, status, warehouse_id
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?)`,
            [orderId, pn, it.sap_part_number, it.material || pn, it.description || '', it.required_qty, warehouseId]
          );
        }

        await dbRun('COMMIT');
        await expandOutboundBomForOrder(dbRun, dbAll, dbGet, orderId);
        await refreshAllOutboundItemsStock(mainStock, dbAll, dbRun, orderId);
        await generateFifoForOutboundOrder(orderId);
        const order = await outboundOrder.findById(orderId);
        requireOutboundWarehouseId(order, 'upload outbound');
        created.push(order);
        let wfResult = { drive_folder: null, workflow: null, message: null, drive_error: null };
        try {
          wfResult = await ensureWorkflowForOutbound({
            warehouseId,
            orderRow: order,
            userId: Number(req.user.sub),
            invoice_number: head.invoice_number,
            customer_po_number: head.customer_reference,
          });
        } catch (wfErr) {
          wfResult = {
            drive_folder: { error: wfErr.message },
            drive_error: wfErr.message,
            workflow: null,
            message: null,
          };
        }
        results.push({
          ok: true,
          delivery: deliveryKey,
          order_id: order.id,
          item_count: items.length,
          status: order.status,
          outbound_number: order.outbound_number || order.delivery,
          sales_doc: order.sales_doc || order.sales_order_number,
          drive_folder: wfResult.drive_folder,
          workflow: wfResult.workflow,
          drive_message: wfResult.message,
          drive_error: wfResult.drive_error || wfResult.drive_folder?.error || null,
        });
        logAudit({
          warehouse_id: order.warehouse_id || warehouseId,
          req,
          module_name: 'OUTBOUND',
          action_type: 'UPLOADED',
          reference_type: 'outbound_order',
          reference_id: order.id,
          reference_number: order.outbound_number || order.delivery,
          status_before: null,
          status_after: order.status,
          new_value: { source: 'excel_upload', filename: req.file?.originalname || null },
        });
      } catch (e) {
        await dbRun('ROLLBACK').catch(() => {});
        results.push({
          ok: false,
          error: e.message,
          delivery: deliveryKey,
          part_number: items[0]?.material || items[0]?.sap_part_number || '',
          row: groupRows[0],
        });
      }
    }

    res.status(201).json({ orders: created, success: created.length, total: results.length, results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Create or repair Google Drive SO folder tree for an existing outbound (after upload). */
router.post('/:id/ensure-drive-folders', requirePermission('can_upload_outbound'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order = await outboundOrder.findById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const { ensureWorkflowForOutbound } = require('../services/outboundDocumentWorkflowService');
    const payload = await ensureWorkflowForOutbound({
      warehouseId: order.warehouse_id,
      orderRow: order,
      userId: Number(req.user.sub),
      customer_po_number: order.customer_po_number || order.customer_reference,
    });
    if (payload.drive_error || payload.drive_folder?.error) {
      return res.status(400).json({
        error: payload.drive_error || payload.drive_folder.error,
        ...payload,
      });
    }
    res.json(payload);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/check-stock', requirePermission('can_upload_outbound'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const before = await dbGet(`SELECT status, outbound_number, delivery, warehouse_id FROM outbound_orders WHERE id = ?`, [orderId]);
    await expandOutboundBomForOrder(dbRun, dbAll, dbGet, orderId);
    await refreshAllOutboundItemsStock(mainStock, dbAll, dbRun, orderId);
    await dbRun(`UPDATE outbound_orders SET status = 'Stock Checked', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      orderId,
    ]);
    const order = await outboundOrder.findById(orderId);
    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'UPDATED',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: order.outbound_number || order.delivery,
      status_before: before?.status,
      status_after: 'Stock Checked',
      remarks: 'Stock check completed',
    });
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/generate-fifo', requirePermission('can_upload_outbound'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order0 = await dbGet(`SELECT outbound_number, delivery, warehouse_id, status FROM outbound_orders WHERE id = ?`, [orderId]);
    const fifo = await generateFifoForOutboundOrder(orderId);
    logAudit({
      warehouse_id: order0?.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'UPDATED',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: order0?.outbound_number || order0?.delivery,
      status_before: order0?.status,
      status_after: order0?.status,
      remarks: 'FIFO generated',
      new_value: { fifo_lines: Array.isArray(fifo) ? fifo.length : null },
    });
    res.json({ ok: true, fifo_suggestions: fifo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id/bom-requirements', requireAnyPermission(['can_upload_outbound', 'can_view_orders', 'can_pick_orders']), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!orderId) return res.status(400).json({ error: 'Invalid id' });
    const rows = await listBomRequirementsForOrder(dbAll, orderId);
    res.json({ outbound_order_id: orderId, bom_requirements: rows });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/expand-bom', requirePermission('can_upload_outbound'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!orderId) return res.status(400).json({ error: 'Invalid id' });
    await expandOutboundBomForOrder(dbRun, dbAll, dbGet, orderId);
    await refreshAllOutboundItemsStock(mainStock, dbAll, dbRun, orderId);
    await generateFifoForOutboundOrder(orderId);
    const order = await outboundOrder.findById(orderId);
    const fifo = await listFifoForOrder(orderId);
    const bom_requirements = await listBomRequirementsForOrder(dbAll, orderId);
    res.json({ ok: true, order: { ...order, fifo_suggestions: fifo, bom_requirements } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Uploaders, managers, and checkers can release orders to mobile pickers. */
function requireSendForPick(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager' || role === 'checker') return next();
  const perms = req.user.permissions || {};
  if (perms.can_upload_outbound || perms.can_confirm_picked || perms.can_pick_orders) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

router.post('/:id/send-for-pick', requireSendForPick, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!orderId) return res.status(400).json({ error: 'Invalid id' });
    const result = await sendOutboundOrderForPick(dbRun, dbGet, orderId, req);
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
  }
});

router.post('/:id/manual-pick', requireAdmin, async (req, res) => {
  const orderId = Number(req.params.id);
  const direct = !!req.body?.direct;
  const override = !!req.body?.override || direct;
  const reason =
    String(req.body?.reason || '').trim() ||
    (direct ? 'Admin direct pick (skip mobile workflow)' : '');
  if (!orderId) return res.status(400).json({ error: 'Invalid id' });
  if (override && !reason) return res.status(400).json({ error: 'Override reason is required' });

  try {
    const adminRow = await dbGet(`SELECT id, full_name, username FROM users WHERE id = ?`, [req.user.sub]);
    const adminName = adminRow?.full_name || adminRow?.username || req.user.username || 'Admin';

    if (direct) {
      await refreshAllOutboundItemsStock(mainStock, dbAll, dbRun, orderId);
      await generateFifoForOutboundOrder(orderId);
    }

    await dbRun('BEGIN IMMEDIATE');

    const order = await dbGet(`SELECT * FROM outbound_orders WHERE id = ?`, [orderId]);
    if (!order) throw new Error('Order not found');
    if (['Picked', 'Delivered', 'Cancelled'].includes(String(order.status || ''))) {
      throw new Error(`Manual pick is closed for status ${order.status}`);
    }

    const existingPick = await dbGet(
      `SELECT COUNT(1) AS c FROM picked_transactions WHERE outbound_order_id = ?`,
      [orderId]
    );
    await dbRun('COMMIT');

    if (!override && !(Number(existingPick?.c) > 0)) {
      await generateFifoForOutboundOrder(orderId);
    }

    await dbRun('BEGIN IMMEDIATE');

    const orderFresh = await dbGet(`SELECT * FROM outbound_orders WHERE id = ?`, [orderId]);
    const items = await dbAll(
      `SELECT i.*,
        (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE outbound_item_id = i.id) AS picked_from_tx
       FROM outbound_items i
       WHERE i.outbound_id = ?
       ORDER BY i.id`,
      [orderId]
    );

    if (!items.length) throw new Error('Order has no items');

    const pickedLines = [];
    for (const item of items) {
      const bomCheck = await dbGet(
        `SELECT COUNT(1) AS c FROM outbound_bom_requirements WHERE outbound_item_id = ?`,
        [item.id]
      );
      const isBomItem = Number(bomCheck?.c) > 0;

      let remaining = 0;
      if (isBomItem) {
        const obrList = await dbAll(
          `SELECT * FROM outbound_bom_requirements WHERE outbound_item_id = ? ORDER BY id`,
          [item.id]
        );
        for (const br of obrList) {
          const sumChild = await dbGet(
            `SELECT COALESCE(SUM(picked_qty), 0) AS x FROM picked_transactions WHERE outbound_bom_requirement_id = ?`,
            [br.id]
          );
          remaining += Math.max(0, Number(br.required_child_qty) - (Number(sumChild?.x) || 0));
        }
      } else {
        const already0 = Math.max(Number(item.picked_qty) || 0, Number(item.picked_from_tx) || 0);
        const required0 = Number(item.required_qty) || 0;
        remaining = Math.max(0, required0 - already0);
      }
      if (remaining <= QTY_EPS) continue;

      const fifoRows = await dbAll(
        `SELECT f.*,
          (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE fifo_suggestion_id = f.id) AS fifo_picked_qty
         FROM fifo_suggestions f
         WHERE f.outbound_order_id = ? AND f.outbound_item_id = ?
         ORDER BY ${fifoDateOrderExpr('f.entry_date', db)} ASC, f.id ASC`,
        [orderId, item.id]
      );

      const fifoAvailable = fifoRows.reduce(
        (sum, f) => sum + Math.max(0, (Number(f.suggested_qty) || 0) - (Number(f.fifo_picked_qty) || 0)),
        0
      );
      /* Allow picking even when FIFO suggestion is absent or insufficient.
         First exhaust any existing FIFO rows (FIFO order), then fall back to
         stock_by_rack rows ordered by first_entry_date (same FIFO logic). */
      const needFallback = fifoAvailable + QTY_EPS < remaining;

      let itemPickedNow = 0;
      for (const f of fifoRows) {
        if (remaining <= QTY_EPS) break;
        const fifoRemaining = Math.max(0, (Number(f.suggested_qty) || 0) - (Number(f.fifo_picked_qty) || 0));
        if (fifoRemaining <= QTY_EPS) continue;
        const pickQty = Math.min(remaining, fifoRemaining);

        const rack = await dbGet(`SELECT * FROM stock_by_rack WHERE id = ?`, [f.stock_by_rack_id]);
        if (!rack) throw new Error(`Rack row missing for FIFO line ${f.id}`);
        const rackAvail = Number(rack.available_qty) || 0;
        if (pickQty > rackAvail + QTY_EPS) {
          if (override) {
            pickQty = Math.min(remaining, fifoRemaining, rackAvail);
            if (pickQty <= QTY_EPS) continue;
          } else {
            throw new Error(`Insufficient rack qty at ${f.rack_location}: need ${pickQty}, available ${rackAvail}`);
          }
        }

        const obrId = Number(f.outbound_bom_requirement_id) || 0;
        const obr = obrId ? await dbGet(`SELECT * FROM outbound_bom_requirements WHERE id = ?`, [obrId]) : null;
        const mat = obr ? obr.child_part_number : item.material || item.part_number;
        const sap = obr ? obr.child_sap_part_number || '' : item.sap_part_number;
        const desc = obr ? obr.child_description || '' : item.description;
        const isBomPick = obr ? 1 : 0;
        const parentPn = obr ? obr.parent_part_number : null;
        const childPn = obr ? obr.child_part_number : null;
        const childPer = obr ? obr.child_qty_per_parent : null;

        const warehouseId = resolvePickWarehouseId({ order: orderFresh, rackRow: rack, fifoSuggestion: f });
        if (!warehouseId) throw new Error('Order warehouse is not set; cannot record pick.');

        await dbRun(
          `INSERT INTO picked_transactions (
            warehouse_id, outbound_order_id, outbound_item_id, fifo_suggestion_id, user_id, user_name,
            material, sap_part_number, description, rack_location, picked_qty, device_id,
            picked_method, is_manual_pick, manual_pick_reason, picked_by_role,
            outbound_bom_requirement_id, parent_part_number, child_part_number, is_bom_pick, child_qty_per_parent
          ) VALUES (?, ?, ?, ?, ?, 'Admin Manual', ?, ?, ?, ?, ?, NULL, 'Manual Admin', 1, ?, ?, ?, ?, ?, ?, ?)`,
          [
            warehouseId,
            orderId,
            item.id,
            f.id,
            req.user.sub,
            mat,
            sap,
            desc,
            f.rack_location,
            pickQty,
            override ? reason : null,
            String(req.user.role || 'admin').toLowerCase(),
            obrId || null,
            parentPn,
            childPn,
            isBomPick,
            childPer,
          ]
        );

        await dbRun(
          `UPDATE stock_by_rack
           SET available_qty = ?, total_out_qty = ?, last_updated = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [rackAvail - pickQty, (Number(rack.total_out_qty) || 0) + pickQty, rack.id]
        );

        const today = new Date().toISOString().slice(0, 10);
        await insertPickStockOut(dbRun, {
          warehouseId,
          transaction_date: today,
          part_number: rack.part_number,
          sap_part_number: rack.sap_part_number || '',
          description: rack.description || '',
          rack_location: f.rack_location,
          qty_out: pickQty,
          outbound_number: orderFresh.delivery || orderFresh.outbound_number || String(orderId),
          reference_no: `manual_pick_fifo_${f.id}`,
          remarks: override ? `Admin Manual override:${reason}` : `Admin Manual:${adminName}`,
        });

        remaining -= pickQty;
        itemPickedNow += pickQty;
        pickedLines.push({
          outbound_item_id: item.id,
          fifo_suggestion_id: f.id,
          rack_location: f.rack_location,
          entry_date: f.entry_date,
          picked_qty: pickQty,
        });
      }

      /* Fallback: no FIFO suggestion or suggestion was insufficient — pick from rack directly (FIFO date order). */
      if (needFallback && remaining > QTY_EPS) {
        const partKey = item.material || item.part_number || '';
        const sapKey = item.sap_part_number || '';
        const keys = [...new Set([partKey, sapKey].filter(Boolean))];
        const ph = keys.map(() => '?').join(', ');
        const directRackRows = keys.length ? await dbAll(
          `SELECT * FROM stock_by_rack
           WHERE available_qty > 0
             AND (part_number IN (${ph}) OR COALESCE(sap_part_number,'') IN (${ph}))
           ORDER BY ${fifoDateOrderExpr('first_entry_date', db)} ASC, id ASC`,
          [...keys, ...keys]
        ) : [];

        for (const rack of directRackRows) {
          if (remaining <= QTY_EPS) break;
          const rackAvail = Number(rack.available_qty) || 0;
          if (rackAvail <= QTY_EPS) continue;
          const pickQty = Math.min(remaining, rackAvail);
          const mat = partKey || rack.part_number;
          const today = new Date().toISOString().slice(0, 10);

          const warehouseIdFallback = resolvePickWarehouseId({ order: orderFresh, rackRow: rack });
          if (!warehouseIdFallback) throw new Error('Order warehouse is not set; cannot record pick.');

          await dbRun(
            `INSERT INTO picked_transactions (
              warehouse_id, outbound_order_id, outbound_item_id, fifo_suggestion_id, user_id, user_name,
              material, sap_part_number, description, rack_location, picked_qty, device_id,
              picked_method, is_manual_pick, manual_pick_reason, picked_by_role,
              outbound_bom_requirement_id, parent_part_number, child_part_number, is_bom_pick, child_qty_per_parent
            ) VALUES (?, ?, ?, NULL, ?, 'Admin Manual', ?, ?, ?, ?, ?, NULL, 'Manual Admin (no FIFO)', 1, ?, ?, NULL, NULL, NULL, 0, NULL)`,
            [
              warehouseIdFallback,
              orderId,
              item.id,
              req.user.sub,
              mat,
              sapKey,
              item.description || '',
              rack.rack_location,
              pickQty,
              override ? reason : 'Picked without FIFO suggestion',
              String(req.user.role || 'admin').toLowerCase(),
            ]
          );

          await dbRun(
            `UPDATE stock_by_rack SET available_qty = ?, total_out_qty = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`,
            [rackAvail - pickQty, (Number(rack.total_out_qty) || 0) + pickQty, rack.id]
          );

          await insertPickStockOut(dbRun, {
            warehouseId: warehouseIdFallback,
            transaction_date: today,
            part_number: rack.part_number,
            sap_part_number: rack.sap_part_number || '',
            description: rack.description || '',
            rack_location: rack.rack_location,
            qty_out: pickQty,
            outbound_number: orderFresh.delivery || orderFresh.outbound_number || String(orderId),
            reference_no: `manual_pick_no_fifo_rack_${rack.id}`,
            remarks: override ? `Admin Manual override:${reason}` : `Admin Manual (no FIFO):${adminName}`,
          });

          remaining -= pickQty;
          itemPickedNow += pickQty;
          pickedLines.push({
            outbound_item_id: item.id,
            fifo_suggestion_id: null,
            rack_location: rack.rack_location,
            entry_date: rack.first_entry_date,
            picked_qty: pickQty,
          });
        }
        /* If still remaining after all rack rows, that is a genuine shortage — we continue (partial pick) rather than blocking. */
      }

      if (isBomItem) {
        await syncBomRequirementPickedFromTransactions(dbRun, dbGet, dbAll, item.id);
        await recomputeParentPickedFromBom(dbGet, dbAll, dbRun, item.id);
      } else {
        const already0 = Math.max(Number(item.picked_qty) || 0, Number(item.picked_from_tx) || 0);
        await dbRun(`UPDATE outbound_items SET picked_qty = ? WHERE id = ?`, [already0 + itemPickedNow, item.id]);
      }
    }

    const itemsCheck = await dbAll(
      `SELECT i.*,
        (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE outbound_item_id = i.id) AS picked_from_tx
       FROM outbound_items i
       WHERE i.outbound_id = ?
       ORDER BY i.id`,
      [orderId]
    );
    const shortfalls = [];
    for (const it of itemsCheck) {
      const ok = await outboundItemLineIsFullyPicked(dbGet, dbAll, it);
      if (!ok) shortfalls.push({ id: it.id });
    }
    const shortfallLineCount = shortfalls.length;

    if (override && shortfallLineCount) {
      await forceOutboundLinesFullyPickedForAdminOverride(dbRun, dbGet, dbAll, orderId);
    }

    /* Admin manual pick always closes as Picked (same as mobile confirm-order). */
    await upsertPickedOrderRow(dbRun, dbGet, {
      orderId,
      order: orderFresh,
      userId: req.user.sub,
      confirmedByName: adminName,
    });
    await dbRun(`UPDATE outbound_orders SET status = 'Picked', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [orderId]);

    await dbRun('COMMIT');

    const updated = await outboundOrder.findById(orderId);
    const fifo = await listFifoForOrder(orderId);
    const pickFootprint = await loadOutboundPickFootprint({ dbGet, dbAll, orderId });
    logAudit({
      warehouse_id: orderFresh.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'MANUAL_PICK',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: orderFresh.outbound_number || orderFresh.delivery,
      status_before: order.status,
      status_after: updated.status,
      remarks: override ? `override:${reason}` : null,
      new_value: {
        picked_lines: pickedLines.length,
        override: !!override,
        partial_pick: shortfallLineCount > 0,
      },
    });
    res.json({
      ok: true,
      status: 'Picked',
      direct: !!direct,
      partial_pick: shortfallLineCount > 0,
      shortfall_line_count: shortfallLineCount,
      picked_lines: pickedLines,
      order: { ...updated, fifo_suggestions: fifo, ...pickFootprint },
    });
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  }
});

/** Same as delivery-note deliver — deduct main_stock only here (sold_out_qty), insert sold_out + guard double delivery. */
router.post('/:id/mark-delivered', requireMarkDelivered, async (req, res) => {
  const orderId = Number(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await markOutboundDelivered(db, orderId, { requireInvoice: true });
    const o = await dbGet(`SELECT outbound_number, delivery, warehouse_id, status FROM outbound_orders WHERE id = ?`, [orderId]);
    logAudit({
      warehouse_id: o?.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'MARK_DELIVERED',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: o?.outbound_number || o?.delivery,
      status_after: o?.status,
      new_value: { ok: result?.ok },
    });
    res.json(result);
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ error: e.message, shortages: e.shortages });
  }
});

/** Undo mark-delivered (reject/return before restocking rack separately): restores main_stock, removes sold_out rows for this delivery. */
router.post('/:id/reverse-delivery', requirePermission('can_upload_outbound'), async (req, res) => {
  const orderId = Number(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await reverseOutboundDelivered(db, orderId);
    const o = await dbGet(`SELECT outbound_number, delivery, warehouse_id, status FROM outbound_orders WHERE id = ?`, [orderId]);
    logAudit({
      warehouse_id: o?.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'UPDATED',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: o?.outbound_number || o?.delivery,
      remarks: 'reverse-delivery',
      status_after: o?.status,
    });
    res.json(result);
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ error: e.message });
  }
});

/** Undo picked order: restore rack quantities, remove pick tx rows, keep picked_orders row as Reversed. */
router.post('/:id/reverse-picked', requireAnyPermission(['can_upload_outbound', 'can_confirm_picked']), async (req, res) => {
  const orderId = Number(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid id' });
  try {
    const userRow = await dbGet(`SELECT full_name, username FROM users WHERE id = ?`, [req.user.sub]).catch(() => null);
    const result = await reversePickedOrder(db, orderId, {
      userId: req.user.sub,
      userName: userRow?.full_name || userRow?.username || req.user.username,
      reason: req.body?.reason || 'web reverse picked',
    });
    const o = await dbGet(`SELECT outbound_number, delivery, warehouse_id, status FROM outbound_orders WHERE id = ?`, [orderId]);
    logAudit({
      warehouse_id: o?.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'PICK_REVERSED',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: o?.outbound_number || o?.delivery,
      remarks: req.body?.reason || 'reverse-picked',
      status_after: o?.status,
      new_value: result,
    });
    res.json(result);
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ error: e.message });
  }
});

/** Link outbound to customer master ID (customer_number) for Drive Customer_PO folder naming. */
router.patch('/:id/customer-link', requirePermission('can_upload_outbound'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!orderId) return res.status(400).json({ error: 'Invalid id' });
    const customer_number = String(req.body?.customer_number || '').trim();
    if (!customer_number) return res.status(400).json({ error: 'customer_number is required' });
    const order = await dbGet(`SELECT id, warehouse_id FROM outbound_orders WHERE id = ?`, [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const gate = await assertOutboundWarehouseReadable(req, order);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.message });
    await dbRun(
      `UPDATE outbound_orders SET customer_po_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [customer_number, orderId]
    );
    res.json(await outboundOrder.findById(orderId));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Sales order attachment (single stage) + Google Drive Customer_PO folder when Sales Doc. is set. */
router.post(
  '/:id/order-documents',
  requirePermission('can_upload_outbound'),
  (req, res, next) => {
    orderDocumentUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || String(err) });
      next();
    });
  },
  async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      if (!orderId) return res.status(400).json({ error: 'Invalid id' });
      const order = await dbGet(
        `SELECT id, warehouse_id, outbound_number, delivery, sales_doc, sales_order_number,
                customer_po_number, customer_reference, customer_name, sold_to, name_1
         FROM outbound_orders WHERE id = ?`,
        [orderId]
      );
      const gate = await assertOutboundWarehouseReadable(req, order);
      if (!gate.ok) return res.status(gate.status).json({ error: gate.message });
      if (!req.file) return res.status(400).json({ error: 'file is required' });

      const customer_number = String(req.body?.customer_number || '').trim();
      if (customer_number) {
        await dbRun(
          `UPDATE outbound_orders SET customer_po_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [customer_number, orderId]
        );
        order.customer_po_number = customer_number;
      }

      const upload_stage = normalizeOutboundDocStage(req.body?.upload_stage || 'sales_order');
      const rel = path.join(UPLOAD_DOC_REL, req.file.filename).replace(/\\/g, '/');
      const insertId = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO outbound_order_documents (outbound_order_id, upload_stage, file_name, file_path, file_mime_type, uploaded_at, uploaded_by)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
          [
            orderId,
            upload_stage,
            req.file.originalname || req.file.filename,
            rel,
            req.file.mimetype || null,
            req.user.sub || null,
          ],
          function onRun(err) {
            if (err) reject(err);
            else resolve(this.lastID);
          }
        );
      });
      const row = await dbGet(`SELECT * FROM outbound_order_documents WHERE id = ?`, [insertId]);

      const salesOrderNumber = String(order.sales_doc || order.sales_order_number || '').trim();
      let drive_document = null;
      let drive_error = null;
      let drive_folder_link = null;

      if (salesOrderNumber) {
        try {
          const wf = await ensureWorkflowForOutbound({
            warehouseId: order.warehouse_id,
            orderRow: order,
            userId: Number(req.user.sub),
            customer_po_number: order.customer_po_number || order.customer_reference,
          });
          drive_folder_link = wf?.drive_folder?.folder_link || wf?.folder_link || null;

          let flow = await uploadDocumentFlow({
            warehouseId: order.warehouse_id,
            salesOrderNumber,
            documentType: DOC_TYPES.CUSTOMER_PO,
            localPath: req.file.path,
            mimeType: req.file.mimetype,
            originalName: req.file.originalname,
            userId: Number(req.user.sub),
            outbound_number: order.outbound_number || order.delivery,
            customer_po_number: order.customer_po_number || customer_number || order.customer_reference,
            customer_name: order.customer_name || order.name_1,
            duplicate_action: null,
          });
          if (flow?.conflict && !flow?.document) {
            flow = await uploadDocumentFlow({
              warehouseId: order.warehouse_id,
              salesOrderNumber,
              documentType: DOC_TYPES.CUSTOMER_PO,
              localPath: req.file.path,
              mimeType: req.file.mimetype,
              originalName: req.file.originalname,
              userId: Number(req.user.sub),
              outbound_number: order.outbound_number || order.delivery,
              customer_po_number: order.customer_po_number || customer_number || order.customer_reference,
              customer_name: order.customer_name || order.name_1,
              duplicate_action: 'version',
            });
          }
          drive_document = flow?.document || null;
        } catch (e) {
          drive_error = e.message;
        }
      } else {
        drive_error = 'Sales Doc. missing on outbound — cannot save to Google Drive.';
      }

      logAudit({
        warehouse_id: order.warehouse_id,
        req,
        module_name: 'OUTBOUND',
        action_type: 'DOCUMENT_UPLOADED',
        reference_type: 'outbound_order',
        reference_id: orderId,
        reference_number: order.outbound_number || order.delivery,
        new_value: {
          document_id: row?.id,
          upload_stage,
          file_name: row?.file_name,
          customer_number: customer_number || order.customer_po_number,
          drive_file_id: drive_document?.cloud_file_id,
        },
      });
      res.status(201).json({
        ...row,
        drive_document,
        drive_error,
        drive_folder_link,
        customer_po_number: order.customer_po_number,
      });
    } catch (e) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: e.message });
    }
  }
);

router.delete('/:id/order-documents/:docId', requirePermission('can_upload_outbound'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const docId = Number(req.params.docId);
    if (!orderId || !docId) return res.status(400).json({ error: 'Invalid id' });
    const order = await dbGet(`SELECT id, warehouse_id, outbound_number, delivery FROM outbound_orders WHERE id = ?`, [orderId]);
    const gate = await assertOutboundWarehouseReadable(req, order);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.message });
    const doc = await dbGet(`SELECT * FROM outbound_order_documents WHERE id = ? AND outbound_order_id = ?`, [docId, orderId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    unlinkOutboundStoredFile(doc.file_path);
    await dbRun(`DELETE FROM outbound_order_documents WHERE id = ?`, [docId]);
    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'DOCUMENT_DELETED',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: order.outbound_number || order.delivery,
      old_value: { document_id: docId, file_name: doc.file_name },
    });
    res.json({ ok: true, deleted: docId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post(
  '/:id/change-pick-location',
  requireAdmin,
  zodValidate(changePickBodySchema),
  async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { fifo_suggestion_id, stock_by_rack_id } = req.validatedBody;
    const sid = Number(fifo_suggestion_id);
    const rid = Number(stock_by_rack_id);

    const sug = await dbGet(`SELECT * FROM fifo_suggestions WHERE id = ? AND outbound_order_id = ?`, [sid, orderId]);
    if (!sug) return res.status(404).json({ error: 'FIFO suggestion not found' });

    const rack = await dbGet(`SELECT * FROM stock_by_rack WHERE id = ?`, [rid]);
    if (!rack) return res.status(404).json({ error: 'Rack row not found' });

    const keys = [
      String(sug.material || '').trim(),
      String(sug.sap_part_number || '').trim(),
    ].filter(Boolean);
    const match =
      keys.includes(String(rack.part_number || '').trim()) ||
      keys.includes(String(rack.sap_part_number || '').trim());
    if (!match) return res.status(400).json({ error: 'Selected rack does not match item part/SAP' });

    await dbRun(
      `UPDATE fifo_suggestions SET
        stock_by_rack_id = ?,
        rack_location = ?,
        entry_date = ?,
        available_qty = ?,
        is_admin_changed = 1,
        changed_by_admin_id = ?
       WHERE id = ?`,
      [
        rack.id,
        rack.rack_location,
        rack.first_entry_date || null,
        rack.available_qty,
        req.user.sub,
        sid,
      ]
    );

    await notifyPickProgress(
      'Pick location updated',
      `Outbound: ${orderId} rack changed by admin`,
      { outbound_order_id: orderId, fifo_suggestion_id: sid }
    );

    const updated = await dbGet(`SELECT * FROM fifo_suggestions WHERE id = ?`, [sid]);
    const ord = await outboundOrder.findById(orderId);
    logAudit({
      warehouse_id: ord?.warehouse_id,
      req,
      module_name: 'PICKING',
      action_type: 'UPDATED',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: ord?.outbound_number || ord?.delivery,
      remarks: 'change-pick-location',
      new_value: { fifo_suggestion_id: sid, stock_by_rack_id: rid },
    });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
  }
);

// Admin: update FIFO suggested quantity
router.put('/:id/fifo/:fifoId', requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const fifoId = Number(req.params.fifoId);
    const suggested_qty = Number(req.body?.suggested_qty);
    if (!orderId || !fifoId) return res.status(400).json({ error: 'Invalid id' });
    if (!Number.isFinite(suggested_qty) || suggested_qty <= 0) {
      return res.status(400).json({ error: 'suggested_qty must be > 0' });
    }
    const row = await dbGet(`SELECT * FROM fifo_suggestions WHERE id = ? AND outbound_order_id = ?`, [fifoId, orderId]);
    if (!row) return res.status(404).json({ error: 'FIFO suggestion not found' });
    await dbRun(
      `UPDATE fifo_suggestions SET suggested_qty = ?, is_admin_changed = 1, changed_by_admin_id = ? WHERE id = ?`,
      [suggested_qty, req.user.sub, fifoId]
    );
    const order = await outboundOrder.findById(orderId);
    const fifo = await listFifoForOrder(orderId);
    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'ADMIN_OVERRIDE',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: order.outbound_number || order.delivery,
      new_value: { fifo_id: fifoId, suggested_qty },
    });
    res.json({ ...order, fifo_suggestions: fifo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Admin: delete a FIFO line
router.delete('/:id/fifo/:fifoId', requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const fifoId = Number(req.params.fifoId);
    if (!orderId || !fifoId) return res.status(400).json({ error: 'Invalid id' });
    const row = await dbGet(`SELECT * FROM fifo_suggestions WHERE id = ? AND outbound_order_id = ?`, [fifoId, orderId]);
    if (!row) return res.status(404).json({ error: 'FIFO suggestion not found' });
    await dbRun(`DELETE FROM fifo_suggestions WHERE id = ?`, [fifoId]);
    const order = await outboundOrder.findById(orderId);
    const fifo = await listFifoForOrder(orderId);
    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'ADMIN_OVERRIDE',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: order.outbound_number || order.delivery,
      remarks: `FIFO line deleted id=${fifoId}`,
      old_value: { fifo_suggestion_id: fifoId },
    });
    res.json({ ...order, fifo_suggestions: fifo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/outbound/:id/items/:itemId - Update required qty (uploader/admin)
router.put('/:id/items/:itemId', requirePermission('can_upload_outbound'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const required_qty = Number(req.body?.required_qty);
    if (!orderId || !itemId) return res.status(400).json({ error: 'Invalid id' });
    if (!Number.isFinite(required_qty) || required_qty <= 0) {
      return res.status(400).json({ error: 'required_qty must be a positive number' });
    }

    const order = await dbGet('SELECT * FROM outbound_orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const st = String(order.status || '').toLowerCase();
    if (['picked', 'delivered'].includes(st)) {
      return res.status(400).json({ error: `Cannot edit an order with status ${order.status}` });
    }

    const role = String(req.user?.role || '').toLowerCase();
    const isAdmin = role === 'admin';
    const isUploader = Number(order.uploaded_by_user_id || 0) === Number(req.user?.sub || 0);
    if (!isAdmin && !isUploader) return res.status(403).json({ error: 'Forbidden' });

    const item = await dbGet('SELECT * FROM outbound_items WHERE id = ? AND outbound_id = ?', [itemId, orderId]);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    await dbRun(`UPDATE outbound_items SET required_qty = ? WHERE id = ?`, [required_qty, itemId]);

    await expandOutboundBomForOrder(dbRun, dbAll, dbGet, orderId);
    await refreshAllOutboundItemsStock(mainStock, dbAll, dbRun, orderId);

    await generateFifoForOutboundOrder(orderId);
    const updated = await outboundOrder.findById(orderId);
    const fifo = await listFifoForOrder(orderId);
    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'UPDATED',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: order.outbound_number || order.delivery,
      new_value: { outbound_item_id: itemId, required_qty },
    });
    return res.json({ ...updated, fifo_suggestions: fifo });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// PATCH /api/outbound/:id/warehouse — admin reassign order to another warehouse
router.patch('/:id/warehouse', requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const newWarehouseId = Number(req.body?.warehouse_id);
    if (!orderId) return res.status(400).json({ error: 'Invalid id' });
    if (!newWarehouseId) return res.status(400).json({ error: 'warehouse_id is required' });
    const result = await reassignOutboundWarehouse({ orderId, newWarehouseId, req });
    res.json(result);
  } catch (e) {
    const code = e.statusCode || 400;
    res.status(code).json({ error: e.message });
  }
});

// GET /api/outbound - List orders
router.get('/', async (req, res) => {
  try {
    const gate = await assertExplicitWarehouseParamAllowed(req);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.message });
    const scope = await resolveReadWarehouseScope(req);
    const { search, status, page = 1, limit = 20 } = req.query;
    const orders = await outboundOrder.findAll({
      search: search || '',
      status: status || '',
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      warehouse_id: scope.mode === 'all' ? undefined : scope.warehouseId,
    });
    const ids = (orders || []).map((o) => Number(o.id)).filter(Boolean);
    if (!ids.length) return res.json(orders);
    const placeholders = ids.map(() => '?').join(',');
    const whRows = await dbAll(
      `SELECT o.id, o.warehouse_id, w.warehouse_code, w.warehouse_name
       FROM outbound_orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
       WHERE o.id IN (${placeholders})`,
      ids
    );
    const whMap = new Map((whRows || []).map((r) => [Number(r.id), r]));
    res.json(
      orders.map((o) => {
        const w = whMap.get(Number(o.id));
        return w
          ? {
              ...o,
              warehouse_id: w.warehouse_id,
              warehouse_code: w.warehouse_code,
              warehouse_name: w.warehouse_name,
            }
          : o;
      })
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/outbound/:id - Delete outbound (uploader/admin)
router.delete('/:id', requirePermission('can_upload_outbound'), async (req, res) => {
  const orderId = Number(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid id' });
  await dbRun('BEGIN IMMEDIATE');
  try {
    const order = await dbGet('SELECT * FROM outbound_orders WHERE id = ?', [orderId]);
    if (!order) {
      await dbRun('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Order not found' });
    }

    const role = String(req.user?.role || '').toLowerCase();
    const isAdmin = role === 'admin';
    const isUploader = Number(order.uploaded_by_user_id || 0) === Number(req.user?.sub || 0);
    if (!isAdmin && !isUploader) {
      await dbRun('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Keep history safe: do not delete completed outbounds.
    const st = String(order.status || '').toLowerCase();
    if (['picked', 'delivered'].includes(st)) {
      await dbRun('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: `Cannot delete an order with status ${order.status}` });
    }

    const docRows = await dbAll(`SELECT file_path FROM outbound_order_documents WHERE outbound_order_id = ?`, [orderId]);
    for (const dr of docRows || []) unlinkOutboundStoredFile(dr.file_path);

    await dbRun('DELETE FROM fifo_suggestions WHERE outbound_order_id = ?', [orderId]);
    await dbRun('DELETE FROM pick_change_requests WHERE outbound_order_id = ?', [orderId]).catch(() => {});
    await dbRun('DELETE FROM pick_suggestions WHERE outbound_id = ?', [orderId]).catch(() => {});
    await dbRun('DELETE FROM picked_transactions WHERE outbound_order_id = ?', [orderId]).catch(() => {});
    await dbRun('DELETE FROM picked_orders WHERE outbound_order_id = ?', [orderId]).catch(() => {});
    await dbRun('DELETE FROM delivered_outbounds WHERE outbound_id = ?', [orderId]).catch(() => {});
    await dbRun('DELETE FROM outbound_items WHERE outbound_id = ?', [orderId]);
    await dbRun('DELETE FROM outbound_orders WHERE id = ?', [orderId]);

    await dbRun('COMMIT');
    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'DELETED',
      reference_type: 'outbound_order',
      reference_id: orderId,
      reference_number: order.outbound_number || order.delivery,
      status_before: order.status,
      remarks: 'outbound_cancelled_or_removed',
    });
    return res.json({ ok: true, deleted: true, id: orderId });
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    return res.status(400).json({ error: e.message });
  }
});

// POST /api/outbound - Create order (legacy)
router.post('/', async (req, res) => {
  try {
    const userId = req.user?.sub || null;
    const warehouseId = await resolveWarehouseIdForRequest({
      userId,
      role: req.user?.role,
      explicitWarehouseId: req.body.warehouse_id ?? req.query?.warehouse_id,
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });

    const order = await outboundOrder.create({ ...req.body, warehouse_id: warehouseId });

    if (req.body.items && Array.isArray(req.body.items)) {
      const merged = dedupeOutboundItems(req.body.items);
      for (const item of merged) {
        await outboundItem.create({ ...item, outbound_id: order.id, warehouse_id: warehouseId });
      }
    }

    await expandOutboundBomForOrder(dbRun, dbAll, dbGet, order.id);
    await refreshAllOutboundItemsStock(mainStock, dbAll, dbRun, order.id);
    await generateFifoForOutboundOrder(order.id).catch(() => {});

    res.status(201).json(order);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/outbound/:id - Get order with items + fifo
router.get('/:id', async (req, res) => {
  try {
    const gate = await assertExplicitWarehouseParamAllowed(req);
    if (!gate.ok) return res.status(gate.status).json({ error: gate.message });
    const order = await dbGet(
      `SELECT o.*, w.warehouse_code, w.warehouse_name
       FROM outbound_orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
       WHERE o.id = ?`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const role = String(req.user?.role || '').toLowerCase();
    if (role !== 'admin') {
      const wid = Number(order.warehouse_id);
      const ok = await userHasWarehouseAccess(req.user.sub, req.user.role, wid);
      if (!ok) return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const fifo = await listFifoForOrder(order.id);
    const order_documents = await listOutboundOrderDocuments(order.id);
    const pickFootprint = await loadOutboundPickFootprint({ dbGet, dbAll, orderId: order.id });
    const itemsWithTx = await dbAll(
      `SELECT i.*,
        (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions
         WHERE outbound_item_id = i.id AND COALESCE(is_bom_pick, 0) = 0) AS picked_from_tx
       FROM outbound_items i WHERE i.outbound_id = ? ORDER BY i.id`,
      [order.id]
    );
    const items = (itemsWithTx || []).map((it) => {
      const txSum = Number(it.picked_from_tx) || 0;
      const col = Number(it.picked_qty) || 0;
      const picked_qty = txSum > EPS ? txSum : col;
      return { ...it, picked_qty, picked_qty_column: col, picked_qty_from_transactions: txSum };
    });
    res.json({ ...order, items, fifo_suggestions: fifo, order_documents, ...pickFootprint });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/outbound/:id/status - Update status
router.put('/:id/status', async (req, res) => {
  try {
    const id = req.params.id;
    const prev = await dbGet(`SELECT status, outbound_number, delivery, warehouse_id FROM outbound_orders WHERE id = ?`, [id]);
    const { status } = req.body;
    const result = await outboundOrder.updateStatus(id, status);
    logAudit({
      warehouse_id: prev?.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'UPDATED',
      reference_type: 'outbound_order',
      reference_id: Number(id),
      reference_number: prev?.outbound_number || prev?.delivery,
      status_before: prev?.status,
      status_after: status,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
