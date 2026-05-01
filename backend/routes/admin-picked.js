const express = require('express');
const { promisify } = require('util');

const db = require('../db');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

router.get('/', async (req, res) => {
  try {
    const { outbound_id, user_id, from_date } = req.query;
    let sql = `
      SELECT
        po.*,
        o.name_1 AS name_1,
        o.customer_name AS customer_name,
        o.customer_reference AS customer_reference
      FROM picked_orders po
      LEFT JOIN outbound_orders o ON o.id = po.outbound_order_id
      WHERE 1=1
    `;
    const params = [];
    if (outbound_id) {
      sql += ` AND po.outbound_order_id = ?`;
      params.push(Number(outbound_id));
    }
    if (from_date) {
      sql += ` AND date(po.confirmed_at) >= date(?)`;
      params.push(from_date);
    }
    if (user_id) {
      sql += ` AND EXISTS (
        SELECT 1 FROM picked_transactions pt
        WHERE pt.outbound_order_id = po.outbound_order_id AND pt.user_id = ?
      )`;
      params.push(Number(user_id));
    }
    sql += ` ORDER BY po.confirmed_at DESC LIMIT 500`;

    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const po = await dbGet(
      `SELECT po.*, o.name_1 AS name_1, o.customer_name AS customer_name, o.customer_reference AS customer_reference
       FROM picked_orders po
       LEFT JOIN outbound_orders o ON o.id = po.outbound_order_id
       WHERE po.id = ?`,
      [id]
    );
    if (!po) return res.status(404).json({ error: 'Not found' });
    const txs = await dbAll(
      `SELECT * FROM picked_transactions WHERE outbound_order_id = ? ORDER BY picked_at ASC`,
      [po.outbound_order_id]
    );
    res.json({ ...po, transactions: txs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
