const { promisify } = require('util');
const db = require('../db');

const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));

function uniqueKeys(material, sapPartNumber) {
  return [...new Set([String(material || '').trim(), String(sapPartNumber || '').trim()].filter(Boolean))];
}

async function clearFifoForOrder(outboundOrderId) {
  await dbRun('DELETE FROM fifo_suggestions WHERE outbound_order_id = ?', [outboundOrderId]);
}

async function loadStockByRackRowsForKeys(material, sapPartNumber) {
  const k = uniqueKeys(material, sapPartNumber);
  if (!k.length) return [];
  const ph = k.map(() => '?').join(', ');
  const sql = `
    SELECT * FROM stock_by_rack
    WHERE available_qty > 0
      AND (part_number IN (${ph}) OR IFNULL(sap_part_number, '') IN (${ph}))
    ORDER BY date(COALESCE(first_entry_date, '1970-01-01')) ASC, id ASC
  `;
  return dbAll(sql, [...k, ...k]);
}

function allocateSuggestions(requiredQty, rows) {
  let remaining = Number(requiredQty) || 0;
  const suggestions = [];
  let seq = 1;
  for (const row of rows) {
    const avail = Number(row.available_qty) || 0;
    if (avail <= 0 || remaining <= 0) continue;
    const take = Math.min(avail, remaining);
    suggestions.push({
      stock_by_rack_id: row.id,
      rack_location: row.rack_location,
      entry_date: row.first_entry_date || null,
      available_qty: avail,
      suggested_qty: take,
      fifo_sequence: seq++,
    });
    remaining -= take;
  }
  return suggestions;
}

async function insertFifoRows(outboundOrderId, item, suggestions) {
  const material = item.material || item.part_number || '';
  const sap = item.sap_part_number || '';
  const desc = item.description || '';
  for (const s of suggestions) {
    await dbRun(
      `INSERT INTO fifo_suggestions (
        outbound_order_id, outbound_item_id, material, sap_part_number, description,
        rack_location, stock_by_rack_id, entry_date, available_qty, suggested_qty, fifo_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outboundOrderId,
        item.id,
        material,
        sap,
        desc,
        s.rack_location,
        s.stock_by_rack_id,
        s.entry_date,
        s.available_qty,
        s.suggested_qty,
        s.fifo_sequence,
      ]
    );
  }
}

async function generateFifoForOutboundOrder(outboundOrderId) {
  await clearFifoForOrder(outboundOrderId);
  const items = await dbAll(
    'SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id',
    [outboundOrderId]
  );
  for (const item of items) {
    const picked = Number(item.picked_qty) || 0;
    const req = Number(item.required_qty) || 0;
    const remaining = Math.max(0, req - picked);
    if (remaining <= 0) continue;
    const rows = await loadStockByRackRowsForKeys(item.material || item.part_number, item.sap_part_number);
    const suggestions = allocateSuggestions(remaining, rows);
    await insertFifoRows(outboundOrderId, item, suggestions);
  }
  return dbAll(
    `SELECT * FROM fifo_suggestions WHERE outbound_order_id = ? ORDER BY outbound_item_id, fifo_sequence`,
    [outboundOrderId]
  );
}

async function listFifoForOrder(outboundOrderId) {
  return dbAll(
    `SELECT * FROM fifo_suggestions WHERE outbound_order_id = ? ORDER BY outbound_item_id, fifo_sequence`,
    [outboundOrderId]
  );
}

module.exports = {
  clearFifoForOrder,
  generateFifoForOutboundOrder,
  listFifoForOrder,
  loadStockByRackRowsForKeys,
  allocateSuggestions,
};
