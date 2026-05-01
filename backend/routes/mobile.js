const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requireAuth, requireMobileAccess, requirePermission } = require('../middleware/auth');
const { applyStockIn } = require('./stock-in');
const MainStock = require('../models/MainStock');
const { notifyPickProgress, notifyAdminChecker } = require('../services/notificationService');

const router = express.Router();
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

const mainStock = new MainStock();

router.use(requireAuth);
router.use(requireMobileAccess);

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

router.get('/orders', requirePermission('can_view_orders'), async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT o.*,
        SUM(i.required_qty) AS total_required,
        SUM(i.picked_qty) AS total_picked
       FROM outbound_orders o
       LEFT JOIN outbound_items i ON i.outbound_id = o.id
       WHERE o.status IN ('Sent For Pick', 'Picking')
       GROUP BY o.id
       ORDER BY o.updated_at DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders/:id', requirePermission('can_view_orders'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order = await dbGet('SELECT * FROM outbound_orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const items = await listOutboundItemsWithPickTotals(orderId);

    const fifo = await dbAll(
      `SELECT f.*,
        (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE fifo_suggestion_id = f.id) AS fifo_picked_qty
       FROM fifo_suggestions f WHERE f.outbound_order_id = ?
       ORDER BY f.outbound_item_id, f.fifo_sequence`,
      [orderId]
    );

    const itemsOut = items.map((it) => ({
      ...it,
      picked_qty_effective: Math.max(Number(it.picked_qty) || 0, Number(it.picked_from_tx) || 0),
      remaining_qty: Math.max(
        0,
        (Number(it.required_qty) || 0) -
          Math.max(Number(it.picked_qty) || 0, Number(it.picked_from_tx) || 0)
      ),
    }));

    res.json({ ...order, items: itemsOut, fifo_suggestions: fifo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

    const sumTx = await dbGet(
      `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions WHERE outbound_item_id = ?`,
      [outbound_item_id]
    );
    // Must match GET /mobile/orders/:id remaining_qty (max of column vs tx sum).
    const pickedFromTx = Number(sumTx?.s) || 0;
    const pickedColumn = Number(item.picked_qty) || 0;
    const already = Math.max(pickedFromTx, pickedColumn);
    const required = Number(item.required_qty) || 0;
    const remaining = Math.max(0, required - already);
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

    await dbRun(
      `INSERT INTO picked_transactions (
        outbound_order_id, outbound_item_id, fifo_suggestion_id, user_id, user_name,
        material, sap_part_number, description, rack_location, picked_qty, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outbound_order_id,
        outbound_item_id,
        fifo_suggestion_id,
        req.user.sub,
        user_name,
        item.material || item.part_number,
        item.sap_part_number,
        item.description,
        sug.rack_location,
        picked_qty,
        device_id,
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
        item.part_number,
        item.sap_part_number,
        item.description,
        sug.rack_location,
        picked_qty,
        deliveryRef,
        `pick_tx_fifo_${fifo_suggestion_id}`,
        `picker:${user_name}`,
      ]
    );

    const newPicked = already + picked_qty;
    await dbRun(`UPDATE outbound_items SET picked_qty = ? WHERE id = ?`, [newPicked, outbound_item_id]);

    const nextStatus = order.status === 'Sent For Pick' ? 'Picking' : order.status;
    await dbRun(`UPDATE outbound_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      nextStatus,
      outbound_order_id,
    ]);

    await dbRun('COMMIT');

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

router.post('/picking/confirm-order', requirePermission('can_pick_orders'), async (req, res) => {
  const outbound_order_id = Number(req.body?.outbound_order_id);
  if (!outbound_order_id) return res.status(400).json({ error: 'outbound_order_id required' });

  try {
    const userRow = await dbGet(`SELECT id, full_name, username FROM users WHERE id = ?`, [req.user.sub]);
    const user_name = userRow?.full_name || userRow?.username || req.user.username;

    const order = await dbGet(`SELECT * FROM outbound_orders WHERE id = ?`, [outbound_order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['Sent For Pick', 'Picking'].includes(order.status)) {
      return res.status(400).json({ error: 'Order cannot be confirmed in current status' });
    }

    const items = await listOutboundItemsWithPickTotals(outbound_order_id);
    const shortfalls = [];
    for (const it of items) {
      const col = Number(it.picked_qty) || 0;
      const txSum = Number(it.picked_from_tx) || 0;
      const picked = Math.max(col, txSum);
      const reqQ = Number(it.required_qty) || 0;
      if (picked + QTY_EPS < reqQ) {
        shortfalls.push({
          item_id: it.id,
          material: it.material || null,
          part_number: it.part_number || null,
          sap_part_number: it.sap_part_number || null,
          picked_qty_column: col,
          picked_from_transactions: txSum,
          picked_effective: picked,
          required: reqQ,
          shortage: reqQ - picked,
        });
      }
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

router.get('/upcoming', requirePermission('can_view_upcoming_orders'), async (_req, res) => {
  try {
    const rows = await dbAll(
      `SELECT * FROM outbound_orders
       WHERE status IN ('Uploaded', 'Stock Checked', 'Sent For Pick', 'Picking')
       ORDER BY updated_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/rack/:rack_location', requirePermission('can_scan_rack'), async (req, res) => {
  try {
    const q = `%${String(req.params.rack_location || '').trim()}%`;
    const rows = await dbAll(
      `SELECT * FROM stock_by_rack WHERE rack_location LIKE ? ORDER BY part_number LIMIT 200`,
      [q]
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
