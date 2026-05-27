const express = require('express');
const { promisify } = require('util');
const XLSX = require('xlsx');

const db = require('../db');
const { getStockComparison } = require('../services/stockComparisonService');
const { assertExplicitWarehouseParamAllowed, resolveReadWarehouseScope } = require('../services/warehouseContext');
const { requirePermission } = require('../middleware/auth');
const {
  listOrderPickStatus,
  getOrderPickStatusDetail,
  detailToExcelRows,
} = require('../services/orderPickStatusReport');

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

function appendOutboundWarehouse(sql, params, scope) {
  if (scope.mode === 'all') return { sql, params };
  return {
    sql: `${sql} AND o.warehouse_id = ? `,
    params: [...params, scope.warehouseId],
  };
}

async function runOutboundPicks(req, res) {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
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
    const scoped = appendOutboundWarehouse(sql, params, scope);
    scoped.sql += ` ORDER BY pt.picked_at DESC LIMIT 5000`;
    const rows = await dbAll(scoped.sql, scoped.params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

router.get('/outbound-picks', runOutboundPicks);
router.get('/outbound', runOutboundPicks);

async function putawayFilterSuggestions(dbAll, field, q, limit, warehouseId) {
  const lim = Math.min(50, Math.max(1, limit || 30));
  const like = q ? `%${q}%` : '%';
  const wh = warehouseId ? ` AND b.warehouse_id = ? ` : '';
  const whParams = warehouseId ? [warehouseId] : [];

  if (field === 'lpo') {
    const rows = await dbAll(
      `SELECT DISTINCT TRIM(b.lpo) AS v FROM inbound_batches b
       JOIN inbound_items i ON i.inbound_batch_id = b.id
       WHERE TRIM(COALESCE(b.lpo,'')) != '' AND b.lpo LIKE ? ${wh}
       ORDER BY v LIMIT ?`,
      [like, ...whParams, lim]
    );
    return (rows || []).map((r) => r.v).filter(Boolean);
  }
  if (field === 'sap_po') {
    const rows = await dbAll(
      `SELECT DISTINCT TRIM(b.sap_po) AS v FROM inbound_batches b
       JOIN inbound_items i ON i.inbound_batch_id = b.id
       WHERE TRIM(COALESCE(b.sap_po,'')) != '' AND b.sap_po LIKE ? ${wh}
       ORDER BY v LIMIT ?`,
      [like, ...whParams, lim]
    );
    return (rows || []).map((r) => r.v).filter(Boolean);
  }
  if (field === 'invoice') {
    const rows = await dbAll(
      `SELECT DISTINCT TRIM(b.invoice_number) AS v FROM inbound_batches b
       JOIN inbound_items i ON i.inbound_batch_id = b.id
       WHERE TRIM(COALESCE(b.invoice_number,'')) != '' AND b.invoice_number LIKE ? ${wh}
       ORDER BY v LIMIT ?`,
      [like, ...whParams, lim]
    );
    return (rows || []).map((r) => r.v).filter(Boolean);
  }
  if (field === 'part') {
    const rows = await dbAll(
      `SELECT DISTINCT TRIM(i.part_number) AS v FROM inbound_items i
       JOIN inbound_batches b ON b.id = i.inbound_batch_id
       WHERE TRIM(COALESCE(i.part_number,'')) != '' AND i.part_number LIKE ? ${wh}
       ORDER BY v LIMIT ?`,
      [like, ...whParams, lim]
    );
    return (rows || []).map((r) => r.v).filter(Boolean);
  }
  return null;
}

function inboundPutawaySql(req, scope) {
  const { batch, vendor, from, to, status, lpo, sap_po, invoice, part_number, part } = req.query;
  const params = [];
  let sql = `
      SELECT
        b.id AS batch_id,
        b.batch_name,
        b.vendor_name,
        b.upload_date,
        b.status AS batch_status,
        b.lpo,
        b.sap_po,
        b.invoice_number,
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
  if (scope.mode === 'one' && scope.warehouseId) {
    sql += ` AND b.warehouse_id = ?`;
    params.push(scope.warehouseId);
  }
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
  const lpoQ = String(lpo || '').trim();
  const sapPoQ = String(sap_po || '').trim();
  const invQ = String(invoice || '').trim();
  const partQ = String(part_number || part || '').trim();
  if (lpoQ) {
    sql += ` AND COALESCE(b.lpo,'') LIKE ?`;
    params.push(`%${lpoQ}%`);
  }
  if (sapPoQ) {
    sql += ` AND COALESCE(b.sap_po,'') LIKE ?`;
    params.push(`%${sapPoQ}%`);
  }
  if (invQ) {
    sql += ` AND COALESCE(b.invoice_number,'') LIKE ?`;
    params.push(`%${invQ}%`);
  }
  if (partQ) {
    sql += ` AND i.part_number LIKE ?`;
    params.push(`%${partQ}%`);
  }
  sql += ` ORDER BY b.id DESC, i.part_number`;
  return { sql, params };
}

router.get('/inbound/filter-suggestions', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const field = String(req.query.field || '').trim().toLowerCase();
    const q = String(req.query.q || '').trim();
    const lim = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const wid = scope.mode === 'one' && scope.warehouseId ? scope.warehouseId : null;
    const values = await putawayFilterSuggestions(dbAll, field, q, lim, wid);
    if (values === null) return res.status(400).json({ error: 'field must be lpo, sap_po, invoice, or part' });
    res.json(values);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/inbound', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const { sql, params } = inboundPutawaySql(req, scope);
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Calendar date for DN filters (dn_date stored as TEXT; created_at is timestamp). */
const DN_REPORT_DATE_SQL = `COALESCE(
  CASE WHEN NULLIF(TRIM(COALESCE(dn.dn_date, '')), '') IS NOT NULL THEN date(dn.dn_date) END,
  date(dn.created_at)
)`;

/** Match outbound the same way as delivery-notes / document-flow (DN key may be outbound_number or sales "delivery"). */
const DELIVERY_REPORT_OUTBOUND_JOIN = `(
  TRIM(COALESCE(o.outbound_number,'')) = TRIM(COALESCE(dn.outbound_number,''))
  OR TRIM(COALESCE(o.delivery,'')) = TRIM(COALESCE(dn.outbound_number,''))
)`;

function deliveryWhereClause(q) {
  const params = [];
  const fragments = [];
  const add = (clause, ...vals) => {
    fragments.push(clause);
    params.push(...vals);
  };
  /** Postgres LIKE is case-sensitive; SQLite LIKE is ASCII-insensitive — align behavior. */
  const likeI = (expr) => `LOWER(${expr}) LIKE LOWER(?)`;

  if (q.date_from) add(`${DN_REPORT_DATE_SQL} >= date(?)`, q.date_from);
  if (q.date_to) add(`${DN_REPORT_DATE_SQL} <= date(?)`, q.date_to);
  if (q.outbound_number) add(likeI(`COALESCE(dn.outbound_number,'')`), `%${String(q.outbound_number).trim()}%`);
  if (q.gapp_po) {
    const pat = `%${String(q.gapp_po).trim()}%`;
    add(`(${likeI(`COALESCE(dn.gapp_po,'')`)} OR ${likeI(`COALESCE(o.gapp_po,'')`)})`, pat, pat);
  }
  if (q.customer_reference) {
    const pat = `%${String(q.customer_reference).trim()}%`;
    add(
      `(${likeI(`COALESCE(dn.customer_po,'')`)} OR ${likeI(`COALESCE(o.customer_reference,'')`)} OR ${likeI(`COALESCE(o.customer_po_number,'')`)})`,
      pat,
      pat,
      pat
    );
  }
  if (q.invoice_number) {
    const pat = `%${String(q.invoice_number).trim()}%`;
    add(`(${likeI(`COALESCE(dn.invoice_number,'')`)} OR ${likeI(`COALESCE(o.invoice_number,'')`)})`, pat, pat);
  }
  if (q.customer_name) add(likeI(`COALESCE(dn.customer_name,'')`), `%${String(q.customer_name).trim()}%`);
  if (q.sold_to) add(likeI(`COALESCE(o.sold_to,'')`), `%${String(q.sold_to).trim()}%`);
  if (q.transportation_type) add(likeI(`COALESCE(dn.transportation_type,'')`), `%${String(q.transportation_type).trim()}%`);
  if (q.carrier_name) add(likeI(`COALESCE(dn.carrier_name,'')`), `%${String(q.carrier_name).trim()}%`);
  if (q.driver_name) add(likeI(`COALESCE(dn.driver_name,'')`), `%${String(q.driver_name).trim()}%`);
  if (q.truck_type) add(likeI(`COALESCE(dn.truck_type,'')`), `%${String(q.truck_type).trim()}%`);
  if (q.status) add(likeI(`COALESCE(dn.status,'')`), `%${String(q.status).trim()}%`);

  return { fragments, params };
}

router.get('/delivery', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const level = String(req.query.level || 'header').toLowerCase() === 'item' ? 'item' : 'header';
    const { fragments, params } = deliveryWhereClause(req.query);
    const frags = [...fragments];
    const pms = [...params];
    if (scope.mode === 'one' && scope.warehouseId) {
      // Many rows have outbound warehouse on `o` but stale/NULL on `dn`; include both.
      frags.push('(dn.warehouse_id = ? OR o.warehouse_id = ?)');
      pms.push(scope.warehouseId, scope.warehouseId);
    }
    const whereExtra = frags.length ? ` AND ${frags.join(' AND ')}` : '';

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
        LEFT JOIN outbound_orders o ON ${DELIVERY_REPORT_OUTBOUND_JOIN}
        WHERE 1=1
        ${whereExtra}
        ORDER BY dn.id DESC
        LIMIT 5000
      `;
      const rows = await dbAll(sql, pms);
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
      LEFT JOIN outbound_orders o ON ${DELIVERY_REPORT_OUTBOUND_JOIN}
      WHERE 1=1
      ${whereExtra}
      ORDER BY dn.id DESC, i.item_no ASC, i.id ASC
      LIMIT 20000
    `;
    const rows = await dbAll(sql, pms);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stock-by-rack', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 5000));
    const search = req.query.search ? `%${String(req.query.search).trim()}%` : null;
    const params = [];
    let sql = `SELECT * FROM stock_by_rack WHERE 1=1`;
    if (scope.mode === 'one' && scope.warehouseId) {
      sql += ` AND warehouse_id = ?`;
      params.push(scope.warehouseId);
    }
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
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 5000));
    const search = req.query.search ? `%${String(req.query.search).trim()}%` : null;
    const params = [];
    let sql = `SELECT * FROM main_stock WHERE 1=1`;
    if (scope.mode === 'one' && scope.warehouseId) {
      sql += ` AND warehouse_id = ?`;
      params.push(scope.warehouseId);
    }
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
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 5000));
    const params = [];
    let sql = `
      SELECT part_number, sap_part_number, description, sap_qty, received_qty, sold_out_qty, pending_delivery_qty,
              available_qty, remarks, vendor_name, vendor_number
       FROM main_stock
       WHERE (COALESCE(sap_qty,0) != 0 OR (COALESCE(sap_part_number,'') != '' AND TRIM(COALESCE(sap_part_number,'')) != ''))`;
    if (scope.mode === 'one' && scope.warehouseId) {
      sql += ` AND warehouse_id = ?`;
      params.push(scope.warehouseId);
    }
    sql += ` ORDER BY part_number LIMIT ?`;
    params.push(limit);
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/stock-comparison', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const q = { ...req.query };
    if (scope.mode === 'one' && scope.warehouseId) {
      q.warehouse_id = String(scope.warehouseId);
    } else {
      delete q.warehouse_id;
    }
    const data = await getStockComparison(db, q);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Rack admin ± adjustments with FIFO refresh audit; expanded one row per related open order. */
router.get('/rack-balance-adjustments', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const { from, to, part_number, deductions_only } = req.query;
    const params = [];
    let sql = `SELECT * FROM rack_balance_adjustments WHERE 1=1`;
    if (scope.mode === 'one' && scope.warehouseId) {
      sql += ` AND warehouse_id = ?`;
      params.push(scope.warehouseId);
    }
    if (from) {
      sql += ` AND date(created_at) >= date(?)`;
      params.push(from);
    }
    if (to) {
      sql += ` AND date(created_at) <= date(?)`;
      params.push(to);
    }
    if (part_number) {
      sql += ` AND part_number LIKE ?`;
      params.push(`%${String(part_number).trim()}%`);
    }
    if (deductions_only === 'true' || deductions_only === '1') {
      sql += ` AND delta_qty < 0`;
    }
    sql += ` ORDER BY created_at DESC LIMIT 5000`;
    const rows = await dbAll(sql, params);

    const expanded = [];
    for (const r of rows) {
      let orders = [];
      try {
        orders = JSON.parse(r.affected_orders_json || '[]');
      } catch {
        orders = [];
      }
      const base = {
        adjustment_id: r.id,
        created_at: r.created_at,
        part_number: r.part_number,
        rack_location: r.rack_location,
        delta_qty: r.delta_qty,
        deduction_qty: r.delta_qty < 0 ? Math.abs(r.delta_qty) : null,
        add_qty: r.delta_qty > 0 ? r.delta_qty : null,
        balance_after_available: r.balance_after_available,
        balance_after_total_in: r.balance_after_total_in,
        balance_after_total_out: r.balance_after_total_out,
        first_entry_date_before: r.first_entry_date_before,
        first_entry_date_after: r.first_entry_date_after,
        remarks: r.remarks,
        created_by_user_id: r.created_by_user_id,
      };
      if (!Array.isArray(orders) || orders.length === 0) {
        expanded.push({
          ...base,
          related_order_id: null,
          related_outbound_number: null,
          related_delivery: null,
          related_order_status: null,
        });
      } else {
        for (const o of orders) {
          expanded.push({
            ...base,
            related_order_id: o.id ?? null,
            related_outbound_number: o.outbound_number ?? null,
            related_delivery: o.delivery ?? null,
            related_order_status: o.status ?? null,
          });
        }
      }
    }
    res.json(expanded);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/bom-definitions', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT s.parent_part_number, s.parent_description, c.child_part_number, c.child_description, c.child_qty_per_parent, c.is_active, c.uom
       FROM part_bom_sets s
       JOIN part_bom_children c ON c.bom_set_id = s.id
       WHERE COALESCE(s.is_active,1) = 1
       ORDER BY s.parent_part_number, c.id`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/bom-outbound-lines', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const params = [];
    let sql = `
      SELECT o.outbound_number, obr.parent_part_number, obr.parent_required_qty,
              obr.child_part_number, obr.required_child_qty, obr.picked_child_qty, obr.status
       FROM outbound_bom_requirements obr
       JOIN outbound_orders o ON o.id = obr.outbound_order_id
       WHERE 1=1`;
    if (scope.mode === 'one' && scope.warehouseId) {
      sql += ` AND o.warehouse_id = ?`;
      params.push(scope.warehouseId);
    }
    sql += ` ORDER BY obr.id DESC LIMIT 5000`;
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function auditLogWhereClause(q, scope) {
  const params = [];
  const frags = [];

  if (scope.mode === 'one' && scope.warehouseId) {
    frags.push('al.warehouse_id = ?');
    params.push(scope.warehouseId);
  } else if (q.warehouse_id && String(q.warehouse_id).trim() && String(q.warehouse_id).toLowerCase() !== 'all') {
    const wid = Number(q.warehouse_id);
    if (Number.isFinite(wid) && wid > 0) {
      frags.push('al.warehouse_id = ?');
      params.push(wid);
    }
  }
  if (q.date_from) {
    frags.push(`date(al.created_at) >= date(?)`);
    params.push(q.date_from);
  }
  if (q.date_to) {
    frags.push(`date(al.created_at) <= date(?)`);
    params.push(q.date_to);
  }
  if (q.user_id) {
    frags.push('al.user_id = ?');
    params.push(Number(q.user_id));
  }
  if (q.user_role) {
    frags.push(`lower(trim(COALESCE(al.user_role, ''))) = lower(trim(?))`);
    params.push(String(q.user_role).trim());
  }
  if (q.module_name) {
    frags.push('al.module_name = ?');
    params.push(String(q.module_name).trim());
  }
  if (q.action_type) {
    frags.push('al.action_type = ?');
    params.push(String(q.action_type).trim());
  }
  if (q.reference_type) {
    frags.push('al.reference_type = ?');
    params.push(String(q.reference_type).trim());
  }
  if (q.reference_number) {
    frags.push(`COALESCE(al.reference_number, '') LIKE ?`);
    params.push(`%${String(q.reference_number).trim()}%`);
  }
  if (q.status_before) {
    frags.push(`COALESCE(al.status_before, '') LIKE ?`);
    params.push(`%${String(q.status_before).trim()}%`);
  }
  if (q.status_after) {
    frags.push(`COALESCE(al.status_after, '') LIKE ?`);
    params.push(`%${String(q.status_after).trim()}%`);
  }
  if (q.has_remarks === '1' || q.has_remarks === 'true') {
    frags.push(`TRIM(COALESCE(al.remarks, '')) != ''`);
  }
  if (q.search) {
    const s = `%${String(q.search).trim()}%`;
    frags.push(
      `(COALESCE(al.reference_number,'') LIKE ? OR COALESCE(al.remarks,'') LIKE ? OR COALESCE(al.user_name,'') LIKE ? OR COALESCE(al.module_name,'') LIKE ? OR COALESCE(al.action_type,'') LIKE ? OR COALESCE(al.old_value_json,'') LIKE ? OR COALESCE(al.new_value_json,'') LIKE ?)`
    );
    params.push(s, s, s, s, s, s, s);
  }
  return { frags, params };
}

router.get('/audit-logs', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const q = req.query || {};
    const { frags, params } = auditLogWhereClause(q, scope);
    const whereExtra = frags.length ? ` AND ${frags.join(' AND ')}` : '';
    const limit = Math.min(5000, Math.max(1, Number(q.limit) || 200));
    const offset = Math.max(0, Number(q.offset) || 0);

    const countSql = `SELECT COUNT(1) AS c FROM audit_logs al WHERE 1=1${whereExtra}`;
    const countRow = await dbGet(countSql, params);
    const total = Number(countRow?.c) || 0;

    const sql = `
      SELECT al.*, w.warehouse_code AS warehouse_code
      FROM audit_logs al
      LEFT JOIN warehouses w ON w.id = al.warehouse_id
      WHERE 1=1
      ${whereExtra}
      ORDER BY al.created_at DESC, al.id DESC
      LIMIT ? OFFSET ?
    `;
    const rows = await dbAll(sql, [...params, limit, offset]);
    res.json({ rows, total, limit, offset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function fetchAuditRowsForExport(req, scope) {
  const q = req.query || {};
  const { frags, params } = auditLogWhereClause(q, scope);
  const whereExtra = frags.length ? ` AND ${frags.join(' AND ')}` : '';
  const maxRows = Math.min(50000, Math.max(1, Number(q.limit) || 20000));
  const sql = `
    SELECT al.created_at, w.warehouse_code, al.user_name, al.user_role, al.module_name, al.action_type,
           al.reference_type, al.reference_id, al.reference_number, al.status_before, al.status_after,
           al.remarks, al.ip_address, al.device_info, al.old_value_json, al.new_value_json
    FROM audit_logs al
    LEFT JOIN warehouses w ON w.id = al.warehouse_id
    WHERE 1=1
    ${whereExtra}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT ?
  `;
  return dbAll(sql, [...params, maxRows]);
}

router.get('/audit-logs/export-csv', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const rows = await fetchAuditRowsForExport(req, scope);
    const headers = [
      'created_at',
      'warehouse_code',
      'user_name',
      'user_role',
      'module_name',
      'action_type',
      'reference_type',
      'reference_id',
      'reference_number',
      'status_before',
      'status_after',
      'remarks',
      'ip_address',
      'device_info',
      'old_value_json',
      'new_value_json',
    ];
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [headers.join(',')];
    for (const r of rows || []) {
      lines.push(headers.map((h) => esc(r[h])).join(','));
    }
    const body = lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    res.send('\ufeff' + body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/audit-logs/export-excel', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const rows = await fetchAuditRowsForExport(req, scope);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows || []);
    XLSX.utils.book_append_sheet(wb, ws, 'Audit');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Rack updates from stock_in (mobile + web). */
router.get('/rack-update', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const { from, to, part_number, rack_location, source_type, user_id } = req.query;
    const params = [];
    let sql = `
      SELECT si.id, si.transaction_date, si.part_number, si.sap_part_number, si.description,
             si.rack_location, si.qty_in, si.source_type, si.reference_no, si.remarks, si.warehouse_id,
             w.warehouse_code
      FROM stock_in si
      LEFT JOIN warehouses w ON w.id = si.warehouse_id
      WHERE si.source_type IN ('MOBILE_RACK_UPDATE', 'MOBILE_ADD_DURING_PICK', 'WEB_STOCK_IN')
         OR si.source_type LIKE 'MOBILE%'
    `;
    if (scope.mode !== 'all') {
      sql += ' AND si.warehouse_id = ? ';
      params.push(scope.warehouseId);
    }
    if (from) {
      sql += ' AND date(si.transaction_date) >= date(?) ';
      params.push(from);
    }
    if (to) {
      sql += ' AND date(si.transaction_date) <= date(?) ';
      params.push(to);
    }
    if (part_number) {
      sql += ' AND si.part_number LIKE ? ';
      params.push(`%${part_number}%`);
    }
    if (rack_location) {
      sql += ' AND si.rack_location LIKE ? ';
      params.push(`%${rack_location}%`);
    }
    if (source_type) {
      sql += ' AND si.source_type = ? ';
      params.push(source_type);
    }
    sql += ' ORDER BY si.transaction_date DESC, si.id DESC LIMIT 5000';
    const rows = await dbAll(sql, params);
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Picking activity by rack (picked_transactions + stock context). */
router.get('/picking-by-rack', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const { from, to, outbound_number, part_number, rack_location, picker } = req.query;
    const params = [];
    let sql = `
      SELECT pt.id, pt.picked_at, pt.user_name AS picker, pt.material AS part_number, pt.sap_part_number,
             pt.description, pt.rack_location, pt.picked_qty, pt.picked_method,
             o.outbound_number, o.delivery, oi.required_qty, oi.picked_qty AS order_picked_qty
      FROM picked_transactions pt
      JOIN outbound_orders o ON o.id = pt.outbound_order_id
      JOIN outbound_items oi ON oi.id = pt.outbound_item_id
      WHERE 1=1
    `;
    if (scope.mode !== 'all') {
      sql += ' AND o.warehouse_id = ? ';
      params.push(scope.warehouseId);
    }
    if (from) {
      sql += ' AND date(pt.picked_at) >= date(?) ';
      params.push(from);
    }
    if (to) {
      sql += ' AND date(pt.picked_at) <= date(?) ';
      params.push(to);
    }
    if (outbound_number) {
      sql += ' AND (o.outbound_number LIKE ? OR o.delivery LIKE ?) ';
      params.push(`%${outbound_number}%`, `%${outbound_number}%`);
    }
    if (part_number) {
      sql += ' AND (pt.material LIKE ? OR pt.sap_part_number LIKE ?) ';
      params.push(`%${part_number}%`, `%${part_number}%`);
    }
    if (rack_location) {
      sql += ' AND pt.rack_location LIKE ? ';
      params.push(`%${rack_location}%`);
    }
    if (picker) {
      sql += ' AND pt.user_name LIKE ? ';
      params.push(`%${picker}%`);
    }
    sql += ' ORDER BY pt.picked_at DESC, pt.id DESC LIMIT 5000';
    const rows = await dbAll(sql, params);
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Document tracking report — same data as GET /api/sales-order-documents/report */
router.get('/document-tracking', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    if (scope.mode === 'all') {
      return res.status(400).json({ error: 'Select a single warehouse for document tracking' });
    }
    const wid = scope.warehouseId;
    const clauses = ['d.warehouse_id = ?'];
    const params = [wid];
    const q = (k) => String(req.query[k] || '').trim();
    if (q('sales_order_number')) {
      clauses.push(`TRIM(d.sales_order_number) = TRIM(?)`);
      params.push(q('sales_order_number'));
    }
    if (q('outbound_number')) {
      clauses.push(`TRIM(COALESCE(d.outbound_number,'')) LIKE ?`);
      params.push(`%${q('outbound_number')}%`);
    }
    if (q('invoice_number')) {
      clauses.push(`TRIM(COALESCE(d.invoice_number,'')) LIKE ?`);
      params.push(`%${q('invoice_number')}%`);
    }
    if (q('dn_number')) {
      clauses.push(`TRIM(COALESCE(d.dn_number,'')) LIKE ?`);
      params.push(`%${q('dn_number')}%`);
    }
    if (q('customer_po_number')) {
      clauses.push(`TRIM(COALESCE(d.customer_po_number,'')) LIKE ?`);
      params.push(`%${q('customer_po_number')}%`);
    }
    if (q('document_type')) {
      clauses.push(`d.document_type = ?`);
      params.push(q('document_type').toUpperCase());
    }
    if (q('upload_status')) {
      clauses.push(`d.upload_status = ?`);
      params.push(q('upload_status').toUpperCase());
    }
    if (q('verification_status')) {
      clauses.push(`d.verification_status = ?`);
      params.push(q('verification_status').toUpperCase());
    }
    if (q('date_from')) {
      clauses.push(`d.uploaded_at >= ?`);
      params.push(q('date_from'));
    }
    if (q('date_to')) {
      clauses.push(`d.uploaded_at <= ?`);
      params.push(`${q('date_to')}T23:59:59.999Z`);
    }
    const sql = `SELECT d.*, u.username AS uploaded_by_username
       FROM sales_order_documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE ${clauses.join(' AND ')}
       ORDER BY d.uploaded_at DESC, d.id DESC
       LIMIT 5000`;
    const rows = await dbAll(sql, params);
    res.json({ rows: rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/document-tracking/export-excel', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    if (scope.mode === 'all') {
      return res.status(400).json({ error: 'Select a single warehouse for document tracking export' });
    }
    const wid = scope.warehouseId;
    const clauses = ['d.warehouse_id = ?'];
    const params = [wid];
    const q = (k) => String(req.query[k] || '').trim();
    if (q('sales_order_number')) {
      clauses.push(`TRIM(d.sales_order_number) = TRIM(?)`);
      params.push(q('sales_order_number'));
    }
    if (q('outbound_number')) {
      clauses.push(`TRIM(COALESCE(d.outbound_number,'')) LIKE ?`);
      params.push(`%${q('outbound_number')}%`);
    }
    const sql = `SELECT d.sales_order_number, d.outbound_number, d.invoice_number, d.dn_number, d.customer_po_number,
      d.document_type, d.stored_file_name, d.cloud_web_url, d.upload_status, d.verification_status,
      d.upload_source, d.source_pdf_name, d.selected_pages_json, u.username AS uploaded_by, d.uploaded_at
      FROM sales_order_documents d
      LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY d.uploaded_at DESC LIMIT 5000`;
    const rows = await dbAll(sql, params);
    const ws = XLSX.utils.json_to_sheet(rows || []);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Document Tracking');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="document-tracking.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Outbound document workflow status report */
router.get('/document-workflow', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    if (scope.mode === 'all') {
      return res.status(400).json({ error: 'Select a single warehouse for document workflow report' });
    }
    const { listWorkflows } = require('../services/outboundDocumentWorkflowService');
    const rows = await listWorkflows(scope.warehouseId, {
      sales_order_number: req.query.sales_order_number,
      outbound_number: req.query.outbound_number,
      invoice_number: req.query.invoice_number,
      workflow_status: req.query.workflow_status,
      missing_only: req.query.missing_only === '1' || String(req.query.missing_only).toLowerCase() === 'true',
    });
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/document-workflow/export-excel', async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    if (scope.mode === 'all') {
      return res.status(400).json({ error: 'Select a single warehouse for export' });
    }
    const { listWorkflows } = require('../services/outboundDocumentWorkflowService');
    const rows = await listWorkflows(scope.warehouseId, {
      sales_order_number: req.query.sales_order_number,
      outbound_number: req.query.outbound_number,
      invoice_number: req.query.invoice_number,
      workflow_status: req.query.workflow_status,
      missing_only: req.query.missing_only === '1',
    });
    const flat = (rows || []).map((r) => ({
      sales_order_number: r.sales_order_number,
      outbound_number: r.outbound_number,
      invoice_number: r.invoice_number,
      dn_number: r.dn_number,
      accounting_document_number: r.accounting_document_number,
      customer_po_number: r.customer_po_number,
      customer_po_status: r.customer_po_status,
      invoice_status: r.invoice_status,
      dn_status: r.dn_status,
      pod_status: r.pod_status,
      accounting_status: r.accounting_status,
      workflow_status: r.workflow_status,
      missing_documents: (r.missing_documents || []).join('; '),
      drive_folder_link: r.drive_folder_link,
    }));
    const ws = XLSX.utils.json_to_sheet(flat);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Document Workflow');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="document-workflow.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Order-wise pick status — list for dropdown filters */
router.get('/order-pick-status', requirePermission('can_view_order_pick_status'), async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const rows = await listOrderPickStatus({
      dbAll,
      scope,
      orderType: req.query.order_type,
      status: req.query.status,
      search: req.query.search,
      vendorNumber: req.query.vendor_number,
      dateFrom: req.query.date_from,
      dateTo: req.query.date_to,
    });
    res.json({ orders: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Order-wise pick status — Excel export (register before :ref detail) */
router.get(
  '/order-pick-status/:ref/export-excel',
  requirePermission('can_export_order_pick_status'),
  async (req, res) => {
    try {
      const scope = await readScopeOrError(req, res);
      if (!scope) return;
      const detail = await getOrderPickStatusDetail({
        dbGet,
        dbAll,
        ref: req.params.ref,
        scope,
        orderType: req.query.order_type,
      });
      if (!detail) return res.status(404).json({ error: 'Order not found' });
      const rows = detailToExcelRows(detail);
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, 'Pick Status');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const slug = String(req.params.ref).replace(/[^\w.-]+/g, '_');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="order-pick-status-${slug}.xlsx"`);
      res.send(buf);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

/** Order-wise pick status — full detail for modal */
router.get('/order-pick-status/:ref', requirePermission('can_view_order_pick_status'), async (req, res) => {
  try {
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const detail = await getOrderPickStatusDetail({
      dbGet,
      dbAll,
      ref: req.params.ref,
      scope,
      orderType: req.query.order_type,
    });
    if (!detail) return res.status(404).json({ error: 'Order not found' });
    const role = String(req.user?.role || '').toLowerCase();
    detail.permissions_hint = {
      can_edit:
        role === 'admin' ||
        role === 'checker' ||
        !!(req.user?.permissions?.can_edit_pick_details),
      can_print: !!(req.user?.permissions?.can_print_order_pick_status) || role === 'admin',
      can_export: !!(req.user?.permissions?.can_export_order_pick_status) || role === 'admin',
    };
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
