const express = require('express');
const { promisify } = require('util');

const db = require('../db');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));

async function runOutboundPicks(req, res) {
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
}

router.get('/outbound-picks', runOutboundPicks);
router.get('/outbound', runOutboundPicks);

function inboundPutawaySql(req) {
  const { batch, vendor, from, to, status } = req.query;
  const params = [];
  let sql = `
      SELECT
        b.id AS batch_id,
        b.batch_name,
        b.vendor_name,
        b.upload_date,
        b.status AS batch_status,
        i.id AS inbound_item_id,
        i.part_number,
        i.sap_part_number,
        i.description,
        i.total_qty,
        i.putaway_qty,
        i.remaining_qty,
        i.status AS item_status,
        i.updated_at AS last_updated,
        (SELECT COUNT(*) FROM inbound_putaway_lines pl WHERE pl.inbound_item_id = i.id AND pl.applied_to_rack = 0) AS pending_lines
      FROM inbound_items i
      JOIN inbound_batches b ON b.id = i.inbound_batch_id
      WHERE 1=1
    `;
  if (batch) {
    sql += ` AND (b.batch_name LIKE ? OR CAST(b.id AS TEXT) = ?)`;
    params.push(`%${String(batch).trim()}%`, String(batch).trim());
  }
  if (vendor) {
    sql += ` AND COALESCE(b.vendor_name,'') LIKE ?`;
    params.push(`%${String(vendor).trim()}%`);
  }
  if (from) {
    sql += ` AND date(COALESCE(b.upload_date, b.created_at)) >= date(?)`;
    params.push(from);
  }
  if (to) {
    sql += ` AND date(COALESCE(b.upload_date, b.created_at)) <= date(?)`;
    params.push(to);
  }
  if (status) {
    sql += ` AND i.status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY b.id DESC, i.part_number`;
  return { sql, params };
}

router.get('/inbound', async (req, res) => {
  try {
    const { sql, params } = inboundPutawaySql(req);
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function deliveryWhereClause(q) {
  const params = [];
  const fragments = [];
  const add = (clause, ...vals) => {
    fragments.push(clause);
    params.push(...vals);
  };

  if (q.date_from) add(`date(COALESCE(dn.dn_date, dn.created_at)) >= date(?)`, q.date_from);
  if (q.date_to) add(`date(COALESCE(dn.dn_date, dn.created_at)) <= date(?)`, q.date_to);
  if (q.outbound_number) add(`COALESCE(dn.outbound_number,'') LIKE ?`, `%${String(q.outbound_number).trim()}%`);
  if (q.gapp_po) {
    add(`(COALESCE(dn.gapp_po,'') LIKE ? OR COALESCE(o.gapp_po,'') LIKE ?)`, `%${String(q.gapp_po).trim()}%`, `%${String(q.gapp_po).trim()}%`);
  }
  if (q.customer_reference) {
    add(
      `(COALESCE(dn.customer_po,'') LIKE ? OR COALESCE(o.customer_reference,'') LIKE ? OR COALESCE(o.customer_po_number,'') LIKE ?)`,
      `%${String(q.customer_reference).trim()}%`,
      `%${String(q.customer_reference).trim()}%`,
      `%${String(q.customer_reference).trim()}%`
    );
  }
  if (q.invoice_number) {
    add(`(COALESCE(dn.invoice_number,'') LIKE ? OR COALESCE(o.invoice_number,'') LIKE ?)`, `%${String(q.invoice_number).trim()}%`, `%${String(q.invoice_number).trim()}%`);
  }
  if (q.customer_name) add(`COALESCE(dn.customer_name,'') LIKE ?`, `%${String(q.customer_name).trim()}%`);
  if (q.sold_to) add(`COALESCE(o.sold_to,'') LIKE ?`, `%${String(q.sold_to).trim()}%`);
  if (q.transportation_type) add(`COALESCE(dn.transportation_type,'') LIKE ?`, `%${String(q.transportation_type).trim()}%`);
  if (q.carrier_name) add(`COALESCE(dn.carrier_name,'') LIKE ?`, `%${String(q.carrier_name).trim()}%`);
  if (q.driver_name) add(`COALESCE(dn.driver_name,'') LIKE ?`, `%${String(q.driver_name).trim()}%`);
  if (q.truck_type) add(`COALESCE(dn.truck_type,'') LIKE ?`, `%${String(q.truck_type).trim()}%`);
  if (q.status) add(`COALESCE(dn.status,'') LIKE ?`, `%${String(q.status).trim()}%`);

  return { fragments, params };
}

router.get('/delivery', async (req, res) => {
  try {
    const level = String(req.query.level || 'header').toLowerCase() === 'item' ? 'item' : 'header';
    const { fragments, params } = deliveryWhereClause(req.query);
    const whereExtra = fragments.length ? ` AND ${fragments.join(' AND ')}` : '';

    if (level === 'header') {
      const sql = `
        SELECT
          dn.id AS dn_id,
          dn.dn_number AS dn_number,
          dn.dn_date AS dn_date,
          dn.outbound_number AS outbound_number,
          COALESCE(o.sales_order_number, dn.sales_order_number) AS sales_order_number,
          COALESCE(dn.gapp_po, o.gapp_po) AS gapp_po,
          COALESCE(dn.customer_po, o.customer_reference, o.customer_po_number) AS customer_po_reference,
          COALESCE(dn.invoice_number, o.invoice_number) AS invoice_number,
          COALESCE(o.sold_to, '') AS sold_to,
          dn.customer_name AS customer_name,
          dn.city_name AS city,
          dn.delivery_address AS delivery_address,
          dn.gps AS gps,
          dn.contact_person AS contact_person_1,
          dn.contact_number AS contact_number_1,
          dn.contact_person_2 AS contact_person_2,
          dn.contact_number_2 AS contact_number_2,
          dn.transportation_type AS transportation_type,
          dn.carrier_name AS carrier_name,
          dn.driver_name AS driver_name,
          dn.driver_mobile AS driver_mobile,
          dn.vehicle AS vehicle,
          dn.truck_type AS truck_type,
          dn.truck_qty AS number_of_trucks,
          dn.package_type AS package_type,
          dn.pallet_qty AS pallet_qty,
          dn.box_qty AS box_qty,
          dn.gross_weight_kg AS gross_weight_kg,
          dn.volume_cbm AS volume_cbm,
          dn.waybill_number AS waybill_number,
          dn.collector_name AS collector_name,
          dn.collector_mobile AS collector_mobile,
          dn.status AS delivery_status,
          dn.delivered_at AS delivered_at,
          NULL AS delivered_by,
          CASE WHEN lower(COALESCE(dn.status,'')) = 'delivered' THEN 'Yes' ELSE 'No' END AS pod_attached,
          COALESCE(dn.deliver_to_remarks, dn.transportation_remarks, '') AS remarks
        FROM delivery_notes dn
        LEFT JOIN outbound_orders o ON TRIM(COALESCE(o.outbound_number,'')) = TRIM(COALESCE(dn.outbound_number,''))
        WHERE 1=1
        ${whereExtra}
        ORDER BY dn.id DESC
        LIMIT 5000
      `;
      const rows = await dbAll(sql, params);
      return res.json(rows);
    }

    const sql = `
      SELECT
        dn.dn_number AS dn_number,
        dn.dn_date AS dn_date,
        dn.outbound_number AS outbound_number,
        COALESCE(o.sales_order_number, dn.sales_order_number) AS sales_order_number,
        COALESCE(dn.gapp_po, o.gapp_po) AS gapp_po,
        COALESCE(dn.customer_po, o.customer_reference, o.customer_po_number) AS customer_po_reference,
        COALESCE(dn.invoice_number, o.invoice_number) AS invoice_number,
        COALESCE(o.sold_to, '') AS sold_to,
        dn.customer_name AS customer_name,
        dn.transportation_type AS transportation_type,
        dn.carrier_name AS carrier_name,
        dn.driver_name AS driver_name,
        dn.truck_type AS truck_type,
        dn.truck_qty AS number_of_trucks,
        i.part_number AS part_number,
        i.sap_part_number AS sap_part_number,
        i.description AS description,
        COALESCE(
          (SELECT d.delivered_qty FROM delivered d
           WHERE d.dn_id = dn.id AND TRIM(COALESCE(d.part_number,'')) = TRIM(COALESCE(i.part_number,''))
           ORDER BY d.id DESC LIMIT 1),
          i.qty
        ) AS qty,
        i.uom AS uom,
        i.serial_no AS serial_no,
        i.condition_text AS item_condition,
        dn.status AS delivery_status,
        dn.delivered_at AS delivered_at,
        NULL AS delivered_by,
        i.item_no AS item_no
      FROM delivery_notes dn
      INNER JOIN delivery_note_items i ON i.dn_id = dn.id
      LEFT JOIN outbound_orders o ON TRIM(COALESCE(o.outbound_number,'')) = TRIM(COALESCE(dn.outbound_number,''))
      WHERE 1=1
      ${whereExtra}
      ORDER BY dn.id DESC, i.item_no ASC, i.id ASC
      LIMIT 20000
    `;
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stock-by-rack', async (req, res) => {
  try {
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 5000));
    const search = req.query.search ? `%${String(req.query.search).trim()}%` : null;
    const params = [];
    let sql = `SELECT * FROM stock_by_rack WHERE 1=1`;
    if (search) {
      sql += ` AND (part_number LIKE ? OR COALESCE(sap_part_number,'') LIKE ? OR COALESCE(rack_location,'') LIKE ?)`;
      params.push(search, search, search);
    }
    sql += ` ORDER BY part_number, rack_location LIMIT ?`;
    params.push(limit);
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/main-stock', async (req, res) => {
  try {
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 5000));
    const search = req.query.search ? `%${String(req.query.search).trim()}%` : null;
    const params = [];
    let sql = `SELECT * FROM main_stock WHERE 1=1`;
    if (search) {
      sql += ` AND (part_number LIKE ? OR COALESCE(sap_part_number,'') LIKE ? OR COALESCE(description,'') LIKE ?)`;
      params.push(search, search, search);
    }
    sql += ` ORDER BY part_number LIMIT ?`;
    params.push(limit);
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sap-stock', async (req, res) => {
  try {
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 5000));
    const rows = await dbAll(
      `SELECT part_number, sap_part_number, description, sap_qty, received_qty, sold_out_qty, pending_delivery_qty,
              available_qty, remarks, vendor_name, vendor_number
       FROM main_stock
       WHERE COALESCE(sap_qty,0) != 0 OR (COALESCE(sap_part_number,'') != '' AND TRIM(COALESCE(sap_part_number,'')) != '')
       ORDER BY part_number
       LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
