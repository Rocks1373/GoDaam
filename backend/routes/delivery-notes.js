const express = require('express');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const db = require('../db');
const { requirePermission, requireAdmin, requireAnyPermission } = require('../middleware/auth');
const { markOutboundDelivered } = require('../services/markOutboundDelivered');
const {
  DS,
  normalizeTransportType,
  normalizePackageType,
  dnIsLocked,
  canConfirmGapp,
  findUserIdByMobile,
  asNumber,
} = require('../services/deliveryWorkflow');
const { notifyWebDeliveryStaff } = require('../services/deliveryNotifications');
const { sendExpoPushToUserIds } = require('../services/notificationService');
const { logAudit } = require('../services/auditLogger');
const { loadOutboundPickFootprint } = require('../services/outboundPickFootprint');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

function trimStr(v) {
  return String(v ?? '').trim();
}

async function warehouseIdForOutboundNumber(outboundNum) {
  const ob = trimStr(outboundNum);
  if (!ob) return null;
  const o = await dbGet(`SELECT warehouse_id FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`, [ob, ob]);
  return o?.warehouse_id != null ? Number(o.warehouse_id) : null;
}

/** Main stock row for DN lines: UOM/description source of truth; match trimmed part or SAP. */
async function lookupMainStockForDnLine(partNumber, sapPartNumber) {
  const pn = trimStr(partNumber);
  const sap = trimStr(sapPartNumber);
  if (!pn && !sap) return null;
  return dbGet(
    `SELECT description, uom, sap_part_number
     FROM main_stock
     WHERE (? != '' AND TRIM(COALESCE(part_number, '')) = TRIM(?))
        OR (? != '' AND TRIM(COALESCE(sap_part_number, '')) = TRIM(?))
     LIMIT 1`,
    [pn, pn, sap, sap]
  );
}

/** Overlay UOM from main_stock so print/API always match current master (stored DN row may be stale). */
async function enrichDnItemsUomFromMainStock(items) {
  const rows = items || [];
  const out = [];
  for (const it of rows) {
    const ms = await lookupMainStockForDnLine(it.part_number, it.sap_part_number);
    const uom = trimStr(ms?.uom) || trimStr(it.uom) || '';
    out.push({ ...it, uom });
  }
  return out;
}

function assertDnEditable(dn, res) {
  if (dnIsLocked(dn)) {
    res.status(400).json({ error: 'Delivery note is closed — no further edits.' });
    return false;
  }
  return true;
}

function resolvePodAbsolute(stored) {
  if (!stored) return null;
  const rel = String(stored).replace(/^\/+/, '');
  if (rel.includes('..')) return null;
  const abs = path.resolve(__dirname, '..', rel);
  const root = path.resolve(__dirname, '..');
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (!rel.startsWith('uploads/')) return null;
  return abs;
}

function rowPrimaryPhone(row) {
  return trimStr(row?.contact_person_number_1 || row?.contact_person_number);
}

async function resolveCustomerForOutbound(order) {
  const soldTo = String(order.sold_to || '').trim();
  let customer = null;
  if (soldTo) {
    customer = await dbGet(`SELECT * FROM customers WHERE TRIM(customer_number) = ? LIMIT 1`, [soldTo]);
  }
  if (!customer && order.customer_name) {
    customer = await dbGet(`SELECT * FROM customers WHERE company_name = ? LIMIT 1`, [order.customer_name]);
  }
  const dnCustomerNumber = (soldTo || customer?.customer_number || '').trim();
  return { customer, dnCustomerNumber, soldTo };
}

async function getOrCreateDnFromOutbound(outbound_number, req) {
  const order = await dbGet(`SELECT * FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`, [
    outbound_number,
    outbound_number,
  ]);
  if (!order) {
    const err = new Error('Outbound not found');
    err.statusCode = 404;
    throw err;
  }

  const items = await dbAll(`SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id ASC`, [order.id]);
  const { customer, dnCustomerNumber } = await resolveCustomerForOutbound(order);
  const dnExisting = await dbGet(`SELECT * FROM delivery_notes WHERE outbound_number = ? LIMIT 1`, [
    order.outbound_number,
  ]);

  if (!dnExisting) {
    await dbRun('BEGIN IMMEDIATE');
    try {
      await dbRun(
        `INSERT INTO delivery_notes (
          dn_number, dn_date, sales_order_number, gapp_po, customer_po, outbound_number, invoice_number,
          customer_id, customer_number, customer_name, delivery_address, gps, contact_person, contact_number,
          package_type, pallet_qty, box_qty, gross_weight_kg, volume_cbm,
          warehouse_id,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Ignore', 0, 0, 0, 0, ?, 'Draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          order.outbound_number,
          order.dn_date || new Date().toISOString().slice(0, 10),
          order.sales_order_number || order.sales_doc || '',
          order.gapp_po || order.sales_doc || '',
          order.customer_po_number || '',
          order.outbound_number,
          order.invoice_number || '',
          customer?.id || null,
          dnCustomerNumber,
          order.customer_name || customer?.company_name || order.name_1 || '',
          customer?.address || order.delivery_address || '',
          customer?.gps || '',
          customer?.contact_person || order.contact_person || '',
          rowPrimaryPhone(customer) || '',
          order.warehouse_id || null,
        ]
      );
      const dnRow = await dbGet(`SELECT * FROM delivery_notes WHERE id = last_insert_rowid()`);
      const dnId = dnRow.id;
      let itemNo = 1;
      for (const it of items) {
        const pn = String(it.part_number || it.material || '').trim();
        const sap = String(it.sap_part_number || '').trim();
        const ms = await lookupMainStockForDnLine(pn, sap);
        const desc = (ms?.description ?? it.description ?? '').toString();
        const uom = (ms?.uom ?? it.uom ?? '').toString();

        await dbRun(
          `INSERT INTO delivery_note_items
            (dn_id, item_no, part_number, sap_part_number, description, qty, uom, serial_no, condition_text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            dnId,
            itemNo++,
            pn,
            sap,
            desc,
            asNumber(it.required_qty),
            uom,
            it.serial_no || '-',
            it.condition || it.condition_text || 'New',
          ]
        );
      }
      await dbRun('COMMIT');
      if (req) {
        logAudit({
          warehouse_id: order.warehouse_id,
          req,
          module_name: 'DELIVERY',
          action_type: 'DN_CREATED',
          reference_type: 'delivery_note',
          reference_id: dnRow.id,
          reference_number: dnRow.dn_number || order.outbound_number,
          status_after: 'Draft',
        });
      }
      return dnRow;
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }
  }

  const mergedCustomerNumber = dnCustomerNumber ? dnCustomerNumber : null;

  // Keep DN header in sync with current outbound header (but do not overwrite transportation/package if already entered).
  await dbRun(
    `UPDATE delivery_notes
     SET dn_date = COALESCE(dn_date, ?),
         sales_order_number = COALESCE(sales_order_number, ?),
         gapp_po = COALESCE(gapp_po, ?),
         customer_po = COALESCE(customer_po, ?),
         invoice_number = COALESCE(NULLIF(invoice_number, ''), ?),
         customer_number = COALESCE(?, customer_number),
         customer_id = COALESCE(?, customer_id),
         customer_name = COALESCE(customer_name, ?),
         delivery_address = COALESCE(delivery_address, ?),
         gps = COALESCE(gps, ?),
         contact_person = COALESCE(contact_person, ?),
         contact_number = COALESCE(contact_number, ?),
         contact_person_2 = COALESCE(contact_person_2, ?),
         contact_number_2 = COALESCE(contact_number_2, ?),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      order.dn_date || new Date().toISOString().slice(0, 10),
      order.sales_order_number || order.sales_doc || '',
      order.gapp_po || order.sales_doc || '',
      order.customer_po_number || '',
      order.invoice_number || '',
      mergedCustomerNumber,
      customer?.id ?? null,
      order.customer_name || customer?.company_name || order.name_1 || '',
      customer?.address || order.delivery_address || '',
      customer?.gps || '',
      customer?.contact_person || order.contact_person || '',
      rowPrimaryPhone(customer) || '',
      customer?.second_name || '',
      customer?.second_number || '',
      dnExisting.id,
    ]
  );
  return await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [dnExisting.id]);
}

/**
 * Resolve vendor name for a given part_number.
 * Lookup priority: main_stock (single row per part) → vendor_items (first match).
 * Returns trimmed vendor_name or null.
 */
async function lookupVendorNameForPart(partNumber) {
  const pn = trimStr(partNumber);
  if (!pn) return null;
  const ms = await dbGet(
    `SELECT vendor_name FROM main_stock
      WHERE TRIM(part_number) = ? AND TRIM(COALESCE(vendor_name, '')) != ''
      LIMIT 1`,
    [pn]
  );
  const fromMain = trimStr(ms?.vendor_name);
  if (fromMain) return fromMain;
  const vi = await dbGet(
    `SELECT vendor_name FROM vendor_items
      WHERE TRIM(part_number) = ? AND TRIM(COALESCE(vendor_name, '')) != ''
      ORDER BY id ASC LIMIT 1`,
    [pn]
  );
  return trimStr(vi?.vendor_name) || null;
}

/** Format a vendor name into the SPO box label ("SCHNEIDER STOCK", "COMMSCOPE STOCK", …). */
function formatSpoLabel(vendorName) {
  const n = trimStr(vendorName);
  if (!n) return '';
  const up = n.toUpperCase();
  return /\bSTOCK\b\s*$/.test(up) ? up : `${up} STOCK`;
}

async function getDnView(id) {
  const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
  if (!dn) return null;
  const rawItems = await dbAll(`SELECT * FROM delivery_note_items WHERE dn_id = ? ORDER BY item_no ASC, id ASC`, [id]);
  const items = await enrichDnItemsUomFromMainStock(rawItems);
  const outboundNum = trimStr(dn.outbound_number);
  let outbound_sold_to = null;
  let outbound_name_1 = null;
  let outbound_customer_reference = null;
  let outbound_sales_doc = null;
  let outbound_header_customer_name = null;
  let outbound_invoice_number = null;
  let pick_footprint = null;
  if (outboundNum) {
    const ord = await dbGet(
      `SELECT id, sold_to, name_1, customer_reference, sales_doc, customer_name, invoice_number
       FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`,
      [outboundNum, outboundNum]
    );
    if (ord) {
      outbound_sold_to = trimStr(ord.sold_to) || null;
      outbound_name_1 = ord.name_1 || null;
      outbound_customer_reference = ord.customer_reference || null;
      outbound_sales_doc = ord.sales_doc || null;
      outbound_header_customer_name = ord.customer_name || null;
      outbound_invoice_number = trimStr(ord.invoice_number) || null;
      if (ord.id) {
        pick_footprint = await loadOutboundPickFootprint({ dbGet, dbAll, orderId: ord.id });
      }
    }
  }

  // SPO label is derived from the vendor of the FIRST item.
  // DN items are authoritative; fall back to outbound_items when DN has none yet.
  let firstPart = null;
  for (const it of items) {
    const p = trimStr(it.part_number);
    if (p) {
      firstPart = p;
      break;
    }
  }
  if (!firstPart && outboundNum) {
    const oi = await dbGet(
      `SELECT oi.part_number FROM outbound_items oi
         JOIN outbound_orders o ON o.id = oi.outbound_id
        WHERE (o.outbound_number = ? OR o.delivery = ?)
          AND TRIM(COALESCE(oi.part_number, '')) != ''
        ORDER BY oi.id ASC LIMIT 1`,
      [outboundNum, outboundNum]
    );
    firstPart = trimStr(oi?.part_number) || null;
  }
  const spoVendorName = firstPart ? await lookupVendorNameForPart(firstPart) : null;
  const spo = formatSpoLabel(spoVendorName) || null;

  return {
    ...dn,
    outbound_sold_to,
    outbound_name_1,
    outbound_customer_reference,
    outbound_sales_doc,
    outbound_header_customer_name,
    outbound_invoice_number,
    items,
    spo,
    spo_vendor_name: spoVendorName || null,
    spo_source_part_number: firstPart || null,
    pick_footprint,
  };
}

// GET /api/delivery-notes?status=
router.get('/', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    let rows = await dbAll(`SELECT * FROM delivery_notes ORDER BY id DESC LIMIT ?`, [limit]);
    if (status) rows = rows.filter((r) => String(r.status || '').toLowerCase() === status.toLowerCase());
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/delivery-notes/outbound-options
// Dropdown source: picked orders (preferred) + on-hold DNs.
router.get('/outbound-options', async (_req, res) => {
  try {
    /** Same eligibility as mobile "picked" list: confirmed row and/or outbound Picked/Checked, never delivered/closed DN. */
    const outboundEligible = `
      LOWER(TRIM(COALESCE(o.status, ''))) NOT IN ('delivered')
      AND NOT EXISTS (SELECT 1 FROM delivered_outbounds d WHERE d.outbound_id = o.id)
      AND NOT EXISTS (
        SELECT 1 FROM delivery_notes dn
        WHERE TRIM(COALESCE(dn.outbound_number, '')) IN (
          TRIM(COALESCE(o.outbound_number, '')),
          NULLIF(TRIM(COALESCE(o.delivery, '')), '')
        )
          AND (
            LOWER(TRIM(COALESCE(dn.status, ''))) = 'delivered'
            OR COALESCE(dn.is_closed, 0) = 1
          )
      )
    `;
    const picked = await dbAll(
      `SELECT
         COALESCE(NULLIF(TRIM(po.delivery), ''), TRIM(o.outbound_number)) AS outbound_number,
         o.status AS status,
         o.customer_name AS customer_name,
         o.customer_reference AS customer_reference,
         o.sold_to AS sold_to,
         NULLIF(TRIM(COALESCE(
           NULLIF(TRIM(COALESCE(o.sales_doc, '')), ''),
           NULLIF(TRIM(COALESCE(o.sales_order_number, '')), ''),
           NULLIF(TRIM(COALESCE(o.gapp_po, '')), '')
         )), '') AS sales_doc
       FROM picked_orders po
       INNER JOIN outbound_orders o ON o.id = po.outbound_order_id
       WHERE ${outboundEligible}
       ORDER BY po.confirmed_at DESC
       LIMIT 800`
    );
    const pickedWithoutRow = await dbAll(
      `SELECT
         COALESCE(NULLIF(TRIM(o.delivery), ''), TRIM(o.outbound_number)) AS outbound_number,
         o.status AS status,
         o.customer_name AS customer_name,
         o.customer_reference AS customer_reference,
         COALESCE(o.sold_to, o.vendor_name, '') AS sold_to,
         NULLIF(TRIM(COALESCE(
           NULLIF(TRIM(COALESCE(o.sales_doc, '')), ''),
           NULLIF(TRIM(COALESCE(o.sales_order_number, '')), ''),
           NULLIF(TRIM(COALESCE(o.gapp_po, '')), '')
         )), '') AS sales_doc
       FROM outbound_orders o
       WHERE LOWER(TRIM(COALESCE(o.status, ''))) IN ('picked', 'checked')
         AND NOT EXISTS (SELECT 1 FROM picked_orders po2 WHERE po2.outbound_order_id = o.id)
         AND ${outboundEligible}
       ORDER BY o.updated_at DESC
       LIMIT 400`
    );
    const holds = await dbAll(
      `SELECT outbound_number, status, customer_name, '' AS customer_reference, customer_number AS sold_to,
         NULLIF(TRIM(COALESCE(
           NULLIF(TRIM(COALESCE(gapp_po, '')), ''),
           NULLIF(TRIM(COALESCE(sales_order_number, '')), '')
         )), '') AS sales_doc
       FROM delivery_notes
       WHERE lower(status) = 'on hold'
       ORDER BY updated_at DESC
       LIMIT 400`
    );
    const map = new Map();
    for (const r of [...picked, ...pickedWithoutRow, ...holds]) {
      const key = String(r.outbound_number || '').trim();
      if (!key) continue;
      if (!map.has(key)) map.set(key, r);
    }
    res.json([...map.values()]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery-notes  { outbound_number }
router.post('/', async (req, res) => {
  try {
    const outbound_number = String(req.body?.outbound_number || '').trim();
    if (!outbound_number) return res.status(400).json({ error: 'outbound_number is required' });
    const dn = await getOrCreateDnFromOutbound(outbound_number, req);
    const { fireAndForgetEnsureFromDeliveryNote } = require('../services/salesOrderDocumentsService');
    void fireAndForgetEnsureFromDeliveryNote(dn);
    res.status(201).json(dn);
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ error: e.message });
  }
});

// GET /api/delivery-notes/:id/delivery-to — outbound header + address book rows for Sold-to
router.get('/:id/delivery-to', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });
    const outboundNum = trimStr(dn.outbound_number);
    const order = outboundNum
      ? await dbGet(
          `SELECT sold_to, name_1, customer_reference, sales_doc, outbound_number, customer_name
           FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`,
          [outboundNum, outboundNum]
        )
      : null;
    const soldTo = trimStr(order?.sold_to);
    let addresses = [];
    const cities = [];
    const citySet = new Set();
    if (soldTo) {
      addresses = await dbAll(`SELECT * FROM customers WHERE TRIM(customer_number) = ? ORDER BY id ASC`, [soldTo]);
      for (const a of addresses) {
        const c = trimStr(a.city_name);
        if (c) citySet.add(c);
      }
      cities.push(...[...citySet].sort((a, b) => a.localeCompare(b)));
    }
    res.json({
      outbound: {
        sold_to: soldTo || null,
        name_1: order?.name_1 || '',
        outbound_number: outboundNum || dn.outbound_number,
        sales_doc: order?.sales_doc || '',
        customer_reference: order?.customer_reference || '',
        customer_name: order?.customer_name || '',
      },
      cities,
      addresses,
      dn_snapshot: {
        customer_number: dn.customer_number,
        customer_name: dn.customer_name,
        city_name: dn.city_name,
        delivery_address: dn.delivery_address,
        gps: dn.gps,
        contact_person: dn.contact_person,
        contact_number: dn.contact_number,
        email_1: dn.email_1,
        contact_person_2: dn.contact_person_2,
        contact_number_2: dn.contact_number_2,
        second_email: dn.second_email,
        deliver_to_remarks: dn.deliver_to_remarks,
        address_type: dn.address_type,
        address_source: dn.address_source,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function postDeliveryTo(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });
    if (String(dn.status || '').toLowerCase() === 'delivered') return res.status(400).json({ error: 'DN already delivered' });
    if (!assertDnEditable(dn, res)) return;

    const outboundNum = trimStr(dn.outbound_number);
    const order = outboundNum
      ? await dbGet(
          `SELECT sold_to, name_1, customer_reference, sales_doc FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`,
          [outboundNum, outboundNum]
        )
      : null;
    const soldTo = trimStr(order?.sold_to);

    const body = req.body || {};
    const source = trimStr(body.address_source).toLowerCase();

    if (source === 'address_book' && body.customer_id != null) {
      const cid = Number(body.customer_id);
      if (!Number.isFinite(cid)) return res.status(400).json({ error: 'customer_id is required' });
      const row = await dbGet(`SELECT * FROM customers WHERE id = ?`, [cid]);
      if (!row) return res.status(404).json({ error: 'Customer address row not found' });
      if (trimStr(row.customer_number) !== soldTo) {
        return res.status(400).json({ error: 'Selected address does not match outbound Sold-to' });
      }
      const addrType = trimStr(body.address_type) || trimStr(row.address_type) || 'permanent';
      await dbRun(
        `UPDATE delivery_notes SET
          customer_id = ?,
          customer_number = ?,
          customer_name = ?,
          city_name = ?,
          delivery_address = ?,
          gps = ?,
          contact_person = ?,
          contact_number = ?,
          email_1 = ?,
          contact_person_2 = ?,
          contact_number_2 = ?,
          second_email = ?,
          deliver_to_remarks = ?,
          address_type = ?,
          address_source = ?,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          row.id,
          trimStr(row.customer_number),
          trimStr(row.company_name),
          trimStr(row.city_name) || null,
          trimStr(row.address),
          trimStr(row.gps) || null,
          trimStr(row.contact_person) || null,
          rowPrimaryPhone(row) || null,
          trimStr(row.email_1) || null,
          trimStr(row.second_name) || null,
          trimStr(row.second_number) || null,
          trimStr(row.second_email) || null,
          trimStr(row.remarks) || null,
          addrType,
          'address_book',
          id,
        ]
      );
      {
        const wh = await warehouseIdForOutboundNumber(outboundNum);
        logAudit({
          warehouse_id: wh,
          req,
          module_name: 'DELIVERY',
          action_type: 'UPDATED',
          reference_type: 'delivery_note',
          reference_id: id,
          reference_number: outboundNum || null,
          remarks: 'delivery_to_applied',
          new_value: { address_source: 'address_book' },
        });
        return res.json(await getDnView(id));
      }
    }

    if (source === 'temporary_manual') {
      const cn = trimStr(body.customer_number);
      const effectiveCn = cn || soldTo;
      if (soldTo && cn && cn !== soldTo) {
        return res.status(400).json({ error: 'customer_number must match outbound Sold-to' });
      }
      const delivery_address = trimStr(body.delivery_address);

      await dbRun(
        `UPDATE delivery_notes SET
          customer_number = COALESCE(NULLIF(?, ''), customer_number),
          customer_name = COALESCE(NULLIF(?, ''), customer_name),
          city_name = ?,
          delivery_address = ?,
          gps = ?,
          contact_person = ?,
          contact_number = ?,
          email_1 = ?,
          contact_person_2 = ?,
          contact_number_2 = ?,
          second_email = ?,
          deliver_to_remarks = ?,
          address_type = ?,
          address_source = ?,
          customer_id = NULL,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          effectiveCn || null,
          trimStr(body.customer_name) || null,
          trimStr(body.city_name) || null,
          delivery_address || null,
          trimStr(body.gps) || null,
          trimStr(body.contact_person) || null,
          trimStr(body.contact_number) || null,
          trimStr(body.email_1) || null,
          trimStr(body.second_name) || null,
          trimStr(body.second_number) || null,
          trimStr(body.second_email) || null,
          trimStr(body.deliver_to_remarks ?? body.remarks) || null,
          trimStr(body.address_type) || 'temporary',
          'temporary_manual',
          id,
        ]
      );
      {
        const wh = await warehouseIdForOutboundNumber(outboundNum);
        logAudit({
          warehouse_id: wh,
          req,
          module_name: 'DELIVERY',
          action_type: 'UPDATED',
          reference_type: 'delivery_note',
          reference_id: id,
          reference_number: outboundNum || null,
          remarks: 'delivery_to_applied',
          new_value: { address_source: 'temporary_manual' },
        });
        return res.json(await getDnView(id));
      }
    }

    return res.status(400).json({ error: 'address_source must be address_book or temporary_manual' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/delivery-notes/:id/timeline
router.get('/:id/timeline', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });

    let confirmed_by_name = null;
    let closed_by_name = null;
    if (dn.confirmed_by) {
      const u = await dbGet(`SELECT full_name FROM users WHERE id = ?`, [dn.confirmed_by]);
      confirmed_by_name = trimStr(u?.full_name) || null;
    }
    if (dn.closed_by) {
      const u = await dbGet(`SELECT full_name FROM users WHERE id = ?`, [dn.closed_by]);
      closed_by_name = trimStr(u?.full_name) || null;
    }

    let task = null;
    if (dn.driver_task_id) {
      task = await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [dn.driver_task_id]);
    }

    res.json({
      delivery_status: dn.delivery_status || DS.DRAFT,
      confirmed_at: dn.confirmed_at || null,
      confirmed_by: dn.confirmed_by || null,
      confirmed_by_name,
      driver_opened_at: dn.driver_opened_at || task?.opened_at || null,
      pickup_confirmed_at: dn.pickup_confirmed_at || task?.pickup_confirmed_at || null,
      out_for_delivery_at: dn.out_for_delivery_at || task?.out_for_delivery_at || null,
      pod_uploaded_at: dn.pod_uploaded_at || task?.pod_uploaded_at || null,
      pod_file_path: dn.pod_file_path || task?.pod_file_path || null,
      closed_at: dn.closed_at || task?.closed_at || null,
      closed_by: dn.closed_by || null,
      closed_by_name,
      is_closed: Number(dn.is_closed) === 1,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/delivery-notes/:id/pod — download POD (image/PDF) if present
router.get(
  '/:id/pod',
  requireAnyPermission(['can_upload_outbound', 'can_confirm_picked']),
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
      const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
      if (!dn) return res.status(404).json({ error: 'DN not found' });
      const rel = trimStr(dn.pod_file_path);
      if (!rel) return res.status(404).json({ error: 'No POD on file' });
      const abs = resolvePodAbsolute(rel);
      if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: 'POD file not found' });
      const ext = path.extname(abs).toLowerCase();
      const types = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.heic': 'image/heic',
      };
      if (types[ext]) res.setHeader('Content-Type', types[ext]);
      return res.sendFile(abs);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// POST /api/delivery-notes/:id/confirm — GAPP only; creates driver task + notifications
router.post('/:id/confirm', requireAnyPermission(['can_upload_outbound', 'can_confirm_picked']), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });
    if (String(dn.status || '').toLowerCase() === 'delivered') {
      return res.status(400).json({ error: 'DN already delivered' });
    }
    if (dnIsLocked(dn)) return res.status(400).json({ error: 'Delivery note is closed — no further edits.' });
    if (normalizeTransportType(dn.transportation_type) !== 'GAPP') {
      return res.status(400).json({ error: 'Confirm is only for GAPP transportation.' });
    }

    const outboundNum = trimStr(dn.outbound_number);
    let outboundInvoice = '';
    if (outboundNum) {
      const ordInv = await dbGet(
        `SELECT invoice_number FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`,
        [outboundNum, outboundNum]
      );
      outboundInvoice = trimStr(ordInv?.invoice_number);
    }
    const dnForConfirm = {
      ...dn,
      invoice_number: trimStr(dn.invoice_number) || outboundInvoice || dn.invoice_number,
    };
    if (!canConfirmGapp(dnForConfirm)) {
      return res.status(400).json({
        error: 'Complete Delivery To, package info, and GAPP driver details before confirming.',
      });
    }

    const uid = Number(req.user.sub);
    const already =
      String(dn.delivery_status || '').toLowerCase() === 'confirmed' && dn.driver_task_id;
    if (already) {
      return res.json(await getDnView(id));
    }

    const driverUserId = await findUserIdByMobile(db, dn.driver_mobile);
    const gpsLink = trimStr(dn.gps) || '';
    const customerName = trimStr(dn.customer_name);
    const address = trimStr(dn.delivery_address);
    const driverName = trimStr(dn.driver_name);
    const dnNumber = trimStr(dn.dn_number) || outboundNum;
    const rawPushItems = await dbAll(
      `SELECT part_number, sap_part_number, qty, uom
       FROM delivery_note_items
       WHERE dn_id = ?
       ORDER BY item_no ASC, id ASC
       LIMIT 8`,
      [id]
    );
    const items = await enrichDnItemsUomFromMainStock(rawPushItems);
    const details =
      (items || [])
        .map((it) => {
          const pn = trimStr(it?.part_number);
          const q = Number(it?.qty) || 0;
          const u = trimStr(it?.uom);
          return pn ? `${pn} x${q}${u ? ` ${u}` : ''}` : '';
        })
        .filter(Boolean)
        .join('\n') || '';

    await dbRun('BEGIN IMMEDIATE');
    try {
      await dbRun(
        `INSERT INTO driver_delivery_tasks (
          dn_id, outbound_number, invoice_number, customer_name, delivery_address, city_name, gps_link,
          contact_person, contact_number, driver_user_id, driver_name, driver_mobile, status,
          confirmed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          id,
          outboundNum,
          trimStr(dnForConfirm.invoice_number),
          customerName,
          address,
          trimStr(dn.city_name),
          gpsLink || null,
          trimStr(dn.contact_person),
          trimStr(dn.contact_number),
          driverUserId,
          driverName,
          trimStr(dn.driver_mobile),
          DS.CONFIRMED,
        ]
      );
      const taskRow = await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = last_insert_rowid()`);
      await dbRun(
        `UPDATE delivery_notes SET
          delivery_status = ?,
          confirmed_at = CURRENT_TIMESTAMP,
          confirmed_by = ?,
          driver_task_id = ?,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [DS.CONFIRMED, Number.isFinite(uid) ? uid : null, taskRow.id, id]
      );
      await dbRun('COMMIT');

      const wh = await warehouseIdForOutboundNumber(outboundNum);
      logAudit({
        warehouse_id: wh,
        req,
        module_name: 'DELIVERY',
        action_type: 'DELIVERY_CONFIRMED',
        reference_type: 'delivery_note',
        reference_id: id,
        reference_number: dnNumber || outboundNum,
        status_before: dn.delivery_status,
        status_after: DS.CONFIRMED,
        new_value: { driver_task_id: taskRow.id },
      });

      const mapsHint = gpsLink ? `\nMaps: ${gpsLink}` : '';
      const detailsHint = details ? `\n\nDetails:\n${details}` : '';
      const bodyDriver = `DN: ${dnNumber}\nOutbound: ${outboundNum}\nCustomer/Site: ${customerName}\nAddress: ${address}\nAssigned Driver: ${driverName}${mapsHint}${detailsHint}`;

      try {
        if (driverUserId) {
          await sendExpoPushToUserIds(
            [driverUserId],
            'Order Confirmed for Delivery',
            bodyDriver,
            {
              type: 'delivery_confirmed',
              channel: 'delivery',
              dn_id: id,
              task_id: taskRow.id,
              outbound_number: outboundNum,
              dn_number: dnNumber,
              customer_name: customerName,
              delivery_address: address,
              driver_user_id: driverUserId,
              driver_name: driverName,
              open_action: 'delivery_open',
            }
          );
        }

        const city = trimStr(dn.city_name);
        const webTitle = `Outbound ${outboundNum} confirmed for delivery`;
        const webBody =
          city && customerName
            ? `${webTitle} – ${customerName.split(/\s+/).slice(0, 2).join(' ')} ${city}`
            : webTitle;
        await notifyWebDeliveryStaff(webTitle, webBody, { dn_id: id, outbound_number: outboundNum });
      } catch (notifyErr) {
        console.error('delivery-notes confirm: notifications failed after commit', notifyErr?.message || notifyErr);
      }

      return res.json(await getDnView(id));
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery-notes/:id/close-admin — admin final lock (POD or override)
router.post('/:id/close-admin', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });
    if (Number(dn.is_closed)) return res.status(400).json({ error: 'Already closed.' });

    const hasPod = Boolean(trimStr(dn.pod_file_path));
    const override = req.body?.admin_override === true || req.body?.admin_override === 'true';
    if (!hasPod && !override) {
      return res.status(400).json({ error: 'Upload POD or use admin override to close without POD.' });
    }

    const uid = Number(req.user.sub);
    await dbRun('BEGIN IMMEDIATE');
    try {
      await dbRun(
        `UPDATE delivery_notes SET
          delivery_status = ?,
          is_closed = 1,
          closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
          closed_by = ?,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [DS.CLOSED, Number.isFinite(uid) ? uid : null, id]
      );
      if (dn.driver_task_id) {
        await dbRun(
          `UPDATE driver_delivery_tasks SET
            status = ?,
            closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [DS.CLOSED, dn.driver_task_id]
        );
      }
      await dbRun('COMMIT');
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }

    const ob = trimStr(dn.outbound_number);
    const wh = await warehouseIdForOutboundNumber(ob);
    logAudit({
      warehouse_id: wh,
      req,
      module_name: 'DELIVERY',
      action_type: 'ORDER_CLOSED',
      reference_type: 'delivery_note',
      reference_id: id,
      reference_number: ob || trimStr(dn.dn_number),
      status_before: dn.delivery_status,
      status_after: DS.CLOSED,
      remarks: hasPod ? 'admin_close' : 'admin_override_no_pod',
      new_value: { admin_override: !hasPod && override, pod_file: hasPod ? trimStr(dn.pod_file_path).split('/').pop() : null },
    });
    await notifyWebDeliveryStaff(
      `Outbound ${ob} delivered and CLOSED`,
      `Admin closed order ${ob}${hasPod ? '' : ' (override, no POD)'}.`,
      { dn_id: id, outbound_number: ob, channel: 'delivery_admin_close' }
    );

    res.json(await getDnView(id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** List delivery notes that have a driver POD file (newest first). */
router.get('/recent-pods', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const rows = await dbAll(
      `SELECT id, outbound_number, customer_name, invoice_number, pod_uploaded_at, pod_file_path, delivery_status, status
       FROM delivery_notes
       WHERE TRIM(COALESCE(pod_file_path, '')) != ''
       ORDER BY datetime(COALESCE(pod_uploaded_at, updated_at)) DESC
       LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/delivery-notes/:id
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const view = await getDnView(id);
    if (!view) return res.status(404).json({ error: 'DN not found' });
    res.json(view);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery-notes/:id/hold  { is_hold: true|false }
router.post('/:id/hold', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });
    if (String(dn.status || '').toLowerCase() === 'delivered') return res.status(400).json({ error: 'DN already delivered' });
    if (!assertDnEditable(dn, res)) return;

    const is_hold = req.body?.is_hold ? true : false;
    const nextStatus = is_hold ? 'On Hold' : 'Draft';
    await dbRun(`UPDATE delivery_notes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [nextStatus, id]);
    res.json(await getDnView(id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery-notes/:id/delivery-to — apply Address Book row or temporary_manual snapshot
router.post('/:id/delivery-to', postDeliveryTo);
// Legacy alias
router.post('/:id/deliver-to', postDeliveryTo);

// POST /api/delivery-notes/:id/transportation
router.post('/:id/transportation', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });
    if (String(dn.status || '').toLowerCase() === 'delivered') return res.status(400).json({ error: 'DN already delivered' });
    if (!assertDnEditable(dn, res)) return;

    const transportation_type = normalizeTransportType(req.body?.transportation_type || req.body?.type);
    if (!transportation_type) return res.status(400).json({ error: 'transportation_type is required' });

    // GAPP
    const carrier_id = req.body?.carrier_id != null ? Number(req.body.carrier_id) : null;
    const driver_id = req.body?.driver_id != null ? Number(req.body.driver_id) : null;
    const driver_name = String(req.body?.driver_name || '').trim();
    const driver_mobile = String(req.body?.driver_mobile || '').trim();
    const vehicle = String(req.body?.vehicle || '').trim();

    // Rental
    const truck_type = String(req.body?.truck_type || '').trim();
    const truck_qty = asNumber(req.body?.truck_qty);

    // Courier
    const waybill_number = String(req.body?.waybill_number || '').trim();

    // Self collection
    const collector_name = String(req.body?.collector_name || '').trim();
    const collector_mobile = String(req.body?.collector_mobile || '').trim();

    const transportation_remarks = String(req.body?.transportation_remarks || req.body?.remarks || '').trim();

    const carrier_name = String(req.body?.carrier_name || '').trim();

    // Validate required fields
    if (transportation_type === 'GAPP') {
      if (!driver_id && !driver_name) return res.status(400).json({ error: 'Driver is required' });
      if (!driver_mobile) return res.status(400).json({ error: 'Driver phone is required' });
      if (!vehicle) return res.status(400).json({ error: 'Vehicle is required' });
    }
    if (transportation_type === 'Rental') {
      if (!carrier_name && !carrier_id) return res.status(400).json({ error: 'Rental carrier is required' });
      if (!truck_type) return res.status(400).json({ error: 'Truck Type is required' });
      if (!(truck_qty > 0)) return res.status(400).json({ error: 'Truck Quantity is required' });
    }
    if (transportation_type === 'Courier') {
      if (!carrier_name && !carrier_id) return res.status(400).json({ error: 'Courier company is required' });
      if (!waybill_number) return res.status(400).json({ error: 'Waybill number is required' });
    }

    await dbRun(
      `UPDATE delivery_notes SET
         transportation_type = ?,
         carrier_id = ?,
         carrier_name = ?,
         driver_id = ?,
         driver_name = ?,
         driver_mobile = ?,
         vehicle = ?,
         truck_type = ?,
         truck_qty = ?,
         waybill_number = ?,
         collector_name = ?,
         collector_mobile = ?,
         transportation_remarks = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        transportation_type,
        Number.isFinite(carrier_id) ? carrier_id : null,
        carrier_name || null,
        Number.isFinite(driver_id) ? driver_id : null,
        driver_name || null,
        driver_mobile || null,
        vehicle || null,
        truck_type || null,
        truck_qty || 0,
        waybill_number || null,
        collector_name || null,
        collector_mobile || null,
        transportation_remarks || null,
        id,
      ]
    );

    const whTr = await warehouseIdForOutboundNumber(trimStr(dn.outbound_number));
    logAudit({
      warehouse_id: whTr,
      req,
      module_name: 'DELIVERY',
      action_type: 'UPDATED',
      reference_type: 'delivery_note',
      reference_id: id,
      reference_number: trimStr(dn.outbound_number) || trimStr(dn.dn_number),
      remarks: 'transportation_saved',
      new_value: { transportation_type },
    });

    res.json(await getDnView(id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery-notes/:id/package-info
router.post('/:id/package-info', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });
    if (String(dn.status || '').toLowerCase() === 'delivered') return res.status(400).json({ error: 'DN already delivered' });
    if (!assertDnEditable(dn, res)) return;

    let invoice_number = req.body?.invoice_number === undefined ? dn.invoice_number : String(req.body.invoice_number || '').trim();
    const package_type = normalizePackageType(req.body?.package_type);
    const package_qty = asNumber(req.body?.package_qty);
    const gross_weight_kg = req.body?.gross_weight_kg === undefined ? dn.gross_weight_kg : asNumber(req.body.gross_weight_kg);
    const volume_cbm = req.body?.volume_cbm === undefined ? dn.volume_cbm : asNumber(req.body.volume_cbm);

    if (!String(invoice_number || '').trim()) {
      const ob = trimStr(dn.outbound_number);
      if (ob) {
        const ordRow = await dbGet(
          `SELECT invoice_number FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`,
          [ob, ob]
        );
        invoice_number = trimStr(ordRow?.invoice_number);
      }
    }
    if (!String(invoice_number || '').trim()) return res.status(400).json({ error: 'Invoice Number is required' });
    if (!package_type) return res.status(400).json({ error: 'Package Type is required' });
    if ((package_type === 'Pallet' || package_type === 'Box') && !(package_qty > 0)) {
      return res.status(400).json({ error: 'Package Quantity is required' });
    }

    const pallet_qty = package_type === 'Pallet' ? package_qty : 0;
    const box_qty = package_type === 'Box' ? package_qty : 0;

    await dbRun(
      `UPDATE delivery_notes SET
         invoice_number = ?,
         package_type = ?,
         pallet_qty = ?,
         box_qty = ?,
         gross_weight_kg = ?,
         volume_cbm = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [invoice_number, package_type, pallet_qty, box_qty, gross_weight_kg, volume_cbm, id]
    );
    const whPkg = await warehouseIdForOutboundNumber(trimStr(dn.outbound_number));
    logAudit({
      warehouse_id: whPkg,
      req,
      module_name: 'DELIVERY',
      action_type: 'UPDATED',
      reference_type: 'delivery_note',
      reference_id: id,
      reference_number: trimStr(dn.outbound_number) || trimStr(dn.dn_number),
      remarks: 'package_info_saved',
      new_value: { package_type, invoice_number: trimStr(invoice_number) || null },
    });
    res.json(await getDnView(id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery-notes/:id/contact-person-2 — secondary contact on DN only (clear with empty strings)
router.post('/:id/contact-person-2', requirePermission('can_upload_outbound'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });
    if (String(dn.status || '').toLowerCase() === 'delivered') return res.status(400).json({ error: 'DN already delivered' });
    if (!assertDnEditable(dn, res)) return;

    const cp2 = trimStr(req.body?.contact_person_2 ?? '');
    const cn2 = trimStr(req.body?.contact_number_2 ?? '');
    await dbRun(
      `UPDATE delivery_notes SET contact_person_2 = ?, contact_number_2 = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [cp2 || null, cn2 || null, id]
    );
    res.json(await getDnView(id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery-notes/:id/mark-delivered
router.post(
  '/:id/mark-delivered',
  requireAnyPermission(['can_upload_outbound', 'can_confirm_picked']),
  async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });
    if (String(dn.status || '').toLowerCase() === 'delivered') return res.status(400).json({ error: 'This DN is already delivered.' });

    const trans = normalizeTransportType(dn.transportation_type);
    if (trans === 'GAPP') {
      if (!dn.confirmed_at) {
        return res.status(400).json({ error: 'GAPP: confirm for delivery is required before marking delivered.' });
      }
      if (!Number(dn.is_closed)) {
        return res
          .status(400)
          .json({ error: 'GAPP: driver must close the delivery (POD) before marking delivered — or use admin close.' });
      }
    }

    // Validate transportation
    if (!String(dn.transportation_type || '').trim()) return res.status(400).json({ error: 'Transportation Method must be saved before Delivered.' });
    if (trans === 'GAPP') {
      if (!String(dn.driver_name || '').trim() && !dn.driver_id) return res.status(400).json({ error: 'Driver is required' });
      if (!String(dn.driver_mobile || '').trim()) return res.status(400).json({ error: 'Driver phone is required' });
      if (!String(dn.vehicle || '').trim()) return res.status(400).json({ error: 'Vehicle is required' });
    }
    if (trans === 'Rental') {
      if (!String(dn.carrier_name || '').trim() && !dn.carrier_id) return res.status(400).json({ error: 'Rental carrier is required' });
      if (!String(dn.truck_type || '').trim()) return res.status(400).json({ error: 'Truck Type is required' });
      if (!(asNumber(dn.truck_qty) > 0)) return res.status(400).json({ error: 'Truck Quantity is required' });
    }
    if (trans === 'Courier') {
      if (!String(dn.carrier_name || '').trim() && !dn.carrier_id) return res.status(400).json({ error: 'Courier company is required' });
      if (!String(dn.waybill_number || '').trim()) return res.status(400).json({ error: 'Waybill number is required' });
    }

    const outboundNum = trimStr(dn.outbound_number);
    const order = outboundNum
      ? await dbGet(`SELECT * FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`, [outboundNum, outboundNum])
      : null;
    if (!order?.id) return res.status(400).json({ error: 'Outbound not found for this DN' });

    /** Single resolved invoice — must exist on both DN + outbound before stock deduction (markOutboundDelivered reads outbound row). */
    const resolvedInvoice = trimStr(dn.invoice_number) || trimStr(order.invoice_number);
    if (!resolvedInvoice) return res.status(400).json({ error: 'Invoice Number is required' });

    await dbRun(`UPDATE outbound_orders SET invoice_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      resolvedInvoice,
      order.id,
    ]);
    await dbRun(`UPDATE delivery_notes SET invoice_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      resolvedInvoice,
      id,
    ]);
    dn.invoice_number = resolvedInvoice;

    const pkg = normalizePackageType(dn.package_type);
    if (!pkg) return res.status(400).json({ error: 'Package Type is required' });
    if ((pkg === 'Pallet' || pkg === 'Box') && !(asNumber(pkg === 'Pallet' ? dn.pallet_qty : dn.box_qty) > 0)) {
      return res.status(400).json({ error: 'Package Quantity is required' });
    }

    // Deduct main stock only at Delivered status (reuse existing outbound delivered logic, which guards double deduction).
    let outboundStockAlreadyFinalized = false;
    try {
      await markOutboundDelivered(db, Number(order.id), { requireInvoice: true });
    } catch (e) {
      const dup =
        Number(e.statusCode) === 409 && String(e.message || '').includes('Already delivered (double deduction prevented)');
      if (!dup) throw e;
      outboundStockAlreadyFinalized = true;
      // Outbound was already marked delivered from another screen (e.g. Outbound upload). Finish the DN without re-deducting.
    }

    const dnLatest = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dnLatest) return res.status(404).json({ error: 'DN not found' });

    // Persist delivered table snapshot (one row per item, with header fields duplicated).
    const dnItems = await dbAll(`SELECT * FROM delivery_note_items WHERE dn_id = ? ORDER BY item_no ASC`, [id]);
    const delivered_date = new Date().toISOString().slice(0, 10);

    await dbRun('BEGIN IMMEDIATE');
    try {
      for (const it of dnItems) {
        const ms = await lookupMainStockForDnLine(it.part_number, it.sap_part_number);
        const uomDelivered = trimStr(ms?.uom) || trimStr(it.uom) || '';
        await dbRun(
          `INSERT INTO delivered (
            dn_id, dn_number, delivered_date, sales_order_number, gapp_po, customer_po, outbound_number, invoice_number,
            customer_number, customer_name, delivery_address, gps, contact_person, contact_number,
            city_name, contact_person_2, contact_number_2, email_1, second_email,
            transportation_type, carrier_name, driver_name, driver_mobile, vehicle, truck_type, truck_qty, waybill_number,
            package_type, pallet_qty, box_qty, gross_weight_kg, volume_cbm, deliver_to_remarks,
            address_type, address_source,
            part_number, sap_part_number, description, delivered_qty, uom, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            id,
            dnLatest.dn_number || dnLatest.outbound_number || '',
            delivered_date,
            dnLatest.sales_order_number || '',
            dnLatest.gapp_po || '',
            dnLatest.customer_po || '',
            dnLatest.outbound_number || '',
            trimStr(dnLatest.invoice_number) || resolvedInvoice || '',
            dnLatest.customer_number || '',
            dnLatest.customer_name || '',
            dnLatest.delivery_address || '',
            dnLatest.gps || '',
            dnLatest.contact_person || '',
            dnLatest.contact_number || '',
            dnLatest.city_name || '',
            dnLatest.contact_person_2 || '',
            dnLatest.contact_number_2 || '',
            dnLatest.email_1 || '',
            dnLatest.second_email || '',
            dnLatest.transportation_type || '',
            dnLatest.carrier_name || '',
            dnLatest.driver_name || '',
            dnLatest.driver_mobile || '',
            dnLatest.vehicle || '',
            dnLatest.truck_type || '',
            asNumber(dnLatest.truck_qty) || 0,
            dnLatest.waybill_number || '',
            dnLatest.package_type || '',
            asNumber(dnLatest.pallet_qty) || 0,
            asNumber(dnLatest.box_qty) || 0,
            asNumber(dnLatest.gross_weight_kg) || 0,
            asNumber(dnLatest.volume_cbm) || 0,
            dnLatest.deliver_to_remarks || '',
            dnLatest.address_type || '',
            dnLatest.address_source || '',
            it.part_number || '',
            it.sap_part_number || '',
            it.description || '',
            asNumber(it.qty) || 0,
            uomDelivered,
          ]
        );
      }
      await dbRun(
        `UPDATE delivery_notes SET
            status = 'Delivered',
            delivery_status = 'Delivered',
            is_closed = 1,
            closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
            delivered_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [id]
      );
      await dbRun('COMMIT');
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }

    const whMd = await warehouseIdForOutboundNumber(outboundNum);
    logAudit({
      warehouse_id: whMd,
      req,
      module_name: 'DELIVERY',
      action_type: 'MARK_DELIVERED',
      reference_type: 'delivery_note',
      reference_id: id,
      reference_number: dnLatest?.dn_number || outboundNum,
      status_before: dn.status,
      status_after: 'Delivered',
      new_value: { outbound_stock_already_finalized: outboundStockAlreadyFinalized },
    });

    res.json({
      ok: true,
      dn_id: id,
      status: 'Delivered',
      outbound_stock_already_finalized: outboundStockAlreadyFinalized,
    });
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({
      error: e.message,
      shortages: e.shortages,
      code: e.code,
      part_number: e.part_number,
    });
  }
});

// GET /api/delivery-notes/:id/print
router.get('/:id/print', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const view = await getDnView(id);
    if (!view) return res.status(404).json({ error: 'DN not found' });
    res.json(view);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

