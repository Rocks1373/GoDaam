#!/usr/bin/env node
/**
 * Large FIFO-focused GoDam test dataset.
 *
 * Usage:
 *   npm run seed:test-data
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
const PART_COUNT = 100;
const VENDOR_COUNT = 10;
const PASSWORD = process.env.TEST_USER_PASSWORD || 'admin123';
const VENDOR_DEFS = [
  ['GD-VEND-001', 'NexaCom Solutions', 'Networking'],
  ['GD-VEND-002', 'Riyadh Power Trading', 'Electrical'],
  ['GD-VEND-003', 'Eastern Datacenter Supply', 'Datacenter'],
  ['GD-VEND-004', 'Saudi Cable Masters', 'Cable'],
  ['GD-VEND-005', 'Gulf Automation Parts', 'Automation'],
  ['GD-VEND-006', 'Al Noor Safety Systems', 'Safety'],
  ['GD-VEND-007', 'Metro Fiber Technologies', 'Fiber'],
  ['GD-VEND-008', 'Desert Industrial Controls', 'Controls'],
  ['GD-VEND-009', 'Kingdom Rack Accessories', 'Rack'],
  ['GD-VEND-010', 'Red Sea Power Components', 'Power'],
];
const DRIVER_SAMPLE_ROWS = [
  ['GAPP', 'GAPP', 'Amjad', '+966562143424', 'Pick up', ''],
  ['GAPP', 'GAPP', 'Mohammed Naser', '+966561896893', 'Dyna', ''],
  ['GAPP', 'GAPP', 'Deepak Test Driver', '+966500000001', 'Pickup', 'Test driver'],
  ['EAYN ALWIFAQ Transportation & Logistics services', 'Rental', 'Trailer', '', 'Trailer', 'Rental vehicle type'],
  ['EAYN ALWIFAQ Transportation & Logistics services', 'Rental', 'Dyna', '', 'Dyna', 'Rental vehicle type'],
  ['EAYN ALWIFAQ Transportation & Logistics services', 'Rental', 'Lorry', '', 'Lorry', 'Rental vehicle type'],
  ['EAYN ALWIFAQ Transportation & Logistics services', 'Rental', 'Boom Truck', '', 'Boom Truck', 'Rental vehicle type'],
  ['Raad AlShamali for Transport Co.', 'Rental', 'Trailer', '', 'Trailer', 'Rental vehicle type'],
  ['Raad AlShamali for Transport Co.', 'Rental', 'Dyna', '', 'Dyna', 'Rental vehicle type'],
  ['Raad AlShamali for Transport Co.', 'Rental', 'Lorry', '', 'Lorry', 'Rental vehicle type'],
  ['Raad AlShamali for Transport Co.', 'Rental', 'Boom Truck', '', 'Boom Truck', 'Rental vehicle type'],
  ['AJEX Logistics Services Co.', 'Courier', 'AJEX', '', 'Waybill required', 'Waybill required'],
  ['ARAMEX', 'Courier', 'ARAMEX', '', 'Waybill required', 'Waybill required'],
  ['Self Collection', 'Self Collection', 'Self Collection', '', 'Customer collection', 'Customer collects directly'],
];

function dateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function partNo(i) {
  return `PN-${String(100 + i).padStart(3, '0')}`;
}

function sapNo(i) {
  return `SAP-PN-${String(100 + i).padStart(3, '0')}`;
}

async function waitForSchema() {
  const required = ['users', 'vendors', 'vendor_items', 'main_stock', 'stock_by_rack', 'outbound_orders', 'transportation_carriers'];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = await all(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${required.map(() => '?').join(',')})`,
      required
    );
    if (rows.length === required.length) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for database schema.');
}

async function upsertUser({ username, role, full_name, mobile_number, email, web = 1, mobile = 1 }) {
  const hash = bcrypt.hashSync(PASSWORD, 10);
  const existing = await get(`SELECT id FROM users WHERE username = ?`, [username]);
  if (existing?.id) {
    await run(
      `UPDATE users SET password_hash = ?, role = ?, full_name = ?, mobile_number = ?, email = ?,
       is_active = 1, token_expiry_days = 30, can_access_web = ?, can_access_mobile = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [hash, role.toLowerCase(), full_name, mobile_number, email, web, mobile, existing.id]
    );
    return existing.id;
  }
  await run(
    `INSERT INTO users
      (username, password_hash, role, full_name, mobile_number, email, is_active, token_expiry_days, can_access_web, can_access_mobile)
     VALUES (?, ?, ?, ?, ?, ?, 1, 30, ?, ?)`,
    [username, hash, role.toLowerCase(), full_name, mobile_number, email, web, mobile]
  );
  return (await get(`SELECT id FROM users WHERE username = ?`, [username])).id;
}

async function upsertVendor(v) {
  const existing = await get(`SELECT id FROM vendors WHERE vendor_number = ?`, [v.vendor_number]);
  if (existing?.id) {
    await run(
      `UPDATE vendors SET vendor_name = ?, contact_person = ?, phone_number = ?, email = ?, remarks = ?,
       is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [v.vendor_name, v.contact_person, v.phone_number, v.email, v.remarks, existing.id]
    );
    return existing.id;
  }
  await run(
    `INSERT INTO vendors
      (vendor_number, vendor_name, contact_person, phone_number, email, remarks, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [v.vendor_number, v.vendor_name, v.contact_person, v.phone_number, v.email, v.remarks]
  );
  return (await get(`SELECT id FROM vendors WHERE vendor_number = ?`, [v.vendor_number])).id;
}

async function upsertVendorItem(item) {
  const existing = await get(
    `SELECT id FROM vendor_items WHERE COALESCE(vendor_id, -1) = COALESCE(?, -1) AND TRIM(part_number) = TRIM(?)`,
    [item.vendor_id, item.part_number]
  );
  if (existing?.id) {
    await run(
      `UPDATE vendor_items SET vendor_number = ?, vendor_name = ?, sap_part_number = ?, description = ?, uom = ?,
       remarks = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [
        item.vendor_number,
        item.vendor_name,
        item.sap_part_number,
        item.description,
        item.uom,
        'FIFO test item',
        existing.id,
      ]
    );
    return;
  }
  await run(
    `INSERT INTO vendor_items
      (vendor_id, vendor_number, vendor_name, sap_part_number, part_number, description, uom, remarks, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'FIFO test item', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
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
}

async function resetTestOutbounds() {
  const orders = await all(`SELECT id, outbound_number FROM outbound_orders WHERE outbound_number LIKE 'GD-FIFO-%'`);
  for (const order of orders) {
    const dns = await all(`SELECT id FROM delivery_notes WHERE outbound_number = ?`, [order.outbound_number]);
    for (const dn of dns) {
      await run(`DELETE FROM driver_delivery_tasks WHERE dn_id = ?`, [dn.id]).catch(() => {});
      await run(`DELETE FROM delivered WHERE dn_id = ?`, [dn.id]).catch(() => {});
      await run(`DELETE FROM delivery_note_items WHERE dn_id = ?`, [dn.id]).catch(() => {});
    }
    await run(`DELETE FROM delivery_notes WHERE outbound_number = ?`, [order.outbound_number]).catch(() => {});
    await run(`DELETE FROM outbound_order_seen WHERE outbound_order_id = ?`, [order.id]).catch(() => {});
    await run(`DELETE FROM pick_change_requests WHERE outbound_order_id = ?`, [order.id]).catch(() => {});
    await run(`DELETE FROM picked_transactions WHERE outbound_order_id = ?`, [order.id]).catch(() => {});
    await run(`DELETE FROM picked_orders WHERE outbound_order_id = ?`, [order.id]).catch(() => {});
    await run(`DELETE FROM delivered_outbounds WHERE outbound_id = ?`, [order.id]).catch(() => {});
    await run(`DELETE FROM fifo_suggestions WHERE outbound_order_id = ?`, [order.id]).catch(() => {});
    await run(`DELETE FROM outbound_items WHERE outbound_id = ?`, [order.id]);
    await run(`DELETE FROM outbound_orders WHERE id = ?`, [order.id]);
  }
}

function rackPlan(i) {
  if (i === 0) {
    return [
      ['32A', '2026-01-01', 5],
      ['34B', '2026-02-01', 20],
      ['41C', '2026-03-01', 50],
    ];
  }
  if (i === 5) {
    return [
      ['F05-A', '2026-01-05', 8],
      ['F05-B', '2026-01-20', 12],
      ['F05-C', '2026-02-10', 30],
      ['F05-D', '2026-03-15', 40],
    ];
  }
  const racks = i % 4 === 0 ? 4 : 3;
  return Array.from({ length: racks }, (_, idx) => [
    `T${String((i % 20) + 1).padStart(2, '0')}-${String.fromCharCode(65 + idx)}`,
    dateDaysAgo(120 - idx * 25 - (i % 9)),
    10 + ((i + idx * 7) % 35),
  ]);
}

async function seedStock(vendors) {
  const testParts = Array.from({ length: PART_COUNT }, (_, i) => partNo(i));
  await run(
    `DELETE FROM fifo_suggestions
     WHERE stock_by_rack_id IN (
       SELECT id FROM stock_by_rack WHERE part_number IN (${testParts.map(() => '?').join(',')})
     )`,
    testParts
  ).catch(() => {});
  await run(`DELETE FROM stock_out WHERE part_number IN (${testParts.map(() => '?').join(',')})`, testParts).catch(() => {});
  await run(`DELETE FROM stock_in WHERE part_number IN (${testParts.map(() => '?').join(',')})`, testParts).catch(() => {});
  await run(`DELETE FROM stock_by_rack WHERE part_number IN (${testParts.map(() => '?').join(',')})`, testParts);

  for (let i = 0; i < PART_COUNT; i += 1) {
    const pn = partNo(i);
    const sap = sapNo(i);
    const vendor = vendors[i % vendors.length];
    const desc = `${vendor.productPrefix} test item ${String(i + 1).padStart(3, '0')}`;
    const racks = rackPlan(i);
    const available = racks.reduce((sum, r) => sum + Number(r[2]), 0);

    await upsertVendorItem({
      vendor_id: vendor.id,
      vendor_number: vendor.vendor_number,
      vendor_name: vendor.vendor_name,
      sap_part_number: sap,
      part_number: pn,
      description: desc,
      uom: 'PCS',
    });

    await run(
      `INSERT INTO main_stock (
        product, vendor_id, vendor_number, vendor_name, sap_part_number, part_number, description,
        received_qty, issued_qty, sold_out_qty, pending_delivery_qty, available_qty, uom, remarks,
        last_updated, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 'PCS', 'FIFO test stock', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(part_number) DO UPDATE SET
        product = excluded.product,
        vendor_id = excluded.vendor_id,
        vendor_number = excluded.vendor_number,
        vendor_name = excluded.vendor_name,
        sap_part_number = excluded.sap_part_number,
        description = excluded.description,
        received_qty = excluded.received_qty,
        issued_qty = 0,
        sold_out_qty = 0,
        pending_delivery_qty = 0,
        available_qty = excluded.available_qty,
        uom = 'PCS',
        remarks = excluded.remarks,
        last_updated = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP`,
      [vendor.productPrefix, vendor.id, vendor.vendor_number, vendor.vendor_name, sap, pn, desc, available, available]
    );

    for (const [rack, entryDate, qty] of racks) {
      await run(
        `INSERT INTO stock_by_rack
          (part_number, sap_part_number, description, rack_location, total_in_qty, total_out_qty, available_qty, first_entry_date, last_updated)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)`,
        [pn, sap, desc, rack, qty, qty, entryDate]
      );
      await run(
        `INSERT INTO stock_in
          (transaction_date, part_number, sap_part_number, description, rack_location, qty_in, source_type, reference_no, remarks)
         VALUES (?, ?, ?, ?, ?, ?, 'fifo-test-seed', ?, 'FIFO test seed')`,
        [entryDate, pn, sap, desc, rack, qty, `GD-FIFO-${pn}-${rack}`]
      );
    }
  }
}

async function seedOutbound(userIds) {
  const orders = [
    {
      outbound_number: 'GD-FIFO-A',
      label: 'Test A PN-100 qty 25',
      status: 'Stock Checked',
      items: [[partNo(0), sapNo(0), 'NexaCom test item 001', 25]],
    },
    {
      outbound_number: 'GD-FIFO-CASE1',
      label: 'Case 1 less than oldest rack',
      status: 'Stock Checked',
      items: [[partNo(1), sapNo(1), 'Case 1 FIFO item', 5]],
    },
    {
      outbound_number: 'GD-FIFO-CASE2',
      label: 'Case 2 consumes oldest then next',
      status: 'Stock Checked',
      items: [[partNo(2), sapNo(2), 'Case 2 FIFO item', 30]],
    },
    {
      outbound_number: 'GD-FIFO-CASE3',
      label: 'Case 3 repeated upload summed',
      status: 'Uploaded',
      items: [[partNo(3), sapNo(3), 'Case 3 repeated material summed', 35]],
    },
    {
      outbound_number: 'GD-FIFO-CASE4',
      label: 'Case 4 insufficient stock',
      status: 'Stock Checked',
      items: [[partNo(4), sapNo(4), 'Case 4 shortage item', 9999]],
    },
    {
      outbound_number: 'GD-FIFO-CASE5',
      label: 'Case 5 four racks sorted by date',
      status: 'Stock Checked',
      items: [[partNo(5), sapNo(5), 'Case 5 four rack FIFO item', 60]],
    },
  ];

  for (const order of orders) {
    await run(
      `INSERT INTO outbound_orders (
        outbound_number, delivery, sales_doc, gapp_po, customer_reference, sold_to, name_1,
        sales_order_number, customer_po_number, customer_name, vendor_name, status, uploaded_by_user_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'CUST-FIFO-001', 'GoDam FIFO Test Customer', ?, ?, 'GoDam FIFO Test Customer', 'FIFO Test Vendors', ?, ?, CURRENT_TIMESTAMP)`,
      [
        order.outbound_number,
        order.outbound_number,
        `SO-${order.outbound_number}`,
        `SO-${order.outbound_number}`,
        order.label,
        `SO-${order.outbound_number}`,
        `PO-${order.outbound_number}`,
        order.status,
        userIds.admin,
      ]
    );
    const orderRow = await get(`SELECT id FROM outbound_orders WHERE outbound_number = ?`, [order.outbound_number]);
    for (const [pn, sap, desc, qty] of order.items) {
      const ms = await get(`SELECT available_qty FROM main_stock WHERE part_number = ?`, [pn]);
      const avail = Number(ms?.available_qty) || 0;
      const shortage = Math.max(0, qty - avail);
      await run(
        `INSERT INTO outbound_items (
          outbound_id, part_number, sap_part_number, material, description, required_qty, picked_qty,
          status, uom, available_qty_main_stock, fifo_status, shortage_qty
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', 'PCS', ?, ?, ?)`,
        [orderRow.id, pn, sap, pn, desc, qty, avail, shortage > 0 ? 'Shortage' : 'Available', shortage]
      );
    }
    await generateFifoForOutboundOrder(orderRow.id);
  }
}

async function upsertCarrierWithDrivers(carrierName, carrierType, drivers) {
  let carrier = await get(`SELECT id FROM transportation_carriers WHERE carrier_name = ? AND carrier_type = ?`, [
    carrierName,
    carrierType,
  ]);
  if (!carrier?.id) {
    await run(
      `INSERT INTO transportation_carriers (carrier_name, carrier_type, status, created_at, updated_at)
       VALUES (?, ?, 'Active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [carrierName, carrierType]
    );
    carrier = await get(`SELECT id FROM transportation_carriers WHERE carrier_name = ? AND carrier_type = ?`, [
      carrierName,
      carrierType,
    ]);
  } else {
    await run(`UPDATE transportation_carriers SET status = 'Active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [carrier.id]);
  }

  for (const d of drivers) {
    const existing = await get(`SELECT id FROM transportation_drivers WHERE carrier_id = ? AND driver_name = ?`, [
      carrier.id,
      d.name,
    ]);
    const { vehicle_type, vehicle_number } = parseVehicleToFields(d.vehicle);
    const phone = d.phone || '';
    if (existing?.id) {
      await run(
        `UPDATE transportation_drivers SET driver_phone = ?, vehicle_type = ?, vehicle_number = ?, status = 'Active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [phone, vehicle_type, vehicle_number, existing.id]
      );
    } else {
      await run(
        `INSERT INTO transportation_drivers (
          carrier_id, carrier_type, carrier_name, driver_name, driver_phone,
          vehicle_type, vehicle_number, status, auto_warning, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [carrier.id, carrierType, carrierName, d.name, phone, vehicle_type, vehicle_number]
      );
    }
  }
}

async function seedCarriers() {
  const byCarrier = new Map();
  for (const [carrierName, carrierType, driverName, phone, vehicle] of DRIVER_SAMPLE_ROWS) {
    const key = `${carrierName}||${carrierType}`;
    if (!byCarrier.has(key)) byCarrier.set(key, { carrierName, carrierType, drivers: [] });
    byCarrier.get(key).drivers.push({ name: driverName, phone, vehicle });
  }
  for (const group of byCarrier.values()) {
    await upsertCarrierWithDrivers(group.carrierName, group.carrierType, group.drivers);
  }
}

function writeWorkbook(filename, sheetName, rows) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
  XLSX.writeFile(wb, path.join(OUT_DIR, filename));
}

function vendorRows() {
  return VENDOR_DEFS.map(([vendorNumber, vendorName], i) => ({
    'Vendor Number': vendorNumber,
    'Vendor Name': vendorName,
    'Contact Person': `Vendor Contact ${i + 1}`,
    'Phone Number': `+96651${String(i + 1).padStart(7, '0')}`,
    Email: `vendor${i + 1}@godam.test`,
    Remarks: 'FIFO test vendor',
  }));
}

function itemRows() {
  return Array.from({ length: PART_COUNT }, (_, i) => {
    const [vendorNumber, vendorName, productPrefix] = VENDOR_DEFS[i % VENDOR_DEFS.length];
    return {
      'Vendor Number': vendorNumber,
      'Vendor Name': vendorName,
      'SAP Part Number': sapNo(i),
      'Part Number': partNo(i),
      Description: `${productPrefix} test item ${String(i + 1).padStart(3, '0')}`,
      UOM: 'PCS',
      Remarks: 'FIFO test item',
    };
  });
}

function rackUploadRows() {
  const rows = [];
  for (let i = 0; i < PART_COUNT; i += 1) {
    const [, , productPrefix] = VENDOR_DEFS[i % VENDOR_DEFS.length];
    const pn = partNo(i);
    const sap = sapNo(i);
    const desc = `${productPrefix} test item ${String(i + 1).padStart(3, '0')}`;
    for (const [rack, entryDate, qty] of rackPlan(i)) {
      rows.push({
        'Transaction Date': entryDate,
        'Part Number': pn,
        'SAP Part Number': sap,
        Description: desc,
        'Rack Location': rack,
        'Qty In': qty,
        'Source Type': 'fifo-test-upload',
        'Reference No': `UPLOAD-${pn}-${rack}`,
        Remarks: 'Every part appears in multiple rack locations',
      });
    }
  }
  return rows;
}

function mainStockRows() {
  return itemRows().map((row, i) => {
    const receivedQty = rackPlan(i).reduce((sum, r) => sum + Number(r[2]), 0);
    return {
      'Vendor Number': row['Vendor Number'],
      'Vendor Name': row['Vendor Name'],
      'SAP Part Number': row['SAP Part Number'],
      'Part Number': row['Part Number'],
      Description: row.Description,
      'Received Qty': receivedQty,
      'Sold Out Qty': 0,
      'Pending Delivery Qty': 0,
      UOM: 'PCS',
      Remarks: 'Matches total quantity in multi-location stock-in file',
    };
  });
}

function outboundRow({ delivery, salesDoc, customerReference, partIndex, qty, descriptionSuffix = '' }) {
  const [, , productPrefix] = VENDOR_DEFS[partIndex % VENDOR_DEFS.length];
  return {
    Delivery: delivery,
    'Sales Doc.': salesDoc,
    'Customer Reference': customerReference,
    'Sold-to': 'CUST-FIFO-001',
    'Name 1': 'GoDam FIFO Test Customer',
    Material: partNo(partIndex),
    'SAP Part Number': sapNo(partIndex),
    Description: `${productPrefix} test item ${String(partIndex + 1).padStart(3, '0')}${descriptionSuffix}`,
    'Delivery quantity': qty,
  };
}

function writeUploadSamples() {
  writeWorkbook('godam-test-vendors-10.xlsx', 'Vendors', vendorRows());
  writeWorkbook('godam-test-vendor-items-100.xlsx', 'Vendor Items', itemRows());
  writeWorkbook('godam-test-main-stock-100.xlsx', 'Main Stock', mainStockRows());
  writeWorkbook('godam-test-stock-in-multi-location.xlsx', 'Stock In', rackUploadRows());
  writeWorkbook(
    'godam-test-drivers.xlsx',
    'Drivers',
    DRIVER_SAMPLE_ROWS.map(([carrierName, carrierType, driverName, phone, vehicle, remarks]) => ({
      'Carrier Name': carrierName,
      'Carrier Type': carrierType,
      'Driver Name': driverName,
      'Phone Number': phone,
      Vehicle: vehicle,
      Remarks: remarks,
    }))
  );

  const outboundFiles = [
    {
      filename: 'outbound-upload-01-fifo-less-than-oldest.xlsx',
      rows: [
        outboundRow({
          delivery: 'GD-UPLOAD-01',
          salesDoc: 'SO-UPLOAD-01',
          customerReference: 'PO-UPLOAD-01',
          partIndex: 1,
          qty: 5,
        }),
      ],
    },
    {
      filename: 'outbound-upload-02-fifo-oldest-plus-next.xlsx',
      rows: [
        outboundRow({
          delivery: 'GD-UPLOAD-02',
          salesDoc: 'SO-UPLOAD-02',
          customerReference: 'PO-UPLOAD-02',
          partIndex: 0,
          qty: 25,
        }),
      ],
    },
    {
      filename: 'outbound-upload-03-repeated-part-summed.xlsx',
      rows: [
        outboundRow({
          delivery: 'GD-UPLOAD-03',
          salesDoc: 'SO-UPLOAD-03',
          customerReference: 'PO-UPLOAD-03',
          partIndex: 3,
          qty: 15,
          descriptionSuffix: ' repeat line A',
        }),
        outboundRow({
          delivery: 'GD-UPLOAD-03',
          salesDoc: 'SO-UPLOAD-03',
          customerReference: 'PO-UPLOAD-03',
          partIndex: 3,
          qty: 20,
          descriptionSuffix: ' repeat line B',
        }),
      ],
    },
    {
      filename: 'outbound-upload-04-insufficient-stock.xlsx',
      rows: [
        outboundRow({
          delivery: 'GD-UPLOAD-04',
          salesDoc: 'SO-UPLOAD-04',
          customerReference: 'PO-UPLOAD-04',
          partIndex: 4,
          qty: 9999,
        }),
      ],
    },
    {
      filename: 'outbound-upload-05-four-racks-different-dates.xlsx',
      rows: [
        outboundRow({
          delivery: 'GD-UPLOAD-05',
          salesDoc: 'SO-UPLOAD-05',
          customerReference: 'PO-UPLOAD-05',
          partIndex: 5,
          qty: 60,
        }),
      ],
    },
  ];

  for (const file of outboundFiles) writeWorkbook(file.filename, 'Outbound', file.rows);

  writeWorkbook('fifo-outbound-upload-test.xlsx', 'Outbound', outboundFiles.flatMap((f) => f.rows));
}

async function main() {
  await waitForSchema();

  const userIds = {
    admin: await upsertUser({
      username: 'admin',
      role: 'Admin',
      full_name: 'Admin',
      mobile_number: '+966500000000',
      email: 'admin@godam.test',
      web: 1,
      mobile: 1,
    }),
    picker: await upsertUser({
      username: 'picker1',
      role: 'Picker',
      full_name: 'Picker One',
      mobile_number: '+966500000101',
      email: 'picker1@godam.test',
      web: 0,
      mobile: 1,
    }),
    checker: await upsertUser({
      username: 'checker1',
      role: 'Checker',
      full_name: 'Checker One',
      mobile_number: '+966500000102',
      email: 'checker1@godam.test',
      web: 1,
      mobile: 1,
    }),
    driver: await upsertUser({
      username: 'driver1',
      role: 'Driver',
      full_name: 'Driver One',
      mobile_number: '+966500000103',
      email: 'driver1@godam.test',
      web: 0,
      mobile: 1,
    }),
    viewer: await upsertUser({
      username: 'viewer1',
      role: 'Viewer',
      full_name: 'Viewer One',
      mobile_number: '+966500000104',
      email: 'viewer1@godam.test',
      web: 1,
      mobile: 0,
    }),
  };

  const vendors = [];
  for (let i = 0; i < VENDOR_COUNT; i += 1) {
    const [vendor_number, vendor_name, productPrefix] = VENDOR_DEFS[i];
    const id = await upsertVendor({
      vendor_number,
      vendor_name,
      contact_person: `Vendor Contact ${i + 1}`,
      phone_number: `+96651${String(i + 1).padStart(7, '0')}`,
      email: `vendor${i + 1}@godam.test`,
      remarks: 'FIFO test vendor',
    });
    vendors.push({ id, vendor_number, vendor_name, productPrefix });
  }

  await resetTestOutbounds();
  await seedStock(vendors);
  await seedOutbound(userIds);
  await seedCarriers();
  writeUploadSamples();

  const mismatch = await all(
    `SELECT ms.part_number, ms.available_qty, COALESCE(SUM(sbr.available_qty), 0) AS rack_qty
     FROM main_stock ms
     LEFT JOIN stock_by_rack sbr ON sbr.part_number = ms.part_number
     WHERE ms.part_number BETWEEN 'PN-100' AND 'PN-199'
     GROUP BY ms.part_number
     HAVING ABS(COALESCE(ms.available_qty, 0) - COALESCE(SUM(sbr.available_qty), 0)) > 0.000001`
  );
  if (mismatch.length) throw new Error(`Main stock/rack mismatch: ${JSON.stringify(mismatch.slice(0, 5))}`);

  const fifoA = await all(
    `SELECT f.rack_location, f.entry_date, f.suggested_qty
     FROM fifo_suggestions f
     JOIN outbound_orders o ON o.id = f.outbound_order_id
     WHERE o.outbound_number = 'GD-FIFO-A'
     ORDER BY f.fifo_sequence`
  );

  console.log(`Seeded FIFO test data into ${path.resolve(process.env.DB_PATH)}`);
  console.log(`Created ${VENDOR_COUNT} vendors, ${PART_COUNT} part numbers, rack splits, carriers/drivers, and test users.`);
  console.log(`Test user password: ${PASSWORD}`);
  console.log(`Test A FIFO: ${fifoA.map((r) => `${r.rack_location}:${r.suggested_qty}`).join(' -> ')}`);
  console.log(`Sample files written to: ${OUT_DIR}`);
  console.log('Outbound upload files: outbound-upload-01...xlsx through outbound-upload-05...xlsx');
}

main()
  .catch((e) => {
    console.error(e.stack || e.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await close().catch(() => {});
  });
