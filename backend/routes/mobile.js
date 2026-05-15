const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const {
  requireAuth,
  requireMobileAccess,
  requirePermission,
  requireAnyPermission,
  requireMobileAppKey,
} = require('../middleware/auth');
const StockByRackSummary = require('../models/StockByRackSummary');
const { applyStockIn } = require('./stock-in');
const MainStock = require('../models/MainStock');
const { notifyPickProgress, notifyAdminChecker } = require('../services/notificationService');
const { updateInboundBatchStatus } = require('../services/inboundPutawayHelpers');
const {
  syncBomRequirementPickedFromTransactions,
  recomputeParentPickedFromBom,
  outboundItemLineIsFullyPicked,
  listBomRequirementsForOrder,
} = require('../services/bomOutboundService');
const {
  assertExplicitWarehouseParamAllowed,
  resolveReadWarehouseScope,
  userHasWarehouseAccess,
} = require('../services/warehouseContext');
const { logAudit } = require('../services/auditLogger');

const router = express.Router();
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

/** Classify unread in-app rows for home badges (see notificationService notif_category). */
function bucketNotifCategory(dataJson) {
  let d = {};
  try {
    d = dataJson ? JSON.parse(dataJson) : {};
  } catch {
    return 'orders';
  }
  if (d.notif_category === 'delivery' || d.channel === 'delivery') return 'delivery';
  if (d.notif_category === 'inbound' || d.type === 'inbound_putaway') return 'inbound';
  if (d.notif_category === 'picked') return 'picked';
  return 'orders';
}

const mainStock = new MainStock();
const stockByRackSummary = new StockByRackSummary();

async function mobileWarehouseScope(req, res) {
  const gate = await assertExplicitWarehouseParamAllowed(req);
  if (!gate.ok) {
    res.status(gate.status || 403).json({ error: gate.message || 'Forbidden' });
    return null;
  }
  return resolveReadWarehouseScope(req);
}

router.use(requireMobileAppKey);
router.use(requireAuth);
router.use(requireMobileAccess);

router.use('/deliveries', require('./mobile-deliveries'));
router.use('/driver-deliveries', require('./mobile-driver-deliveries'));
router.use('/driver-routes', require('./mobile-driver-routes'));

/** One round-trip for home badges: unread notifications + unseen pick orders (for pickers). */
router.get('/summary', async (req, res) => {
  try {
    const scope = await mobileWarehouseScope(req, res);
    if (!scope) return;
    const uid = Number(req.user.sub);
    if (!uid) return res.status(400).json({ error: 'Invalid user' });
    const notesRow = await dbGet(
      `SELECT COUNT(1) AS c FROM notification_log WHERE user_id = ? AND read_at IS NULL`,
      [uid]
    );
    const notifications_unread = Number(notesRow?.c) || 0;
    const perm = req.user.permissions || {};
    let orders_unseen = 0;
    const whO = scope.mode === 'all' ? { sql: '', p: [] } : { sql: ' AND o.warehouse_id = ? ', p: [scope.warehouseId] };
    const whB = scope.mode === 'all' ? { sql: '', p: [] } : { sql: ' AND b.warehouse_id = ? ', p: [scope.warehouseId] };
    // Pickers typically have can_pick_orders, not can_view_orders. Either should show the picking queue.
    if (perm.can_view_orders || perm.can_pick_orders) {
      const oRow = await dbGet(
        `SELECT COUNT(1) AS c
         FROM outbound_orders o
         LEFT JOIN outbound_order_seen s
           ON s.outbound_order_id = o.id AND s.user_id = ?
         WHERE o.status IN ('Sent For Pick', 'Picking')
           AND s.outbound_order_id IS NULL ${whO.sql}`,
        [uid, ...whO.p]
      );
      orders_unseen = Number(oRow?.c) || 0;
    }
    let inbound_putaway_pending = 0;
    if (perm.can_receive_stock || perm.can_pick_orders) {
      const inb = await dbGet(
        `SELECT COUNT(DISTINCT b.id) AS c
         FROM inbound_batches b
         WHERE EXISTS (
           SELECT 1 FROM inbound_items i
           WHERE i.inbound_batch_id = b.id AND COALESCE(i.remaining_qty, 0) > 0.000001
         ) ${whB.sql}`,
        [...whB.p]
      );
      inbound_putaway_pending = Number(inb?.c) || 0;
    }

    const unreadJsonRows = await dbAll(
      `SELECT data_json FROM notification_log WHERE user_id = ? AND read_at IS NULL LIMIT 400`,
      [uid]
    );
    const notif_unread_orders = (unreadJsonRows || []).filter((r) => bucketNotifCategory(r.data_json) === 'orders').length;
    const notif_unread_delivery = (unreadJsonRows || []).filter((r) => bucketNotifCategory(r.data_json) === 'delivery').length;
    const notif_unread_inbound = (unreadJsonRows || []).filter((r) => bucketNotifCategory(r.data_json) === 'inbound').length;
    const notif_unread_picked = (unreadJsonRows || []).filter((r) => bucketNotifCategory(r.data_json) === 'picked').length;

    res.json({
      notifications_unread,
      orders_unseen,
      inbound_putaway_pending,
      notif_unread_orders,
      notif_unread_delivery,
      notif_unread_inbound,
      notif_unread_picked,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Read-only main stock list for mobile (pickers or users with can_view_main_stock). */
router.get(
  '/stock/main',
  requireAnyPermission(['can_view_main_stock', 'can_pick_orders']),
  async (req, res) => {
    try {
      const part = String(req.query.part_number || req.query.q || '').trim();
      const search = String(req.query.search || '').trim();
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      const page = Math.max(1, Number(req.query.page) || 1);
      const offset = (page - 1) * limit;

      const clauses = ['WHERE 1=1'];
      const params = [];
      const scope = await mobileWarehouseScope(req, res);
      if (!scope) return;
      if (scope.mode === 'one' && scope.warehouseId) {
        clauses.push('AND warehouse_id = ?');
        params.push(scope.warehouseId);
      }
      if (part) {
        const like = `%${part}%`;
        clauses.push('AND (part_number LIKE ? OR COALESCE(sap_part_number, \'\') LIKE ?)');
        params.push(like, like);
      }
      if (search) {
        const like = `%${search}%`;
        clauses.push(
          'AND (part_number LIKE ? OR COALESCE(sap_part_number, \'\') LIKE ? OR COALESCE(vendor_number, \'\') LIKE ? OR COALESCE(description, \'\') LIKE ?)'
        );
        params.push(like, like, like, like);
      }

      const sql = `SELECT * FROM main_stock ${clauses.join(' ')} ORDER BY part_number ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      const rows = await dbAll(sql, params);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/** Read-only stock-by-rack list for mobile (pickers or users with can_view_stock_by_rack). */
router.get(
  '/stock/by-rack',
  requireAnyPermission(['can_view_stock_by_rack', 'can_pick_orders']),
  async (req, res) => {
    try {
      const scope = await mobileWarehouseScope(req, res);
      if (!scope) return;
      const part_number = req.query.part_number ? String(req.query.part_number).trim() : '';
      const rack_location =
        req.query.rack_location != null && req.query.rack_location !== ''
          ? String(req.query.rack_location).trim()
          : req.query.rack != null && req.query.rack !== ''
            ? String(req.query.rack).trim()
            : '';
      const search = String(req.query.search || '').trim();
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const rows = await stockByRackSummary.list({
        part_number: part_number || undefined,
        rack_location: rack_location || undefined,
        search,
        available_only: false,
        limit,
        offset,
        warehouse_id: scope.mode === 'all' ? undefined : scope.warehouseId,
      });
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/** Lightweight typeahead for main stock (distinct parts / match on SAP / description). */
router.get(
  '/stock/main/suggest',
  requireAnyPermission(['can_view_main_stock', 'can_pick_orders']),
  async (req, res) => {
    try {
      const scope = await mobileWarehouseScope(req, res);
      if (!scope) return;
      const q = String(req.query.q || '').trim();
      if (!q) return res.json([]);
      const lim = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      const like = `%${q.toUpperCase()}%`;
      const wh = scope.mode === 'all' ? '' : ' AND warehouse_id = ? ';
      const wp = scope.mode === 'all' ? [] : [scope.warehouseId];
      const rows = await dbAll(
        `SELECT part_number,
                MIN(sap_part_number) AS sap_part_number,
                MIN(description) AS description
         FROM main_stock
         WHERE (UPPER(part_number) LIKE ?
            OR UPPER(COALESCE(sap_part_number, '')) LIKE ?
            OR UPPER(COALESCE(description, '')) LIKE ?) ${wh}
         GROUP BY part_number
         ORDER BY
           CASE
             WHEN SUBSTR(UPPER(part_number), 1, LENGTH(?)) = UPPER(?) THEN 0
             ELSE 1
           END,
           part_number ASC
         LIMIT ?`,
        [like, like, like, ...wp, q, q, lim]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/** Typeahead for stock-by-rack: type=part|rack (default part). */
router.get(
  '/stock/by-rack/suggest',
  requireAnyPermission(['can_view_stock_by_rack', 'can_pick_orders']),
  async (req, res) => {
    try {
      const scope = await mobileWarehouseScope(req, res);
      if (!scope) return;
      const type = String(req.query.type || 'part').toLowerCase();
      const q = String(req.query.q || '').trim();
      if (!q) return res.json([]);
      const lim = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      const like = `%${q.toUpperCase()}%`;
      const wh = scope.mode === 'all' ? '' : ' AND warehouse_id = ? ';
      const wp = scope.mode === 'all' ? [] : [scope.warehouseId];
      if (type === 'rack') {
        const rows = await dbAll(
          `SELECT DISTINCT rack_location
           FROM stock_by_rack
           WHERE UPPER(rack_location) LIKE ? ${wh}
           ORDER BY
             CASE
               WHEN SUBSTR(UPPER(rack_location), 1, LENGTH(?)) = UPPER(?) THEN 0
               ELSE 1
             END,
             rack_location ASC
           LIMIT ?`,
          [like, ...wp, q, q, lim]
        );
        return res.json(rows);
      }
      const rows = await dbAll(
        `SELECT part_number,
                MIN(sap_part_number) AS sap_part_number,
                MIN(description) AS description
         FROM stock_by_rack
         WHERE (UPPER(part_number) LIKE ?
            OR UPPER(COALESCE(sap_part_number, '')) LIKE ?
            OR UPPER(COALESCE(description, '')) LIKE ?) ${wh}
         GROUP BY part_number
         ORDER BY
           CASE
             WHEN SUBSTR(UPPER(part_number), 1, LENGTH(?)) = UPPER(?) THEN 0
             ELSE 1
           END,
           part_number ASC
         LIMIT ?`,
        [like, like, like, ...wp, q, q, lim]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

function normRack(s) {
  return String(s || '').trim().toUpperCase();
}

const QTY_EPS = 1e-6;

/** Same rows + picked_from_tx subquery as GET /mobile/orders/:id (keep confirm validation in sync). */
async function listOutboundItemsWithPickTotals(outboundDbOrderId) {
  return dbAll(
    `SELECT i.*,
      (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE outbound_item_id = i.id) AS picked_from_tx
     FROM outbound_items i WHERE i.outbound_id = ?
     ORDER BY i.id`,
    [outboundDbOrderId]
  );
}

/** Sum of (suggested − already picked) across FIFO lines for this order line. */
async function fifoRemainingCapacityForItem(outbound_order_id, outbound_item_id) {
  const rows = await dbAll(
    `SELECT f.suggested_qty,
      (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE fifo_suggestion_id = f.id) AS fifo_picked_qty
     FROM fifo_suggestions f
     WHERE f.outbound_order_id = ? AND f.outbound_item_id = ?`,
    [outbound_order_id, outbound_item_id]
  );
  let sum = 0;
  for (const f of rows) {
    sum += Math.max(0, (Number(f.suggested_qty) || 0) - (Number(f.fifo_picked_qty) || 0));
  }
  return sum;
}

function uniquePartKeys(material, partNumber, sapPartNumber) {
  return [...new Set([material, partNumber, sapPartNumber].map((x) => String(x || '').trim()).filter(Boolean))];
}

function rackMatchesKeys(rackRow, keys) {
  const pn = String(rackRow.part_number || '').trim().toUpperCase();
  const sp = String(rackRow.sap_part_number || '').trim().toUpperCase();
  for (const k of keys) {
    const ku = String(k).trim().toUpperCase();
    if (!ku) continue;
    if (pn === ku || (sp && sp === ku)) return true;
  }
  return false;
}

async function bumpMainStock(part_number, sap_part_number, description, qtyIn) {
  const pn = String(part_number || '').trim();
  if (!pn) return;
  const ms = await mainStock.findByPartNumber(pn);
  if (!ms) {
    await mainStock.upsertByPartNumber({
      product: null,
      vendor_name: null,
      vendor_number: null,
      sap_part_number: sap_part_number || pn,
      part_number: pn,
      description: description || '',
      received_qty: qtyIn,
      sold_out_qty: 0,
      pending_delivery_qty: 0,
      uom: null,
      remarks: 'mobile_receiving',
    });
    return;
  }
  const received_qty = Number(ms.received_qty) + qtyIn;
  const sold = Number(ms.sold_out_qty ?? ms.issued_qty) || 0;
  const pending_delivery_qty = Number(ms.pending_delivery_qty);
  const available_qty = MainStock.computeAvailableQty({
    received_qty,
    sold_out_qty: sold,
    pending_delivery_qty,
  });
  await mainStock.updateById(ms.id, {
    product: ms.product,
    vendor_name: ms.vendor_name,
    vendor_number: ms.vendor_number,
    sap_part_number: sap_part_number || ms.sap_part_number,
    part_number: ms.part_number,
    description: description || ms.description,
    received_qty,
    sold_out_qty: sold,
    issued_qty: sold,
    pending_delivery_qty,
    uom: ms.uom,
    remarks: ms.remarks,
  });
}

router.get('/orders', requireAnyPermission(['can_view_orders', 'can_pick_orders']), async (req, res) => {
  try {
    const scope = await mobileWarehouseScope(req, res);
    if (!scope) return;
    const uid = Number(req.user.sub);
    const wh = scope.mode === 'all' ? '' : ' AND o.warehouse_id = ? ';
    const params = scope.mode === 'all' ? [uid] : [uid, scope.warehouseId];
    const rows = await dbAll(
      `SELECT o.*,
        (SELECT COALESCE(SUM(required_qty), 0) FROM outbound_items WHERE outbound_id = o.id) AS total_required,
        (SELECT COALESCE(SUM(picked_qty), 0) FROM outbound_items WHERE outbound_id = o.id) AS total_picked,
        CASE WHEN EXISTS (
          SELECT 1 FROM outbound_order_seen s WHERE s.outbound_order_id = o.id AND s.user_id = ?
        ) THEN 1 ELSE 0 END AS order_seen
       FROM outbound_orders o
       WHERE o.status IN ('Sent For Pick', 'Picking') ${wh}
       ORDER BY o.updated_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/orders/:id/seen', requireAnyPermission(['can_view_orders', 'can_pick_orders']), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const uid = Number(req.user.sub);
    if (!orderId || !uid) return res.status(400).json({ error: 'Invalid order or user' });

    await dbRun(
      `INSERT OR IGNORE INTO outbound_order_seen (user_id, outbound_order_id) VALUES (?, ?)`,
      [uid, orderId]
    );

    try {
      await dbRun(
        `UPDATE notification_log
         SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
         WHERE user_id = ? AND read_at IS NULL
           AND json_extract(data_json, '$.outbound_order_id') = ?`,
        [uid, orderId]
      );
    } catch {
      await dbRun(
        `UPDATE notification_log
         SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
         WHERE user_id = ? AND read_at IS NULL
             AND data_json LIKE '%"outbound_order_id":' || ? || '%'`,
        [uid, orderId]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Picked orders panel (read-only):
 * - shows which orders are already picked
 * - includes who picked (from picked_transactions) + who confirmed picked (picked_orders)
 */
router.get(
  '/picked-orders',
  requireAnyPermission(['can_pick_orders', 'can_confirm_picked', 'can_view_orders']),
  async (req, res) => {
    try {
      const scope = await mobileWarehouseScope(req, res);
      if (!scope) return;
      const limit = Math.min(300, Math.max(1, Number(req.query.limit) || 120));
      const wh = scope.mode === 'all' ? '' : ' AND o.warehouse_id = ? ';
      const whParams = scope.mode === 'all' ? [] : [scope.warehouseId, scope.warehouseId];
      const rows = await dbAll(
        `SELECT * FROM (
           SELECT
             po.outbound_order_id AS order_id,
             po.delivery,
             po.sales_doc,
             po.customer_reference,
             po.sold_to,
             po.name_1,
             po.confirmed_by_user_id,
             po.confirmed_by_user_name,
             po.confirmed_at,
             o.status AS order_status,
             o.updated_at AS order_updated_at,
             (
               SELECT GROUP_CONCAT(DISTINCT TRIM(COALESCE(pt.user_name, '')), ', ')
               FROM picked_transactions pt
               WHERE pt.outbound_order_id = po.outbound_order_id
                 AND TRIM(COALESCE(pt.user_name, '')) != ''
             ) AS picked_by_names
           FROM picked_orders po
           LEFT JOIN outbound_orders o ON o.id = po.outbound_order_id
           WHERE 1=1 ${wh}
           UNION ALL
           SELECT
             o.id AS order_id,
             COALESCE(o.delivery, o.outbound_number) AS delivery,
             COALESCE(o.sales_doc, o.sales_order_number) AS sales_doc,
             COALESCE(o.customer_reference, o.customer_po_number) AS customer_reference,
             COALESCE(o.sold_to, o.vendor_name) AS sold_to,
             COALESCE(o.name_1, o.customer_name) AS name_1,
             NULL AS confirmed_by_user_id,
             NULL AS confirmed_by_user_name,
             o.updated_at AS confirmed_at,
             o.status AS order_status,
             o.updated_at AS order_updated_at,
             (
               SELECT GROUP_CONCAT(DISTINCT TRIM(COALESCE(pt.user_name, '')), ', ')
               FROM picked_transactions pt
               WHERE pt.outbound_order_id = o.id
                 AND TRIM(COALESCE(pt.user_name, '')) != ''
             ) AS picked_by_names
           FROM outbound_orders o
           WHERE lower(trim(COALESCE(o.status, ''))) IN ('picked', 'checked')
             AND NOT EXISTS (SELECT 1 FROM picked_orders po2 WHERE po2.outbound_order_id = o.id) ${wh}
         ) AS picked_union
         ORDER BY datetime(COALESCE(picked_union.confirmed_at, picked_union.order_updated_at)) DESC
         LIMIT ?`,
        [...whParams, limit]
      );
      res.json(rows || []);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

router.get(
  '/picked-orders/:id',
  requireAnyPermission(['can_pick_orders', 'can_confirm_picked', 'can_view_orders']),
  async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      if (!orderId) return res.status(400).json({ error: 'Invalid id' });
      let po = await dbGet(`SELECT * FROM picked_orders WHERE outbound_order_id = ?`, [orderId]);
      const order = await dbGet(`SELECT * FROM outbound_orders WHERE id = ?`, [orderId]);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      const role = String(req.user?.role || '').toLowerCase();
      if (role !== 'admin') {
        const ok = await userHasWarehouseAccess(req.user.sub, req.user.role, order.warehouse_id);
        if (!ok) return res.status(403).json({ error: 'Forbidden for this warehouse' });
      }
      const st = String(order.status || '').trim().toLowerCase();
      if (!po && (st === 'picked' || st === 'checked')) {
        po = {
          outbound_order_id: orderId,
          delivery: order.delivery || order.outbound_number || null,
          sales_doc: order.sales_doc || order.sales_order_number || null,
          customer_reference: order.customer_reference || order.customer_po_number || null,
          sold_to: order.sold_to || order.vendor_name || null,
          name_1: order.name_1 || order.customer_name || null,
          confirmed_by_user_id: null,
          confirmed_by_user_name: null,
          confirmed_at: order.updated_at || null,
          status: order.status || 'Picked',
        };
      }
      if (!po) return res.status(404).json({ error: 'Picked order not found' });
      const tx = await dbAll(
        `SELECT id, user_id, user_name, material, sap_part_number, description, rack_location, picked_qty, picked_at
         FROM picked_transactions
         WHERE outbound_order_id = ?
         ORDER BY datetime(picked_at) ASC, id ASC`,
        [orderId]
      );
      res.json({ picked_order: po, order, picked_transactions: tx || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

router.get('/orders/:id', requireAnyPermission(['can_view_orders', 'can_pick_orders']), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order = await dbGet('SELECT * FROM outbound_orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const role = String(req.user?.role || '').toLowerCase();
    if (role !== 'admin') {
      const ok = await userHasWarehouseAccess(req.user.sub, req.user.role, order.warehouse_id);
      if (!ok) return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }

    const items = await listOutboundItemsWithPickTotals(orderId);

    const fifo = await dbAll(
      `SELECT f.*,
        (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE fifo_suggestion_id = f.id) AS fifo_picked_qty
       FROM fifo_suggestions f WHERE f.outbound_order_id = ?
       ORDER BY f.outbound_item_id, f.fifo_sequence`,
      [orderId]
    );

    const bom_requirements = await listBomRequirementsForOrder(dbAll, orderId);

    const bomItemIds = new Set(
      (await dbAll(
        `SELECT DISTINCT outbound_item_id AS id FROM outbound_bom_requirements WHERE outbound_order_id = ?`,
        [orderId]
      )).map((r) => Number(r.id))
    );

    const itemsOut = items.map((it) => {
      const isBom = bomItemIds.has(Number(it.id));
      const pickedCol = Number(it.picked_qty) || 0;
      const txSum = Number(it.picked_from_tx) || 0;
      const picked_qty_effective = isBom ? pickedCol : Math.max(pickedCol, txSum);
      return {
        ...it,
        is_bom_parent: isBom,
        picked_qty_effective,
        remaining_qty: Math.max(0, (Number(it.required_qty) || 0) - picked_qty_effective),
      };
    });

    res.json({ ...order, items: itemsOut, fifo_suggestions: fifo, bom_requirements });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get(
  '/orders/:id/bom-requirements',
  requireAnyPermission(['can_view_orders', 'can_pick_orders']),
  async (req, res) => {
    try {
      const orderId = Number(req.params.id);
      if (!orderId) return res.status(400).json({ error: 'Invalid id' });
      const rows = await listBomRequirementsForOrder(dbAll, orderId);
      res.json({ outbound_order_id: orderId, bom_requirements: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/** Main stock + stock-by-rack rows per pick line (read-only reference for mobile). Optional rack_q filters rack_location. */
router.get(
  '/orders/:id/stock-overview',
  requireAnyPermission(['can_view_orders', 'can_pick_orders']),
  async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const rackQ = String(req.query.rack_q || '').trim();
    const order = await dbGet('SELECT id FROM outbound_orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const items = await listOutboundItemsWithPickTotals(orderId);
    const like = rackQ ? `%${rackQ}%` : null;

    const bomItemIds = new Set(
      (await dbAll(
        `SELECT DISTINCT outbound_item_id AS id FROM outbound_bom_requirements WHERE outbound_order_id = ?`,
        [orderId]
      )).map((r) => Number(r.id))
    );

    const lines = [];
    for (const it of items) {
      const pn = String(it.part_number || '').trim();
      const isBom = bomItemIds.has(Number(it.id));

      if (isBom) {
        const obrList = await dbAll(
          `SELECT * FROM outbound_bom_requirements WHERE outbound_item_id = ? ORDER BY id`,
          [it.id]
        );
        const bomChildLines = [];
        for (const br of obrList) {
          const cpn = String(br.child_part_number || '').trim();
          const sumC = await dbGet(
            `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions WHERE outbound_bom_requirement_id = ?`,
            [br.id]
          );
          const pickedC = Number(sumC?.s) || 0;
          const remC = Math.max(0, Number(br.required_child_qty) - pickedC);
          let cms = null;
          if (cpn) {
            cms = await dbGet(
              `SELECT part_number, sap_part_number, vendor_number, vendor_name, description,
                      received_qty, sold_out_qty, pending_delivery_qty, available_qty, uom, remarks
               FROM main_stock WHERE part_number = ?`,
              [cpn]
            );
          }
          let racks = [];
          if (cpn) {
            if (like) {
              racks = await dbAll(
                `SELECT id, part_number, sap_part_number, rack_location, available_qty, total_in_qty, total_out_qty,
                        first_entry_date, description
                 FROM stock_by_rack WHERE part_number = ? AND rack_location LIKE ?
                 ORDER BY rack_location`,
                [cpn, like]
              );
            } else {
              racks = await dbAll(
                `SELECT id, part_number, sap_part_number, rack_location, available_qty, total_in_qty, total_out_qty,
                        first_entry_date, description
                 FROM stock_by_rack WHERE part_number = ?
                 ORDER BY rack_location`,
                [cpn]
              );
            }
          }
          bomChildLines.push({
            outbound_bom_requirement_id: br.id,
            parent_part_number: br.parent_part_number,
            child_part_number: cpn,
            child_sap_part_number: String(br.child_sap_part_number || '').trim(),
            child_description: br.child_description || null,
            child_qty_per_parent: Number(br.child_qty_per_parent) || 0,
            required_child_qty: Number(br.required_child_qty) || 0,
            picked_child_qty: pickedC,
            remaining_child_qty: remC,
            main_stock: cms
              ? {
                  available_qty: cms.available_qty,
                  received_qty: cms.received_qty,
                  sold_out_qty: cms.sold_out_qty,
                  pending_delivery_qty: cms.pending_delivery_qty,
                  uom: cms.uom,
                  remarks: cms.remarks,
                }
              : null,
            racks,
          });
        }
        const pickedParent = Number(it.picked_qty) || 0;
        const reqParent = Number(it.required_qty) || 0;
        lines.push({
          outbound_item_id: it.id,
          is_bom_parent: true,
          material: it.material || null,
          part_number: pn,
          sap_part_number: String(it.sap_part_number || '').trim(),
          description: it.description || null,
          required_qty: reqParent,
          picked_qty: Number(it.picked_qty) || 0,
          picked_qty_effective: pickedParent,
          remaining_qty: Math.max(0, reqParent - pickedParent),
          vendor_number: null,
          vendor_name: null,
          main_stock: null,
          racks: [],
          bom_child_lines: bomChildLines,
        });
        continue;
      }

      const pickedEff = Math.max(Number(it.picked_qty) || 0, Number(it.picked_from_tx) || 0);
      const rem = Math.max(0, (Number(it.required_qty) || 0) - pickedEff);

      let ms = null;
      if (pn) {
        ms = await dbGet(
          `SELECT part_number, sap_part_number, vendor_number, vendor_name, description,
                  received_qty, sold_out_qty, pending_delivery_qty, available_qty, uom, remarks
           FROM main_stock WHERE part_number = ?`,
          [pn]
        );
      }

      let racks = [];
      if (pn) {
        if (like) {
          racks = await dbAll(
            `SELECT id, part_number, sap_part_number, rack_location, available_qty, total_in_qty, total_out_qty,
                    first_entry_date, description
             FROM stock_by_rack WHERE part_number = ? AND rack_location LIKE ?
             ORDER BY rack_location`,
            [pn, like]
          );
        } else {
          racks = await dbAll(
            `SELECT id, part_number, sap_part_number, rack_location, available_qty, total_in_qty, total_out_qty,
                    first_entry_date, description
             FROM stock_by_rack WHERE part_number = ?
             ORDER BY rack_location`,
            [pn]
          );
        }
      }

      lines.push({
        outbound_item_id: it.id,
        is_bom_parent: false,
        material: it.material || null,
        part_number: pn,
        sap_part_number: String(it.sap_part_number || '').trim() || (ms?.sap_part_number ? String(ms.sap_part_number) : ''),
        description: it.description || null,
        required_qty: Number(it.required_qty) || 0,
        picked_qty: Number(it.picked_qty) || 0,
        picked_qty_effective: pickedEff,
        remaining_qty: rem,
        vendor_number: ms?.vendor_number != null ? String(ms.vendor_number) : null,
        vendor_name: ms?.vendor_name != null ? String(ms.vendor_name) : null,
        main_stock: ms
          ? {
              available_qty: ms.available_qty,
              received_qty: ms.received_qty,
              sold_out_qty: ms.sold_out_qty,
              pending_delivery_qty: ms.pending_delivery_qty,
              uom: ms.uom,
              remarks: ms.remarks,
            }
          : null,
        racks,
      });
    }

    res.json({ order_id: orderId, rack_q: rackQ || null, lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
  }
);

router.post('/picking/confirm-item', requirePermission('can_pick_orders'), async (req, res) => {
  const body = req.body || {};
  const outbound_order_id = Number(body.outbound_order_id);
  const outbound_item_id = Number(body.outbound_item_id);
  const fifo_suggestion_id = Number(body.fifo_suggestion_id);
  const scanned_rack = body.scanned_rack;
  const picked_qty = Number(body.picked_qty);
  const device_id = body.device_id || null;

  if (!outbound_order_id || !outbound_item_id || !fifo_suggestion_id || !scanned_rack || !(picked_qty > 0)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  try {
    const userRow = await dbGet(`SELECT id, full_name, username FROM users WHERE id = ?`, [req.user.sub]);
    const user_name = userRow?.full_name || userRow?.username || req.user.username;

    await dbRun('BEGIN IMMEDIATE');

    const order = await dbGet(`SELECT * FROM outbound_orders WHERE id = ?`, [outbound_order_id]);
    if (!order) throw new Error('Order not found');
    if (!['Sent For Pick', 'Picking'].includes(order.status)) {
      throw new Error('Order is not open for picking');
    }
    if (['Picked', 'Checked', 'Delivered', 'Cancelled'].includes(order.status)) {
      throw new Error('Picking closed for this order');
    }

    const item = await dbGet(`SELECT * FROM outbound_items WHERE id = ? AND outbound_id = ?`, [
      outbound_item_id,
      outbound_order_id,
    ]);
    if (!item) throw new Error('Item not found');

    const sug = await dbGet(
      `SELECT * FROM fifo_suggestions WHERE id = ? AND outbound_item_id = ? AND outbound_order_id = ?`,
      [fifo_suggestion_id, outbound_item_id, outbound_order_id]
    );
    if (!sug) throw new Error('FIFO suggestion not found');

    if (normRack(scanned_rack) !== normRack(sug.rack_location)) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Wrong rack. Please scan suggested rack.' });
    }

    const bomReqId = Number(sug.outbound_bom_requirement_id) || 0;
    const obr = bomReqId ? await dbGet(`SELECT * FROM outbound_bom_requirements WHERE id = ?`, [bomReqId]) : null;

    let remaining;
    if (obr) {
      const sumChild = await dbGet(
        `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions WHERE outbound_bom_requirement_id = ?`,
        [bomReqId]
      );
      const pickedChild = Number(sumChild?.s) || 0;
      const reqChild = Number(obr.required_child_qty) || 0;
      remaining = Math.max(0, reqChild - pickedChild);
    } else {
      const sumTx = await dbGet(
        `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions
         WHERE outbound_item_id = ? AND COALESCE(is_bom_pick, 0) = 0`,
        [outbound_item_id]
      );
      const pickedFromTx = Number(sumTx?.s) || 0;
      const pickedColumn = Number(item.picked_qty) || 0;
      const already = Math.max(pickedFromTx, pickedColumn);
      const required = Number(item.required_qty) || 0;
      remaining = Math.max(0, required - already);
    }
    if (picked_qty > remaining) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Over-pick not allowed', remaining_qty: remaining });
    }

    const sumFifo = await dbGet(
      `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions WHERE fifo_suggestion_id = ?`,
      [fifo_suggestion_id]
    );
    const fifoAlready = Number(sumFifo?.s) || 0;
    const fifoCap = Number(sug.suggested_qty) || 0;
    const fifoRemaining = Math.max(0, fifoCap - fifoAlready);
    const mustPickExact = Math.min(remaining, fifoRemaining);
    const qtyEps = 1e-6;
    if (Math.abs(picked_qty - mustPickExact) > qtyEps) {
      await dbRun('ROLLBACK');
      return res.status(400).json({
        error: 'Must pick exact suggested quantity for this rack',
        required_qty_for_rack_now: mustPickExact,
      });
    }
    if (fifoAlready + picked_qty > fifoCap) {
      await dbRun('ROLLBACK');
      return res.status(400).json({
        error: 'Quantity exceeds FIFO suggestion for this rack',
        max_for_rack: fifoCap - fifoAlready,
      });
    }

    const rackRow = await dbGet(`SELECT * FROM stock_by_rack WHERE id = ?`, [sug.stock_by_rack_id]);
    if (!rackRow) throw new Error('Stock rack row missing');
    const rackAvail = Number(rackRow.available_qty) || 0;
    if (picked_qty > rackAvail) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient qty at rack' });
    }

    const mat = obr ? obr.child_part_number : item.material || item.part_number;
    const sap = obr ? obr.child_sap_part_number || '' : item.sap_part_number;
    const desc = obr ? obr.child_description || '' : item.description;
    const isBomPick = obr ? 1 : 0;

    await dbRun(
      `INSERT INTO picked_transactions (
        outbound_order_id, outbound_item_id, fifo_suggestion_id, user_id, user_name,
        material, sap_part_number, description, rack_location, picked_qty, device_id,
        picked_method, is_manual_pick, manual_pick_reason, picked_by_role,
        outbound_bom_requirement_id, parent_part_number, child_part_number, is_bom_pick, child_qty_per_parent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Mobile', 0, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        outbound_order_id,
        outbound_item_id,
        fifo_suggestion_id,
        req.user.sub,
        user_name,
        mat,
        sap,
        desc,
        sug.rack_location,
        picked_qty,
        device_id,
        String(req.user.role || '').toLowerCase(),
        obr ? bomReqId : null,
        obr ? obr.parent_part_number : null,
        obr ? obr.child_part_number : null,
        isBomPick,
        obr ? obr.child_qty_per_parent : null,
      ]
    );

    const nextAvail = rackAvail - picked_qty;
    const totalOut = Number(rackRow.total_out_qty) + picked_qty;
    await dbRun(
      `UPDATE stock_by_rack SET available_qty = ?, total_out_qty = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`,
      [nextAvail, totalOut, rackRow.id]
    );

    const today = new Date().toISOString().slice(0, 10);
    const deliveryRef = order.delivery || order.outbound_number || String(outbound_order_id);
    await dbRun(
      `INSERT INTO stock_out (
        transaction_date, part_number, sap_part_number, description, rack_location,
        qty_out, outbound_number, reference_no, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        today,
        rackRow.part_number,
        rackRow.sap_part_number || '',
        rackRow.description || '',
        sug.rack_location,
        picked_qty,
        deliveryRef,
        `pick_tx_fifo_${fifo_suggestion_id}`,
        `picker:${user_name}`,
      ]
    );

    if (obr) {
      await syncBomRequirementPickedFromTransactions(dbRun, dbGet, dbAll, outbound_item_id);
      await recomputeParentPickedFromBom(dbGet, dbAll, dbRun, outbound_item_id);
    } else {
      const sumTx2 = await dbGet(
        `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions
         WHERE outbound_item_id = ? AND COALESCE(is_bom_pick, 0) = 0`,
        [outbound_item_id]
      );
      const pickedFromTx2 = Number(sumTx2?.s) || 0;
      const pickedColumn2 = Number(item.picked_qty) || 0;
      const already2 = Math.max(pickedFromTx2, pickedColumn2);
      const newPicked = already2 + picked_qty;
      await dbRun(`UPDATE outbound_items SET picked_qty = ? WHERE id = ?`, [newPicked, outbound_item_id]);
    }

    const nextStatus = order.status === 'Sent For Pick' ? 'Picking' : order.status;
    await dbRun(`UPDATE outbound_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      nextStatus,
      outbound_order_id,
    ]);

    await dbRun('COMMIT');

    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'PICKING',
      action_type: 'PICK_CONFIRMED',
      reference_type: 'outbound_order',
      reference_id: outbound_order_id,
      reference_number: order.outbound_number || order.delivery,
      new_value: { outbound_item_id, fifo_suggestion_id, picked_qty, rack: normRack(scanned_rack) },
    });

    const sales_doc = order.sales_doc || order.sales_order_number || '';
    await notifyPickProgress(
      'Order picked',
      `Order picked by ${user_name}\nOutbound: ${deliveryRef}\nSales Doc: ${sales_doc}`,
      { outbound_order_id, outbound_item_id }
    );

    const refreshed = await dbGet(`SELECT * FROM outbound_items WHERE id = ?`, [outbound_item_id]);
    res.json({ ok: true, item: refreshed });
  } catch (e) {
    try {
      await dbRun('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(400).json({ error: e.message });
  }
});

/**
 * When FIFO has no remaining suggestions for the line, pick up to full remaining from one rack
 * (same stock deduction as FIFO pick; fifo_suggestion_id is NULL / manual flag).
 */
router.post('/picking/confirm-item-from-rack', requirePermission('can_pick_orders'), async (req, res) => {
  const body = req.body || {};
  const outbound_order_id = Number(body.outbound_order_id);
  const outbound_item_id = Number(body.outbound_item_id);
  const stock_by_rack_id = Number(body.stock_by_rack_id);
  const scanned_rack = body.scanned_rack;
  let picked_qty = body.picked_qty != null && body.picked_qty !== '' ? Number(body.picked_qty) : NaN;
  const outbound_bom_requirement_id =
    body.outbound_bom_requirement_id != null && body.outbound_bom_requirement_id !== ''
      ? Number(body.outbound_bom_requirement_id)
      : null;
  const device_id = body.device_id || null;

  if (!outbound_order_id || !outbound_item_id || !stock_by_rack_id || !scanned_rack) {
    return res.status(400).json({
      error: 'Invalid payload: outbound_order_id, outbound_item_id, stock_by_rack_id, scanned_rack required',
    });
  }

  try {
    const userRow = await dbGet(`SELECT id, full_name, username FROM users WHERE id = ?`, [req.user.sub]);
    const user_name = userRow?.full_name || userRow?.username || req.user.username;

    await dbRun('BEGIN IMMEDIATE');

    const order = await dbGet(`SELECT * FROM outbound_orders WHERE id = ?`, [outbound_order_id]);
    if (!order) throw new Error('Order not found');
    if (!['Sent For Pick', 'Picking'].includes(order.status)) {
      throw new Error('Order is not open for picking');
    }
    if (['Picked', 'Checked', 'Delivered', 'Cancelled'].includes(order.status)) {
      throw new Error('Picking closed for this order');
    }

    const fifoLeft = await fifoRemainingCapacityForItem(outbound_order_id, outbound_item_id);
    if (fifoLeft > QTY_EPS) {
      await dbRun('ROLLBACK');
      return res.status(400).json({
        error: 'FIFO suggestions still apply for this line — use the normal pick flow',
        fifo_remaining_qty: fifoLeft,
      });
    }

    const item = await dbGet(`SELECT * FROM outbound_items WHERE id = ? AND outbound_id = ?`, [
      outbound_item_id,
      outbound_order_id,
    ]);
    if (!item) throw new Error('Item not found');

    const obrList = await dbAll(
      `SELECT * FROM outbound_bom_requirements WHERE outbound_item_id = ? ORDER BY id`,
      [outbound_item_id]
    );
    const isBom = obrList.length > 0;
    let obr = null;
    if (isBom) {
      if (!outbound_bom_requirement_id) {
        await dbRun('ROLLBACK');
        return res.status(400).json({ error: 'outbound_bom_requirement_id required for BOM order lines' });
      }
      obr = await dbGet(
        `SELECT * FROM outbound_bom_requirements WHERE id = ? AND outbound_item_id = ? AND outbound_order_id = ?`,
        [outbound_bom_requirement_id, outbound_item_id, outbound_order_id]
      );
      if (!obr) {
        await dbRun('ROLLBACK');
        return res.status(400).json({ error: 'BOM requirement not found for this item' });
      }
    } else if (outbound_bom_requirement_id) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'outbound_bom_requirement_id must not be set for non-BOM lines' });
    }

    let remaining;
    if (obr) {
      const sumChild = await dbGet(
        `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions WHERE outbound_bom_requirement_id = ?`,
        [obr.id]
      );
      const pickedChild = Number(sumChild?.s) || 0;
      const reqChild = Number(obr.required_child_qty) || 0;
      remaining = Math.max(0, reqChild - pickedChild);
    } else {
      const sumTx = await dbGet(
        `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions
         WHERE outbound_item_id = ? AND COALESCE(is_bom_pick, 0) = 0`,
        [outbound_item_id]
      );
      const pickedFromTx = Number(sumTx?.s) || 0;
      const pickedColumn = Number(item.picked_qty) || 0;
      const already = Math.max(pickedFromTx, pickedColumn);
      const required = Number(item.required_qty) || 0;
      remaining = Math.max(0, required - already);
    }
    if (remaining <= QTY_EPS) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Nothing left to pick for this line' });
    }

    const rackRow = await dbGet(`SELECT * FROM stock_by_rack WHERE id = ?`, [stock_by_rack_id]);
    if (!rackRow) throw new Error('Rack row not found');
    if (normRack(scanned_rack) !== normRack(rackRow.rack_location)) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Wrong rack. Scanned location does not match selected rack row.' });
    }

    const keys = obr
      ? uniquePartKeys(obr.child_part_number, obr.child_part_number, obr.child_sap_part_number)
      : uniquePartKeys(item.material, item.part_number, item.sap_part_number);
    if (!rackMatchesKeys(rackRow, keys)) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Rack stock part number does not match this order line' });
    }

    const rackAvail = Number(rackRow.available_qty) || 0;
    if (rackAvail <= QTY_EPS) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'No available quantity at this rack' });
    }

    const maxPick = Math.min(remaining, rackAvail);
    if (!Number.isFinite(picked_qty) || picked_qty <= QTY_EPS) {
      picked_qty = maxPick;
    }
    if (picked_qty - maxPick > QTY_EPS) {
      await dbRun('ROLLBACK');
      return res.status(400).json({
        error: 'Quantity exceeds what can be taken from this rack for the remaining line',
        max_pick_qty: maxPick,
        remaining_qty: remaining,
        rack_available_qty: rackAvail,
      });
    }

    const mat = obr ? obr.child_part_number : item.material || item.part_number;
    const sap = obr ? obr.child_sap_part_number || '' : item.sap_part_number;
    const desc = obr ? obr.child_description || '' : item.description;
    const isBomPick = obr ? 1 : 0;
    const bomReqId = obr ? obr.id : null;

    await dbRun(
      `INSERT INTO picked_transactions (
        outbound_order_id, outbound_item_id, fifo_suggestion_id, user_id, user_name,
        material, sap_part_number, description, rack_location, picked_qty, device_id,
        picked_method, is_manual_pick, manual_pick_reason, picked_by_role,
        outbound_bom_requirement_id, parent_part_number, child_part_number, is_bom_pick, child_qty_per_parent
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'Mobile', 1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outbound_order_id,
        outbound_item_id,
        req.user.sub,
        user_name,
        mat,
        sap,
        desc,
        rackRow.rack_location,
        picked_qty,
        device_id,
        'No FIFO suggestion — single rack pick',
        String(req.user.role || '').toLowerCase(),
        bomReqId,
        obr ? obr.parent_part_number : null,
        obr ? obr.child_part_number : null,
        isBomPick,
        obr ? obr.child_qty_per_parent : null,
      ]
    );

    const nextAvail = rackAvail - picked_qty;
    const totalOut = Number(rackRow.total_out_qty) + picked_qty;
    await dbRun(
      `UPDATE stock_by_rack SET available_qty = ?, total_out_qty = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`,
      [nextAvail, totalOut, rackRow.id]
    );

    const today = new Date().toISOString().slice(0, 10);
    const deliveryRef = order.delivery || order.outbound_number || String(outbound_order_id);
    await dbRun(
      `INSERT INTO stock_out (
        transaction_date, part_number, sap_part_number, description, rack_location,
        qty_out, outbound_number, reference_no, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        today,
        rackRow.part_number,
        rackRow.sap_part_number || '',
        rackRow.description || '',
        rackRow.rack_location,
        picked_qty,
        deliveryRef,
        `mobile_no_fifo_rack_${rackRow.id}`,
        `picker:${user_name}`,
      ]
    );

    if (obr) {
      await syncBomRequirementPickedFromTransactions(dbRun, dbGet, dbAll, outbound_item_id);
      await recomputeParentPickedFromBom(dbGet, dbAll, dbRun, outbound_item_id);
    } else {
      const sumTx2 = await dbGet(
        `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions
         WHERE outbound_item_id = ? AND COALESCE(is_bom_pick, 0) = 0`,
        [outbound_item_id]
      );
      const pickedFromTx2 = Number(sumTx2?.s) || 0;
      const pickedColumn2 = Number(item.picked_qty) || 0;
      const already2 = Math.max(pickedFromTx2, pickedColumn2);
      const newPicked = already2 + picked_qty;
      await dbRun(`UPDATE outbound_items SET picked_qty = ? WHERE id = ?`, [newPicked, outbound_item_id]);
    }

    const nextStatus = order.status === 'Sent For Pick' ? 'Picking' : order.status;
    await dbRun(`UPDATE outbound_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      nextStatus,
      outbound_order_id,
    ]);

    await dbRun('COMMIT');

    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'PICKING',
      action_type: 'PICK_CONFIRMED',
      reference_type: 'outbound_order',
      reference_id: outbound_order_id,
      reference_number: order.outbound_number || order.delivery,
      remarks: 'from_rack_no_fifo',
      new_value: { outbound_item_id, stock_by_rack_id, picked_qty },
    });

    const sales_doc = order.sales_doc || order.sales_order_number || '';
    await notifyPickProgress(
      'Order picked',
      `Order picked by ${user_name}\nOutbound: ${deliveryRef}\nSales Doc: ${sales_doc}`,
      { outbound_order_id, outbound_item_id }
    );

    const refreshed = await dbGet(`SELECT * FROM outbound_items WHERE id = ?`, [outbound_item_id]);
    res.json({ ok: true, item: refreshed, picked_qty });
  } catch (e) {
    try {
      await dbRun('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(400).json({ error: e.message });
  }
});

/**
 * Create (or use) a stock_by_rack row at the given location for the pick part, then deduct in one transaction.
 * Allowed even when FIFO suggestions still exist (picker-declared location).
 */
router.post('/picking/confirm-item-with-new-rack', requirePermission('can_pick_orders'), async (req, res) => {
  const body = req.body || {};
  const outbound_order_id = Number(body.outbound_order_id);
  const outbound_item_id = Number(body.outbound_item_id);
  const rack_location = String(body.rack_location || '').trim();
  const picked_qty = Number(body.picked_qty);
  const outbound_bom_requirement_id =
    body.outbound_bom_requirement_id != null && body.outbound_bom_requirement_id !== ''
      ? Number(body.outbound_bom_requirement_id)
      : null;
  const device_id = body.device_id || null;

  const MANUAL_REASON = 'Mobile: new rack row created then picked (same transaction)';

  if (!outbound_order_id || !outbound_item_id || !rack_location || !(picked_qty > 0)) {
    return res.status(400).json({
      error: 'outbound_order_id, outbound_item_id, rack_location, and picked_qty (>0) required',
    });
  }

  try {
    const userRow = await dbGet(`SELECT id, full_name, username FROM users WHERE id = ?`, [req.user.sub]);
    const user_name = userRow?.full_name || userRow?.username || req.user.username;

    await dbRun('BEGIN IMMEDIATE');

    const order = await dbGet(`SELECT * FROM outbound_orders WHERE id = ?`, [outbound_order_id]);
    if (!order) throw new Error('Order not found');
    if (!['Sent For Pick', 'Picking'].includes(order.status)) {
      throw new Error('Order is not open for picking');
    }
    if (['Picked', 'Checked', 'Delivered', 'Cancelled'].includes(order.status)) {
      throw new Error('Picking closed for this order');
    }

    const item = await dbGet(`SELECT * FROM outbound_items WHERE id = ? AND outbound_id = ?`, [
      outbound_item_id,
      outbound_order_id,
    ]);
    if (!item) throw new Error('Item not found');

    const obrList = await dbAll(
      `SELECT * FROM outbound_bom_requirements WHERE outbound_item_id = ? ORDER BY id`,
      [outbound_item_id]
    );

    let obr = null;
    let remaining = 0;
    let mat;
    let sap;
    let desc;
    let partKeys;

    if (!obrList.length) {
      if (outbound_bom_requirement_id) {
        await dbRun('ROLLBACK');
        return res.status(400).json({ error: 'outbound_bom_requirement_id must not be set for non-BOM lines' });
      }
      const sumTx = await dbGet(
        `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions
         WHERE outbound_item_id = ? AND COALESCE(is_bom_pick, 0) = 0`,
        [outbound_item_id]
      );
      const pickedFromTx = Number(sumTx?.s) || 0;
      const pickedColumn = Number(item.picked_qty) || 0;
      const already = Math.max(pickedFromTx, pickedColumn);
      const required = Number(item.required_qty) || 0;
      remaining = Math.max(0, required - already);
      mat = String(item.material || item.part_number || '').trim();
      sap = String(item.sap_part_number || '').trim();
      desc = String(item.description || '').trim();
      partKeys = uniquePartKeys(item.material, item.part_number, item.sap_part_number);
    } else {
      if (!outbound_bom_requirement_id) {
        await dbRun('ROLLBACK');
        return res.status(400).json({ error: 'outbound_bom_requirement_id required for BOM order lines' });
      }
      obr = await dbGet(
        `SELECT * FROM outbound_bom_requirements WHERE id = ? AND outbound_item_id = ? AND outbound_order_id = ?`,
        [outbound_bom_requirement_id, outbound_item_id, outbound_order_id]
      );
      if (!obr) {
        await dbRun('ROLLBACK');
        return res.status(400).json({ error: 'BOM requirement not found for this item' });
      }
      const sumChild = await dbGet(
        `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions WHERE outbound_bom_requirement_id = ?`,
        [obr.id]
      );
      const pickedChild = Number(sumChild?.s) || 0;
      const reqChild = Number(obr.required_child_qty) || 0;
      remaining = Math.max(0, reqChild - pickedChild);
      mat = String(obr.child_part_number || '').trim();
      sap = String(obr.child_sap_part_number || '').trim();
      desc = String(obr.child_description || '').trim();
      partKeys = uniquePartKeys(obr.child_part_number, obr.child_part_number, obr.child_sap_part_number);
    }

    if (!partKeys.length || !String(mat || '').trim()) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Order line has no part number for rack stock' });
    }

    if (remaining <= QTY_EPS) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Nothing left to pick for this line' });
    }
    if (picked_qty - remaining > QTY_EPS) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Over-pick not allowed', remaining_qty: remaining });
    }

    let rackRow = await dbGet(
      `SELECT * FROM stock_by_rack
       WHERE UPPER(TRIM(part_number)) = UPPER(TRIM(?)) AND UPPER(TRIM(rack_location)) = UPPER(TRIM(?))`,
      [mat, rack_location]
    );

    if (rackRow) {
      if (!rackMatchesKeys(rackRow, partKeys)) {
        await dbRun('ROLLBACK');
        return res.status(400).json({ error: 'Existing rack row part number does not match this pick line' });
      }
      const avail0 = Number(rackRow.available_qty) || 0;
      if (avail0 + QTY_EPS < picked_qty) {
        await dbRun('ROLLBACK');
        return res.status(400).json({
          error:
            'This rack location already exists for this part but has insufficient available qty. Pick less, use another location, or add stock on web.',
          rack_available_qty: avail0,
        });
      }
    } else {
      await dbRun(
        `INSERT INTO stock_by_rack (
          part_number, sap_part_number, description, rack_location,
          total_in_qty, total_out_qty, available_qty, first_entry_date, last_updated
        ) VALUES (?, ?, ?, ?, ?, 0, ?, date('now'), CURRENT_TIMESTAMP)`,
        [mat, sap || null, desc || null, rack_location, picked_qty, picked_qty]
      );
      rackRow = await dbGet(`SELECT * FROM stock_by_rack WHERE id = (SELECT last_insert_rowid())`);
      if (!rackRow) throw new Error('Failed to create stock_by_rack row');
    }

    const rackAvail = Number(rackRow.available_qty) || 0;
    if (picked_qty > rackAvail + QTY_EPS) {
      await dbRun('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient qty at rack after setup' });
    }

    const rackLocStored = String(rackRow.rack_location || rack_location).trim();
    const isBomPick = obr ? 1 : 0;
    const bomReqId = obr ? obr.id : null;

    await dbRun(
      `INSERT INTO picked_transactions (
        outbound_order_id, outbound_item_id, fifo_suggestion_id, user_id, user_name,
        material, sap_part_number, description, rack_location, picked_qty, device_id,
        picked_method, is_manual_pick, manual_pick_reason, picked_by_role,
        outbound_bom_requirement_id, parent_part_number, child_part_number, is_bom_pick, child_qty_per_parent
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'Mobile', 1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outbound_order_id,
        outbound_item_id,
        req.user.sub,
        user_name,
        mat,
        sap,
        desc,
        rackLocStored,
        picked_qty,
        device_id,
        MANUAL_REASON,
        String(req.user.role || '').toLowerCase(),
        bomReqId,
        obr ? obr.parent_part_number : null,
        obr ? obr.child_part_number : null,
        isBomPick,
        obr ? obr.child_qty_per_parent : null,
      ]
    );

    const nextAvail = rackAvail - picked_qty;
    const totalOut = Number(rackRow.total_out_qty) + picked_qty;
    await dbRun(
      `UPDATE stock_by_rack SET available_qty = ?, total_out_qty = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`,
      [nextAvail, totalOut, rackRow.id]
    );

    const today = new Date().toISOString().slice(0, 10);
    const deliveryRef = order.delivery || order.outbound_number || String(outbound_order_id);
    await dbRun(
      `INSERT INTO stock_out (
        transaction_date, part_number, sap_part_number, description, rack_location,
        qty_out, outbound_number, reference_no, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        today,
        rackRow.part_number,
        rackRow.sap_part_number || '',
        rackRow.description || '',
        rackLocStored,
        picked_qty,
        deliveryRef,
        `mobile_new_rack_pick_${rackRow.id}`,
        `picker:${user_name}`,
      ]
    );

    if (obr) {
      await syncBomRequirementPickedFromTransactions(dbRun, dbGet, dbAll, outbound_item_id);
      await recomputeParentPickedFromBom(dbGet, dbAll, dbRun, outbound_item_id);
    } else {
      const sumTx2 = await dbGet(
        `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions
         WHERE outbound_item_id = ? AND COALESCE(is_bom_pick, 0) = 0`,
        [outbound_item_id]
      );
      const pickedFromTx2 = Number(sumTx2?.s) || 0;
      const pickedColumn2 = Number(item.picked_qty) || 0;
      const already2 = Math.max(pickedFromTx2, pickedColumn2);
      const newPicked = already2 + picked_qty;
      await dbRun(`UPDATE outbound_items SET picked_qty = ? WHERE id = ?`, [newPicked, outbound_item_id]);
    }

    const nextStatus = order.status === 'Sent For Pick' ? 'Picking' : order.status;
    await dbRun(`UPDATE outbound_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      nextStatus,
      outbound_order_id,
    ]);

    await dbRun('COMMIT');

    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'PICKING',
      action_type: 'PICK_CONFIRMED',
      reference_type: 'outbound_order',
      reference_id: outbound_order_id,
      reference_number: order.outbound_number || order.delivery,
      remarks: 'new_rack_row',
      new_value: { outbound_item_id, rack_location, picked_qty, stock_by_rack_id: rackRow.id },
    });

    const refreshed = await dbGet(`SELECT * FROM outbound_items WHERE id = ?`, [outbound_item_id]);
    res.json({ ok: true, item: refreshed, stock_by_rack_id: rackRow.id, picked_qty });

    const sales_doc = order.sales_doc || order.sales_order_number || '';
    void notifyPickProgress(
      'Order picked',
      `Pick with new rack by ${user_name}\nOutbound: ${deliveryRef}\nSales Doc: ${sales_doc}`,
      { outbound_order_id, outbound_item_id }
    ).catch((nerr) => console.error('[mobile] notifyPickProgress (new rack):', nerr?.message || nerr));
  } catch (e) {
    try {
      await dbRun('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(400).json({ error: String(e?.message || e || 'Pick failed') });
  }
});

router.post('/picking/confirm-order', requirePermission('can_pick_orders'), async (req, res) => {
  const outbound_order_id = Number(req.body?.outbound_order_id);
  if (!outbound_order_id) return res.status(400).json({ error: 'outbound_order_id required' });

  try {
    const userRow = await dbGet(`SELECT id, full_name, username FROM users WHERE id = ?`, [req.user.sub]);
    const user_name = userRow?.full_name || userRow?.username || req.user.username;

    const order = await dbGet(`SELECT * FROM outbound_orders WHERE id = ?`, [outbound_order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const items = await listOutboundItemsWithPickTotals(outbound_order_id);
    const shortfalls = [];
    for (const it of items) {
      const ok = await outboundItemLineIsFullyPicked(dbGet, dbAll, it);
      if (!ok) {
        const obrx = await dbGet(`SELECT 1 AS x FROM outbound_bom_requirements WHERE outbound_item_id = ? LIMIT 1`, [
          it.id,
        ]);
        const isBomLine = Boolean(obrx?.x);
        const col = Number(it.picked_qty) || 0;
        const txSum = Number(it.picked_from_tx) || 0;
        const picked = isBomLine ? col : Math.max(col, txSum);
        const reqQ = Number(it.required_qty) || 0;
        shortfalls.push({
          item_id: it.id,
          material: it.material || null,
          part_number: it.part_number || null,
          sap_part_number: it.sap_part_number || null,
          picked_qty_column: col,
          picked_from_transactions: txSum,
          picked_effective: picked,
          required: reqQ,
          shortage: Math.max(0, reqQ - picked),
        });
      }
    }

    const stNorm = String(order.status || '').trim();
    const stLo = stNorm.toLowerCase();

    /** Outbound row was set Picked without picked_orders (legacy / admin / reverse-delivery). */
    if (stLo === 'picked' || stLo === 'checked') {
      const existingPo = await dbGet(`SELECT 1 AS x FROM picked_orders WHERE outbound_order_id = ?`, [
        outbound_order_id,
      ]);
      if (existingPo?.x != null) {
        return res.status(400).json({ error: 'Order already confirmed' });
      }
      if (shortfalls.length) {
        return res.status(400).json({
          error:
            'Order is marked picked but pick totals look incomplete. Fix on web or finish picking before saving confirmation.',
          shortfalls,
        });
      }
      await dbRun('BEGIN IMMEDIATE');
      await dbRun(
        `INSERT INTO picked_orders (
          outbound_order_id, delivery, sales_doc, customer_reference, sold_to, name_1,
          confirmed_by_user_id, confirmed_by_user_name, confirmed_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'Picked')`,
        [
          outbound_order_id,
          order.delivery || order.outbound_number,
          order.sales_doc || order.sales_order_number,
          order.customer_reference || order.customer_po_number,
          order.sold_to || order.vendor_name,
          order.name_1 || order.customer_name,
          req.user.sub,
          user_name,
        ]
      );
      await dbRun('COMMIT');
      logAudit({
        warehouse_id: order.warehouse_id,
        req,
        module_name: 'PICKING',
        action_type: 'PICK_CONFIRMED',
        reference_type: 'outbound_order',
        reference_id: outbound_order_id,
        reference_number: order.outbound_number || order.delivery,
        status_before: stNorm,
        status_after: 'Picked',
        remarks: 'repair_picked_orders_row',
      });
      const deliveryRef0 = order.delivery || order.outbound_number || '';
      const sales_doc0 = order.sales_doc || order.sales_order_number || '';
      void notifyPickProgress(
        'Order picked',
        `${user_name} saved picked order record\nOutbound: ${deliveryRef0}\nSales Doc: ${sales_doc0}`,
        { outbound_order_id }
      ).catch((nerr) => console.error('[mobile] notifyPickProgress (repair picked_orders):', nerr?.message || nerr));
      void notifyAdminChecker(
        'Order picked',
        `${user_name} saved picked order record\nOutbound: ${deliveryRef0}\nSales Doc: ${sales_doc0}`,
        { outbound_order_id }
      ).catch((nerr) => console.error('[mobile] notifyAdminChecker (repair picked_orders):', nerr?.message || nerr));
      return res.json({ ok: true, status: stNorm, repaired_picked_orders: true });
    }

    if (!['sent for pick', 'picking'].includes(stLo)) {
      return res.status(400).json({ error: 'Order cannot be confirmed in current status' });
    }

    if (shortfalls.length) {
      console.warn(
        '[mobile] confirm-order blocked — order %s incomplete (%s line(s)):',
        outbound_order_id,
        shortfalls.length,
        JSON.stringify(shortfalls, null, 0)
      );
      const first = shortfalls[0];
      return res.status(400).json({
        error: 'Not all items fully picked',
        shortfalls,
        item_id: first.item_id,
        picked: first.picked_effective,
        picked_qty_column: first.picked_qty_column,
        picked_from_transactions: first.picked_from_transactions,
        required: first.required,
      });
    }

    await dbRun('BEGIN IMMEDIATE');
    await dbRun(
      `INSERT INTO picked_orders (
        outbound_order_id, delivery, sales_doc, customer_reference, sold_to, name_1,
        confirmed_by_user_id, confirmed_by_user_name, confirmed_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'Picked')`,
      [
        outbound_order_id,
        order.delivery || order.outbound_number,
        order.sales_doc || order.sales_order_number,
        order.customer_reference || order.customer_po_number,
        order.sold_to || order.vendor_name,
        order.name_1 || order.customer_name,
        req.user.sub,
        user_name,
      ]
    );
    await dbRun(`UPDATE outbound_orders SET status = 'Picked', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      outbound_order_id,
    ]);
    await dbRun('COMMIT');

    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'PICKING',
      action_type: 'PICK_CONFIRMED',
      reference_type: 'outbound_order',
      reference_id: outbound_order_id,
      reference_number: order.outbound_number || order.delivery,
      status_before: order.status,
      status_after: 'Picked',
    });

    const deliveryRef = order.delivery || order.outbound_number || '';
    const sales_doc = order.sales_doc || order.sales_order_number || '';
    await notifyPickProgress(
      'Order confirmed picked',
      `${user_name} confirmed picked\nOutbound: ${deliveryRef}\nSales Doc: ${sales_doc}`,
      { outbound_order_id }
    );
    await notifyAdminChecker(
      'Order confirmed picked',
      `${user_name} confirmed picked\nOutbound: ${deliveryRef}\nSales Doc: ${sales_doc}`,
      { outbound_order_id }
    );

    res.json({ ok: true, status: 'Picked' });
  } catch (e) {
    try {
      await dbRun('ROLLBACK');
    } catch {
      // ignore
    }
    if (String(e.message || '').includes('UNIQUE')) {
      return res.status(400).json({ error: 'Order already confirmed' });
    }
    res.status(400).json({ error: e.message });
  }
});

// Picker requests rack/qty change (admin reviews in web)
router.post('/picking/change-request', requirePermission('can_pick_orders'), async (req, res) => {
  try {
    const b = req.body || {};
    const outbound_order_id = Number(b.outbound_order_id);
    const outbound_item_id = Number(b.outbound_item_id);
    const fifo_suggestion_id = b.fifo_suggestion_id ? Number(b.fifo_suggestion_id) : null;
    const requested_rack_location = b.requested_rack_location ? normRack(b.requested_rack_location) : null;
    const requested_qty = b.requested_qty !== undefined && b.requested_qty !== null ? Number(b.requested_qty) : null;
    const reason = b.reason ? String(b.reason).trim() : null;

    if (!outbound_order_id || !outbound_item_id) {
      return res.status(400).json({ error: 'outbound_order_id and outbound_item_id required' });
    }

    const userRow = await dbGet(`SELECT id, full_name, username FROM users WHERE id = ?`, [req.user.sub]);
    const user_name = userRow?.full_name || userRow?.username || req.user.username;

    const order = await dbGet(`SELECT * FROM outbound_orders WHERE id = ?`, [outbound_order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const item = await dbGet(`SELECT * FROM outbound_items WHERE id = ? AND outbound_id = ?`, [
      outbound_item_id,
      outbound_order_id,
    ]);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    await dbRun(
      `INSERT INTO pick_change_requests (
        outbound_order_id, outbound_item_id, fifo_suggestion_id,
        requested_rack_location, requested_qty, reason,
        requested_by_user_id, requested_by_user_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outbound_order_id,
        outbound_item_id,
        fifo_suggestion_id,
        requested_rack_location,
        requested_qty,
        reason,
        req.user.sub,
        user_name,
      ]
    );

    const deliveryRef = order.delivery || order.outbound_number || String(outbound_order_id);
    const mat = item.material || item.part_number || '';
    await notifyAdminChecker(
      'Pick change request',
      `${user_name} requested change\nOutbound: ${deliveryRef}\nItem: ${mat}\nRack: ${requested_rack_location || '-'} Qty: ${
        requested_qty ?? '-'
      }\nReason: ${reason || '-'}`,
      { outbound_order_id, outbound_item_id, fifo_suggestion_id }
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/upcoming', requirePermission('can_view_upcoming_orders'), async (req, res) => {
  try {
    const scope = await mobileWarehouseScope(req, res);
    if (!scope) return;
    const wh = scope.mode === 'all' ? '' : ' AND warehouse_id = ? ';
    const params = scope.mode === 'all' ? [] : [scope.warehouseId];
    const rows = await dbAll(
      `SELECT * FROM outbound_orders
       WHERE status IN ('Uploaded', 'Stock Checked', 'Sent For Pick', 'Picking') ${wh}
       ORDER BY updated_at DESC
       LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/rack/:rack_location', requirePermission('can_scan_rack'), async (req, res) => {
  try {
    const scope = await mobileWarehouseScope(req, res);
    if (!scope) return;
    const q = `%${String(req.params.rack_location || '').trim()}%`;
    const wh = scope.mode === 'all' ? '' : ' AND warehouse_id = ? ';
    const params = scope.mode === 'all' ? [q] : [q, scope.warehouseId];
    const rows = await dbAll(
      `SELECT * FROM stock_by_rack WHERE rack_location LIKE ? ${wh} ORDER BY part_number LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/rack-scan/import', requirePermission('can_scan_rack'), async (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array required' });
    let n = 0;
    await dbRun('BEGIN IMMEDIATE');
    for (const r of rows) {
      await applyStockIn(db, r, { updateExisting: false });
      n += 1;
    }
    await dbRun('COMMIT');
    res.json({ ok: true, imported: n });
  } catch (e) {
    try {
      await dbRun('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(400).json({ error: e.message });
  }
});

router.get('/inbound-batches', async (req, res) => {
  try {
    const scope = await mobileWarehouseScope(req, res);
    if (!scope) return;
    const whClause = scope.mode === 'all' ? '' : ' WHERE b.warehouse_id = ? ';
    const params = scope.mode === 'all' ? [] : [scope.warehouseId];
    const rows = await dbAll(
      `SELECT b.*,
        (SELECT COUNT(*) FROM inbound_items i WHERE i.inbound_batch_id = b.id) AS item_count,
        (SELECT COALESCE(SUM(i.remaining_qty),0) FROM inbound_items i WHERE i.inbound_batch_id = b.id) AS sum_remaining
       FROM inbound_batches b
       ${whClause}
       ORDER BY b.id DESC
       LIMIT 300`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/inbound-batches/:id', async (req, res) => {
  try {
    const scope = await mobileWarehouseScope(req, res);
    if (!scope) return;
    const id = Number(req.params.id);
    const batch = await dbGet(`SELECT * FROM inbound_batches WHERE id = ?`, [id]);
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    if (scope.mode === 'one' && scope.warehouseId && Number(batch.warehouse_id) !== Number(scope.warehouseId)) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const items = await dbAll(
      `SELECT * FROM inbound_items WHERE inbound_batch_id = ? ORDER BY part_number`,
      [id]
    );
    res.json({ batch, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/putaway/upload', requirePermission('can_receive_stock'), async (req, res) => {
  try {
    const b = req.body || {};
    const inbound_batch_id = Number(b.inbound_batch_id);
    const inbound_item_id = Number(b.inbound_item_id);
    const part_number = String(b.part_number || '').trim();
    const rack_location = normRack(b.rack_location || b.scan_rack || '');
    const qty = Number(b.qty);
    const transaction_date = b.transaction_date || new Date().toISOString().slice(0, 10);
    const remarks = String(b.remarks || '').trim();
    const user_name = String(req.user?.username || '').trim() || 'mobile';

    if (!inbound_batch_id || !inbound_item_id || !part_number || !rack_location || !(qty > 0)) {
      return res.status(400).json({
        error: 'inbound_batch_id, inbound_item_id, part_number, rack_location, qty required',
      });
    }

    const item = await dbGet(`SELECT * FROM inbound_items WHERE id = ? AND inbound_batch_id = ?`, [
      inbound_item_id,
      inbound_batch_id,
    ]);
    if (!item) return res.status(404).json({ error: 'Inbound item not found' });
    if (String(item.part_number).trim() !== part_number) return res.status(400).json({ error: 'part_number mismatch' });

    const rem = Number(item.remaining_qty);
    if (qty > rem + QTY_EPS) return res.status(400).json({ error: 'Qty exceeds remaining putaway allowance' });

    await dbRun('BEGIN IMMEDIATE');
    await dbRun(
      `INSERT INTO inbound_putaway_lines
        (inbound_item_id, inbound_batch_id, part_number, rack_location, qty, transaction_date, user_name, remarks, applied_to_rack)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        inbound_item_id,
        inbound_batch_id,
        part_number,
        rack_location,
        qty,
        transaction_date,
        user_name,
        remarks || null,
      ]
    );

    const nextPut = Number(item.putaway_qty) + qty;
    const nextRem = Math.max(0, Number(item.total_qty) - nextPut);
    const st = nextRem <= QTY_EPS ? 'Completed' : nextPut > QTY_EPS ? 'Partial' : 'Pending';

    await dbRun(
      `UPDATE inbound_items SET putaway_qty = ?, remaining_qty = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [nextPut, nextRem, st, inbound_item_id]
    );

    await updateInboundBatchStatus(inbound_batch_id);
    await dbRun('COMMIT');

    const batchRow = await dbGet(`SELECT warehouse_id FROM inbound_batches WHERE id = ?`, [inbound_batch_id]);
    logAudit({
      warehouse_id: batchRow?.warehouse_id,
      req,
      module_name: 'PUTAWAY',
      action_type: st === 'Completed' ? 'PUTAWAY_COMPLETED' : 'PUTAWAY_PARTIAL',
      reference_type: 'inbound_item',
      reference_id: inbound_item_id,
      reference_number: part_number,
      status_after: st,
      new_value: { rack_location, qty, inbound_batch_id },
    });

    const updated = await dbGet(`SELECT * FROM inbound_items WHERE id = ?`, [inbound_item_id]);
    res.json({ ok: true, item: updated });
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  }
});

router.post('/receiving', requirePermission('can_receive_stock'), async (req, res) => {
  try {
    const b = req.body || {};
    const transaction_date = b.transaction_date || new Date().toISOString().slice(0, 10);
    const row = {
      transaction_date,
      part_number: String(b.part_number || '').trim(),
      sap_part_number: b.sap_part_number || null,
      description: b.description || '',
      rack_location: String(b.scan_rack || b.rack_location || '').trim(),
      qty_in: Number(b.qty_in),
      source_type: 'mobile_receiving',
      reference_no: b.reference_no || '',
      remarks: b.remarks || '',
    };
    if (!row.part_number || !row.rack_location || !(row.qty_in > 0)) {
      return res.status(400).json({ error: 'scan_rack/part_number/qty_in required' });
    }

    await dbRun('BEGIN IMMEDIATE');
    await applyStockIn(db, row, { updateExisting: false });
    await bumpMainStock(row.part_number, row.sap_part_number, row.description, row.qty_in);
    await dbRun('COMMIT');

    const rackWh = await dbGet(
      `SELECT warehouse_id FROM stock_by_rack WHERE part_number = ? AND rack_location = ? ORDER BY id DESC LIMIT 1`,
      [row.part_number, row.rack_location]
    );
    logAudit({
      warehouse_id: rackWh?.warehouse_id,
      req,
      module_name: 'MAIN_STOCK',
      action_type: 'STOCK_IN',
      reference_type: 'mobile_receiving',
      reference_number: row.reference_no || row.part_number,
      new_value: {
        part_number: row.part_number,
        rack_location: row.rack_location,
        qty_in: row.qty_in,
        transaction_date: row.transaction_date,
      },
    });

    await notifyAdminChecker('Receiving saved', `${row.part_number} +${row.qty_in} @ ${row.rack_location}`, {
      part_number: row.part_number,
    });

    res.json({ ok: true });
  } catch (e) {
    try {
      await dbRun('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
