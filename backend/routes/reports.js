const express = require('express');
const { promisify } = require('util');

const db = require('../db');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));

/** Outbound picking audit — joins picked_transactions with orders/items */
router.get('/outbound-picks', async (req, res) => {
  try {
    const { from, to, outbound_number, delivery, customer } = req.query;
    const params = [];
    let sql = `
      SELECT
        o.outbound_number,
        o.delivery,
        COALESCE(o.sold_to, o.customer_name, '') AS customer,
        oi.part_number,
        pt.picked_qty,
        pt.user_name AS picked_by,
        pt.picked_at,
        oi.status AS item_status,
        o.status AS order_status
      FROM picked_transactions pt
      JOIN outbound_items oi ON oi.id = pt.outbound_item_id
      JOIN outbound_orders o ON o.id = pt.outbound_order_id
      WHERE 1=1
    `;
    if (from) {
      sql += ` AND date(pt.picked_at) >= date(?)`;
      params.push(from);
    }
    if (to) {
      sql += ` AND date(pt.picked_at) <= date(?)`;
      params.push(to);
    }
    if (outbound_number) {
      sql += ` AND o.outbound_number LIKE ?`;
      params.push(`%${String(outbound_number).trim()}%`);
    }
    if (delivery) {
      sql += ` AND COALESCE(o.delivery,'') LIKE ?`;
      params.push(`%${String(delivery).trim()}%`);
    }
    if (customer) {
      sql += ` AND (COALESCE(o.sold_to,'') LIKE ? OR COALESCE(o.customer_name,'') LIKE ?)`;
      const q = `%${String(customer).trim()}%`;
      params.push(q, q);
    }
    sql += ` ORDER BY pt.picked_at DESC LIMIT 5000`;
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
