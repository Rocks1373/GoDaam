const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { markOutboundDelivered } = require('../services/markOutboundDelivered');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizePackageType(t) {
  const v = String(t || '').trim().toLowerCase();
  if (v === 'pallet') return 'Pallet';
  if (v === 'box') return 'Box';
  if (v === 'ignore') return 'Ignore';
  return '';
}

function normalizeTransportType(t) {
  const v = String(t || '').trim().toLowerCase();
  if (v === 'gapp' || v === 'own') return 'GAPP';
  if (v === 'rental') return 'Rental';
  if (v === 'courier') return 'Courier';
  if (v === 'self collection' || v === 'selfcollection') return 'Self Collection';
  return '';
}

function trimStr(v) {
  return String(v ?? '').trim();
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

async function getOrCreateDnFromOutbound(outbound_number) {
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
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Ignore', 0, 0, 0, 0, 'Draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
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
        ]
      );
      const dnRow = await dbGet(`SELECT * FROM delivery_notes WHERE id = last_insert_rowid()`);
      const dnId = dnRow.id;
      let itemNo = 1;
      for (const it of items) {
        const pn = String(it.part_number || it.material || '').trim();
        const sap = String(it.sap_part_number || '').trim();
        // Enrich from Main Stock (description + UOM source of truth)
        const ms = await dbGet(
          `SELECT description, uom, sap_part_number
           FROM main_stock
           WHERE part_number = ?
              OR (COALESCE(TRIM(?), '') != '' AND TRIM(COALESCE(sap_part_number, '')) = TRIM(?))
           LIMIT 1`,
          [pn, sap, sap]
        );
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

async function getDnView(id) {
  const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
  if (!dn) return null;
  const items = await dbAll(`SELECT * FROM delivery_note_items WHERE dn_id = ? ORDER BY item_no ASC, id ASC`, [id]);
  const outboundNum = trimStr(dn.outbound_number);
  let outbound_sold_to = null;
  let outbound_name_1 = null;
  let outbound_customer_reference = null;
  let outbound_sales_doc = null;
  let outbound_header_customer_name = null;
  if (outboundNum) {
    const ord = await dbGet(
      `SELECT sold_to, name_1, customer_reference, sales_doc, customer_name
       FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`,
      [outboundNum, outboundNum]
    );
    if (ord) {
      outbound_sold_to = trimStr(ord.sold_to) || null;
      outbound_name_1 = ord.name_1 || null;
      outbound_customer_reference = ord.customer_reference || null;
      outbound_sales_doc = ord.sales_doc || null;
      outbound_header_customer_name = ord.customer_name || null;
    }
  }
  return {
    ...dn,
    outbound_sold_to,
    outbound_name_1,
    outbound_customer_reference,
    outbound_sales_doc,
    outbound_header_customer_name,
    items,
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
    const picked = await dbAll(
      `SELECT DISTINCT
         po.delivery AS outbound_number,
         o.status AS status,
         o.customer_name AS customer_name,
         o.customer_reference AS customer_reference,
         o.sold_to AS sold_to
       FROM picked_orders po
       LEFT JOIN outbound_orders o ON o.id = po.outbound_order_id
       ORDER BY po.confirmed_at DESC
       LIMIT 800`
    );
    const holds = await dbAll(
      `SELECT outbound_number, status, customer_name, '' AS customer_reference, customer_number AS sold_to
       FROM delivery_notes
       WHERE lower(status) = 'on hold'
       ORDER BY updated_at DESC
       LIMIT 400`
    );
    const map = new Map();
    for (const r of [...picked, ...holds]) {
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
    const dn = await getOrCreateDnFromOutbound(outbound_number);
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
      return res.json(await getDnView(id));
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
      return res.json(await getDnView(id));
    }

    return res.status(400).json({ error: 'address_source must be address_book or temporary_manual' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

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

    const invoice_number = req.body?.invoice_number === undefined ? dn.invoice_number : String(req.body.invoice_number || '').trim();
    const package_type = normalizePackageType(req.body?.package_type);
    const package_qty = asNumber(req.body?.package_qty);
    const gross_weight_kg = req.body?.gross_weight_kg === undefined ? dn.gross_weight_kg : asNumber(req.body.gross_weight_kg);
    const volume_cbm = req.body?.volume_cbm === undefined ? dn.volume_cbm : asNumber(req.body.volume_cbm);

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
    res.json(await getDnView(id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery-notes/:id/mark-delivered
router.post('/:id/mark-delivered', requirePermission('can_upload_outbound'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [id]);
    if (!dn) return res.status(404).json({ error: 'DN not found' });
    if (String(dn.status || '').toLowerCase() === 'delivered') return res.status(400).json({ error: 'This DN is already delivered.' });

    // Validate transportation
    if (!String(dn.transportation_type || '').trim()) return res.status(400).json({ error: 'Transportation Method must be saved before Delivered.' });
    if (dn.transportation_type === 'GAPP') {
      if (!String(dn.driver_name || '').trim() && !dn.driver_id) return res.status(400).json({ error: 'Driver is required' });
      if (!String(dn.driver_mobile || '').trim()) return res.status(400).json({ error: 'Driver phone is required' });
      if (!String(dn.vehicle || '').trim()) return res.status(400).json({ error: 'Vehicle is required' });
    }
    if (dn.transportation_type === 'Rental') {
      if (!String(dn.carrier_name || '').trim() && !dn.carrier_id) return res.status(400).json({ error: 'Rental carrier is required' });
      if (!String(dn.truck_type || '').trim()) return res.status(400).json({ error: 'Truck Type is required' });
      if (!(asNumber(dn.truck_qty) > 0)) return res.status(400).json({ error: 'Truck Quantity is required' });
    }
    if (dn.transportation_type === 'Courier') {
      if (!String(dn.carrier_name || '').trim() && !dn.carrier_id) return res.status(400).json({ error: 'Courier company is required' });
      if (!String(dn.waybill_number || '').trim()) return res.status(400).json({ error: 'Waybill number is required' });
    }

    // Validate invoice + package
    if (!String(dn.invoice_number || '').trim()) return res.status(400).json({ error: 'Invoice Number is required' });
    const pkg = normalizePackageType(dn.package_type);
    if (!pkg) return res.status(400).json({ error: 'Package Type is required' });
    if ((pkg === 'Pallet' || pkg === 'Box') && !(asNumber(pkg === 'Pallet' ? dn.pallet_qty : dn.box_qty) > 0)) {
      return res.status(400).json({ error: 'Package Quantity is required' });
    }

    // Deduct main stock only at Delivered status (reuse existing outbound delivered logic, which guards double deduction).
    const order = await dbGet(`SELECT id FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`, [
      dn.outbound_number,
      dn.outbound_number,
    ]);
    if (!order?.id) return res.status(400).json({ error: 'Outbound not found for this DN' });

    // Let existing service handle shortage checks + deduction + sold_out insert + delivered guard on outbound_id.
    await markOutboundDelivered(db, Number(order.id), { requireInvoice: true });

    // Persist delivered table snapshot (one row per item, with header fields duplicated).
    const dnItems = await dbAll(`SELECT * FROM delivery_note_items WHERE dn_id = ? ORDER BY item_no ASC`, [id]);
    const delivered_date = new Date().toISOString().slice(0, 10);

    await dbRun('BEGIN IMMEDIATE');
    try {
      for (const it of dnItems) {
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
            dn.dn_number || dn.outbound_number || '',
            delivered_date,
            dn.sales_order_number || '',
            dn.gapp_po || '',
            dn.customer_po || '',
            dn.outbound_number || '',
            dn.invoice_number || '',
            dn.customer_number || '',
            dn.customer_name || '',
            dn.delivery_address || '',
            dn.gps || '',
            dn.contact_person || '',
            dn.contact_number || '',
            dn.city_name || '',
            dn.contact_person_2 || '',
            dn.contact_number_2 || '',
            dn.email_1 || '',
            dn.second_email || '',
            dn.transportation_type || '',
            dn.carrier_name || '',
            dn.driver_name || '',
            dn.driver_mobile || '',
            dn.vehicle || '',
            dn.truck_type || '',
            asNumber(dn.truck_qty) || 0,
            dn.waybill_number || '',
            dn.package_type || '',
            asNumber(dn.pallet_qty) || 0,
            asNumber(dn.box_qty) || 0,
            asNumber(dn.gross_weight_kg) || 0,
            asNumber(dn.volume_cbm) || 0,
            dn.deliver_to_remarks || '',
            dn.address_type || '',
            dn.address_source || '',
            it.part_number || '',
            it.sap_part_number || '',
            it.description || '',
            asNumber(it.qty) || 0,
            it.uom || '',
          ]
        );
      }
      await dbRun(
        `UPDATE delivery_notes SET status = 'Delivered', delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [id]
      );
      await dbRun('COMMIT');
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }

    res.json({ ok: true, dn_id: id, status: 'Delivered' });
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ error: e.message, shortages: e.shortages });
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

