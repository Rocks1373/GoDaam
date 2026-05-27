const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { loadOutboundPickFootprint } = require('../services/outboundPickFootprint');
const { assertExplicitWarehouseParamAllowed, resolveReadWarehouseScope } = require('../services/warehouseContext');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

async function readScopeOrError(req, res) {
  const gate = await assertExplicitWarehouseParamAllowed(req);
  if (!gate.ok) {
    res.status(gate.status || 403).json({ error: gate.message || 'Forbidden' });
    return null;
  }
  return resolveReadWarehouseScope(req);
}

/** Append ` AND warehouse_id = ?` when a single warehouse is selected (not admin "all"). */
function whOutbound(scope) {
  if (scope.mode === 'all') return { sql: '', params: [] };
  return { sql: ' AND warehouse_id = ? ', params: [scope.warehouseId] };
}

function whDeliveryNotes(scope, alias = '') {
  if (scope.mode === 'all') return { sql: '', params: [] };
  const p = alias ? `${alias}.` : '';
  return { sql: ` AND ${p}warehouse_id = ? `, params: [scope.warehouseId] };
}

function whInboundBatches(scope) {
  if (scope.mode === 'all') return { sql: '', params: [] };
  return { sql: ' AND b.warehouse_id = ? ', params: [scope.warehouseId] };
}

function todaySqlite() {
  return new Date().toISOString().slice(0, 10);
}

function parseIsoDay(s) {
  const t = String(s || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

/** Default range: last 7 calendar days ending `to` (inclusive). */
function defaultRangeToFrom(toDay) {
  const end = parseIsoDay(toDay) || todaySqlite();
  const base = new Date(`${end}T12:00:00`);
  if (Number.isNaN(base.getTime())) return { from: end, to: end };
  base.setDate(base.getDate() - 6);
  const from = base.toISOString().slice(0, 10);
  return from <= end ? { from, to: end } : { from: end, to: end };
}

/** GET /api/dashboard/summary */
router.get('/summary', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const wh = whOutbound(scope);
    const day = todaySqlite();

    const totalRow = await dbGet(`SELECT COUNT(1) AS c FROM outbound_orders WHERE 1=1 ${wh.sql}`, wh.params);
    const pendingRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE lower(trim(COALESCE(status,''))) IN ('uploaded','stock checked','pending') ${wh.sql}`,
      [...wh.params]
    );
    const pickingRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE COALESCE(status,'') IN ('Sent For Pick','Picking') ${wh.sql}`,
      [...wh.params]
    );
    const pickedRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE COALESCE(status,'') = 'Picked' ${wh.sql}`,
      [...wh.params]
    );
    const deliveredRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE lower(COALESCE(status,'')) = 'delivered' ${wh.sql}`,
      [...wh.params]
    );
    const cancelledRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE lower(COALESCE(status,'')) LIKE '%cancel%' ${wh.sql}`,
      [...wh.params]
    );
    const todayUploadRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE date(created_at) = date(?) ${wh.sql}`,
      [day, ...wh.params]
    );
    const todayDeliveredRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE lower(COALESCE(status,'')) = 'delivered' AND date(updated_at) = date(?) ${wh.sql}`,
      [day, ...wh.params]
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
router.get('/recent-activity', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const wh = whOutbound(scope);

    const last_uploaded = await dbGet(
      `SELECT outbound_number AS ref, created_at AS at FROM outbound_orders WHERE 1=1 ${wh.sql} ORDER BY id DESC LIMIT 1`,
      [...wh.params]
    );
    const last_sent_pick = await dbGet(
      `SELECT outbound_number AS ref, updated_at AS at FROM outbound_orders
       WHERE (COALESCE(status,'') IN ('Sent For Pick','Picking','Picked')
          OR lower(COALESCE(status,'')) = 'delivered') ${wh.sql}
       ORDER BY updated_at DESC LIMIT 1`,
      [...wh.params]
    );
    const last_picked = await dbGet(
      `SELECT outbound_number AS ref, updated_at AS at FROM outbound_orders
       WHERE (COALESCE(status,'') IN ('Picked') OR lower(COALESCE(status,'')) = 'delivered') ${wh.sql}
       ORDER BY updated_at DESC LIMIT 1`,
      [...wh.params]
    );
    const last_delivered = await dbGet(
      `SELECT outbound_number AS ref, updated_at AS at FROM outbound_orders
       WHERE lower(COALESCE(status,'')) = 'delivered' ${wh.sql}
       ORDER BY updated_at DESC LIMIT 1`,
      [...wh.params]
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
router.get('/notifications', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const wh = whOutbound(scope);
    const dn = whDeliveryNotes(scope);
    const day = todaySqlite();

    const uploadedToday = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE date(created_at) = date(?) ${wh.sql}`,
      [day, ...wh.params]
    );
    const sentToday = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE COALESCE(status,'') = 'Sent For Pick' AND date(updated_at) = date(?) ${wh.sql}`,
      [day, ...wh.params]
    );
    const pickedToday = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE COALESCE(status,'') = 'Picked' AND date(updated_at) = date(?) ${wh.sql}`,
      [day, ...wh.params]
    );
    const deliveredToday = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE lower(COALESCE(status,'')) = 'delivered' AND date(updated_at) = date(?) ${wh.sql}`,
      [day, ...wh.params]
    );
    const podToday = await dbGet(
      `SELECT COUNT(1) AS c FROM delivery_notes
       WHERE lower(COALESCE(status,'')) = 'delivered' AND date(delivered_at) = date(?) ${dn.sql}`,
      [day, ...dn.params]
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

/** GET /api/dashboard/range-summary?from=&to=
 *  Orders / DN activity for a date window (default last 7 days through today).
 */
router.get('/range-summary', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const wh = whOutbound(scope);
    const dn = whDeliveryNotes(scope);

    const toQ = parseIsoDay(req.query.to);
    const { from: fromDefault, to: toDefault } = defaultRangeToFrom(toQ || todaySqlite());
    let from = parseIsoDay(req.query.from) || fromDefault;
    let to = toQ || toDefault;
    if (from > to) {
      const x = from;
      from = to;
      to = x;
    }

    const rangeParams = [from, to, ...wh.params];
    const uploadedAgg = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE date(created_at) BETWEEN date(?) AND date(?) ${wh.sql}`,
      rangeParams
    );
    const deliveredAgg = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE lower(trim(COALESCE(status,''))) = 'delivered'
         AND date(updated_at) BETWEEN date(?) AND date(?) ${wh.sql}`,
      rangeParams
    );
    const sentPickAgg = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE COALESCE(status,'') = 'Sent For Pick'
         AND date(updated_at) BETWEEN date(?) AND date(?) ${wh.sql}`,
      rangeParams
    );
    const pickedAgg = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE COALESCE(status,'') = 'Picked'
         AND date(updated_at) BETWEEN date(?) AND date(?) ${wh.sql}`,
      rangeParams
    );

    const pendingRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE lower(trim(COALESCE(status,''))) IN ('uploaded','stock checked','pending') ${wh.sql}`,
      [...wh.params]
    );
    const pickingRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders
       WHERE COALESCE(status,'') IN ('Sent For Pick','Picking') ${wh.sql}`,
      [...wh.params]
    );
    const pickedRow = await dbGet(
      `SELECT COUNT(1) AS c FROM outbound_orders WHERE COALESCE(status,'') = 'Picked' ${wh.sql}`,
      [...wh.params]
    );

    const uploadsByDay = await dbAll(
      `SELECT date(created_at) AS day, COUNT(1) AS count FROM outbound_orders
       WHERE date(created_at) BETWEEN date(?) AND date(?) ${wh.sql}
       GROUP BY date(created_at) ORDER BY day ASC`,
      [from, to, ...wh.params]
    );
    const outboundDeliveredByDay = await dbAll(
      `SELECT date(updated_at) AS day, COUNT(1) AS count FROM outbound_orders
       WHERE lower(trim(COALESCE(status,''))) = 'delivered'
         AND date(updated_at) BETWEEN date(?) AND date(?) ${wh.sql}
       GROUP BY date(updated_at) ORDER BY day ASC`,
      [from, to, ...wh.params]
    );

    const dnRangeParams = [from, to, ...dn.params];
    const dnRows = await dbAll(
      `SELECT id, dn_number, outbound_number, customer_name, status, delivery_status,
              dn_date, delivered_at, created_at, updated_at
       FROM delivery_notes
       WHERE date(COALESCE(delivered_at, dn_date, created_at)) BETWEEN date(?) AND date(?) ${dn.sql}
       ORDER BY datetime(COALESCE(delivered_at, updated_at, created_at)) DESC
       LIMIT 150`,
      dnRangeParams
    );

    const dnStatusBreakdown = await dbAll(
      `SELECT
         COALESCE(NULLIF(TRIM(delivery_status), ''), NULLIF(TRIM(status), ''), '(unset)') AS bucket,
         COUNT(1) AS count
       FROM delivery_notes
       WHERE date(COALESCE(delivered_at, dn_date, created_at)) BETWEEN date(?) AND date(?) ${dn.sql}
       GROUP BY bucket
       ORDER BY count DESC`,
      dnRangeParams
    );

    const payload = {
      from,
      to,
      outbound_in_range: {
        uploaded: Number(uploadedAgg?.c) || 0,
        delivered: Number(deliveredAgg?.c) || 0,
        sent_for_pick_updates: Number(sentPickAgg?.c) || 0,
        picked_updates: Number(pickedAgg?.c) || 0,
      },
      pipeline_now: {
        pending: Number(pendingRow?.c) || 0,
        under_picking: Number(pickingRow?.c) || 0,
        picked: Number(pickedRow?.c) || 0,
      },
      uploads_by_day: uploadsByDay.map((r) => ({ day: r.day, count: Number(r.count) || 0 })),
      outbound_delivered_by_day: outboundDeliveredByDay.map((r) => ({
        day: r.day,
        count: Number(r.count) || 0,
      })),
      delivery_notes_in_range: dnRows,
      dn_status_in_range: dnStatusBreakdown.map((r) => ({
        status: r.bucket,
        count: Number(r.count) || 0,
      })),
    };
    res.json(JSON.parse(JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v))));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/dashboard/live-activity — orders under pick with line progress + recent picker scans. */
router.get('/live-activity', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const wh = whOutbound(scope);

    const orders = await dbAll(
      `SELECT o.id, o.outbound_number, o.status, o.customer_name, o.vendor_name, o.sold_to,
              o.sales_order_number, o.updated_at, o.created_at,
              o.warehouse_id, w.warehouse_code, w.warehouse_name
       FROM outbound_orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
       WHERE COALESCE(o.status,'') IN ('Sent For Pick','Picking') ${wh.sql.replace(/warehouse_id/g, 'o.warehouse_id')}
       ORDER BY datetime(COALESCE(o.updated_at, o.created_at)) DESC
       LIMIT 30`,
      [...wh.params]
    );

    if (!orders.length) {
      return res.json({ orders: [], recent_picks: [] });
    }

    const ids = orders.map((o) => Number(o.id)).filter(Boolean);
    const placeholders = ids.map(() => '?').join(',');

    const seenRows = await dbAll(
      `SELECT s.outbound_order_id, s.seen_at, COALESCE(u.full_name, u.username, '') AS user_name
       FROM outbound_order_seen s
       JOIN users u ON u.id = s.user_id
       WHERE s.outbound_order_id IN (${placeholders})
       ORDER BY s.seen_at DESC`,
      ids
    ).catch(() => []);

    const seenByOrder = new Map();
    for (const s of seenRows || []) {
      const oid = Number(s.outbound_order_id);
      if (!seenByOrder.has(oid)) seenByOrder.set(oid, []);
      const list = seenByOrder.get(oid);
      if (list.length < 5) list.push({ user_name: s.user_name, seen_at: s.seen_at });
    }

    const recent_picks = await dbAll(
      `SELECT t.id, t.outbound_order_id, o.outbound_number,
              t.user_name, t.material, t.sap_part_number, t.rack_location, t.picked_qty, t.picked_at, t.picked_method
       FROM picked_transactions t
       JOIN outbound_orders o ON o.id = t.outbound_order_id
       WHERE t.outbound_order_id IN (${placeholders})
         AND COALESCE(o.status,'') IN ('Sent For Pick','Picking') ${wh.sql.replace(/warehouse_id/g, 'o.warehouse_id')}
       ORDER BY datetime(t.picked_at) DESC, t.id DESC
       LIMIT 40`,
      [...ids, ...wh.params]
    ).catch(() => []);

    const enriched = [];
    for (const o of orders) {
      const { pick_progress, picked_transactions, picked_order } = await loadOutboundPickFootprint({
        dbGet,
        dbAll,
        orderId: o.id,
      });
      enriched.push({
        id: o.id,
        outbound_number: o.outbound_number,
        status: o.status,
        customer_name: o.customer_name,
        vendor_name: o.vendor_name || o.sold_to,
        sales_order_number: o.sales_order_number,
        warehouse_id: o.warehouse_id,
        warehouse_code: o.warehouse_code,
        warehouse_name: o.warehouse_name,
        updated_at: o.updated_at || o.created_at,
        pick_progress,
        picked_order: picked_order
          ? {
              confirmed_by_user_name: picked_order.confirmed_by_user_name,
              confirmed_at: picked_order.confirmed_at,
            }
          : null,
        viewers: seenByOrder.get(Number(o.id)) || [],
        recent_picks: (picked_transactions || []).slice(-5).reverse(),
      });
    }

    res.json({ orders: enriched, recent_picks: recent_picks || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Recent outbound rows + inbound putaway count for dashboard pipeline view. */
router.get('/order-pipeline', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const wh = whOutbound(scope);
    const bh = whInboundBatches(scope);

    const inboundRow = await dbGet(
      `SELECT COUNT(DISTINCT b.id) AS c
       FROM inbound_batches b
       WHERE EXISTS (
         SELECT 1 FROM inbound_items i
         WHERE i.inbound_batch_id = b.id AND COALESCE(i.remaining_qty, 0) > 0.000001
       ) ${bh.sql}`,
      [...bh.params]
    );
    const outbound_orders = await dbAll(
      `SELECT o.*, w.warehouse_code, w.warehouse_name
       FROM outbound_orders o
       LEFT JOIN warehouses w ON w.id = o.warehouse_id
       WHERE 1=1 ${wh.sql.replace(/warehouse_id/g, 'o.warehouse_id')}
       ORDER BY datetime(COALESCE(o.updated_at, o.created_at)) DESC
       LIMIT 80`,
      [...wh.params]
    );
    res.json({
      inbound_putaway_pending: Number(inboundRow?.c) || 0,
      outbound_orders: outbound_orders || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
