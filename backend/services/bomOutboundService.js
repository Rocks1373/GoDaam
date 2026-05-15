const QTY_EPS = 1e-6;

function normPart(s) {
  return String(s || '').trim();
}

async function getActiveBomSetForParent(dbGet, parentPart) {
  const p = normPart(parentPart);
  if (!p) return null;
  return dbGet(
    `SELECT * FROM part_bom_sets WHERE LOWER(TRIM(parent_part_number)) = LOWER(TRIM(?)) AND COALESCE(is_active,1) = 1`,
    [p]
  );
}

/**
 * Replace outbound_bom_requirements for an order from active BOM definitions.
 * Safe no-op when no BOM matches outbound line part numbers.
 */
async function expandOutboundBomForOrder(dbRun, dbAll, dbGet, orderId) {
  await dbRun('DELETE FROM outbound_bom_requirements WHERE outbound_order_id = ?', [orderId]);
  const items = await dbAll(`SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id`, [orderId]);
  for (const item of items) {
    const parentPn = normPart(item.material || item.part_number);
    if (!parentPn) continue;
    const setRow = await getActiveBomSetForParent(dbGet, parentPn);
    if (!setRow) continue;
    const chRows = await dbAll(
      `SELECT * FROM part_bom_children WHERE bom_set_id = ? AND COALESCE(is_active,1) = 1 ORDER BY id`,
      [setRow.id]
    );
    const parentReq = Number(item.required_qty) || 0;
    const parentSap = normPart(item.sap_part_number) || normPart(setRow.parent_sap_part_number);
    const parentDesc = normPart(item.description) || normPart(setRow.parent_description);
    for (const ch of chRows) {
      const per = Number(ch.child_qty_per_parent);
      if (!Number.isFinite(per) || per <= QTY_EPS) continue;
      const reqChild = parentReq * per;
      await dbRun(
        `INSERT INTO outbound_bom_requirements (
          outbound_order_id, outbound_item_id,
          parent_part_number, parent_sap_part_number, parent_description, parent_required_qty,
          child_part_number, child_sap_part_number, child_description, child_qty_per_parent,
          required_child_qty, picked_child_qty, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'Pending', CURRENT_TIMESTAMP)`,
        [
          orderId,
          item.id,
          parentPn,
          parentSap || null,
          parentDesc || null,
          parentReq,
          normPart(ch.child_part_number),
          normPart(ch.child_sap_part_number) || null,
          normPart(ch.child_description) || null,
          per,
          reqChild,
        ]
      );
    }
  }
}

async function listBomRequirementsForOrder(dbAll, orderId) {
  return dbAll(
    `SELECT * FROM outbound_bom_requirements WHERE outbound_order_id = ? ORDER BY outbound_item_id, id`,
    [orderId]
  );
}

async function listBomRequirementsForItem(dbAll, outboundItemId) {
  return dbAll(`SELECT * FROM outbound_bom_requirements WHERE outbound_item_id = ? ORDER BY id`, [outboundItemId]);
}

async function itemHasBomExpansion(dbGet, outboundItemId) {
  const row = await dbGet(`SELECT 1 AS x FROM outbound_bom_requirements WHERE outbound_item_id = ? LIMIT 1`, [
    outboundItemId,
  ]);
  return Boolean(row);
}

/**
 * Update outbound_items availability / fifo_status from main_stock.
 * BOM lines: use child parts only (minimum parent-equivalent availability).
 */
async function refreshOutboundItemStockRow(mainStock, dbRun, dbAll, item, warehouseId) {
  const itemId = item.id;
  const wh = warehouseId != null && warehouseId !== '' ? Number(warehouseId) : null;
  const bom = await dbAll(`SELECT * FROM outbound_bom_requirements WHERE outbound_item_id = ? ORDER BY id`, [itemId]);
  if (!bom.length) {
    const ms = await mainStock.findByPartOrSap(item.material || item.part_number, item.sap_part_number, wh);
    const avail = ms ? Number(ms.available_qty) || 0 : 0;
    const reqQ = Number(item.required_qty) || 0;
    const fifo_status = reqQ <= avail + QTY_EPS ? 'Available' : 'Shortage';
    const shortage_qty = Math.max(0, reqQ - avail);
    await dbRun(
      `UPDATE outbound_items SET available_qty_main_stock = ?, fifo_status = ?, shortage_qty = ? WHERE id = ?`,
      [avail, fifo_status, shortage_qty, itemId]
    );
    return;
  }

  let minParentEquiv = Infinity;
  let anyShort = false;
  let worstChildShort = 0;
  const parentReq = Number(item.required_qty) || 0;

  for (const b of bom) {
    const ms = await mainStock.findByPartOrSap(b.child_part_number, b.child_sap_part_number, wh);
    const avail = ms ? Number(ms.available_qty) || 0 : 0;
    const per = Number(b.child_qty_per_parent) || 1;
    const need = Number(b.required_child_qty) || 0;
    if (avail + QTY_EPS < need) {
      anyShort = true;
      worstChildShort = Math.max(worstChildShort, need - avail);
    }
    const equiv = per > QTY_EPS ? Math.floor(avail / per + QTY_EPS) : 0;
    minParentEquiv = Math.min(minParentEquiv, equiv);
  }
  if (!Number.isFinite(minParentEquiv)) minParentEquiv = 0;
  const fifo_status = anyShort ? 'Shortage' : 'Available';
  const shortage_qty = anyShort ? Math.max(worstChildShort, Math.max(0, parentReq - minParentEquiv)) : 0;
  await dbRun(
    `UPDATE outbound_items SET available_qty_main_stock = ?, fifo_status = ?, shortage_qty = ? WHERE id = ?`,
    [minParentEquiv, fifo_status, shortage_qty, itemId]
  );
}

async function refreshAllOutboundItemsStock(mainStock, dbAll, dbRun, orderId) {
  const orows = await dbAll(`SELECT warehouse_id FROM outbound_orders WHERE id = ? LIMIT 1`, [orderId]);
  const wh = orows && orows[0] ? Number(orows[0].warehouse_id) : null;
  const items = await dbAll(`SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id`, [orderId]);
  for (const it of items) {
    await refreshOutboundItemStockRow(mainStock, dbRun, dbAll, it, wh);
  }
}

async function syncBomRequirementPickedFromTransactions(dbRun, dbGet, dbAll, outboundItemId) {
  const rows = await dbAll(`SELECT id, required_child_qty FROM outbound_bom_requirements WHERE outbound_item_id = ?`, [
    outboundItemId,
  ]);
  for (const r of rows) {
    const sumRow = await dbGet(
      `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions WHERE outbound_bom_requirement_id = ?`,
      [r.id]
    );
    const picked = Number(sumRow?.s) || 0;
    const req = Number(r.required_child_qty) || 0;
    let status = 'Pending';
    if (picked + QTY_EPS >= req) status = 'Picked';
    else if (picked > QTY_EPS) status = 'Partial';
    await dbRun(
      `UPDATE outbound_bom_requirements SET picked_child_qty = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [picked, status, r.id]
    );
  }
}

/**
 * Parent outbound_items.picked_qty = min_i floor(picked_child_i / qty_per_parent_i), capped at parent required.
 */
async function recomputeParentPickedFromBom(dbGet, dbAll, dbRun, outboundItemId) {
  const item = await dbGet(`SELECT * FROM outbound_items WHERE id = ?`, [outboundItemId]);
  if (!item) return;
  const bom = await dbAll(`SELECT * FROM outbound_bom_requirements WHERE outbound_item_id = ? ORDER BY id`, [
    outboundItemId,
  ]);
  if (!bom.length) return;

  let minParentUnits = Infinity;
  for (const b of bom) {
    const sumRow = await dbGet(
      `SELECT COALESCE(SUM(picked_qty), 0) AS s FROM picked_transactions WHERE outbound_bom_requirement_id = ?`,
      [b.id]
    );
    const got = Number(sumRow?.s) || 0;
    const per = Number(b.child_qty_per_parent) || 1;
    const units = per > QTY_EPS ? Math.floor(got / per + QTY_EPS) : 0;
    minParentUnits = Math.min(minParentUnits, units);
  }
  if (!Number.isFinite(minParentUnits)) minParentUnits = 0;
  const parentReq = Number(item.required_qty) || 0;
  const picked = Math.max(0, Math.min(parentReq, minParentUnits));
  await dbRun(`UPDATE outbound_items SET picked_qty = ? WHERE id = ?`, [picked, outboundItemId]);
}

/**
 * Build main_stock deduction lines for mark-delivered / reverse.
 * @returns {Array<{ part_number: string, description: string, qty: number }>}
 */
async function buildDeliveredDeductionLines(dbAll, dbGet, orderId) {
  const rawItems = await dbAll(`SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id ASC`, [orderId]);
  const lines = [];

  for (const it of rawItems) {
    const obr = await dbAll(`SELECT obr.*, s.parent_is_physical
       FROM outbound_bom_requirements obr
       LEFT JOIN part_bom_sets s ON UPPER(TRIM(s.parent_part_number)) = UPPER(TRIM(obr.parent_part_number))
       WHERE obr.outbound_item_id = ?
       ORDER BY obr.id`, [it.id]);

    if (!obr.length) {
      const pn = normPart(it.part_number ?? it.material);
      if (!pn) continue;
      lines.push({
        part_number: pn,
        description: normPart(it.description),
        qty: Number(it.required_qty) || 0,
      });
      continue;
    }

    const physical = Number(obr[0].parent_is_physical) === 1;
    if (physical) {
      const pn = normPart(it.material || it.part_number);
      lines.push({
        part_number: pn,
        description: normPart(it.description),
        qty: Number(it.required_qty) || 0,
      });
      continue;
    }

    for (const row of obr) {
      lines.push({
        part_number: normPart(row.child_part_number),
        description: normPart(row.child_description),
        qty: Number(row.required_child_qty) || 0,
      });
    }
  }

  const merged = new Map();
  for (const L of lines) {
    if (!L.part_number || !(L.qty > QTY_EPS)) continue;
    const k = L.part_number.toUpperCase();
    if (!merged.has(k)) merged.set(k, { part_number: L.part_number, description: L.description, qty: L.qty });
    else {
      const ex = merged.get(k);
      ex.qty += L.qty;
      if (!ex.description && L.description) ex.description = L.description;
    }
  }
  return [...merged.values()];
}

async function outboundItemLineIsFullyPicked(dbGet, dbAll, it) {
  const obr = await dbAll(`SELECT id, required_child_qty FROM outbound_bom_requirements WHERE outbound_item_id = ?`, [it.id]);
  if (obr.length) {
    for (const r of obr) {
      const s = await dbGet(
        `SELECT COALESCE(SUM(picked_qty), 0) AS x FROM picked_transactions WHERE outbound_bom_requirement_id = ?`,
        [r.id]
      );
      if (Number(s?.x || 0) + QTY_EPS < (Number(r.required_child_qty) || 0)) return false;
    }
    return true;
  }
  const col = Number(it.picked_qty) || 0;
  const txSum = Number(it.picked_from_tx) || 0;
  const picked = Math.max(col, txSum);
  const reqQ = Number(it.required_qty) || 0;
  return picked + QTY_EPS >= reqQ;
}

module.exports = {
  QTY_EPS,
  normPart,
  getActiveBomSetForParent,
  expandOutboundBomForOrder,
  listBomRequirementsForOrder,
  listBomRequirementsForItem,
  itemHasBomExpansion,
  refreshOutboundItemStockRow,
  refreshAllOutboundItemsStock,
  syncBomRequirementPickedFromTransactions,
  recomputeParentPickedFromBom,
  buildDeliveredDeductionLines,
  outboundItemLineIsFullyPicked,
};
