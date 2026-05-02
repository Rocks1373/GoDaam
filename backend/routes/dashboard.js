const express = require('express');
const { promisify } = require('util');

const db = require('../db');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

function todaySqlite() {
  return new Date().toISOString().slice(0, 10);
}

/** GET /api/dashboard/summary */
router.get('/summary', async (req, res) => {
  try {
    const day = todaySqlite();
    const totalRow = await dbGet(`SELECT COUNT(1) AS c FROM outbound_orders`);
    const pendingRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE lower(trim(COALESCE(status,''))) IN ('uploaded','stock checked','pending')`
    );
    const pickingRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE COALESCE(status,'') IN ('Sent For Pick','Picking')`
    );
    const pickedRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE COALESCE(status,'') = 'Picked'`
    );
    const deliveredRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE lower(COALESCE(status,'')) = 'delivered'`
    );
    const cancelledRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE lower(COALESCE(status,'')) LIKE '%cancel%'`
    );
    const todayUploadRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE date(created_at) = date(?)`,
      [day]
    );
    const todayDeliveredRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE lower(COALESCE(status,'')) = 'delivered' AND date(updated_at) = date(?)`,
      [day]
    );

    res.json({
      total_orders_uploaded: Number(totalRow?.c) || 0,
      orders_pending: Number(pendingRow?.c) || 0,
      orders_under_picking: Number(pickingRow?.c) || 0,
      orders_picked: Number(pickedRow?.c) || 0,
      orders_delivered: Number(deliveredRow?.c) || 0,
      orders_cancelled: Number(cancelledRow?.c) || 0,
      today_uploaded_orders: Number(todayUploadRow?.c) || 0,
      today_delivered_orders: Number(todayDeliveredRow?.c) || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/dashboard/recent-activity */
router.get('/recent-activity', async (_req, res) => {
  try {
    const last_uploaded = await dbGet(
      `SELECT outbound_number AS ref, created_at AS at FROM outbound_orders ORDER BY id DESC LIMIT 1`
    );
    const last_sent_pick = await dbGet(
      `SELECT outbound_number AS ref, updated_at AS at FROM outbound_orders
       WHERE COALESCE(status,'') IN ('Sent For Pick','Picking','Picked')
          OR lower(COALESCE(status,'')) = 'delivered'
       ORDER BY updated_at DESC LIMIT 1`
    );
    const last_picked = await dbGet(
      `SELECT outbound_number AS ref, updated_at AS at FROM outbound_orders
       WHERE COALESCE(status,'') IN ('Picked') OR lower(COALESCE(status,'')) = 'delivered'
       ORDER BY updated_at DESC LIMIT 1`
    );
    const last_delivered = await dbGet(
      `SELECT outbound_number AS ref, updated_at AS at FROM outbound_orders
       WHERE lower(COALESCE(status,'')) = 'delivered'
       ORDER BY updated_at DESC LIMIT 1`
    );

    res.json({
      last_uploaded_order: last_uploaded || null,
      last_sent_for_pick: last_sent_pick || null,
      last_picked_order: last_picked || null,
      last_delivered_order: last_delivered || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/dashboard/notifications — summary tiles for dashboard (not user inbox). */
router.get('/notifications', async (_req, res) => {
  try {
    const day = todaySqlite();
    const uploadedToday = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE date(created_at) = date(?)`,
      [day]
    );
    const sentToday = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE COALESCE(status,'') = 'Sent For Pick' AND date(updated_at) = date(?)`,
      [day]
    );
    const pickedToday = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE COALESCE(status,'') = 'Picked' AND date(updated_at) = date(?)`,
      [day]
    );
    const deliveredToday = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE lower(COALESCE(status,'')) = 'delivered' AND date(updated_at) = date(?)`,
      [day]
    );
    const podToday = await dbGet(
      `SELECT COUNT(1) AS c FROM delivery_notes
       WHERE lower(COALESCE(status,'')) = 'delivered' AND date(delivered_at) = date(?)`,
      [day]
    );

    res.json({
      order_uploaded: { today_count: Number(uploadedToday?.c) || 0 },
      order_sent_for_pick: { today_count: Number(sentToday?.c) || 0 },
      order_picked: { today_count: Number(pickedToday?.c) || 0 },
      order_delivered: { today_count: Number(deliveredToday?.c) || 0 },
      driver_pod_uploaded: {
        today_count: Number(podToday?.c) || 0,
        note: 'Counts delivery notes marked Delivered today (POD workflow uses DN completion).',
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
