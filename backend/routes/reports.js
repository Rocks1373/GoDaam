const express = require('express');
const { promisify } = require('util');
const XLSX = require('xlsx');

const db = require('../db');
const { getStockComparison } = require('../services/stockComparisonService');
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

function inboundPutawaySql(req, scope) {
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
  sql += ` ORDER BY b.id DESC, i.part_number`;
  return { sql, params };
}

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
    const scope = await readScopeOrError(req, res);
    if (!scope) return;
    const level = String(req.query.level || 'header').toLowerCase() === 'item' ? 'item' : 'header';
    const { fragments, params } = deliveryWhereClause(req.query);
    const frags = [...fragments];
    const pms = [...params];
    if (scope.mode === 'one' && scope.warehouseId) {
      frags.push('dn.warehouse_id = ?');
      pms.push(scope.warehouseId);
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
        LEFT JOIN outbound_orders o ON TRIM(COALESCE(o.outbound_number,'')) = TRIM(COALESCE(dn.outbound_number,''))
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
      LEFT JOIN outbound_orders o ON TRIM(COALESCE(o.outbound_number,'')) = TRIM(COALESCE(dn.outbound_number,''))
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

module.exports = router;
