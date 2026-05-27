const express = require('express');

const router = express.Router();
const db = require('../db');
const { markOutboundDelivered } = require('../services/markOutboundDelivered');
const { logAudit } = require('../services/auditLogger');
const { enrichDnItemsFromMasterData } = require('../services/dnMasterDataLookup');

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function getOutboundByNumber(outbound_number) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM outbound_orders WHERE outbound_number = ?', [outbound_number], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function getItems(outbound_id) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id ASC', [outbound_id], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

/** Collapse duplicate part_number rows for DN display (same as outbound export uniqueness). */
function aggregateItemsByPartNumber(rows) {
  const map = new Map();
  for (const it of rows || []) {
    const pn = String(it.part_number ?? '').trim();
    if (!pn) continue;
    const qty = asNumber(it.required_qty);
    if (!map.has(pn)) {
      map.set(pn, { ...it, part_number: pn, required_qty: qty });
    } else {
      const ex = map.get(pn);
      ex.required_qty = asNumber(ex.required_qty) + qty;
    }
  }
  return [...map.values()];
}

async function getCustomerByCompanyName(company_name) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM customers WHERE company_name = ?', [company_name], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

// GET /api/delivery-note/:outbound_number
// Returns DN data with exact mapping keys expected by frontend.
router.get('/:outbound_number', async (req, res) => {
  try {
    const outbound_number = req.params.outbound_number;
    const order = await getOutboundByNumber(outbound_number);
    if (!order) return res.status(404).json({ error: 'Outbound not found' });

    const rawItems = await getItems(order.id);
    const items = aggregateItemsByPartNumber(rawItems);
    const customer = order.customer_name ? await getCustomerByCompanyName(order.customer_name) : null;

    const delivery_address = order.delivery_address || customer?.address || '';
    const gps = customer?.gps || '';
    const contact_person = order.contact_person || customer?.contact_person || '';

    const mappedItemsRaw = items.map((it) => ({
      part_number: it.part_number,
      sap_part_number: it.sap_part_number,
      description: it.description,
      qty: asNumber(it.required_qty),
      uom: it.uom || '',
      serial_no: it.serial_no || '-',
      condition: it.condition || 'New',
    }));
    const warehouseId = order.warehouse_id != null ? Number(order.warehouse_id) : null;
    const mappedItems = (await enrichDnItemsFromMasterData(mappedItemsRaw, warehouseId)).map((it) => ({
      part_number: it.part_number,
      description: it.description,
      qty: it.qty,
      uom: it.uom || '',
      serial_no: it.serial_no || '-',
      condition: it.condition || 'New',
    }));

    res.json({
      header: {
        dn_date: order.dn_date || new Date().toISOString().slice(0, 10),
        // Business mapping: Sales Doc document number is the DN "GAPP PO".
        gapp_po: order.gapp_po || order.sales_doc || '',
        customer_po: order.customer_po_number || '',
        outbound_number: order.outbound_number,
        invoice_number: order.invoice_number || '',
      },
      delivery: {
        customer_name: order.customer_name || '',
        delivery_address,
        gps,
      },
      contact: {
        contact_person,
      },
      items: mappedItems,
      summary: {
        total_cases: order.total_cases || '',
        gross_weight: order.gross_weight || '',
        volume: order.volume || '',
      },
      meta: {
        dn_status: order.dn_status || 'Draft',
        has_invoice: Boolean(String(order.invoice_number || '').trim()),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/delivery-note/:outbound_number/invoice — set invoice when ready (can be blank to clear)
router.patch('/:outbound_number/invoice', async (req, res) => {
  try {
    const outbound_number = req.params.outbound_number;
    const order = await getOutboundByNumber(outbound_number);
    if (!order) return res.status(404).json({ error: 'Outbound not found' });
    const invoice_number =
      req.body.invoice_number === undefined || req.body.invoice_number === null
        ? ''
        : String(req.body.invoice_number).trim();
    await new Promise((resolve, reject) => {
      db.run('UPDATE outbound_orders SET invoice_number = ? WHERE id = ?', [invoice_number, order.id], (err) =>
        err ? reject(err) : resolve()
      );
    });
    logAudit({
      warehouse_id: order.warehouse_id,
      req,
      module_name: 'DELIVERY',
      action_type: 'UPDATED',
      reference_type: 'outbound_order',
      reference_id: order.id,
      reference_number: outbound_number,
      remarks: 'invoice_number_updated',
      new_value: { invoice_number: invoice_number || null },
    });
    res.json({ ok: true, outbound_number, invoice_number });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/delivery-note/:outbound_number/deliver
// Delegates to shared service (sold_out_qty + sold_out log + delivered guard).
router.post('/:outbound_number/deliver', async (req, res) => {
  const outbound_number = req.params.outbound_number;
  try {
    const order = await getOutboundByNumber(outbound_number);
    if (!order) return res.status(404).json({ error: 'Outbound not found' });
    const result = await markOutboundDelivered(db, order.id, { requireInvoice: true });
    const o2 = await new Promise((resolve, reject) => {
      db.get('SELECT status, warehouse_id FROM outbound_orders WHERE id = ?', [order.id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    logAudit({
      warehouse_id: o2?.warehouse_id,
      req,
      module_name: 'OUTBOUND',
      action_type: 'MARK_DELIVERED',
      reference_type: 'outbound_order',
      reference_id: order.id,
      reference_number: outbound_number,
      status_after: o2?.status,
      remarks: 'delivery_note_deliver_endpoint',
    });
    res.json({ ...result, outbound_number });
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ error: e.message, shortages: e.shortages });
  }
});

module.exports = router;

