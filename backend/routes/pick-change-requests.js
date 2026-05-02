const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requireAuth, requireAdmin, requireWebAccess } = require('../middleware/auth');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));

router.use(requireAuth);
router.use(requireWebAccess);

// GET /api/pick-change-requests
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { status = 'Pending', limit = 200 } = req.query;
    const rows = await dbAll(
      `SELECT r.*,
        o.delivery AS delivery,
        o.sales_doc AS sales_doc,
        i.material AS material,
        i.part_number AS part_number,
        i.sap_part_number AS sap_part_number
       FROM pick_change_requests r
       LEFT JOIN outbound_orders o ON o.id = r.outbound_order_id
       LEFT JOIN outbound_items i ON i.id = r.outbound_item_id
       WHERE (? = '' OR r.status = ?)
       ORDER BY r.id DESC
       LIMIT ?`,
      [String(status || ''), String(status || ''), Number(limit) || 200]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pick-change-requests/:id/resolve
router.post('/:id/resolve', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, resolution_note } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const row = await dbGet(`SELECT * FROM pick_change_requests WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const next = status === 'Approved' ? 'Approved' : status === 'Rejected' ? 'Rejected' : null;
    if (!next) return res.status(400).json({ error: 'status must be Approved or Rejected' });

    // If approved, apply changes directly to FIFO suggestions when possible.
    if (next === 'Approved') {
      const fifoId = row.fifo_suggestion_id ? Number(row.fifo_suggestion_id) : null;
      if (fifoId) {
        const sug = await dbGet(`SELECT * FROM fifo_suggestions WHERE id = ? AND outbound_order_id = ?`, [
          fifoId,
          row.outbound_order_id,
        ]);
        if (sug) {
          // Update qty if requested
          if (row.requested_qty !== null && row.requested_qty !== undefined) {
            const q = Number(row.requested_qty);
            if (Number.isFinite(q) && q > 0) {
              await dbRun(
                `UPDATE fifo_suggestions
                 SET suggested_qty = ?, is_admin_changed = 1, changed_by_admin_id = ?
                 WHERE id = ?`,
                [q, req.user.sub, fifoId]
              );
            }
          }

          // Update rack if requested (find matching stock_by_rack row)
          if (row.requested_rack_location) {
            const item = await dbGet(`SELECT * FROM outbound_items WHERE id = ?`, [row.outbound_item_id]);
            const keys = [
              String(item?.material || '').trim(),
              String(item?.part_number || '').trim(),
              String(item?.sap_part_number || '').trim(),
              String(sug.material || '').trim(),
              String(sug.sap_part_number || '').trim(),
            ].filter(Boolean);
            const rack = await dbGet(
              `SELECT * FROM stock_by_rack
               WHERE UPPER(TRIM(rack_location)) = UPPER(TRIM(?))
                 AND available_qty > 0
                 AND (part_number IN (${keys.map(() => '?').join(',')}) OR IFNULL(sap_part_number,'') IN (${keys
                .map(() => '?')
                .join(',')}))
               ORDER BY date(COALESCE(first_entry_date, '1970-01-01')) ASC, id ASC
               LIMIT 1`,
              [row.requested_rack_location, ...keys, ...keys]
            );
            if (rack?.id) {
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
                  fifoId,
                ]
              );
            }
          }
        }
      }
    }

    await dbRun(
      `UPDATE pick_change_requests
       SET status = ?,
           resolved_at = CURRENT_TIMESTAMP,
           resolved_by_user_id = ?,
           resolution_note = ?
       WHERE id = ?`,
      [next, req.user.sub, resolution_note || null, id]
    );
    const updated = await dbGet(`SELECT * FROM pick_change_requests WHERE id = ?`, [id]);
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;

