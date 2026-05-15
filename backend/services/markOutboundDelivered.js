const { promisify } = require('util');

/** sqlite3 promisify drops `this.changes`; use this for UPDATE … WHERE part_number = ? */
function runUpdateReturningChanges(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const { buildDeliveredDeductionLines } = require('./bomOutboundService');

/**
 * Mark outbound delivered: guard double delivery, check shortage, bump main_stock.sold_out_qty, insert sold_out + delivered_outbounds.
 * @param {import('sqlite3').Database} db
 */
async function markOutboundDelivered(db, orderId, { requireInvoice = true } = {}) {
  const dbRun = promisify(db.run.bind(db));
  const dbGet = promisify(db.get.bind(db));
  const dbAll = promisify(db.all.bind(db));

  const order = await dbGet('SELECT * FROM outbound_orders WHERE id = ?', [orderId]);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }
  let whId = Number(order.warehouse_id) || null;
  if (!whId) {
    const d = await dbGet(`SELECT id FROM warehouses ORDER BY id LIMIT 1`);
    whId = Number(d?.id) || null;
  }

  const items = await buildDeliveredDeductionLines(dbAll, dbGet, orderId);
  if (!items.length) {
    const err = new Error('Outbound has no items');
    err.statusCode = 400;
    throw err;
  }

  if (requireInvoice && !String(order.invoice_number || '').trim()) {
    const err = new Error('Invoice number is required before marking delivered');
    err.statusCode = 400;
    throw err;
  }

  const already = await dbGet('SELECT id FROM delivered_outbounds WHERE outbound_id = ?', [orderId]);
  if (already?.id) {
    const err = new Error('Already delivered (double deduction prevented)');
    err.statusCode = 409;
    throw err;
  }

  const shortages = [];
  for (const it of items) {
    const qty = asNumber(it.qty);
    const row = await dbGet(
      `SELECT part_number, received_qty, COALESCE(sold_out_qty, issued_qty, 0) AS sold_out,
              pending_delivery_qty, available_qty FROM main_stock WHERE part_number = ? AND warehouse_id = ?`,
      [it.part_number, whId]
    );
    const avail = row ? asNumber(row.available_qty) : 0;
    if (avail < qty) {
      shortages.push({
        part_number: it.part_number,
        required_qty: qty,
        available_qty: avail,
        shortage_qty: qty - avail,
      });
    }
  }
  if (shortages.length) {
    const err = new Error('Insufficient stock');
    err.statusCode = 400;
    err.shortages = shortages;
    throw err;
  }

  await dbRun('BEGIN IMMEDIATE');
  try {
    const dnDate = order.dn_date || new Date().toISOString().slice(0, 10);

    for (const it2 of items) {
      const qty2 = asNumber(it2.qty);
      const dedupeKey = `outbound-deliver:${orderId}:${it2.part_number}:${qty2}`;
      const sql = `UPDATE main_stock SET
           sold_out_qty = COALESCE(sold_out_qty, 0) + ?,
           issued_qty = COALESCE(issued_qty, 0) + ?,
           available_qty = received_qty - (COALESCE(sold_out_qty, 0) + ?) - COALESCE(pending_delivery_qty, 0),
           last_updated = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE part_number = ? AND warehouse_id = ?`;
      const changes = await runUpdateReturningChanges(db, sql, [qty2, qty2, qty2, it2.part_number, whId]);
      if (!changes) {
        const err = new Error(
          `Main stock has no row for part "${it2.part_number}". Stock was not deducted — add or align this part in Main Stock first.`
        );
        err.statusCode = 400;
        err.code = 'MAIN_STOCK_PART_MISSING';
        err.part_number = it2.part_number;
        throw err;
      }

      await dbRun(
        `INSERT INTO sold_out
          (date, po, gapp_po, customer_po, invoice_number, invoice, customer_name, delivery_address, gps,
           part_number, sap_part_number, description, sold_qty, outbound_qty, delivery, sales_doc, status, source_dn_id, dedupe_key, warehouse_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          dnDate,
          order.gapp_po || order.sales_doc || order.sales_order_number || '',
          order.gapp_po || order.sales_doc || '',
          order.customer_po_number || '',
          order.invoice_number || '',
          order.invoice_number || '',
          order.customer_name || '',
          order.delivery_address || '',
          '',
          it2.part_number,
          '',
          it2.description || '',
          qty2,
          qty2,
          order.delivery || order.outbound_number || '',
          order.gapp_po || order.sales_doc || order.sales_order_number || '',
          'Delivered',
          orderId,
          dedupeKey,
          whId,
        ]
      );
    }

    await dbRun('INSERT INTO delivered_outbounds (outbound_id) VALUES (?)', [orderId]);
    await dbRun(`UPDATE outbound_orders SET status = 'delivered', dn_status = 'Delivered', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      orderId,
    ]);

    await dbRun('COMMIT');
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }

  try {
    const { onOutboundMarkedDelivered } = require('./salesOrderDocumentsService');
    await onOutboundMarkedDelivered(db, orderId, order);
  } catch (e) {
    console.warn('[salesOrderDocuments] after delivered:', e.message);
  }

  return { ok: true, order_id: orderId, status: 'delivered' };
}

/**
 * Undo mark-delivered: remove sold_out rows and delivered_outbounds record, restore main_stock sold counts.
 * Expects the same per-part dedupe keys as markOutboundDelivered. Fails if sold_out rows are missing.
 * @param {import('sqlite3').Database} db
 */
async function reverseOutboundDelivered(db, orderId) {
  const dbRun = promisify(db.run.bind(db));
  const dbGet = promisify(db.get.bind(db));
  const dbAll = promisify(db.all.bind(db));

  const order = await dbGet('SELECT * FROM outbound_orders WHERE id = ?', [orderId]);
  if (!order) {
    const err = new Error('Order not found');
    err.statusCode = 404;
    throw err;
  }
  let whId = Number(order.warehouse_id) || null;
  if (!whId) {
    const d = await dbGet(`SELECT id FROM warehouses ORDER BY id LIMIT 1`);
    whId = Number(d?.id) || null;
  }

  const deliveredGuard = await dbGet('SELECT id FROM delivered_outbounds WHERE outbound_id = ?', [orderId]);
  if (!deliveredGuard?.id) {
    const err = new Error('Order is not marked delivered — nothing to reverse');
    err.statusCode = 409;
    throw err;
  }

  const items = await buildDeliveredDeductionLines(dbAll, dbGet, orderId);
  if (!items.length) {
    const err = new Error('Outbound has no items');
    err.statusCode = 400;
    throw err;
  }

  for (const it of items) {
    const qty = asNumber(it.qty);
    const dedupeKey = `outbound-deliver:${orderId}:${it.part_number}:${qty}`;
    const logRow = await dbGet('SELECT id FROM sold_out WHERE dedupe_key = ?', [dedupeKey]);
    if (!logRow?.id) {
      const err = new Error(
        `Cannot reverse: sold_out audit row missing for ${it.part_number} (dedupe key). Fix data or contact admin.`
      );
      err.statusCode = 409;
      throw err;
    }
    const ms = await dbGet(
      `SELECT COALESCE(sold_out_qty, issued_qty, 0) AS sold FROM main_stock WHERE part_number = ? AND warehouse_id = ?`,
      [it.part_number, whId]
    );
    const sold = asNumber(ms?.sold);
    if (sold < qty) {
      const err = new Error(
        `Cannot reverse: main stock sold_out for ${it.part_number} is lower than delivered qty (stock may have been adjusted).`
      );
      err.statusCode = 409;
      throw err;
    }
  }

  await dbRun('BEGIN IMMEDIATE');
  try {
    for (const it2 of items) {
      const qty2 = asNumber(it2.qty);
      const dedupeKey = `outbound-deliver:${orderId}:${it2.part_number}:${qty2}`;

      await dbRun('DELETE FROM sold_out WHERE dedupe_key = ?', [dedupeKey]);

      await dbRun(
        `UPDATE main_stock SET
           sold_out_qty = COALESCE(sold_out_qty, 0) - ?,
           issued_qty = COALESCE(issued_qty, 0) - ?,
           available_qty = received_qty - (COALESCE(sold_out_qty, 0) - ?) - COALESCE(pending_delivery_qty, 0),
           last_updated = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE part_number = ? AND warehouse_id = ?`,
        [qty2, qty2, qty2, it2.part_number, whId]
      );
    }

    await dbRun('DELETE FROM delivered_outbounds WHERE outbound_id = ?', [orderId]);
    await dbRun(
      `UPDATE outbound_orders SET status = 'Picked', dn_status = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [orderId]
    );

    await dbRun('COMMIT');
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }

  return {
    ok: true,
    order_id: orderId,
    status: 'Picked',
    note:
      'Stock and sold_out entries for this delivery were reversed. If the order was marked via Delivery Note, set that DN back from Delivered manually if needed.',
  };
}

module.exports = { markOutboundDelivered, reverseOutboundDelivered };
