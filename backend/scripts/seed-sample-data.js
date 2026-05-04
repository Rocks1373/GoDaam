#!/usr/bin/env node
/**
 * Seeds a realistic GoDam test dataset and writes upload-ready Excel samples.
 *
 * Usage:
 *   npm run seed:sample --workspace backend
 *
 * Env:
 *   DB_PATH optional, defaults to backend/warehouse.db
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'warehouse.db');

const db = require('../db');
const { generateFifoForOutboundOrder } = require('../services/godamFifo');
const { parseVehicleToFields } = require('../services/transportationService');

const run = promisify(db.run.bind(db));
const get = promisify(db.get.bind(db));
const all = promisify(db.all.bind(db));
const close = promisify(db.close.bind(db));

const OUT_DIR = path.join(__dirname, '..', 'sample-data');
const SAMPLE_PARTS = ['GAPP-CBL-001', 'GAPP-SWT-002', 'GAPP-BRK-003', 'GAPP-PNL-004'];
const SAMPLE_OUTBOUNDS = ['GD-DO-10001', 'GD-DO-10002', 'GD-DO-10003'];

function today(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function waitForSchema() {
  const required = ['users', 'main_stock', 'stock_by_rack', 'outbound_orders', 'vendors', 'delivery_notes'];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = await all(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${required.map(() => '?').join(',')})`,
      required
    );
    if (rows.length === required.length) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for database schema. Start once with npm run start --workspace backend and retry.');
}

async function upsertUser(user) {
  const hash = bcrypt.hashSync(user.password, 10);
  const existing = await get(`SELECT id FROM users WHERE username = ?`, [user.username]);
  if (existing?.id) {
    await run(
      `UPDATE users
       SET password_hash = ?, role = ?, full_name = ?, mobile_number = ?, email = ?,
           is_active = 1, token_expiry_days = 30, can_access_web = ?, can_access_mobile = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        hash,
        user.role,
        user.full_name,
        user.mobile_number,
        user.email,
        user.can_access_web,
        user.can_access_mobile,
        existing.id,
      ]
    );
    return existing.id;
  }
  await run(
    `INSERT INTO users
      (username, password_hash, role, full_name, mobile_number, email, is_active, token_expiry_days, can_access_web, can_access_mobile)
     VALUES (?, ?, ?, ?, ?, ?, 1, 30, ?, ?)`,
    [
      user.username,
      hash,
      user.role,
      user.full_name,
      user.mobile_number,
      user.email,
      user.can_access_web,
      user.can_access_mobile,
    ]
  );
  const row = await get(`SELECT id FROM users WHERE username = ?`, [user.username]);
  return row.id;
}

async function upsertVendor(vendor) {
  let row = await get(`SELECT id FROM vendors WHERE vendor_number = ?`, [vendor.vendor_number]);
  if (row?.id) {
    await run(
      `UPDATE vendors
       SET vendor_name = ?, contact_person = ?, phone_number = ?, email = ?, remarks = ?,
           is_active = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [vendor.vendor_name, vendor.contact_person, vendor.phone_number, vendor.email, vendor.remarks, row.id]
    );
    return row.id;
  }
  await run(
    `INSERT INTO vendors
      (vendor_number, vendor_name, contact_person, phone_number, email, remarks, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [vendor.vendor_number, vendor.vendor_name, vendor.contact_person, vendor.phone_number, vendor.email, vendor.remarks]
  );
  row = await get(`SELECT id FROM vendors WHERE vendor_number = ?`, [vendor.vendor_number]);
  return row.id;
}

async function upsertCustomer(customer) {
  const existing = await get(
    `SELECT id FROM customers
     WHERE TRIM(COALESCE(customer_number, '')) = ?
       AND TRIM(COALESCE(city_name, '')) = ?
       AND TRIM(COALESCE(address, '')) = ?`,
    [customer.customer_number, customer.city_name, customer.address]
  );
  if (existing?.id) {
    await run(
      `UPDATE customers
       SET company_name = ?, gps = ?, contact_person = ?, contact_person_number = ?,
           contact_person_number_1 = ?, email_1 = ?, designation_job = ?,
           second_name = ?, second_number = ?, second_email = ?, designation_job_2 = ?,
           remarks = ?, address_type = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        customer.company_name,
        customer.gps,
        customer.contact_person,
        customer.contact_person_number,
        customer.contact_person_number,
        customer.email_1,
        customer.designation_job,
        customer.second_name,
        customer.second_number,
        customer.second_email,
        customer.designation_job_2,
        customer.remarks,
        customer.address_type,
        existing.id,
      ]
    );
    return existing.id;
  }
  await run(
    `INSERT INTO customers (
      customer_number, company_name, city_name, address, gps, contact_person,
      contact_person_number, contact_person_number_1, email_1, designation_job,
      second_name, second_number, second_email, designation_job_2, remarks,
      address_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      customer.customer_number,
      customer.company_name,
      customer.city_name,
      customer.address,
      customer.gps,
      customer.contact_person,
      customer.contact_person_number,
      customer.contact_person_number,
      customer.email_1,
      customer.designation_job,
      customer.second_name,
      customer.second_number,
      customer.second_email,
      customer.designation_job_2,
      customer.remarks,
      customer.address_type,
    ]
  );
  const row = await get(`SELECT id FROM customers WHERE customer_number = ? ORDER BY id DESC LIMIT 1`, [
    customer.customer_number,
  ]);
  return row.id;
}

async function upsertCarrier(carrier) {
  let row = await get(
    `SELECT id FROM transportation_carriers WHERE carrier_name = ? AND carrier_type = ? LIMIT 1`,
    [carrier.carrier_name, carrier.carrier_type]
  );
  if (!row?.id) {
    await run(
      `INSERT INTO transportation_carriers (carrier_name, carrier_type, status, created_at, updated_at)
       VALUES (?, ?, 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [carrier.carrier_name, carrier.carrier_type]
    );
    row = await get(
      `SELECT id FROM transportation_carriers WHERE carrier_name = ? AND carrier_type = ? LIMIT 1`,
      [carrier.carrier_name, carrier.carrier_type]
    );
  }

  for (const driver of carrier.drivers || []) {
    const existing = await get(
      `SELECT id FROM transportation_drivers WHERE carrier_id = ? AND driver_name = ? LIMIT 1`,
      [row.id, driver.driver_name]
    );
    const { vehicle_type, vehicle_number } = parseVehicleToFields(driver.vehicle);
    const phone = driver.phone_number || '';
    if (existing?.id) {
      await run(
        `UPDATE transportation_drivers
         SET driver_phone = ?, vehicle_type = ?, vehicle_number = ?, status = 'Active', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [phone, vehicle_type, vehicle_number, existing.id]
      );
    } else {
      await run(
        `INSERT INTO transportation_drivers (
          carrier_id, carrier_type, carrier_name, driver_name, driver_phone,
          vehicle_type, vehicle_number, status, auto_warning, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [row.id, carrier.carrier_type, carrier.carrier_name, driver.driver_name, phone, vehicle_type, vehicle_number]
      );
    }
  }
  return row.id;
}

async function seedStock(vendorIds) {
  const items = [
    {
      product: 'Structured Cabling',
      vendor_id: vendorIds.GDVEN001,
      vendor_number: 'GD-VEN-001',
      vendor_name: 'NexaCom Solutions',
      sap_part_number: 'SAP-GD-1001',
      part_number: 'GAPP-CBL-001',
      description: 'Cat6 blue patch cord 3m',
      received_qty: 250,
      sold_out_qty: 30,
      pending_delivery_qty: 20,
      available_qty: 200,
      uom: 'PCS',
    },
    {
      product: 'Networking',
      vendor_id: vendorIds.GDVEN001,
      vendor_number: 'GD-VEN-001',
      vendor_name: 'NexaCom Solutions',
      sap_part_number: 'SAP-GD-1002',
      part_number: 'GAPP-SWT-002',
      description: '24 port managed access switch',
      received_qty: 80,
      sold_out_qty: 15,
      pending_delivery_qty: 10,
      available_qty: 55,
      uom: 'PCS',
    },
    {
      product: 'Electrical',
      vendor_id: vendorIds.GDVEN002,
      vendor_number: 'GD-VEN-002',
      vendor_name: 'Riyadh Power Trading',
      sap_part_number: 'SAP-GD-2001',
      part_number: 'GAPP-BRK-003',
      description: '32A miniature circuit breaker',
      received_qty: 120,
      sold_out_qty: 20,
      pending_delivery_qty: 10,
      available_qty: 90,
      uom: 'PCS',
    },
    {
      product: 'Electrical',
      vendor_id: vendorIds.GDVEN002,
      vendor_number: 'GD-VEN-002',
      vendor_name: 'Riyadh Power Trading',
      sap_part_number: 'SAP-GD-2002',
      part_number: 'GAPP-PNL-004',
      description: 'Wall mounted distribution panel',
      received_qty: 40,
      sold_out_qty: 8,
      pending_delivery_qty: 8,
      available_qty: 24,
      uom: 'PCS',
    },
  ];

  for (const item of items) {
    await run(
      `INSERT INTO vendor_items
        (vendor_id, vendor_number, vendor_name, sap_part_number, part_number, description, uom, remarks, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Sample data item', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(COALESCE(vendor_id, -1), TRIM(part_number)) DO UPDATE SET
        vendor_number = excluded.vendor_number,
        vendor_name = excluded.vendor_name,
        sap_part_number = excluded.sap_part_number,
        description = excluded.description,
        uom = excluded.uom,
        remarks = excluded.remarks,
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP`,
      [
        item.vendor_id,
        item.vendor_number,
        item.vendor_name,
        item.sap_part_number,
        item.part_number,
        item.description,
        item.uom,
      ]
    );

    await run(
      `INSERT INTO main_stock (
        product, vendor_id, vendor_number, vendor_name, sap_part_number, part_number, description,
        received_qty, issued_qty, sold_out_qty, pending_delivery_qty, available_qty, uom, remarks,
        last_updated, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sample test stock', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(part_number) DO UPDATE SET
        product = excluded.product,
        vendor_id = excluded.vendor_id,
        vendor_number = excluded.vendor_number,
        vendor_name = excluded.vendor_name,
        sap_part_number = excluded.sap_part_number,
        description = excluded.description,
        received_qty = excluded.received_qty,
        issued_qty = excluded.issued_qty,
        sold_out_qty = excluded.sold_out_qty,
        pending_delivery_qty = excluded.pending_delivery_qty,
        available_qty = excluded.available_qty,
        uom = excluded.uom,
        remarks = excluded.remarks,
        last_updated = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP`,
      [
        item.product,
        item.vendor_id,
        item.vendor_number,
        item.vendor_name,
        item.sap_part_number,
        item.part_number,
        item.description,
        item.received_qty,
        item.sold_out_qty,
        item.sold_out_qty,
        item.pending_delivery_qty,
        item.available_qty,
        item.uom,
      ]
    );
  }

  await run(`DELETE FROM stock_in WHERE reference_no LIKE 'GD-SEED-%'`);
  await run(
    `DELETE FROM fifo_suggestions
     WHERE stock_by_rack_id IN (
       SELECT id FROM stock_by_rack WHERE part_number IN (${SAMPLE_PARTS.map(() => '?').join(',')})
     )`,
    SAMPLE_PARTS
  );
  await run(`DELETE FROM stock_by_rack WHERE part_number IN (${SAMPLE_PARTS.map(() => '?').join(',')})`, SAMPLE_PARTS);

  const rackRows = [
    [today(-75), 'GAPP-CBL-001', 'SAP-GD-1001', 'Cat6 blue patch cord 3m', 'A01-01', 90],
    [today(-40), 'GAPP-CBL-001', 'SAP-GD-1001', 'Cat6 blue patch cord 3m', 'A01-02', 110],
    [today(-68), 'GAPP-SWT-002', 'SAP-GD-1002', '24 port managed access switch', 'B02-01', 25],
    [today(-22), 'GAPP-SWT-002', 'SAP-GD-1002', '24 port managed access switch', 'B02-03', 30],
    [today(-50), 'GAPP-BRK-003', 'SAP-GD-2001', '32A miniature circuit breaker', 'C03-01', 70],
    [today(-12), 'GAPP-BRK-003', 'SAP-GD-2001', '32A miniature circuit breaker', 'C03-02', 20],
    [today(-33), 'GAPP-PNL-004', 'SAP-GD-2002', 'Wall mounted distribution panel', 'D04-01', 24],
  ];

  for (const [transactionDate, part, sap, desc, rack, qty] of rackRows) {
    await run(
      `INSERT INTO stock_in
        (transaction_date, part_number, sap_part_number, description, rack_location, qty_in, source_type, reference_no, remarks)
       VALUES (?, ?, ?, ?, ?, ?, 'sample-seed', ?, 'Generated sample putaway')`,
      [transactionDate, part, sap, desc, rack, qty, `GD-SEED-${part}-${rack}`]
    );
    await run(
      `INSERT INTO stock_by_rack
        (part_number, sap_part_number, description, rack_location, total_in_qty, total_out_qty, available_qty, first_entry_date, last_updated)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)`,
      [part, sap, desc, rack, qty, qty, transactionDate]
    );
  }
}

async function seedOutbounds(userIds) {
  for (const outbound of SAMPLE_OUTBOUNDS) {
    const row = await get(`SELECT id FROM outbound_orders WHERE outbound_number = ? OR delivery = ? LIMIT 1`, [
      outbound,
      outbound,
    ]);
    if (row?.id) {
      const dns = await all(`SELECT id FROM delivery_notes WHERE outbound_number = ?`, [outbound]);
      for (const dn of dns) {
        await run(`DELETE FROM driver_delivery_tasks WHERE dn_id = ?`, [dn.id]).catch(() => {});
        await run(`DELETE FROM delivered WHERE dn_id = ?`, [dn.id]).catch(() => {});
        await run(`DELETE FROM delivery_note_items WHERE dn_id = ?`, [dn.id]).catch(() => {});
      }
      await run(`DELETE FROM delivery_notes WHERE outbound_number = ?`, [outbound]).catch(() => {});
      await run(`DELETE FROM outbound_order_seen WHERE outbound_order_id = ?`, [row.id]).catch(() => {});
      await run(`DELETE FROM pick_change_requests WHERE outbound_order_id = ?`, [row.id]).catch(() => {});
      await run(`DELETE FROM picked_transactions WHERE outbound_order_id = ?`, [row.id]).catch(() => {});
      await run(`DELETE FROM picked_orders WHERE outbound_order_id = ?`, [row.id]).catch(() => {});
      await run(`DELETE FROM delivered_outbounds WHERE outbound_id = ?`, [row.id]).catch(() => {});
      await run(`DELETE FROM fifo_suggestions WHERE outbound_order_id = ?`, [row.id]);
      await run(`DELETE FROM outbound_items WHERE outbound_id = ?`, [row.id]);
      await run(`DELETE FROM outbound_orders WHERE id = ?`, [row.id]);
    }
  }

  const orders = [
    {
      outbound_number: 'GD-DO-10001',
      sales_doc: 'SO-900101',
      customer_reference: 'PO-KAFD-4481',
      sold_to: 'GD-CUST-001',
      name_1: 'KAFD Facilities Management',
      status: 'Sent For Pick',
      items: [
        ['GAPP-CBL-001', 'SAP-GD-1001', 'Cat6 blue patch cord 3m', 60, 'PCS'],
        ['GAPP-SWT-002', 'SAP-GD-1002', '24 port managed access switch', 12, 'PCS'],
      ],
    },
    {
      outbound_number: 'GD-DO-10002',
      sales_doc: 'SO-900102',
      customer_reference: 'PO-RUH-2210',
      sold_to: 'GD-CUST-002',
      name_1: 'Riyadh Metro Operations',
      status: 'Uploaded',
      items: [
        ['GAPP-BRK-003', 'SAP-GD-2001', '32A miniature circuit breaker', 45, 'PCS'],
        ['GAPP-PNL-004', 'SAP-GD-2002', 'Wall mounted distribution panel', 5, 'PCS'],
      ],
    },
    {
      outbound_number: 'GD-DO-10003',
      sales_doc: 'SO-900103',
      customer_reference: 'PO-SHORT-1009',
      sold_to: 'GD-CUST-001',
      name_1: 'KAFD Facilities Management',
      status: 'Stock Checked',
      items: [['GAPP-SWT-002', 'SAP-GD-1002', '24 port managed access switch', 70, 'PCS']],
    },
  ];

  for (const order of orders) {
    await run(
      `INSERT INTO outbound_orders (
        outbound_number, delivery, sales_doc, gapp_po, customer_reference, sold_to, name_1,
        sales_order_number, customer_po_number, customer_name, vendor_name, status,
        uploaded_by_user_id, dn_date, invoice_number, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sample Vendors', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        order.outbound_number,
        order.outbound_number,
        order.sales_doc,
        order.sales_doc,
        order.customer_reference,
        order.sold_to,
        order.name_1,
        order.sales_doc,
        order.customer_reference,
        order.name_1,
        order.status,
        userIds.admin,
        today(1),
        `INV-${order.sales_doc}`,
      ]
    );
    const orderRow = await get(`SELECT id FROM outbound_orders WHERE outbound_number = ?`, [order.outbound_number]);
    for (const [part, sap, desc, qty, uom] of order.items) {
      const stock = await get(
        `SELECT available_qty FROM main_stock WHERE part_number = ? OR sap_part_number = ? LIMIT 1`,
        [part, sap]
      );
      const available = Number(stock?.available_qty || 0);
      const shortage = Math.max(0, qty - available);
      await run(
        `INSERT INTO outbound_items (
          outbound_id, part_number, sap_part_number, material, description, required_qty,
          picked_qty, status, uom, available_qty_main_stock, fifo_status, shortage_qty
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?)`,
        [orderRow.id, part, sap, part, desc, qty, uom, available, shortage > 0 ? 'Shortage' : 'Available', shortage]
      );
    }
    await generateFifoForOutboundOrder(orderRow.id);
  }
}

async function seedInbound(userIds) {
  const existing = await get(`SELECT id FROM inbound_batches WHERE batch_name = 'GD Sample Receiving Batch' LIMIT 1`);
  if (existing?.id) {
    await run(`DELETE FROM inbound_putaway_lines WHERE inbound_batch_id = ?`, [existing.id]);
    await run(`DELETE FROM inbound_items WHERE inbound_batch_id = ?`, [existing.id]);
    await run(`DELETE FROM inbound_batches WHERE id = ?`, [existing.id]);
  }

  await run(
    `INSERT INTO inbound_batches (batch_name, vendor_name, upload_date, status, created_by, created_at)
     VALUES ('GD Sample Receiving Batch', 'NexaCom Solutions', ?, 'Pending', ?, CURRENT_TIMESTAMP)`,
    [today(), userIds.admin]
  );
  const batch = await get(`SELECT id FROM inbound_batches WHERE batch_name = 'GD Sample Receiving Batch'`);
  const rows = [
    ['GAPP-CBL-001', 'SAP-GD-1001', 'Cat6 blue patch cord 3m', 30],
    ['GAPP-SWT-002', 'SAP-GD-1002', '24 port managed access switch', 8],
  ];
  for (const [part, sap, desc, qty] of rows) {
    await run(
      `INSERT INTO inbound_items
        (inbound_batch_id, part_number, sap_part_number, description, total_qty, putaway_qty, remaining_qty, status)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'Pending')`,
      [batch.id, part, sap, desc, qty, qty]
    );
  }
}

function writeWorkbook(filename, sheetName, rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, path.join(OUT_DIR, filename));
}

function writeSampleFiles() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  writeWorkbook('main-stock-sample.xlsx', 'Main Stock', [
    {
      'Vendor Number': 'GD-VEN-003',
      'Vendor Name': 'Eastern Datacenter Supply',
      'SAP Part Number': 'SAP-GD-3001',
      'Part Number': 'GAPP-UPS-005',
      Description: 'Line interactive UPS 1500VA',
      'Received Qty': 25,
      'Sold Out Qty': 2,
      'Pending Delivery Qty': 3,
      UOM: 'PCS',
      Remarks: 'Upload test row',
    },
    {
      'Vendor Number': 'GD-VEN-003',
      'Vendor Name': 'Eastern Datacenter Supply',
      'SAP Part Number': 'SAP-GD-3002',
      'Part Number': 'GAPP-PDU-006',
      Description: 'Rack PDU 12 outlet',
      'Received Qty': 60,
      'Sold Out Qty': 5,
      'Pending Delivery Qty': 10,
      UOM: 'PCS',
      Remarks: 'Upload test row',
    },
  ]);

  writeWorkbook('stock-in-sample.xlsx', 'Stock In', [
    {
      'Transaction Date': today(),
      'Part Number': 'GAPP-CBL-001',
      'SAP Part Number': 'SAP-GD-1001',
      Description: 'Cat6 blue patch cord 3m',
      'Rack Location': 'A01-03',
      'Qty In': 25,
      'Source Type': 'sample-upload',
      'Reference No': 'GD-UPLOAD-STIN-001',
      Remarks: 'Upload test stock-in',
    },
    {
      'Transaction Date': today(),
      'Part Number': 'GAPP-BRK-003',
      'SAP Part Number': 'SAP-GD-2001',
      Description: '32A miniature circuit breaker',
      'Rack Location': 'C03-03',
      'Qty In': 15,
      'Source Type': 'sample-upload',
      'Reference No': 'GD-UPLOAD-STIN-002',
      Remarks: 'Upload test stock-in',
    },
  ]);

  writeWorkbook('outbound-upload-sample.xlsx', 'Outbound', [
    {
      Delivery: 'GD-UPLOAD-20001',
      'Sales Doc.': 'SO-910001',
      'Customer Reference': 'PO-UPLOAD-77',
      'Sold-to': 'GD-CUST-001',
      'Name 1': 'KAFD Facilities Management',
      Material: 'GAPP-CBL-001',
      'SAP Part Number': 'SAP-GD-1001',
      Description: 'Cat6 blue patch cord 3m',
      'Delivery quantity': 15,
    },
    {
      Delivery: 'GD-UPLOAD-20001',
      'Sales Doc.': 'SO-910001',
      'Customer Reference': 'PO-UPLOAD-77',
      'Sold-to': 'GD-CUST-001',
      'Name 1': 'KAFD Facilities Management',
      Material: 'GAPP-SWT-002',
      'SAP Part Number': 'SAP-GD-1002',
      Description: '24 port managed access switch',
      'Delivery quantity': 3,
    },
    {
      Delivery: 'GD-UPLOAD-20002',
      'Sales Doc.': 'SO-910002',
      'Customer Reference': 'PO-UPLOAD-88',
      'Sold-to': 'GD-CUST-002',
      'Name 1': 'Riyadh Metro Operations',
      Material: 'GAPP-BRK-003',
      'SAP Part Number': 'SAP-GD-2001',
      Description: '32A miniature circuit breaker',
      'Delivery quantity': 20,
    },
  ]);
}

async function main() {
  await waitForSchema();

  const userIds = {};
  userIds.admin = await upsertUser({
    username: 'sample.admin',
    password: 'Sample123!',
    role: 'admin',
    full_name: 'Sample Admin',
    mobile_number: '+966500000001',
    email: 'sample.admin@godam.test',
    can_access_web: 1,
    can_access_mobile: 1,
  });
  userIds.picker = await upsertUser({
    username: 'sample.picker',
    password: 'Sample123!',
    role: 'picker',
    full_name: 'Sample Picker',
    mobile_number: '+966500000002',
    email: 'sample.picker@godam.test',
    can_access_web: 0,
    can_access_mobile: 1,
  });
  userIds.driver = await upsertUser({
    username: 'sample.driver',
    password: 'Sample123!',
    role: 'driver',
    full_name: 'Sample Driver',
    mobile_number: '+966500000003',
    email: 'sample.driver@godam.test',
    can_access_web: 0,
    can_access_mobile: 1,
  });

  const vendorIds = {
    GDVEN001: await upsertVendor({
      vendor_number: 'GD-VEN-001',
      vendor_name: 'NexaCom Solutions',
      contact_person: 'Faisal Al Harbi',
      phone_number: '+966511111111',
      email: 'sales@nexacom.test',
      remarks: 'Sample networking vendor',
    }),
    GDVEN002: await upsertVendor({
      vendor_number: 'GD-VEN-002',
      vendor_name: 'Riyadh Power Trading',
      contact_person: 'Maha Al Rashid',
      phone_number: '+966522222222',
      email: 'orders@riyadhpower.test',
      remarks: 'Sample electrical vendor',
    }),
  };

  const customerOneId = await upsertCustomer({
    customer_number: 'GD-CUST-001',
    company_name: 'KAFD Facilities Management',
    city_name: 'Riyadh',
    address: 'King Abdullah Financial District, Parcel 2.09',
    gps: 'https://maps.google.com/?q=24.7636,46.6400',
    contact_person: 'Abeer Al Saud',
    contact_person_number: '+966533333333',
    email_1: 'abeer.kafd@example.test',
    designation_job: 'Facilities Coordinator',
    second_name: 'Nasser Al Qahtani',
    second_number: '+966544444444',
    second_email: 'nasser.kafd@example.test',
    designation_job_2: 'Site Supervisor',
    remarks: 'Sample permanent delivery address',
    address_type: 'permanent',
  });
  const customerTwoId = await upsertCustomer({
    customer_number: 'GD-CUST-002',
    company_name: 'Riyadh Metro Operations',
    city_name: 'Riyadh',
    address: 'Depot 3, Eastern Ring Road',
    gps: 'https://maps.google.com/?q=24.7136,46.6753',
    contact_person: 'Omar Al Mutairi',
    contact_person_number: '+966555555555',
    email_1: 'omar.metro@example.test',
    designation_job: 'Logistics Lead',
    second_name: 'Huda Al Salem',
    second_number: '+966566666666',
    second_email: 'huda.metro@example.test',
    designation_job_2: 'Receiving Desk',
    remarks: 'Sample permanent delivery address',
    address_type: 'permanent',
  });

  await run(`DELETE FROM customer_locations WHERE customer_id IN (?, ?)`, [customerOneId, customerTwoId]);
  await run(
    `INSERT INTO customer_locations
      (customer_id, label, address, gps, contact_person, contact_number, contact_person_2, contact_number_2, is_active)
     VALUES (?, 'Temporary project store', 'KAFD Laydown Yard Gate 4', 'https://maps.google.com/?q=24.7624,46.6392',
       'Salman Al Enezi', '+966577777777', 'Abeer Al Saud', '+966533333333', 1)`,
    [customerOneId]
  );

  await upsertCarrier({
    carrier_name: 'GD Sample Transport',
    carrier_type: 'GAPP',
    drivers: [
      { driver_name: 'Sample Driver', phone_number: '+966500000003', vehicle: 'Dyna GD-101' },
      { driver_name: 'Yousef Test Driver', phone_number: '+966588888888', vehicle: 'Pickup GD-202' },
    ],
  });

  await seedStock(vendorIds);
  await seedOutbounds(userIds);
  await seedInbound(userIds);
  writeSampleFiles();

  const counts = {};
  for (const table of ['users', 'vendors', 'vendor_items', 'customers', 'main_stock', 'stock_by_rack', 'outbound_orders']) {
    const row = await get(`SELECT COUNT(1) AS c FROM ${table}`);
    counts[table] = row.c;
  }

  console.log(`Seeded sample data into ${path.resolve(process.env.DB_PATH)}`);
  console.log('Sample logins: sample.admin / sample.picker / sample.driver, password Sample123!');
  console.log(`Wrote Excel upload samples to ${OUT_DIR}`);
  console.log(JSON.stringify(counts, null, 2));
}

main()
  .catch((e) => {
    console.error(e.stack || e.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // db.js runs its built-in admin/demo seed asynchronously after migrations.
    // Give that startup task a brief turn before closing this script's handle.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await close().catch(() => {});
  });
