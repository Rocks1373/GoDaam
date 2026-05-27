const { promisify } = require('util');
const db = require('../db');
const { generateFifoForOutboundOrder } = require('./godamFifo');
const { normalizeDateValue } = require('../lib/safeDateSql');

const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const QTY_EPS = 1e-6;

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

async function listOpenOrderIds() {
  const rows = await dbAll(
    `SELECT id FROM outbound_orders
     WHERE TRIM(COALESCE(status,'')) IN ('Uploaded','Stock Checked','Sent For Pick','Picking')`
  );
  return rows.map((r) => Number(r.id)).filter(Boolean);
}

async function regenerateFifoForOpenOrders() {
  const ids = await listOpenOrderIds();
  const affected = [];
  for (const id of ids) {
    await generateFifoForOutboundOrder(id);
    const o = await dbGet(
      `SELECT id, outbound_number, delivery, status FROM outbound_orders WHERE id = ?`,
      [id]
    );
    if (o) {
      affected.push({
        id: o.id,
        outbound_number: o.outbound_number,
        delivery: o.delivery,
        status: o.status,
      });
    }
  }
  return affected;
}

/**
 * Admin rack correction: changes stock_by_rack quantities and/or FIFO date, then rebuilds FIFO for all open orders.
 */
async function applyRackAdjustment({
  stock_by_rack_id,
  delta_qty,
  remarks,
  first_entry_date,
  userId,
}) {
  const id = Number(stock_by_rack_id);
  if (!id) throw new Error('stock_by_rack_id is required');

  const delta =
    delta_qty === undefined || delta_qty === null || delta_qty === '' ? 0 : Number(delta_qty);
  if (!Number.isFinite(delta)) throw new Error('Invalid delta_qty');

  const feRaw = first_entry_date;
  const feTrim =
    feRaw !== undefined && feRaw !== null && String(feRaw).trim() !== '' ? String(feRaw).trim().slice(0, 10) : null;

  const row = await dbGet(`SELECT * FROM stock_by_rack WHERE id = ?`, [id]);
  if (!row) throw new Error('Rack row not found');

  const feBefore = row.first_entry_date || null;
  let totalIn = toNumber(row.total_in_qty);
  let totalOut = toNumber(row.total_out_qty);
  let avail = toNumber(row.available_qty);

  if (delta !== 0) {
    if (delta > 0) {
      totalIn += delta;
      avail += delta;
    } else {
      let d = Math.abs(delta);
      if (d > avail + QTY_EPS) {
        d = Math.max(0, avail);
      }
      totalOut += d;
      avail -= d;
    }
    if (totalIn < -1e-9 || totalOut < -1e-9 || avail < -1e-9) {
      throw new Error('Invalid balances after adjustment');
    }
    avail = Math.max(0, avail);
  }

  let newFe = normalizeDateValue(feBefore);
  if (feTrim) {
    newFe = feTrim;
  }
  const feChanged = String(newFe || '') !== String(feBefore || '');
  const qtyChanged = delta !== 0;

  if (!qtyChanged && !feChanged) throw new Error('No changes: set delta (+/−) or first entry date');

  await dbRun('BEGIN IMMEDIATE');
  try {
    await dbRun(
      `UPDATE stock_by_rack
       SET total_in_qty = ?,
           total_out_qty = ?,
           available_qty = ?,
           first_entry_date = ?,
           last_updated = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [totalIn, totalOut, avail, newFe, id]
    );
    await dbRun('COMMIT');
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }

  const affectedOrders = await regenerateFifoForOpenOrders();

  const affJson = JSON.stringify(affectedOrders);

  await dbRun(
    `INSERT INTO rack_balance_adjustments (
      stock_by_rack_id, part_number, rack_location,
      delta_qty, balance_after_available, balance_after_total_in, balance_after_total_out,
      first_entry_date_before, first_entry_date_after,
      remarks, affected_orders_json, created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      row.part_number,
      row.rack_location,
      delta,
      avail,
      totalIn,
      totalOut,
      feBefore,
      newFe,
      remarks ? String(remarks).slice(0, 2000) : '',
      affJson,
      userId || null,
    ]
  );

  const adj = await dbGet(`SELECT * FROM rack_balance_adjustments ORDER BY id DESC LIMIT 1`);

  return {
    ok: true,
    adjustment: adj,
    rack: {
      id,
      part_number: row.part_number,
      rack_location: row.rack_location,
      total_in_qty: totalIn,
      total_out_qty: totalOut,
      available_qty: avail,
      first_entry_date: newFe,
    },
    fifo_refreshed_orders: affectedOrders.length,
  };
}

module.exports = {
  applyRackAdjustment,
  regenerateFifoForOpenOrders,
  listOpenOrderIds,
};
