const { promisify } = require('util');

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Increment main_stock.received_qty on shared DB connection (matches inbound / transactional flows).
 */
async function incrementReceivedOnDb(db, part_number, inboundQty, patch = {}) {
  const dbRun = promisify(db.run.bind(db));
  const dbGet = promisify(db.get.bind(db));

  const pn = String(part_number || '').trim();
  const d = asNum(inboundQty);
  if (!pn || !(d > 0)) throw new Error('Invalid part_number or inbound_qty');

  const row = await dbGet('SELECT * FROM main_stock WHERE part_number = ?', [pn]);
  const sold = row ? asNum(row.sold_out_qty ?? row.issued_qty) : 0;
  const pend = row ? asNum(row.pending_delivery_qty) : 0;

  if (!row) {
    const sap = String(patch.sap_part_number || pn).trim();
    const desc = String(patch.description || '').trim();
    const vn = patch.vendor_name != null ? String(patch.vendor_name) : null;
    const avail = d - sold - pend;
    if (avail < 0) throw new Error('available_qty cannot be negative');
    await dbRun(
      `INSERT INTO main_stock (
        product, vendor_name, vendor_number, sap_part_number, sap_qty, part_number, description,
        received_qty, issued_qty, sold_out_qty, pending_delivery_qty, available_qty, uom, remarks,
        last_updated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        patch.product ?? null,
        vn,
        patch.vendor_number ?? null,
        sap,
        patch.sap_qty != null ? asNum(patch.sap_qty) : null,
        pn,
        desc,
        d,
        avail,
        patch.uom ?? null,
        patch.remarks ?? null,
      ]
    );
    return;
  }

  const nextRec = asNum(row.received_qty) + d;
  const avail = nextRec - sold - pend;
  if (avail < 0) throw new Error('available_qty cannot be negative');

  await dbRun(
    `UPDATE main_stock SET
       received_qty = received_qty + ?,
       available_qty = received_qty + ? - COALESCE(sold_out_qty, issued_qty, 0) - COALESCE(pending_delivery_qty, 0),
       vendor_name = COALESCE(?, vendor_name),
       sap_part_number = COALESCE(?, sap_part_number),
       description = COALESCE(?, description),
       last_updated = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     WHERE part_number = ?`,
    [
      d,
      d,
      patch.vendor_name !== undefined ? patch.vendor_name : null,
      patch.sap_part_number !== undefined ? patch.sap_part_number : null,
      patch.description !== undefined ? patch.description : null,
      pn,
    ]
  );
}

module.exports = { incrementReceivedOnDb };
