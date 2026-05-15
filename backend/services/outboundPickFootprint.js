/**
 * Live pick summary for an outbound: line totals, picked_transactions (who / rack / qty), picked_orders header.
 * Used by GET /api/outbound/:id and delivery note view when linked to an outbound.
 */

const EPS = 1e-6;

/**
 * @param {{ dbGet: Function, dbAll: Function, orderId: number|string }} args
 * @returns {Promise<{ pick_progress: object, picked_transactions: object[], picked_order: object|null }>}
 */
async function loadOutboundPickFootprint({ dbGet, dbAll, orderId }) {
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) {
    return {
      pick_progress: {
        total_required_qty: 0,
        total_picked_qty: 0,
        remaining_qty: 0,
        lines_total: 0,
        lines_complete: 0,
        fully_picked: false,
      },
      picked_transactions: [],
      picked_order: null,
    };
  }

  const [txs, pickedOrder, items] = await Promise.all([
    dbAll(
      `SELECT id, outbound_item_id, outbound_bom_requirement_id, fifo_suggestion_id, user_id, user_name,
              material, sap_part_number, description, rack_location, picked_qty, picked_at, picked_method,
              is_manual_pick, manual_pick_reason, picked_by_role, device_id, is_bom_pick, parent_part_number, child_part_number
         FROM picked_transactions
        WHERE outbound_order_id = ?
     ORDER BY picked_at ASC NULLS LAST, id ASC`,
      [oid]
    ).catch(() => []),
    dbGet(`SELECT * FROM picked_orders WHERE outbound_order_id = ? ORDER BY id DESC LIMIT 1`, [oid]).catch(() => null),
    dbAll(`SELECT id, required_qty, picked_qty FROM outbound_items WHERE outbound_id = ?`, [oid]).catch(() => []),
  ]);

  let totalRequired = 0;
  let totalPicked = 0;
  let linesTotal = 0;
  let linesComplete = 0;
  for (const it of items || []) {
    const rq = Number(it.required_qty) || 0;
    if (rq <= EPS) continue;
    linesTotal += 1;
    const pq = Number(it.picked_qty) || 0;
    totalRequired += rq;
    totalPicked += pq;
    if (pq + EPS >= rq) linesComplete += 1;
  }
  const remaining = Math.max(0, totalRequired - totalPicked);
  const pick_progress = {
    total_required_qty: totalRequired,
    total_picked_qty: totalPicked,
    remaining_qty: remaining,
    lines_total: linesTotal,
    lines_complete: linesComplete,
    fully_picked: linesTotal > 0 && linesComplete >= linesTotal,
  };

  return {
    pick_progress,
    picked_transactions: Array.isArray(txs) ? txs : [],
    picked_order: pickedOrder || null,
  };
}

module.exports = { loadOutboundPickFootprint };
