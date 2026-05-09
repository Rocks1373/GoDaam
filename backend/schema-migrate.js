/**
 * Additive SQLite migrations for GoDam (ALTER TABLE + indexes).
 * Safe to run on every startup.
 */
const { promisify } = require('util');

async function ensureColumn(db, table, column, ddl) {
  const all = promisify(db.all.bind(db));
  const run = promisify(db.run.bind(db));
  const cols = await all(`PRAGMA table_info(${table})`);
  if ((cols || []).some((c) => c.name === column)) return;
  await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

const PERMISSION_DEFS = [
  ['can_view_orders', 'View orders'],
  ['can_pick_orders', 'Pick orders'],
  ['can_confirm_picked', 'Confirm picked'],
  ['can_scan_rack', 'Scan rack'],
  ['can_receive_stock', 'Receive stock'],
  ['can_view_upcoming_orders', 'View upcoming orders'],
  ['can_view_main_stock', 'View main stock'],
  ['can_view_stock_by_rack', 'View stock by rack'],
  ['can_upload_outbound', 'Upload outbound'],
  ['can_manage_users', 'Manage users'],
  ['can_view_picked_table', 'View picked table'],
  ['can_change_pick_location', 'Change pick location'],
  ['can_use_ai', 'Use AI admin assistant'],
  ['can_access_web', 'Access web'],
  ['can_access_mobile', 'Access mobile'],
  ['can_view_transportation', 'View transportation details'],
  ['can_manage_transportation', 'Manage transportation (carriers, drivers, attachments)'],
];

const ROLES_SEED = ['admin', 'picker', 'checker', 'viewer', 'driver'];

async function seedDefaultRolePermissions(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const row = await get('SELECT COUNT(1) as c FROM role_permissions');
  if ((row?.c || 0) > 0) return;

  for (const role of ROLES_SEED) {
    for (const [permission_key, permission_label] of PERMISSION_DEFS) {
      const transportPerm =
        permission_key === 'can_view_transportation' || permission_key === 'can_manage_transportation';
      const isEnabled = role === 'admin' ? 1 : transportPerm ? 0 : 1;
      await run(
        `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [role, permission_key, permission_label, isEnabled]
      );
    }
  }
}

async function migrateGodamSchema(db) {
  const run = promisify(db.run.bind(db));

  await ensureColumn(db, 'users', 'full_name', 'TEXT');
  await ensureColumn(db, 'users', 'mobile_number', 'TEXT');
  await ensureColumn(db, 'users', 'email', 'TEXT');
  await ensureColumn(db, 'users', 'is_active', 'INTEGER DEFAULT 1');
  await ensureColumn(db, 'users', 'token_expiry_days', 'INTEGER DEFAULT 30');
  await ensureColumn(db, 'users', 'updated_at', 'DATETIME');
  await ensureColumn(db, 'users', 'can_access_web', 'INTEGER DEFAULT 1');
  await ensureColumn(db, 'users', 'can_access_mobile', 'INTEGER DEFAULT 1');

  await ensureColumn(db, 'outbound_orders', 'delivery', 'TEXT');
  await ensureColumn(db, 'outbound_orders', 'sales_doc', 'TEXT');
  await ensureColumn(db, 'outbound_orders', 'customer_reference', 'TEXT');
  await ensureColumn(db, 'outbound_orders', 'sold_to', 'TEXT');
  await ensureColumn(db, 'outbound_orders', 'name_1', 'TEXT');
  await ensureColumn(db, 'outbound_orders', 'uploaded_by_user_id', 'INTEGER');
  await ensureColumn(db, 'outbound_orders', 'updated_at', 'DATETIME');

  await ensureColumn(db, 'outbound_items', 'material', 'TEXT');
  await ensureColumn(db, 'outbound_items', 'available_qty_main_stock', 'REAL');
  await ensureColumn(db, 'outbound_items', 'fifo_status', 'TEXT');
  await ensureColumn(db, 'outbound_items', 'shortage_qty', 'REAL DEFAULT 0');

  // Notifications: unread tracking
  await ensureColumn(db, 'notification_log', 'read_at', 'DATETIME');

  // Main Stock — sold-out semantics (received − sold_out − pending = available)
  await ensureColumn(db, 'main_stock', 'sold_out_qty', 'REAL DEFAULT 0');
  await ensureColumn(db, 'main_stock', 'sap_qty', 'REAL');
  await ensureColumn(db, 'main_stock', 'vendor_id', 'INTEGER');
  await ensureColumn(db, 'main_stock', 'vendor_number', 'TEXT');
  await ensureColumn(db, 'main_stock', 'vendor_name', 'TEXT');
  await ensureColumn(db, 'main_stock', 'created_at', 'DATETIME');
  await ensureColumn(db, 'main_stock', 'updated_at', 'DATETIME');
  await run(
    `UPDATE main_stock SET sold_out_qty = COALESCE(issued_qty, 0)
     WHERE COALESCE(sold_out_qty, 0) = 0 AND COALESCE(issued_qty, 0) != 0`
  );

  await run(`
    CREATE TABLE IF NOT EXISTS inbound_receiving (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_date TEXT,
      batch_vendor_name TEXT,
      vendor_id INTEGER,
      vendor_number TEXT,
      vendor_name TEXT,
      invoice_no TEXT,
      po_number TEXT,
      part_number TEXT NOT NULL,
      sap_part_number TEXT,
      description TEXT,
      inbound_qty REAL NOT NULL,
      received_date TEXT,
      reference_no TEXT,
      remarks TEXT,
      uploaded_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);

  // Additive columns for existing DBs
  await ensureColumn(db, 'inbound_receiving', 'transaction_date', 'TEXT');
  await ensureColumn(db, 'inbound_receiving', 'vendor_id', 'INTEGER');
  await ensureColumn(db, 'inbound_receiving', 'vendor_number', 'TEXT');
  await ensureColumn(db, 'inbound_receiving', 'vendor_name', 'TEXT');
  await ensureColumn(db, 'inbound_receiving', 'reference_no', 'TEXT');

  await ensureColumn(db, 'sold_out', 'sap_part_number', 'TEXT');
  await ensureColumn(db, 'sold_out', 'invoice', 'TEXT');
  await ensureColumn(db, 'sold_out', 'po', 'TEXT');
  await ensureColumn(db, 'sold_out', 'outbound_qty', 'REAL');
  await ensureColumn(db, 'sold_out', 'delivery', 'TEXT');
  await ensureColumn(db, 'sold_out', 'sales_doc', 'TEXT');
  await ensureColumn(db, 'sold_out', 'status', 'TEXT');
  await ensureColumn(db, 'sold_out', 'source_dn_id', 'INTEGER');
  await ensureColumn(db, 'sold_out', 'dedupe_key', 'TEXT');
  await run(`UPDATE sold_out SET outbound_qty = sold_qty WHERE outbound_qty IS NULL AND sold_qty IS NOT NULL`);

  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sold_out_dedupe_key ON sold_out(dedupe_key) WHERE dedupe_key IS NOT NULL`);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_stock_by_rack_fifo
    ON stock_by_rack(part_number, sap_part_number, available_qty, first_entry_date, id)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_fifo_suggestions_outbound
    ON fifo_suggestions(outbound_order_id, outbound_item_id)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_picked_tx_order
    ON picked_transactions(outbound_order_id, outbound_item_id)
  `);

  await ensureColumn(db, 'picked_transactions', 'picked_method', 'TEXT');
  await ensureColumn(db, 'picked_transactions', 'is_manual_pick', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'picked_transactions', 'manual_pick_reason', 'TEXT');
  await ensureColumn(db, 'picked_transactions', 'picked_by_role', 'TEXT');
  await run(`UPDATE picked_transactions SET picked_method = 'Mobile' WHERE picked_method IS NULL`);
  await run(`UPDATE picked_transactions SET is_manual_pick = 0 WHERE is_manual_pick IS NULL`);

  await run(`UPDATE users SET can_access_web = 1 WHERE can_access_web IS NULL`);
  await run(`UPDATE users SET can_access_mobile = 1 WHERE can_access_mobile IS NULL`);
  await run(`UPDATE users SET is_active = 1 WHERE is_active IS NULL`);
  await run(`UPDATE users SET token_expiry_days = 30 WHERE token_expiry_days IS NULL`);

  // --- Delivery Notes + Transportation workflow ---
  await run(`
    CREATE TABLE IF NOT EXISTS carriers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      carrier_name TEXT NOT NULL,
      carrier_type TEXT NOT NULL, -- GAPP | Rental | Courier | Self Collection
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS carrier_drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      carrier_id INTEGER NOT NULL,
      driver_name TEXT NOT NULL,
      phone_number TEXT,
      vehicle TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (carrier_id) REFERENCES carriers(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dn_number TEXT,
      dn_date TEXT,
      sales_order_number TEXT,
      gapp_po TEXT,
      customer_po TEXT,
      outbound_number TEXT,
      invoice_number TEXT,
      customer_id INTEGER,
      customer_number TEXT,
      customer_name TEXT,
      delivery_address TEXT,
      gps TEXT,
      contact_person TEXT,
      contact_number TEXT,
      contact_person_2 TEXT,
      contact_number_2 TEXT,
      package_type TEXT, -- Pallet | Box | Ignore
      pallet_qty REAL DEFAULT 0,
      box_qty REAL DEFAULT 0,
      gross_weight_kg REAL DEFAULT 0,
      volume_cbm REAL DEFAULT 0,
      transportation_type TEXT, -- GAPP | Rental | Courier | Self Collection
      carrier_id INTEGER,
      carrier_name TEXT,
      driver_id INTEGER,
      driver_name TEXT,
      driver_mobile TEXT,
      vehicle TEXT,
      truck_type TEXT,
      truck_qty REAL DEFAULT 0,
      waybill_number TEXT,
      collector_name TEXT,
      collector_mobile TEXT,
      transportation_remarks TEXT,
      status TEXT DEFAULT 'Draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      delivered_at DATETIME
    )
  `);

  // Add new contact2 columns for existing DBs
  await ensureColumn(db, 'delivery_notes', 'contact_person_2', 'TEXT');
  await ensureColumn(db, 'delivery_notes', 'contact_number_2', 'TEXT');
  await ensureColumn(db, 'delivery_notes', 'deliver_to_remarks', 'TEXT');
  await ensureColumn(db, 'delivery_notes', 'city_name', 'TEXT');
  await ensureColumn(db, 'delivery_notes', 'email_1', 'TEXT');
  await ensureColumn(db, 'delivery_notes', 'second_email', 'TEXT');
  await ensureColumn(db, 'delivery_notes', 'address_type', 'TEXT');
  await ensureColumn(db, 'delivery_notes', 'address_source', 'TEXT');

  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_notes_outbound ON delivery_notes(outbound_number)`);

  await run(`
    CREATE TABLE IF NOT EXISTS delivery_note_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dn_id INTEGER NOT NULL,
      item_no INTEGER,
      part_number TEXT,
      sap_part_number TEXT,
      description TEXT,
      qty REAL,
      uom TEXT,
      serial_no TEXT,
      condition_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (dn_id) REFERENCES delivery_notes(id)
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_delivery_note_items_dn ON delivery_note_items(dn_id, item_no)`);

  await run(`
    CREATE TABLE IF NOT EXISTS delivered (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dn_id INTEGER,
      dn_number TEXT,
      delivered_date TEXT,
      sales_order_number TEXT,
      gapp_po TEXT,
      customer_po TEXT,
      outbound_number TEXT,
      invoice_number TEXT,
      customer_number TEXT,
      customer_name TEXT,
      delivery_address TEXT,
      gps TEXT,
      contact_person TEXT,
      contact_number TEXT,
      transportation_type TEXT,
      carrier_name TEXT,
      driver_name TEXT,
      driver_mobile TEXT,
      vehicle TEXT,
      truck_type TEXT,
      truck_qty REAL,
      waybill_number TEXT,
      package_type TEXT,
      pallet_qty REAL,
      box_qty REAL,
      gross_weight_kg REAL,
      volume_cbm REAL,
      part_number TEXT,
      sap_part_number TEXT,
      description TEXT,
      delivered_qty REAL,
      uom TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_delivered_dn ON delivered(dn_id, created_at)`);
  await ensureColumn(db, 'delivered', 'deliver_to_remarks', 'TEXT');
  await ensureColumn(db, 'delivered', 'city_name', 'TEXT');
  await ensureColumn(db, 'delivered', 'email_1', 'TEXT');
  await ensureColumn(db, 'delivered', 'second_email', 'TEXT');
  await ensureColumn(db, 'delivered', 'contact_person_2', 'TEXT');
  await ensureColumn(db, 'delivered', 'contact_number_2', 'TEXT');
  await ensureColumn(db, 'delivered', 'address_type', 'TEXT');
  await ensureColumn(db, 'delivered', 'address_source', 'TEXT');

  // --- Vendors + Vendor Items (Admin only master data) ---
  await run(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_number TEXT,
      vendor_name TEXT NOT NULL,
      contact_person TEXT,
      phone_number TEXT,
      email TEXT,
      remarks TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_vendor_number_unique
     ON vendors(vendor_number)
     WHERE vendor_number IS NOT NULL AND TRIM(vendor_number) != ''`
  );

  await run(`
    CREATE TABLE IF NOT EXISTS vendor_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER,
      vendor_number TEXT,
      vendor_name TEXT,
      sap_part_number TEXT,
      part_number TEXT NOT NULL,
      description TEXT NOT NULL,
      uom TEXT,
      remarks TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendor_id) REFERENCES vendors(id)
    )
  `);
  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_items_vendor_part
    ON vendor_items(COALESCE(vendor_id, -1), TRIM(part_number))
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_vendor_items_search
     ON vendor_items(TRIM(part_number), TRIM(COALESCE(sap_part_number,'')), TRIM(COALESCE(description,'')), TRIM(COALESCE(vendor_name,'')))`
  );

  // --- Customers: multi-address rows (natural key: customer_number + city + address) ---
  await run(`DROP INDEX IF EXISTS idx_customers_customer_number_unique`);
  await ensureColumn(db, 'customers', 'contact_person_number_1', 'TEXT');
  await ensureColumn(db, 'customers', 'designation_job_title_2', 'TEXT');
  await ensureColumn(db, 'customers', 'address_type', `TEXT DEFAULT 'permanent'`);
  await run(`UPDATE customers SET contact_person_number_1 = contact_person_number WHERE contact_person_number_1 IS NULL AND contact_person_number IS NOT NULL`);
  await run(`UPDATE customers SET designation_job_title_2 = designation_job_2 WHERE designation_job_title_2 IS NULL AND designation_job_2 IS NOT NULL`);
  await run(`UPDATE customers SET address_type = 'permanent' WHERE address_type IS NULL OR TRIM(address_type) = ''`);
  try {
    await run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_number_city_address
      ON customers (
        TRIM(COALESCE(customer_number, '')),
        TRIM(COALESCE(city_name, '')),
        TRIM(COALESCE(address, ''))
      )
    `);
  } catch (e) {
    console.warn('[migrate] idx_customers_number_city_address:', e.message);
  }

  // --- Customer locations (multi-site delivery addresses) ---
  await run(`
    CREATE TABLE IF NOT EXISTS customer_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      label TEXT,
      address TEXT,
      gps TEXT,
      contact_person TEXT,
      contact_number TEXT,
      contact_person_2 TEXT,
      contact_number_2 TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_customer_locations_customer ON customer_locations(customer_id, is_active, id)`);

  // --- Inbound batches / putaway (GoDam receiving workflow) ---
  await run(`
    CREATE TABLE IF NOT EXISTS inbound_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_name TEXT NOT NULL,
      vendor_name TEXT,
      upload_date TEXT,
      status TEXT DEFAULT 'Pending',
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS inbound_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inbound_batch_id INTEGER NOT NULL,
      part_number TEXT NOT NULL,
      sap_part_number TEXT,
      description TEXT,
      total_qty REAL NOT NULL,
      putaway_qty REAL DEFAULT 0,
      remaining_qty REAL NOT NULL,
      status TEXT DEFAULT 'Pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inbound_batch_id) REFERENCES inbound_batches(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_inbound_items_batch ON inbound_items(inbound_batch_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_inbound_items_part ON inbound_items(part_number)`);

  await run(`
    CREATE TABLE IF NOT EXISTS inbound_putaway_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inbound_item_id INTEGER NOT NULL,
      inbound_batch_id INTEGER NOT NULL,
      part_number TEXT NOT NULL,
      rack_location TEXT NOT NULL,
      qty REAL NOT NULL,
      transaction_date TEXT NOT NULL,
      user_name TEXT,
      remarks TEXT,
      applied_to_rack INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inbound_item_id) REFERENCES inbound_items(id),
      FOREIGN KEY (inbound_batch_id) REFERENCES inbound_batches(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_putaway_lines_item ON inbound_putaway_lines(inbound_item_id, applied_to_rack)`);

  await run(`
    CREATE TABLE IF NOT EXISTS outbound_order_seen (
      user_id INTEGER NOT NULL,
      outbound_order_id INTEGER NOT NULL,
      seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, outbound_order_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (outbound_order_id) REFERENCES outbound_orders(id)
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_outbound_seen_order ON outbound_order_seen(outbound_order_id)`
  );

  // --- Delivery workflow (GAPP driver flow + final lock) ---
  await ensureColumn(db, 'delivery_notes', 'delivery_status', "TEXT DEFAULT 'Draft'");
  await ensureColumn(db, 'delivery_notes', 'confirmed_at', 'DATETIME');
  await ensureColumn(db, 'delivery_notes', 'confirmed_by', 'INTEGER');
  await ensureColumn(db, 'delivery_notes', 'driver_task_id', 'INTEGER');
  await ensureColumn(db, 'delivery_notes', 'driver_opened_at', 'DATETIME');
  await ensureColumn(db, 'delivery_notes', 'pickup_confirmed_at', 'DATETIME');
  await ensureColumn(db, 'delivery_notes', 'out_for_delivery_at', 'DATETIME');
  await ensureColumn(db, 'delivery_notes', 'pod_file_path', 'TEXT');
  await ensureColumn(db, 'delivery_notes', 'pod_uploaded_at', 'DATETIME');
  await ensureColumn(db, 'delivery_notes', 'closed_at', 'DATETIME');
  await ensureColumn(db, 'delivery_notes', 'closed_by', 'INTEGER');
  await ensureColumn(db, 'delivery_notes', 'is_closed', 'INTEGER DEFAULT 0');

  await run(`
    CREATE TABLE IF NOT EXISTS driver_delivery_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dn_id INTEGER NOT NULL,
      outbound_number TEXT,
      invoice_number TEXT,
      customer_name TEXT,
      delivery_address TEXT,
      city_name TEXT,
      gps_link TEXT,
      latitude REAL,
      longitude REAL,
      sequence_no INTEGER,
      contact_person TEXT,
      contact_number TEXT,
      driver_user_id INTEGER,
      driver_name TEXT,
      driver_mobile TEXT,
      status TEXT DEFAULT 'Confirmed',
      confirmed_at DATETIME,
      opened_at DATETIME,
      pickup_confirmed_at DATETIME,
      out_for_delivery_at DATETIME,
      pod_uploaded_at DATETIME,
      pod_file_path TEXT,
      closed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (dn_id) REFERENCES delivery_notes(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_driver_tasks_dn ON driver_delivery_tasks(dn_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_driver_tasks_driver ON driver_delivery_tasks(driver_user_id)`);
  await ensureColumn(db, 'driver_delivery_tasks', 'latitude', 'REAL');
  await ensureColumn(db, 'driver_delivery_tasks', 'longitude', 'REAL');
  await ensureColumn(db, 'driver_delivery_tasks', 'sequence_no', 'INTEGER');

  // --- AI admin assistant: action audit log ---
  await run(`
    CREATE TABLE IF NOT EXISTS ai_action_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      role TEXT,
      command TEXT,
      tool_name TEXT,
      tool_args_json TEXT,
      result_json TEXT,
      status TEXT DEFAULT 'ok',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_ai_action_logs_created ON ai_action_logs(created_at DESC)`);

  // --- AI floating agent logs (web widget) ---
  await run(`
    CREATE TABLE IF NOT EXISTS ai_agent_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      role TEXT,
      message TEXT,
      response_summary TEXT,
      tools_used TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_ai_agent_logs_created ON ai_agent_logs(created_at DESC)`);

  // --- Driver route planner (manual order + auto-sort) ---
  await run(`
    CREATE TABLE IF NOT EXISTS driver_route_stops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_user_id INTEGER NOT NULL,
      driver_delivery_task_id INTEGER NOT NULL,
      outbound_number TEXT,
      customer_name TEXT,
      city_name TEXT,
      gps_link TEXT,
      latitude REAL,
      longitude REAL,
      sequence_no INTEGER,
      route_status TEXT DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(driver_user_id, driver_delivery_task_id),
      FOREIGN KEY (driver_user_id) REFERENCES users(id),
      FOREIGN KEY (driver_delivery_task_id) REFERENCES driver_delivery_tasks(id)
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_driver_route_stops_driver_status
     ON driver_route_stops(driver_user_id, route_status, sequence_no, id)`
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_driver_route_stops_task
     ON driver_route_stops(driver_delivery_task_id)`
  );

  // --- Transportation Details (replaces legacy carriers / carrier_drivers master data) ---
  await run(`
    CREATE TABLE IF NOT EXISTS transportation_carriers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      carrier_type TEXT NOT NULL,
      carrier_name TEXT NOT NULL,
      contact_person TEXT,
      phone_number TEXT,
      email TEXT,
      remarks TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS transportation_drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      carrier_id INTEGER NOT NULL,
      carrier_type TEXT NOT NULL,
      carrier_name TEXT NOT NULL,
      driver_name TEXT NOT NULL,
      driver_phone TEXT NOT NULL,
      iqama_number TEXT,
      iqama_expiry TEXT,
      license_number TEXT,
      license_expiry TEXT,
      national_id TEXT,
      vehicle_number TEXT,
      vehicle_type TEXT,
      vehicle_document_number TEXT,
      vehicle_document_expiry TEXT,
      insurance_number TEXT,
      insurance_expiry TEXT,
      fahas_number TEXT,
      fahas_expiry TEXT,
      remarks TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      auto_warning TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (carrier_id) REFERENCES transportation_carriers(id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS transportation_driver_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driver_id INTEGER NOT NULL,
      attachment_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_mime_type TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      uploaded_by INTEGER,
      FOREIGN KEY (driver_id) REFERENCES transportation_drivers(id),
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_tdrivers_carrier ON transportation_drivers(carrier_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_tdrivers_type ON transportation_drivers(carrier_type)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_tattach_driver ON transportation_driver_attachments(driver_id)`);

  const get = promisify(db.get.bind(db));
  const nNew = await get(`SELECT COUNT(1) as c FROM transportation_carriers`);
  const nOld = await get(`SELECT COUNT(1) as c FROM carriers`);
  // --- OCR Center (web) — templates + results; does not touch stock/DN/picking ---
  await run(`
    CREATE TABLE IF NOT EXISTS ocr_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_name TEXT NOT NULL,
      party_name TEXT,
      document_type TEXT NOT NULL,
      description TEXT,
      field_mappings_json TEXT NOT NULL DEFAULT '{}',
      table_mappings_json TEXT NOT NULL DEFAULT '{}',
      split_rules_json TEXT,
      sample_file_path TEXT,
      is_active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_ocr_templates_doc_type ON ocr_templates(document_type, is_active)`);
  await run(`
    CREATE TABLE IF NOT EXISTS ocr_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER,
      document_type TEXT NOT NULL,
      original_file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      extracted_header_json TEXT,
      extracted_items_json TEXT,
      raw_ocr_json TEXT,
      confidence_score REAL,
      status TEXT NOT NULL DEFAULT 'Draft',
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (template_id) REFERENCES ocr_templates(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_ocr_results_created ON ocr_results(created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_ocr_results_status ON ocr_results(status)`);
  await run(`
    CREATE TABLE IF NOT EXISTS ocr_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`INSERT OR IGNORE INTO ocr_settings (id, settings_json) VALUES (1, '{}')`);

  // Huawei module — GoDam-1.0 Streamlit/tool URL + launch audit (same SQLite DB as warehouse).
  await run(`
    CREATE TABLE IF NOT EXISTS huawei_godam_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      external_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:8501',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const defaultHuaweiGodamUrl =
    process.env.HUAWEI_GODAM_URL || process.env.GODAM_10_URL || 'http://127.0.0.1:8501';
  await run(`INSERT OR IGNORE INTO huawei_godam_settings (id, external_url) VALUES (1, ?)`, [
    defaultHuaweiGodamUrl,
  ]);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_godam_launch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      target_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_godam_launch_created ON huawei_godam_launch_log(created_at DESC)`);

  await run(`
    CREATE TABLE IF NOT EXISTS sap_stock_upload_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      upload_date TEXT NOT NULL,
      uploaded_by INTEGER,
      total_rows INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Uploaded',
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_upload_batches_created ON sap_stock_upload_batches(created_at DESC)`);

  await run(`
    CREATE TABLE IF NOT EXISTS sap_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_batch_id INTEGER NOT NULL,
      vendor_number TEXT,
      material TEXT,
      sap_part_number TEXT,
      description TEXT,
      storage_location TEXT,
      storage_location_description TEXT,
      stock_qty REAL,
      storage_document TEXT,
      batch TEXT,
      unrestricted_qty REAL,
      base_uom TEXT,
      value_amount REAL,
      material_group TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      uploaded_by INTEGER,
      FOREIGN KEY (upload_batch_id) REFERENCES sap_stock_upload_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_stock_batch ON sap_stock(upload_batch_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_stock_material ON sap_stock(material)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_stock_sl ON sap_stock(storage_location)`);

  await run(`
    CREATE TABLE IF NOT EXISTS rack_balance_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_by_rack_id INTEGER NOT NULL,
      part_number TEXT NOT NULL,
      rack_location TEXT NOT NULL,
      delta_qty REAL NOT NULL,
      balance_after_available REAL,
      balance_after_total_in REAL,
      balance_after_total_out REAL,
      first_entry_date_before TEXT,
      first_entry_date_after TEXT,
      remarks TEXT,
      affected_orders_json TEXT,
      created_by_user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_by_rack_id) REFERENCES stock_by_rack(id),
      FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_rack_adj_created ON rack_balance_adjustments(created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_rack_adj_part ON rack_balance_adjustments(part_number)`);

  if ((nNew?.c || 0) === 0 && (nOld?.c || 0) > 0) {
    await run(`
      INSERT INTO transportation_carriers (id, carrier_type, carrier_name, contact_person, phone_number, email, remarks, status, created_at, updated_at)
      SELECT id, carrier_type, carrier_name, NULL, NULL, NULL, NULL,
             CASE WHEN COALESCE(is_active,1) = 1 THEN 'Active' ELSE 'Inactive' END,
             COALESCE(created_at, CURRENT_TIMESTAMP), COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM carriers
    `);
    await run(`
      INSERT INTO transportation_drivers (
        id, carrier_id, carrier_type, carrier_name, driver_name, driver_phone,
        iqama_number, iqama_expiry, license_number, license_expiry, national_id,
        vehicle_number, vehicle_type, vehicle_document_number, vehicle_document_expiry,
        insurance_number, insurance_expiry, fahas_number, fahas_expiry,
        remarks, status, auto_warning, created_at, updated_at
      )
      SELECT
        d.id, d.carrier_id, c.carrier_type, c.carrier_name, d.driver_name, COALESCE(d.phone_number, ''),
        NULL, NULL, NULL, NULL, NULL,
        NULLIF(TRIM(COALESCE(d.vehicle, '')), ''), NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL,
        CASE WHEN COALESCE(d.is_active,1) = 1 THEN 'Active' ELSE 'Inactive' END,
        '',
        COALESCE(d.created_at, CURRENT_TIMESTAMP), COALESCE(d.updated_at, CURRENT_TIMESTAMP)
      FROM carrier_drivers d
      JOIN carriers c ON c.id = d.carrier_id
    `);
    await run(`DELETE FROM carrier_drivers`);
    await run(`DELETE FROM carriers`);
  }

  await seedDefaultRolePermissions(db);
  await ensureTransportationPermissionRows(db);
}

/** Additive permissions for existing DBs (seedDefaultRolePermissions only runs on empty table). */
async function ensureTransportationPermissionRows(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const extra = [
    ['can_view_transportation', 'View transportation details'],
    ['can_manage_transportation', 'Manage transportation (carriers, drivers, attachments)'],
    ['can_use_ai', 'Use AI admin assistant'],
  ];
  for (const role of ROLES_SEED) {
    for (const [key, label] of extra) {
      const row = await get(`SELECT id FROM role_permissions WHERE role = ? AND permission_key = ?`, [role, key]);
      if (row) continue;
      const enabled = role === 'admin' ? 1 : 0;
      await run(
        `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [role, key, label, enabled]
      );
    }
  }
}

module.exports = { migrateGodamSchema, seedDefaultRolePermissions, PERMISSION_DEFS, ROLES_SEED };
