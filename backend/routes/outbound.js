const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { promisify } = require('util');

const db = require('../db');
const { requirePermission, requireAdmin } = require('../middleware/auth');
const MainStock = require('../models/MainStock');
const OutboundOrder = require('../models/OutboundOrder');
const OutboundItem = require('../models/OutboundItem');
const { generateFifoForOutboundOrder, listFifoForOrder } = require('../services/godamFifo');
const { notifyPickOrder, notifyPickProgress } = require('../services/notificationService');
const { normalizeExcelRows } = require('../utils/excelDates');
const { markOutboundDelivered, reverseOutboundDelivered } = require('../services/markOutboundDelivered');

const router = express.Router();
const outboundOrder = new OutboundOrder();
const outboundItem = new OutboundItem();
const mainStock = new MainStock();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const QTY_EPS = 1e-6;

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
router.post('/upload', requirePermission('can_upload_outbound'), upload.single('file'), async (req, res) => {
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
    const created = [];

    for (const [, groupRows] of byDelivery) {
      const head = headerFromRows(groupRows);
      const items = mergeLinesForDelivery(groupRows);
      if (!items.length) continue;

      const deliveryKey = head.delivery || String(pick(groupRows[0], 'Delivery')).trim();

      await dbRun('BEGIN IMMEDIATE');
      try {
        const existing = await dbGet(
          `SELECT * FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`,
          [deliveryKey, deliveryKey]
        );

        if (existing) {
          const st = String(existing.status || '').toLowerCase();
          if (['picked', 'delivered'].includes(st)) {
            throw new Error(`Cannot re-upload delivery ${deliveryKey} because it is already ${existing.status}`);
          }
        }

        let orderId;
        if (existing?.id) {
          orderId = Number(existing.id);
          await dbRun(
            `UPDATE outbound_orders
             SET outbound_number = ?,
                 delivery = ?,
                 sales_doc = ?,
                 gapp_po = ?,
                 customer_reference = ?,
                 sold_to = ?,
                 name_1 = ?,
                 sales_order_number = ?,
                 customer_po_number = ?,
                 customer_name = ?,
                 vendor_name = ?,
                 status = 'Uploaded',
                 uploaded_by_user_id = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
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
              orderId,
            ]
          );
          // Make upload idempotent: replace lines + fifo for this delivery.
          await dbRun(`DELETE FROM outbound_items WHERE outbound_id = ?`, [orderId]);
          await dbRun(`DELETE FROM fifo_suggestions WHERE outbound_order_id = ?`, [orderId]);
        } else {
          orderId = await new Promise((resolve, reject) => {
            db.run(
              `INSERT INTO outbound_orders (
              outbound_number, delivery, sales_doc, gapp_po, customer_reference, sold_to, name_1,
              sales_order_number, customer_po_number, customer_name, vendor_name,
              status, uploaded_by_user_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Uploaded', ?, CURRENT_TIMESTAMP)`,
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
              ],
              function (err) {
                if (err) reject(err);
                else resolve(this.lastID);
              }
            );
          });
        }

        for (const it of items) {
          const pn = it.material || it.sap_part_number;
          await dbRun(
            `INSERT INTO outbound_items (
              outbound_id, part_number, sap_part_number, material, description,
              required_qty, picked_qty, status
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending')`,
            [orderId, pn, it.sap_part_number, it.material || pn, it.description || '', it.required_qty]
          );
        }

        await dbRun('COMMIT');
        // Auto check-stock + FIFO immediately after upload.
        await (async () => {
          const orderItems = await dbAll('SELECT * FROM outbound_items WHERE outbound_id = ?', [orderId]);
          for (const item of orderItems) {
            const ms = await mainStock.findByPartOrSap(item.material || item.part_number, item.sap_part_number);
            const avail = ms ? Number(ms.available_qty) || 0 : 0;
            const reqQ = Number(item.required_qty) || 0;
            const fifo_status = reqQ <= avail ? 'Available' : 'Shortage';
            const shortage_qty = Math.max(0, reqQ - avail);
            await dbRun(
              `UPDATE outbound_items SET available_qty_main_stock = ?, fifo_status = ?, shortage_qty = ? WHERE id = ?`,
              [avail, fifo_status, shortage_qty, item.id]
            );
          }
        })();
        await generateFifoForOutboundOrder(orderId);
        const order = await outboundOrder.findById(orderId);
        created.push(order);
      } catch (e) {
        await dbRun('ROLLBACK').catch(() => {});
        throw e;
      }
    }

    res.status(201).json({ orders: created });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/check-stock', requirePermission('can_upload_outbound'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const items = await dbAll('SELECT * FROM outbound_items WHERE outbound_id = ?', [orderId]);
    for (const item of items) {
      const ms = await mainStock.findByPartOrSap(item.material || item.part_number, item.sap_part_number);
      const avail = ms ? Number(ms.available_qty) || 0 : 0;
      const reqQ = Number(item.required_qty) || 0;
      const fifo_status = reqQ <= avail ? 'Available' : 'Shortage';
      const shortage_qty = Math.max(0, reqQ - avail);
      await dbRun(
        `UPDATE outbound_items SET available_qty_main_stock = ?, fifo_status = ?, shortage_qty = ? WHERE id = ?`,
        [avail, fifo_status, shortage_qty, item.id]
      );
    }
    await dbRun(`UPDATE outbound_orders SET status = 'Stock Checked', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      orderId,
    ]);
    const order = await outboundOrder.findById(orderId);
    res.json(order);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/generate-fifo', requirePermission('can_upload_outbound'), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const fifo = await generateFifoForOutboundOrder(orderId);
    res.json({ ok: true, fifo_suggestions: fifo });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/send-for-pick', requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order = await dbGet('SELECT * FROM outbound_orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['Uploaded', 'Stock Checked'].includes(String(order.status || ''))) {
      return res.status(400).json({ error: 'Only Uploaded or Stock Checked orders can be sent for pick' });
    }

    await dbRun(`UPDATE outbound_orders SET status = 'Sent For Pick', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      orderId,
    ]);

    const sold_to = order.sold_to || order.vendor_name || '';
    const delivery = order.delivery || order.outbound_number || '';
    const sales_doc = order.sales_doc || order.sales_order_number || '';
    const body = `Prepare: ${sold_to}_${delivery}_${sales_doc}`;

    await notifyPickOrder('New Pick Order', body, { outbound_order_id: orderId, type: 'send_for_pick' });

    res.json({ ok: true, status: 'Sent For Pick', notification_preview: { title: 'New Pick Order', body } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/manual-pick', requireAdmin, async (req, res) => {
  const orderId = Number(req.params.id);
  const override = !!req.body?.override;
  const reason = String(req.body?.reason || '').trim();
  if (!orderId) return res.status(400).json({ error: 'Invalid id' });
  if (override && !reason) return res.status(400).json({ error: 'Override reason is required' });

  try {
    const adminRow = await dbGet(`SELECT id, full_name, username FROM users WHERE id = ?`, [req.user.sub]);
    const adminName = adminRow?.full_name || adminRow?.username || req.user.username || 'Admin';

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
      const already = Math.max(Number(item.picked_qty) || 0, Number(item.picked_from_tx) || 0);
      const required = Number(item.required_qty) || 0;
      let remaining = Math.max(0, required - already);
      if (remaining <= QTY_EPS) continue;

      const fifoRows = await dbAll(
        `SELECT f.*,
          (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE fifo_suggestion_id = f.id) AS fifo_picked_qty
         FROM fifo_suggestions f
         WHERE f.outbound_order_id = ? AND f.outbound_item_id = ?
         ORDER BY date(COALESCE(f.entry_date, '1970-01-01')) ASC, f.id ASC`,
        [orderId, item.id]
      );

      const fifoAvailable = fifoRows.reduce(
        (sum, f) => sum + Math.max(0, (Number(f.suggested_qty) || 0) - (Number(f.fifo_picked_qty) || 0)),
        0
      );
      if (fifoAvailable + QTY_EPS < remaining) {
        throw new Error(
          `Insufficient FIFO suggestion for ${item.material || item.part_number}: need ${remaining}, suggested ${fifoAvailable}`
        );
      }

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
          throw new Error(`Insufficient rack qty at ${f.rack_location}: need ${pickQty}, available ${rackAvail}`);
        }

        await dbRun(
          `INSERT INTO picked_transactions (
            outbound_order_id, outbound_item_id, fifo_suggestion_id, user_id, user_name,
            material, sap_part_number, description, rack_location, picked_qty, device_id,
            picked_method, is_manual_pick, manual_pick_reason, picked_by_role
          ) VALUES (?, ?, ?, ?, 'Admin Manual', ?, ?, ?, ?, ?, NULL, 'Manual Admin', 1, ?, ?)`,
          [
            orderId,
            item.id,
            f.id,
            req.user.sub,
            item.material || item.part_number,
            item.sap_part_number,
            item.description,
            f.rack_location,
            pickQty,
            override ? reason : null,
            String(req.user.role || 'admin').toLowerCase(),
          ]
        );

        await dbRun(
          `UPDATE stock_by_rack
           SET available_qty = ?, total_out_qty = ?, last_updated = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [rackAvail - pickQty, (Number(rack.total_out_qty) || 0) + pickQty, rack.id]
        );

        const today = new Date().toISOString().slice(0, 10);
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
            f.rack_location,
            pickQty,
            orderFresh.delivery || orderFresh.outbound_number || String(orderId),
            `manual_pick_fifo_${f.id}`,
            override ? `Admin Manual override:${reason}` : `Admin Manual:${adminName}`,
          ]
        );

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

      await dbRun(`UPDATE outbound_items SET picked_qty = ? WHERE id = ?`, [already + itemPickedNow, item.id]);
    }

    const shortfalls = await dbAll(
      `SELECT i.id, i.part_number, i.required_qty,
        MAX(COALESCE(i.picked_qty, 0), COALESCE((SELECT SUM(picked_qty) FROM picked_transactions WHERE outbound_item_id = i.id), 0)) AS picked_qty
       FROM outbound_items i
       WHERE i.outbound_id = ?
         AND COALESCE(i.required_qty, 0) >
             MAX(COALESCE(i.picked_qty, 0), COALESCE((SELECT SUM(picked_qty) FROM picked_transactions WHERE outbound_item_id = i.id), 0)) + ?`,
      [orderId, QTY_EPS]
    );

    if (shortfalls.length) {
      await dbRun(`UPDATE outbound_orders SET status = 'Picking', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [orderId]);
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO picked_orders (
          outbound_order_id, delivery, sales_doc, customer_reference, sold_to, name_1,
          confirmed_by_user_id, confirmed_by_user_name, confirmed_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Admin Manual', CURRENT_TIMESTAMP, 'Picked')`,
        [
          orderId,
          orderFresh.delivery || orderFresh.outbound_number,
          orderFresh.sales_doc || orderFresh.sales_order_number,
          orderFresh.customer_reference || orderFresh.customer_po_number,
          orderFresh.sold_to || orderFresh.vendor_name,
          orderFresh.name_1 || orderFresh.customer_name,
          req.user.sub,
        ]
      );
      await dbRun(`UPDATE outbound_orders SET status = 'Picked', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [orderId]);
    }

    await dbRun('COMMIT');

    const updated = await outboundOrder.findById(orderId);
    const fifo = await listFifoForOrder(orderId);
    res.json({ ok: true, status: shortfalls.length ? 'Picking' : 'Picked', picked_lines: pickedLines, order: { ...updated, fifo_suggestions: fifo } });
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    res.status(400).json({ error: e.message });
  }
});

/** Same as delivery-note deliver — deduct main_stock only here (sold_out_qty), insert sold_out + guard double delivery. */
router.post('/:id/mark-delivered', requirePermission('can_upload_outbound'), async (req, res) => {
  const orderId = Number(req.params.id);
  if (!orderId) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await markOutboundDelivered(db, orderId, { requireInvoice: true });
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
    res.json(result);
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ error: e.message });
  }
});

router.post('/:id/change-pick-location', requireAdmin, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { fifo_suggestion_id, stock_by_rack_id } = req.body || {};
    const sid = Number(fifo_suggestion_id);
    const rid = Number(stock_by_rack_id);
    if (!sid || !rid) return res.status(400).json({ error: 'fifo_suggestion_id and stock_by_rack_id required' });

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
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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

    // Recompute shortage + FIFO for order
    const ms = await mainStock.findByPartOrSap(item.material || item.part_number, item.sap_part_number);
    const avail = ms ? Number(ms.available_qty) || 0 : 0;
    const fifo_status = required_qty <= avail ? 'Available' : 'Shortage';
    const shortage_qty = Math.max(0, required_qty - avail);
    await dbRun(
      `UPDATE outbound_items SET available_qty_main_stock = ?, fifo_status = ?, shortage_qty = ? WHERE id = ?`,
      [avail, fifo_status, shortage_qty, itemId]
    );

    await generateFifoForOutboundOrder(orderId);
    const updated = await outboundOrder.findById(orderId);
    const fifo = await listFifoForOrder(orderId);
    return res.json({ ...updated, fifo_suggestions: fifo });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// GET /api/outbound - List orders
router.get('/', async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const orders = await outboundOrder.findAll({
      search: search || '',
      status: status || '',
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
    res.json(orders);
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

    await dbRun('DELETE FROM fifo_suggestions WHERE outbound_order_id = ?', [orderId]);
    await dbRun('DELETE FROM pick_change_requests WHERE outbound_order_id = ?', [orderId]).catch(() => {});
    await dbRun('DELETE FROM pick_suggestions WHERE outbound_id = ?', [orderId]).catch(() => {});
    await dbRun('DELETE FROM picked_transactions WHERE outbound_order_id = ?', [orderId]).catch(() => {});
    await dbRun('DELETE FROM picked_orders WHERE outbound_order_id = ?', [orderId]).catch(() => {});
    await dbRun('DELETE FROM delivered_outbounds WHERE outbound_id = ?', [orderId]).catch(() => {});
    await dbRun('DELETE FROM outbound_items WHERE outbound_id = ?', [orderId]);
    await dbRun('DELETE FROM outbound_orders WHERE id = ?', [orderId]);

    await dbRun('COMMIT');
    return res.json({ ok: true, deleted: true, id: orderId });
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    return res.status(400).json({ error: e.message });
  }
});

// POST /api/outbound - Create order (legacy)
router.post('/', async (req, res) => {
  try {
    const order = await outboundOrder.create(req.body);

    if (req.body.items && Array.isArray(req.body.items)) {
      const merged = dedupeOutboundItems(req.body.items);
      for (const item of merged) {
        await outboundItem.create({ ...item, outbound_id: order.id });
      }
    }

    res.status(201).json(order);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/outbound/:id - Get order with items + fifo
router.get('/:id', async (req, res) => {
  try {
    const order = await outboundOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const fifo = await listFifoForOrder(order.id);
    res.json({ ...order, fifo_suggestions: fifo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/outbound/:id/status - Update status
router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const result = await outboundOrder.updateStatus(req.params.id, status);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
