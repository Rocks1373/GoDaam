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

/** Aggregate outbound_items by part_number for delivery / main-stock deduction */
function aggregateItemsByPartNumber(rows) {
  const map = new Map();
  for (const it of rows || []) {
    const pn = String(it.part_number ?? it.material ?? '').trim();
    if (!pn) continue;
    const qty = asNumber(it.required_qty);
    if (!map.has(pn)) {
      map.set(pn, { part_number: pn, description: it.description || '', required_qty: qty });
    } else {
      const ex = map.get(pn);
      ex.required_qty += qty;
    }
  }
  return [...map.values()];
}

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

  const rawItems = await dbAll('SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id ASC', [orderId]);
  const items = aggregateItemsByPartNumber(rawItems);
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
    const qty = asNumber(it.required_qty);
    const row = await dbGet(
      `SELECT part_number, received_qty, COALESCE(sold_out_qty, issued_qty, 0) AS sold_out,
              pending_delivery_qty, available_qty FROM main_stock WHERE part_number = ?`,
      [it.part_number]
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
      const qty2 = asNumber(it2.required_qty);
      const dedupeKey = `outbound-deliver:${orderId}:${it2.part_number}:${qty2}`;
      const sql = `UPDATE main_stock SET
           sold_out_qty = COALESCE(sold_out_qty, 0) + ?,
           issued_qty = COALESCE(issued_qty, 0) + ?,
           available_qty = received_qty - (COALESCE(sold_out_qty, 0) + ?) - COALESCE(pending_delivery_qty, 0),
           last_updated = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE part_number = ?`;
      const changes = await runUpdateReturningChanges(db, sql, [qty2, qty2, qty2, it2.part_number]);
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
           part_number, sap_part_number, description, sold_qty, outbound_qty, delivery, sales_doc, status, source_dn_id, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  const deliveredGuard = await dbGet('SELECT id FROM delivered_outbounds WHERE outbound_id = ?', [orderId]);
  if (!deliveredGuard?.id) {
    const err = new Error('Order is not marked delivered — nothing to reverse');
    err.statusCode = 409;
    throw err;
  }

  const rawItems = await dbAll('SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id ASC', [orderId]);
  const items = aggregateItemsByPartNumber(rawItems);
  if (!items.length) {
    const err = new Error('Outbound has no items');
    err.statusCode = 400;
    throw err;
  }

  for (const it of items) {
    const qty = asNumber(it.required_qty);
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
      `SELECT COALESCE(sold_out_qty, issued_qty, 0) AS sold FROM main_stock WHERE part_number = ?`,
      [it.part_number]
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
      const qty2 = asNumber(it2.required_qty);
      const dedupeKey = `outbound-deliver:${orderId}:${it2.part_number}:${qty2}`;

      await dbRun('DELETE FROM sold_out WHERE dedupe_key = ?', [dedupeKey]);

      await dbRun(
        `UPDATE main_stock SET
           sold_out_qty = COALESCE(sold_out_qty, 0) - ?,
           issued_qty = COALESCE(issued_qty, 0) - ?,
           available_qty = received_qty - (COALESCE(sold_out_qty, 0) - ?) - COALESCE(pending_delivery_qty, 0),
           last_updated = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE part_number = ?`,
        [qty2, qty2, qty2, it2.part_number]
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

module.exports = { markOutboundDelivered, reverseOutboundDelivered, aggregateItemsByPartNumber };
