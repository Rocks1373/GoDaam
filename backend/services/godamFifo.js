const { promisify } = require('util');
const db = require('../db');
const { fifoDateOrderExpr, normalizeDateValue } = require('../lib/safeDateSql');

const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

function uniqueKeys(material, sapPartNumber) {
  return [...new Set([String(material || '').trim(), String(sapPartNumber || '').trim()].filter(Boolean))];
}

async function clearFifoForOrder(outboundOrderId) {
  await dbRun('DELETE FROM fifo_suggestions WHERE outbound_order_id = ?', [outboundOrderId]);
}

async function loadStockByRackRowsForKeys(material, sapPartNumber, warehouseId) {
  const k = uniqueKeys(material, sapPartNumber);
  if (!k.length) return [];
  let wh = Number(warehouseId);
  if (!Number.isFinite(wh) || wh <= 0) {
    const row = await dbGet(`SELECT id FROM warehouses ORDER BY id LIMIT 1`);
    wh = Number(row?.id) || 0;
  }
  if (!wh) return [];
  const ph = k.map(() => '?').join(', ');
  const sql = `
    SELECT * FROM stock_by_rack
    WHERE warehouse_id = ?
      AND available_qty > 0
      AND (part_number IN (${ph}) OR COALESCE(sap_part_number, '') IN (${ph}))
    ORDER BY ${fifoDateOrderExpr('first_entry_date', db)} ASC, id ASC
  `;
  return dbAll(sql, [wh, ...k, ...k]);
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
      entry_date: normalizeDateValue(row.first_entry_date),
      available_qty: avail,
      suggested_qty: take,
      fifo_sequence: seq++,
    });
    remaining -= take;
  }
  return suggestions;
}

async function insertFifoRows(outboundOrderId, item, suggestions, meta = {}, warehouseId) {
  const material = item.material || item.part_number || '';
  const sap = item.sap_part_number || '';
  const desc = item.description || '';
  const outboundBomRequirementId = meta.outboundBomRequirementId != null ? Number(meta.outboundBomRequirementId) : null;
  const parentPartNumber = meta.parentPartNumber ? String(meta.parentPartNumber) : null;
  const isBomExpansion = meta.isBomExpansion ? 1 : 0;
  const wh = Number(warehouseId) || null;
  for (const s of suggestions) {
    await dbRun(
      `INSERT INTO fifo_suggestions (
        outbound_order_id, outbound_item_id, material, sap_part_number, description,
        rack_location, stock_by_rack_id, entry_date, available_qty, suggested_qty, fifo_sequence,
        outbound_bom_requirement_id, parent_part_number, is_bom_expansion, warehouse_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        outboundBomRequirementId || null,
        parentPartNumber,
        isBomExpansion,
        wh,
      ]
    );
  }
}

const QTY_EPS = 1e-6;

async function generateFifoForOutboundOrder(outboundOrderId) {
  await clearFifoForOrder(outboundOrderId);
  const orderRow = await dbGet(`SELECT warehouse_id FROM outbound_orders WHERE id = ?`, [outboundOrderId]);
  let warehouseId = Number(orderRow?.warehouse_id) || null;
  if (!warehouseId) {
    const d = await dbGet(`SELECT id FROM warehouses ORDER BY id LIMIT 1`);
    warehouseId = Number(d?.id) || null;
  }
  const items = await dbAll(
    'SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id',
    [outboundOrderId]
  );
  for (const item of items) {
    const bomReqs = await dbAll(
      `SELECT * FROM outbound_bom_requirements WHERE outbound_item_id = ? ORDER BY id`,
      [item.id]
    );

    if (bomReqs.length) {
      for (const br of bomReqs) {
        const sumRow = await dbGet(
          `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions WHERE outbound_bom_requirement_id = ?`,
          [br.id]
        );
        const pickedChild = Number(sumRow?.s) || 0;
        const reqChild = Number(br.required_child_qty) || 0;
        const remaining = Math.max(0, reqChild - pickedChild);
        if (remaining <= QTY_EPS) continue;
        const rows = await loadStockByRackRowsForKeys(br.child_part_number, br.child_sap_part_number, warehouseId);
        const suggestions = allocateSuggestions(remaining, rows);
        const pseudoItem = {
          id: item.id,
          material: br.child_part_number,
          part_number: br.child_part_number,
          sap_part_number: br.child_sap_part_number || '',
          description: br.child_description || '',
        };
        await insertFifoRows(outboundOrderId, pseudoItem, suggestions, {
          outboundBomRequirementId: br.id,
          parentPartNumber: br.parent_part_number,
          isBomExpansion: 1,
        }, warehouseId);
      }
      continue;
    }

    const sumNonBom = await dbGet(
      `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions
       WHERE outbound_item_id = ? AND COALESCE(is_bom_pick, 0) = 0`,
      [item.id]
    );
    const picked = Math.max(Number(item.picked_qty) || 0, Number(sumNonBom?.s) || 0);
    const req = Number(item.required_qty) || 0;
    const remaining = Math.max(0, req - picked);
    if (remaining <= QTY_EPS) continue;
    const rows = await loadStockByRackRowsForKeys(item.material || item.part_number, item.sap_part_number, warehouseId);
    const suggestions = allocateSuggestions(remaining, rows);
    await insertFifoRows(outboundOrderId, item, suggestions, {}, warehouseId);
  }
  return dbAll(
    `SELECT * FROM fifo_suggestions WHERE outbound_order_id = ? ORDER BY outbound_item_id, fifo_sequence`,
    [outboundOrderId]
  );
}

async function listFifoForOrder(outboundOrderId) {
  return dbAll(
    `SELECT f.*,
            (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE fifo_suggestion_id = f.id) AS fifo_picked_qty
       FROM fifo_suggestions f
      WHERE f.outbound_order_id = ?
   ORDER BY f.outbound_item_id, f.fifo_sequence`,
    [outboundOrderId]
  );
}

/**
 * After mobile add-rack during pick, expose the new rack in Legacy FIFO without regenerating the whole order.
 */
async function appendFifoSuggestionForAddedRack({
  outboundOrderId,
  outboundItemId,
  warehouseId,
  stockByRackId,
  outboundBomRequirementId = null,
}) {
  const orderId = Number(outboundOrderId);
  const itemId = Number(outboundItemId);
  const rackId = Number(stockByRackId);
  if (!orderId || !itemId || !rackId) return null;

  const item = await dbGet('SELECT * FROM outbound_items WHERE id = ? AND outbound_id = ?', [itemId, orderId]);
  if (!item) return null;

  const rackRow = await dbGet('SELECT * FROM stock_by_rack WHERE id = ?', [rackId]);
  if (!rackRow || Number(rackRow.available_qty) <= QTY_EPS) return null;

  const existing = await dbGet(
    `SELECT id FROM fifo_suggestions WHERE outbound_order_id = ? AND outbound_item_id = ? AND stock_by_rack_id = ?`,
    [orderId, itemId, rackId]
  );
  if (existing) {
    return dbGet(
      `SELECT f.*,
              (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE fifo_suggestion_id = f.id) AS fifo_picked_qty
         FROM fifo_suggestions f WHERE f.id = ?`,
      [existing.id]
    );
  }

  let obrId =
    outboundBomRequirementId != null && outboundBomRequirementId !== ''
      ? Number(outboundBomRequirementId)
      : null;
  if (obrId) {
    const br = await dbGet(`SELECT id FROM outbound_bom_requirements WHERE id = ? AND outbound_item_id = ?`, [
      obrId,
      itemId,
    ]);
    if (!br) obrId = null;
  }
  if (!obrId) {
    const bomCount = await dbGet(
      `SELECT COUNT(*) AS c FROM outbound_bom_requirements WHERE outbound_item_id = ?`,
      [itemId]
    );
    if (Number(bomCount?.c) > 0) {
      const pn = String(rackRow.part_number || '').trim();
      const br = await dbGet(
        `SELECT * FROM outbound_bom_requirements WHERE outbound_item_id = ? AND child_part_number = ? ORDER BY id LIMIT 1`,
        [itemId, pn]
      );
      if (br) obrId = br.id;
    }
  }

  let remaining;
  let pseudoItem = item;
  let meta = {};

  if (obrId) {
    const br = await dbGet(`SELECT * FROM outbound_bom_requirements WHERE id = ?`, [obrId]);
    const sumRow = await dbGet(
      `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions WHERE outbound_bom_requirement_id = ?`,
      [obrId]
    );
    const pickedChild = Number(sumRow?.s) || 0;
    remaining = Math.max(0, Number(br.required_child_qty) - pickedChild);
    pseudoItem = {
      id: item.id,
      material: br.child_part_number,
      part_number: br.child_part_number,
      sap_part_number: br.child_sap_part_number || '',
      description: br.child_description || '',
    };
    meta = {
      outboundBomRequirementId: obrId,
      parentPartNumber: br.parent_part_number,
      isBomExpansion: 1,
    };
  } else {
    const sumNonBom = await dbGet(
      `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions
       WHERE outbound_item_id = ? AND COALESCE(is_bom_pick, 0) = 0`,
      [itemId]
    );
    const picked = Math.max(Number(item.picked_qty) || 0, Number(sumNonBom?.s) || 0);
    remaining = Math.max(0, Number(item.required_qty) - picked);
  }

  if (remaining <= QTY_EPS) return null;

  const maxSeqRow = await dbGet(
    `SELECT COALESCE(MAX(fifo_sequence), 0) AS m FROM fifo_suggestions WHERE outbound_order_id = ? AND outbound_item_id = ?`,
    [orderId, itemId]
  );
  const seq = Number(maxSeqRow?.m) + 1;
  const take = Math.min(Number(rackRow.available_qty), remaining);

  await insertFifoRows(
    orderId,
    pseudoItem,
    [
      {
        stock_by_rack_id: rackRow.id,
        rack_location: rackRow.rack_location,
        entry_date: normalizeDateValue(rackRow.first_entry_date),
        available_qty: Number(rackRow.available_qty),
        suggested_qty: take,
        fifo_sequence: seq,
      },
    ],
    meta,
    warehouseId
  );

  return dbGet(
    `SELECT f.*,
            (SELECT COALESCE(SUM(picked_qty), 0) FROM picked_transactions WHERE fifo_suggestion_id = f.id) AS fifo_picked_qty
       FROM fifo_suggestions f
      WHERE f.outbound_order_id = ? AND f.outbound_item_id = ? AND f.stock_by_rack_id = ?
      ORDER BY f.id DESC LIMIT 1`,
    [orderId, itemId, rackId]
  );
}

module.exports = {
  clearFifoForOrder,
  generateFifoForOutboundOrder,
  listFifoForOrder,
  loadStockByRackRowsForKeys,
  allocateSuggestions,
  appendFifoSuggestionForAddedRack,
};
