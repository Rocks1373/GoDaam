/**
 * Additive SQLite migrations for GoDam (ALTER TABLE + indexes).
 * Safe to run on every startup.
 */
const { promisify } = require('util');

function isPostgresDb(db) {
  return db && db.dialect === 'postgres';
}

function pgColumnTypeFromSqliteDdl(ddl) {
  return String(ddl)
    .replace(/\bDATETIME\b/gi, 'TIMESTAMP')
    .replace(/\bDATE\b/gi, 'DATE')
    .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
    .replace(/\bINTEGER\b/gi, 'INTEGER')
    .replace(/\bTEXT\b/gi, 'TEXT');
}

async function ensureColumn(db, table, column, ddl) {
  const run = promisify(db.run.bind(db));
  if (isPostgresDb(db)) {
    const get = promisify(db.get.bind(db));
    const row = await get(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
      [String(table).toLowerCase(), String(column).toLowerCase()]
    );
    if (row) return;
    const pgType = pgColumnTypeFromSqliteDdl(ddl);
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${pgType}`);
    return;
  }
  const all = promisify(db.all.bind(db));
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
  ['can_update_rack_mobile', 'Mobile: update stock by rack (batch scan)'],
  ['can_pick_from_rack_mobile', 'Mobile: pick from selected racks'],
  ['can_add_rack_stock_mobile', 'Mobile: add rack stock during pick'],
  ['can_adjust_rack_mobile', 'Mobile: adjust rack quantity (physical count correction)'],
  ['can_confirm_order_picked_mobile', 'Mobile: confirm order picked'],
  ['can_view_rack_update_report', 'View rack update report'],
  ['can_view_picking_by_rack_report', 'View picking by rack report'],
  ['can_view_order_pick_status', 'View order-wise pick status report'],
  ['can_print_order_pick_status', 'Print order-wise pick status report'],
  ['can_export_order_pick_status', 'Export order-wise pick status to Excel'],
  ['can_edit_pick_details', 'Edit pick details from pick status report'],
  ['can_upload_outbound', 'Upload outbound'],
  ['can_manage_users', 'Manage users'],
  ['can_view_picked_table', 'View picked table'],
  ['can_change_pick_location', 'Change pick location'],
  ['can_use_ai', 'Use AI admin assistant'],
  ['can_access_web', 'Access web'],
  ['can_access_mobile', 'Access mobile'],
  ['can_view_transportation', 'View transportation details'],
  ['can_manage_transportation', 'Manage transportation (carriers, drivers, attachments)'],
  ['can_view_driver_gps', 'View live driver GPS and location history'],
  ['can_view_document_center', 'View Sales Order Document Center'],
  ['can_upload_customer_po', 'Upload customer PO to Drive'],
  ['can_upload_invoice', 'Upload invoice to Drive'],
  ['can_upload_delivery_note', 'Upload delivery note to Drive'],
  ['can_upload_pod', 'Upload POD to Drive'],
  ['can_view_pod_page_picker', 'View POD Page Picker Center'],
  ['can_upload_pod_from_page_picker', 'Upload POD from Page Picker'],
  ['can_override_existing_pod', 'Override existing POD from Page Picker'],
  ['can_upload_accounting_document', 'Upload accounting document to Drive'],
  ['can_upload_order_images', 'Upload order images to Drive'],
  ['can_verify_pod', 'Verify POD documents'],
  ['can_replace_documents', 'Replace or version Drive documents'],
  ['can_download_documents', 'Download / export Drive document packages'],
  ['can_view_document_tracking_report', 'View document tracking report'],
  ['can_view_delivery_notes', 'View delivery notes (read-only — download DN/POD, no edits)'],
  ['can_use_whatsapp_messenger', 'WhatsApp messenger (linked WhatsApp Web + chat archive)'],
  ['can_view_followups', 'View follow-up notes and reminders'],
  ['can_manage_followups', 'Create and manage follow-up notes and reminders'],
];

const ROLES_SEED = ['admin', 'picker', 'checker', 'viewer', 'driver'];

/**
 * PostgreSQL databases created by older migrate-sqlite-to-postgres.js used
 * `BIGINT PRIMARY KEY` without IDENTITY/SERIAL, so INSERTs that omit `id` fail with
 * "null value in column id violates not-null constraint". Attach a per-table sequence + DEFAULT.
 */
async function repairPostgresMissingIdDefaults(db) {
  if (!isPostgresDb(db)) return;
  const get = promisify(db.get.bind(db));
  const all = promisify(db.all.bind(db));
  const run = promisify(db.run.bind(db));

  let rows;
  try {
    rows = await all(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id' AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
      WHERE c.relkind = 'r'
        AND ad.adbin IS NULL
        AND COALESCE(a.attidentity, '') = ''
        AND a.atttypid IN ('int8'::regtype, 'int4'::regtype)
      ORDER BY c.relname
    `);
  } catch (e) {
    console.warn('[repairPostgresMissingIdDefaults] scan:', e.message);
    return;
  }

  for (const row of rows || []) {
    const t = String(row.table_name || '');
    if (!/^[a-z][a-z0-9_]*$/i.test(t)) continue;
    const seq = `${t}_id_seq`;
    try {
      await run(`CREATE SEQUENCE IF NOT EXISTS ${seq} AS bigint`);
    } catch (e) {
      console.warn(`[repairPostgresMissingIdDefaults] CREATE SEQUENCE ${seq}:`, e.message);
      continue;
    }
    try {
      const mx = await get(`SELECT COALESCE(MAX(id), 0)::bigint AS m FROM ${t}`);
      const next = Math.max(1, Number(mx?.m || 0) + 1);
      await run(`SELECT setval('${seq}', ?, false)`, [next]);
    } catch (e) {
      console.warn(`[repairPostgresMissingIdDefaults] setval ${t}:`, e.message);
    }
    try {
      await run(`ALTER TABLE ${t} ALTER COLUMN id SET DEFAULT nextval('${seq}'::regclass)`);
    } catch (e) {
      console.warn(`[repairPostgresMissingIdDefaults] SET DEFAULT ${t}:`, e.message);
    }
    try {
      await run(`ALTER SEQUENCE ${seq} OWNED BY ${t}.id`);
    } catch (_) {
      /* optional */
    }
  }
}

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

async function migrateWarehouseLayer(db) {
  const run = promisify(db.run.bind(db));
  const get = promisify(db.get.bind(db));
  const all = promisify(db.all.bind(db));
  const pg = isPostgresDb(db);

  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS warehouses (
        id SERIAL PRIMARY KEY,
        warehouse_code TEXT NOT NULL,
        warehouse_name TEXT NOT NULL,
        location TEXT,
        manager_name TEXT,
        remarks TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (warehouse_code)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS user_warehouses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        role_in_warehouse TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, warehouse_id)
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_user_warehouses_wh ON user_warehouses(warehouse_id)`);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS warehouses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_code TEXT NOT NULL UNIQUE,
        warehouse_name TEXT NOT NULL,
        location TEXT,
        manager_name TEXT,
        remarks TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS user_warehouses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        warehouse_id INTEGER NOT NULL,
        role_in_warehouse TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
        UNIQUE (user_id, warehouse_id)
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_user_warehouses_wh ON user_warehouses(warehouse_id)`);
  }

  const whCount = await get(`SELECT COUNT(1) AS c FROM warehouses`);
  if (!(Number(whCount?.c) > 0)) {
    await run(
      `INSERT INTO warehouses (warehouse_code, warehouse_name, location, manager_name, remarks, is_active)
       VALUES ('WH1', 'Main Warehouse', NULL, NULL, 'Default warehouse for legacy data', 1)`
    );
  }
  let wh2 = await get(`SELECT id FROM warehouses WHERE lower(warehouse_code) = 'wh2' LIMIT 1`);
  if (!wh2) {
    await run(
      `INSERT INTO warehouses (warehouse_code, warehouse_name, location, manager_name, remarks, is_active)
       VALUES ('WH2', 'Warehouse 2', NULL, NULL, 'Second warehouse site', 1)`
    );
    wh2 = await get(`SELECT id FROM warehouses WHERE lower(warehouse_code) = 'wh2' LIMIT 1`);
  }
  if (wh2?.id) {
    await run(
      `UPDATE users SET default_warehouse_id = ? WHERE lower(role) = 'admin' AND default_warehouse_id IS NULL`,
      [Number(wh2.id)]
    );
  }

  await ensureColumn(db, 'warehouses', 'manager_user_id', pg ? 'INTEGER REFERENCES users(id)' : 'INTEGER');

  const defaultWh = await get(`SELECT id FROM warehouses WHERE lower(warehouse_code) = 'wh1' ORDER BY id LIMIT 1`);
  const defaultWhId = Number(defaultWh?.id) || 1;

  await ensureColumn(db, 'users', 'default_warehouse_id', `INTEGER REFERENCES warehouses(id)`);
  /** Official / registration number — returned only to admins (see listWarehousesForUser, GET /warehouses). */
  await ensureColumn(db, 'warehouses', 'warehouse_number', 'TEXT');

  const opTables = [
    'main_stock',
    'stock_by_rack',
    'stock_by_rack_legacy',
    'stock_in',
    'stock_out',
    'inbound_receiving',
    'inbound_batches',
    'inbound_items',
    'outbound_orders',
    'outbound_items',
    'fifo_suggestions',
    'picked_transactions',
    'picked_orders',
    'delivery_notes',
    'delivery_note_items',
    'delivered',
    'sold_out',
    'driver_delivery_tasks',
    'notification_log',
    'rack_balance_adjustments',
    'inbound_putaway_lines',
  ];

  for (const t of opTables) {
    try {
      if (pg) {
        const exists = await get(
          `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?`,
          [String(t).toLowerCase()]
        );
        if (!exists) continue;
      } else {
        const exists = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [t]);
        if (!exists) continue;
      }
      await ensureColumn(db, t, 'warehouse_id', `INTEGER NOT NULL DEFAULT ${defaultWhId}`);
    } catch (e) {
      console.warn(`[migrateWarehouseLayer] skip ${t}:`, e.message);
    }
  }

  await ensureColumn(db, 'sap_stock', 'warehouse_id', `INTEGER REFERENCES warehouses(id)`);

  if (!pg) {
    for (let n = 1; n <= 5; n += 1) {
      try {
        await run(`DROP INDEX IF EXISTS sqlite_autoindex_main_stock_${n}`);
      } catch (_) {
        /* ignore */
      }
    }
  }

  if (!pg) {
    try {
      await run(`DROP INDEX IF EXISTS idx_main_stock_wh_part`);
      await run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_main_stock_wh_part ON main_stock(warehouse_id, part_number)`
      );
    } catch (e) {
      console.warn('[migrateWarehouseLayer] main_stock unique:', e.message);
    }
    try {
      await run(`DROP INDEX IF EXISTS idx_stock_by_rack_summary_unique`);
      await run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_by_rack_summary_unique ON stock_by_rack(warehouse_id, part_number, rack_location)`
      );
    } catch (e) {
      console.warn('[migrateWarehouseLayer] stock_by_rack unique:', e.message);
    }
    try {
      await run(`DROP INDEX IF EXISTS idx_stock_by_rack_legacy_unique`);
      await run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_by_rack_legacy_unique ON stock_by_rack_legacy(warehouse_id, part_number, rack_location, entry_date)`
      );
    } catch (e) {
      console.warn('[migrateWarehouseLayer] legacy rack unique:', e.message);
    }
  } else {
    try {
      await run(`DROP INDEX IF EXISTS idx_main_stock_wh_part`);
      await run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_main_stock_wh_part ON main_stock(warehouse_id, part_number)`
      );
    } catch (e) {
      console.warn('[migrateWarehouseLayer] pg main_stock unique:', e.message);
    }
    try {
      await run(`DROP INDEX IF EXISTS idx_stock_by_rack_summary_unique`);
      await run(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_by_rack_summary_unique ON stock_by_rack(warehouse_id, part_number, rack_location)`
      );
    } catch (e) {
      console.warn('[migrateWarehouseLayer] pg stock_by_rack unique:', e.message);
    }
  }

  const usersNeeding = await all(
    `SELECT u.id FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_warehouses uw WHERE uw.user_id = u.id)`
  );
  for (const u of usersNeeding || []) {
    const uid = Number(u.id);
    if (!uid) continue;
    const roleRow = await get(`SELECT role FROM users WHERE id = ?`, [uid]);
    const role = String(roleRow?.role || '').toLowerCase();
    const rw = role === 'admin' ? 'admin' : String(roleRow?.role || 'member');
    await run(
      `INSERT OR IGNORE INTO user_warehouses (user_id, warehouse_id, role_in_warehouse, is_default)
       VALUES (?, ?, ?, 1)`,
      [uid, defaultWhId, rw]
    );
  }

  await run(`UPDATE users SET default_warehouse_id = ? WHERE default_warehouse_id IS NULL`, [defaultWhId]);
}

async function migrateGodamSchema(db) {
  const rawRun = promisify(db.run.bind(db));
  const run = async (sql, params) => {
    if (isPostgresDb(db) && /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(String(sql))) {
      return undefined;
    }
    if (params !== undefined && params !== null) return rawRun(sql, params);
    return rawRun(sql);
  };

  await repairPostgresMissingIdDefaults(db);

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
  await ensureColumn(db, 'picked_orders', 'reversed_at', 'DATETIME');
  await ensureColumn(db, 'picked_orders', 'reversed_by_user_id', 'INTEGER');
  await ensureColumn(db, 'picked_orders', 'reversed_by_user_name', 'TEXT');
  await ensureColumn(db, 'picked_orders', 'reversal_reason', 'TEXT');
  await ensureColumn(db, 'picked_orders', 'reversal_snapshot_json', 'TEXT');
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

  await migrateDriverLocationTables(db);

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
      item_sd TEXT,
      sales_document TEXT,
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
  await ensureColumn(db, 'sap_stock', 'item_sd', 'TEXT');
  await ensureColumn(db, 'sap_stock', 'sales_document', 'TEXT');

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

  // --- Parent / child BOM (optional picking expansion) ---
  await run(`
    CREATE TABLE IF NOT EXISTS part_bom_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_part_number TEXT NOT NULL COLLATE NOCASE,
      parent_sap_part_number TEXT,
      parent_description TEXT,
      parent_is_physical INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(parent_part_number),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS part_bom_children (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_set_id INTEGER NOT NULL,
      parent_part_number TEXT NOT NULL COLLATE NOCASE,
      child_part_number TEXT NOT NULL COLLATE NOCASE,
      child_sap_part_number TEXT,
      child_description TEXT,
      child_qty_per_parent REAL NOT NULL,
      uom TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bom_set_id) REFERENCES part_bom_sets(id) ON DELETE CASCADE,
      UNIQUE(bom_set_id, child_part_number)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_part_bom_children_child ON part_bom_children(child_part_number)`);
  await run(`
    CREATE TABLE IF NOT EXISTS outbound_bom_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbound_order_id INTEGER NOT NULL,
      outbound_item_id INTEGER NOT NULL,
      parent_part_number TEXT,
      parent_sap_part_number TEXT,
      parent_description TEXT,
      parent_required_qty REAL NOT NULL DEFAULT 0,
      child_part_number TEXT NOT NULL,
      child_sap_part_number TEXT,
      child_description TEXT,
      child_qty_per_parent REAL NOT NULL,
      required_child_qty REAL NOT NULL,
      picked_child_qty REAL DEFAULT 0,
      status TEXT DEFAULT 'Pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (outbound_order_id) REFERENCES outbound_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (outbound_item_id) REFERENCES outbound_items(id) ON DELETE CASCADE
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_obr_order ON outbound_bom_requirements(outbound_order_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_obr_item ON outbound_bom_requirements(outbound_item_id)`);

  await ensureColumn(db, 'fifo_suggestions', 'outbound_bom_requirement_id', 'INTEGER');
  await ensureColumn(db, 'fifo_suggestions', 'parent_part_number', 'TEXT');
  await ensureColumn(db, 'fifo_suggestions', 'is_bom_expansion', 'INTEGER DEFAULT 0');

  await ensureColumn(db, 'picked_transactions', 'outbound_bom_requirement_id', 'INTEGER');
  await ensureColumn(db, 'picked_transactions', 'parent_part_number', 'TEXT');
  await ensureColumn(db, 'picked_transactions', 'child_part_number', 'TEXT');
  await ensureColumn(db, 'picked_transactions', 'is_bom_pick', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'picked_transactions', 'child_qty_per_parent', 'REAL');

  await ensureColumn(db, 'delivery_notes', 'show_bom_child_lines', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'delivery_notes', 'is_huawei_source', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'delivery_notes', 'reseller_name', 'TEXT');
  await ensureColumn(db, 'delivery_notes', 'huawei_contract', 'TEXT');
  await ensureColumn(db, 'delivery_note_items', 'box_name', 'TEXT');

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
  await ensureDriverGpsPermissionRows(db);
  await ensureMobileRackPermissionRows(db);
  await ensureOrderPickStatusPermissionRows(db);
  await ensureManagerOutboundDeliveryRows(db);
  await ensureHuaweiPermissionRows(db);
  await ensureManagerRolePermissions(db);
  await migrateWarehouseLayer(db);
  await migrateAuditLogs(db);
  await migrateOutboundOrderDocuments(db);
  await migrateSalesOrderCloudStorage(db);
  await migrateSalesOrderOrderImagesFolder(db);
  await migrateSalesOrderDocumentValidation(db);
  await migrateSapPoModule(db);
  await migrateOutboundDocumentWorkflows(db);
  await migrateDocumentFlowExtras(db);
  await migrateWhatsAppChatTables(db);
  await ensureDocumentCenterPermissionRows(db);
  await ensureWhatsAppMessengerPermissionRows(db);
  await ensureViewerReadOnlyRolePermissions(db);
  await migrateHuaweiWorkflow(db);
  await migrateHuaweiOrdersModule(db);
  await migrateHuaweiV2Enhancement(db);
  await migrateUserTablePreferences(db);
  await migrateHuaweiReceiveWorkflow(db);
  await migrateHuaweiDnRefresh(db);
  await migrateHuaweiCustomerOrders(db);
  await migrateHuaweiWorkflowPages(db);
  await ensureHuaweiOrderModulePermissions(db);
  await migrateGoogleAuth(db);
  await migrateGoogleDriveOAuth(db);
  await migrateGoogleDriveSettings(db);
  await migrateWarehouseUniqueness(db);
  await migrateAuthSecurity(db);
  await migrateOutboundPickProof(db);
  await migrateInboundShipmentRefs(db);
  await migrateAiLogs(db);
  await migrateCustomerServiceTables(db);
  await migrateFollowupNotesModule(db);
  await migrateInboundItemMasterTables(db);
  await migrateShipmentsModule(db);
  await migrateStockInVendorFields(db);
}

async function migrateFollowupNotesModule(db) {
  const run = promisify(db.run.bind(db));
  const get = promisify(db.get.bind(db));
  const pg = isPostgresDb(db);
  const id = pg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const ts = pg ? 'TIMESTAMP' : 'DATETIME';
  const now = 'DEFAULT CURRENT_TIMESTAMP';

  await run(`
    CREATE TABLE IF NOT EXISTS notes (
      id ${id},
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'warehouse',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'pending',
      link_type TEXT,
      link_id TEXT,
      link_label TEXT,
      assigned_to_user_id INTEGER,
      created_by_user_id INTEGER,
      completed_by_user_id INTEGER,
      completed_at ${ts},
      archived_by_user_id INTEGER,
      archived_at ${ts},
      reminder_at ${ts},
      next_reminder_at ${ts},
      reminder_channel TEXT DEFAULT 'dashboard_push',
      ai_suggestion TEXT,
      warehouse_id INTEGER,
      created_at ${ts} ${now},
      updated_at ${ts} ${now}
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS note_messages (
      id ${id},
      note_id INTEGER NOT NULL,
      sender_user_id INTEGER,
      body TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'message',
      created_at ${ts} ${now}
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS reminders (
      id ${id},
      note_id INTEGER NOT NULL,
      remind_at ${ts} NOT NULL,
      channel TEXT NOT NULL DEFAULT 'dashboard_push',
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at ${ts},
      created_by_user_id INTEGER,
      created_at ${ts} ${now}
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS note_attachments (
      id ${id},
      note_id INTEGER NOT NULL,
      message_id INTEGER,
      uploaded_by_user_id INTEGER,
      original_name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER DEFAULT 0,
      created_at ${ts} ${now}
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_notes_status_due ON notes(status, reminder_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_notes_link ON notes(link_type, link_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_note_messages_note ON note_messages(note_id, created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, remind_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_note_attachments_note ON note_attachments(note_id)`);

  await ensureColumn(db, 'notes', 'visibility', "TEXT DEFAULT 'public'");
  await run(`
    CREATE TABLE IF NOT EXISTS note_tags (
      id ${id},
      note_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      tagged_by_user_id INTEGER,
      created_at ${ts} ${now},
      UNIQUE(note_id, user_id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_note_tags_note ON note_tags(note_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_note_tags_user ON note_tags(user_id)`);

  const perms = [
    ['can_view_followups', 'View follow-up notes and reminders'],
    ['can_manage_followups', 'Create and manage follow-up notes and reminders'],
  ];
  for (const role of ['admin', 'manager', 'checker', 'picker', 'viewer', 'driver']) {
    for (const [permission_key, permission_label] of perms) {
      const row = await get(`SELECT id FROM role_permissions WHERE lower(role) = ? AND permission_key = ?`, [
        role,
        permission_key,
      ]);
      if (!row) {
        const enabled = role === 'admin' || role === 'manager' || role === 'checker' || role === 'picker' ? 1 : 0;
        await run(
          `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [role, permission_key, permission_label, enabled]
        );
      }
    }
  }
}

/** Optional vendor / UOM on rack stock-in movements. */
async function migrateStockInVendorFields(db) {
  await ensureColumn(db, 'stock_in', 'vendor_id', 'INTEGER');
  await ensureColumn(db, 'stock_in', 'vendor_name', 'TEXT');
  await ensureColumn(db, 'stock_in', 'uom', 'TEXT');
}

/** Item master + inbound upload validation audit (Postgres-safe). */
async function migrateInboundItemMasterTables(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS item_master (
        id BIGSERIAL PRIMARY KEY,
        vendor_number TEXT NOT NULL,
        vendor_name TEXT NOT NULL,
        part_number TEXT NOT NULL,
        normalized_part_number TEXT NOT NULL,
        description TEXT NOT NULL,
        uom TEXT NOT NULL,
        size TEXT,
        weight DOUBLE PRECISION,
        created_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (normalized_part_number)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS inbound_upload_validations (
        id BIGSERIAL PRIMARY KEY,
        validation_id TEXT NOT NULL UNIQUE,
        warehouse_id INTEGER,
        user_id INTEGER,
        filename TEXT,
        status TEXT NOT NULL,
        valid INTEGER NOT NULL DEFAULT 0,
        total_rows INTEGER DEFAULT 0,
        valid_rows INTEGER DEFAULT 0,
        missing_parts_count INTEGER DEFAULT 0,
        payload_json TEXT,
        reject_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS item_master (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor_number TEXT NOT NULL,
        vendor_name TEXT NOT NULL,
        part_number TEXT NOT NULL,
        normalized_part_number TEXT NOT NULL,
        description TEXT NOT NULL,
        uom TEXT NOT NULL,
        size TEXT,
        weight REAL,
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (normalized_part_number)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS inbound_upload_validations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        validation_id TEXT NOT NULL UNIQUE,
        warehouse_id INTEGER,
        user_id INTEGER,
        filename TEXT,
        status TEXT NOT NULL,
        valid INTEGER DEFAULT 0,
        total_rows INTEGER DEFAULT 0,
        valid_rows INTEGER DEFAULT 0,
        missing_parts_count INTEGER DEFAULT 0,
        payload_json TEXT,
        reject_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  await run(`CREATE INDEX IF NOT EXISTS idx_item_master_part ON item_master(part_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_inbound_upload_validations_user ON inbound_upload_validations(user_id, created_at DESC)`);
}

/** Customer-service portal delivery confirmations (Postgres-safe). */
async function migrateCustomerServiceTables(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);
  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS customer_service_delivery_confirmations (
        id BIGSERIAL PRIMARY KEY,
        order_ref TEXT NOT NULL,
        outbound_number TEXT,
        sales_order_number TEXT,
        customer_po TEXT,
        customer_username TEXT,
        delivery_location TEXT,
        receiving_time TEXT,
        receiver_availability TEXT,
        stamp_available TEXT,
        labor_available TEXT,
        forklift_available TEXT,
        gate_pass_required TEXT,
        notes TEXT,
        source TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS customer_service_delivery_confirmations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_ref TEXT NOT NULL,
        outbound_number TEXT,
        sales_order_number TEXT,
        customer_po TEXT,
        customer_username TEXT,
        delivery_location TEXT,
        receiving_time TEXT,
        receiver_availability TEXT,
        stamp_available TEXT,
        labor_available TEXT,
        forklift_available TEXT,
        gate_pass_required TEXT,
        notes TEXT,
        source TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  await run(
    `CREATE INDEX IF NOT EXISTS idx_customer_service_delivery_conf_ref
       ON customer_service_delivery_confirmations(order_ref, outbound_number, sales_order_number, customer_po)`
  );
}

/** Driver route stops + GPS pings (Postgres: generic CREATE TABLE in migrateGodamSchema is skipped). */
async function migrateDriverLocationTables(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS driver_route_stops (
        id BIGSERIAL PRIMARY KEY,
        driver_user_id INTEGER NOT NULL REFERENCES users(id),
        driver_delivery_task_id INTEGER NOT NULL REFERENCES driver_delivery_tasks(id),
        outbound_number TEXT,
        customer_name TEXT,
        city_name TEXT,
        gps_link TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        sequence_no INTEGER,
        route_status TEXT DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (driver_user_id, driver_delivery_task_id)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS driver_location_pings (
        id BIGSERIAL PRIMARY KEY,
        driver_user_id INTEGER NOT NULL REFERENCES users(id),
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        accuracy DOUBLE PRECISION,
        altitude DOUBLE PRECISION,
        heading DOUBLE PRECISION,
        speed DOUBLE PRECISION,
        source TEXT DEFAULT 'foreground',
        recorded_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS driver_location_latest (
        driver_user_id INTEGER PRIMARY KEY REFERENCES users(id),
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        accuracy DOUBLE PRECISION,
        altitude DOUBLE PRECISION,
        heading DOUBLE PRECISION,
        speed DOUBLE PRECISION,
        source TEXT,
        recorded_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
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
    await run(`
      CREATE TABLE IF NOT EXISTS driver_location_pings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_user_id INTEGER NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        accuracy REAL,
        altitude REAL,
        heading REAL,
        speed REAL,
        source TEXT DEFAULT 'foreground',
        recorded_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_user_id) REFERENCES users(id)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS driver_location_latest (
        driver_user_id INTEGER PRIMARY KEY,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        accuracy REAL,
        altitude REAL,
        heading REAL,
        speed REAL,
        source TEXT,
        recorded_at DATETIME NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (driver_user_id) REFERENCES users(id)
      )
    `);
  }

  await run(
    `CREATE INDEX IF NOT EXISTS idx_driver_route_stops_driver_status
     ON driver_route_stops(driver_user_id, route_status, sequence_no, id)`
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_driver_route_stops_task
     ON driver_route_stops(driver_delivery_task_id)`
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_driver_loc_ping_user_time
     ON driver_location_pings(driver_user_id, recorded_at DESC)`
  );
}

/** AI request logs (Postgres table skipped by generic CREATE TABLE guard in migrateGodamSchema). */
async function migrateAiLogs(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);
  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS ai_logs (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER,
        warehouse_id INTEGER,
        module TEXT,
        request TEXT,
        response TEXT,
        ai_provider TEXT,
        processing_time_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS ai_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        warehouse_id INTEGER,
        module TEXT,
        request TEXT,
        response TEXT,
        ai_provider TEXT,
        processing_time_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  await run(`CREATE INDEX IF NOT EXISTS idx_ai_logs_created ON ai_logs(created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_ai_logs_user ON ai_logs(user_id, created_at DESC)`);
}

/** Main Stock inbound — LPO / SAP PO / invoice on batch + receiving audit. */
async function migrateInboundShipmentRefs(db) {
  await ensureColumn(db, 'inbound_batches', 'lpo', 'TEXT');
  await ensureColumn(db, 'inbound_batches', 'sap_po', 'TEXT');
  await ensureColumn(db, 'inbound_batches', 'invoice_number', 'TEXT');
  await ensureColumn(db, 'inbound_receiving', 'lpo', 'TEXT');
  await ensureColumn(db, 'inbound_receiving', 'sap_po', 'TEXT');
}

/** Mobile pick proof photos (JPEG in Drive Other folder). */
async function migrateOutboundPickProof(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  await ensureColumn(db, 'picked_orders', 'pick_proof_skipped_at', pg ? 'TIMESTAMP' : 'DATETIME');
  await ensureColumn(db, 'picked_orders', 'pick_proof_skipped_by', 'INTEGER');

  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS outbound_pick_proof_photos (
        id BIGSERIAL PRIMARY KEY,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        outbound_order_id INTEGER NOT NULL,
        outbound_item_id INTEGER NOT NULL,
        sales_order_number TEXT,
        outbound_number TEXT,
        material TEXT,
        required_qty REAL,
        stored_file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
        storage_provider TEXT NOT NULL DEFAULT 'GOOGLE_DRIVE',
        cloud_file_id TEXT NOT NULL,
        cloud_folder_id TEXT,
        cloud_web_url TEXT,
        serial_date TEXT NOT NULL,
        serial_no INTEGER NOT NULL,
        uploaded_by INTEGER REFERENCES users(id),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS outbound_pick_proof_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        outbound_order_id INTEGER NOT NULL,
        outbound_item_id INTEGER NOT NULL,
        sales_order_number TEXT,
        outbound_number TEXT,
        material TEXT,
        required_qty REAL,
        stored_file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
        storage_provider TEXT NOT NULL DEFAULT 'GOOGLE_DRIVE',
        cloud_file_id TEXT NOT NULL,
        cloud_folder_id TEXT,
        cloud_web_url TEXT,
        serial_date TEXT NOT NULL,
        serial_no INTEGER NOT NULL,
        uploaded_by INTEGER,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  await run(
    `CREATE INDEX IF NOT EXISTS idx_pick_proof_order ON outbound_pick_proof_photos(outbound_order_id)`
  ).catch(() => {});
  await run(
    `CREATE INDEX IF NOT EXISTS idx_pick_proof_item ON outbound_pick_proof_photos(outbound_item_id)`
  ).catch(() => {});
}

/** Remove duplicate warehouse rows (same code) and enforce unique code + name. */
async function migrateWarehouseUniqueness(db) {
  const run = promisify(db.run.bind(db));
  const all = promisify(db.all.bind(db));
  const pg = isPostgresDb(db);

  const dups = pg
    ? await all(`
        SELECT lower(trim(warehouse_code)) AS lc,
               array_agg(id ORDER BY is_active DESC, id ASC) AS id_list
        FROM warehouses
        GROUP BY lower(trim(warehouse_code))
        HAVING COUNT(*) > 1
      `)
    : await all(`
        SELECT lower(trim(warehouse_code)) AS lc, GROUP_CONCAT(id) AS id_list
        FROM warehouses
        GROUP BY lower(trim(warehouse_code))
        HAVING COUNT(*) > 1
      `);

  for (const row of dups || []) {
    let ids = [];
    if (Array.isArray(row.id_list)) ids = row.id_list.map(Number);
    else if (row.id_list != null) {
      ids = String(row.id_list)
        .replace(/[{}]/g, '')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n));
    }
    if (ids.length < 2) continue;
    const keeper = ids[0];
    for (let i = 1; i < ids.length; i++) {
      const loser = ids[i];
      const stillThere = await all(`SELECT id FROM warehouses WHERE id = ?`, [loser]);
      if (!stillThere?.length) continue;
      await reassignWarehouseReferences(db, loser, keeper);
      await run(`DELETE FROM warehouses WHERE id = ?`, [loser]);
      console.log(`[schema] Merged duplicate warehouse id ${loser} → ${keeper} (code ${row.lc})`);
    }
  }

  if (pg) {
    await run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_code_lower ON warehouses (lower(trim(warehouse_code)))`
    ).catch(() => {});
    await run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_name_lower ON warehouses (lower(trim(warehouse_name)))`
    ).catch(() => {});
  } else {
    await run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_code_lower ON warehouses(warehouse_code COLLATE NOCASE)`
    ).catch(() => {});
  }
}

async function reassignWarehouseReferences(db, fromId, toId) {
  const run = promisify(db.run.bind(db));
  const all = promisify(db.all.bind(db));
  const from = Number(fromId);
  const to = Number(toId);
  if (!from || !to || from === to) return;

  const tables = [
    'user_warehouses',
    'users',
    'outbound_orders',
    'inbound_orders',
    'notification_log',
    'sales_order_folders',
    'sales_order_documents',
    'audit_logs',
    'huawei_shipment',
    'main_stock',
    'stock_by_rack',
  ];

  if (isPostgresDb(db)) {
    const cols = await all(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'warehouse_id'`
    );
    for (const { table_name } of cols || []) {
      if (table_name === 'warehouses') continue;
      try {
        if (table_name === 'users') {
          await run(`UPDATE users SET default_warehouse_id = ? WHERE default_warehouse_id = ?`, [to, from]);
        } else if (table_name === 'user_warehouses') {
          await run(
            `DELETE FROM user_warehouses uw1 WHERE warehouse_id = ? AND EXISTS (
              SELECT 1 FROM user_warehouses uw2 WHERE uw2.user_id = uw1.user_id AND uw2.warehouse_id = ?
            )`,
            [from, to]
          );
          await run(`UPDATE user_warehouses SET warehouse_id = ? WHERE warehouse_id = ?`, [to, from]);
        } else {
          await run(`UPDATE ${table_name} SET warehouse_id = ? WHERE warehouse_id = ?`, [to, from]);
        }
      } catch {
        /* table may not exist on older DBs */
      }
    }
    return;
  }

  for (const table_name of tables) {
    try {
      if (table_name === 'users') {
        await run(`UPDATE users SET default_warehouse_id = ? WHERE default_warehouse_id = ?`, [to, from]);
      } else if (table_name === 'user_warehouses') {
        await run(`DELETE FROM user_warehouses WHERE warehouse_id = ? AND user_id IN (
          SELECT user_id FROM user_warehouses WHERE warehouse_id = ?
        )`, [from, to]);
        await run(`UPDATE user_warehouses SET warehouse_id = ? WHERE warehouse_id = ?`, [to, from]);
      } else {
        await run(`UPDATE ${table_name} SET warehouse_id = ? WHERE warehouse_id = ?`, [to, from]);
      }
    } catch {
      /* ignore missing table */
    }
  }
}

/** Google OAuth + admin approval workflow (users + access requests). */
async function migrateGoogleAuth(db) {
  const run = promisify(db.run.bind(db));
  const get = promisify(db.get.bind(db));
  const pg = isPostgresDb(db);
  const pk = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const ts = pg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';

  await ensureColumn(db, 'users', 'google_id', 'TEXT');
  await ensureColumn(db, 'users', 'google_picture', 'TEXT');
  await ensureColumn(db, 'users', 'auth_provider', "TEXT DEFAULT 'LOCAL'");
  await ensureColumn(db, 'users', 'approval_status', "TEXT DEFAULT 'APPROVED'");
  await ensureColumn(db, 'users', 'is_blocked', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'users', 'approved_by', pg ? 'INTEGER REFERENCES users(id)' : 'INTEGER');
  await ensureColumn(db, 'users', 'approved_at', ts.replace('DEFAULT CURRENT_TIMESTAMP', ''));
  await ensureColumn(db, 'users', 'blocked_by', pg ? 'INTEGER REFERENCES users(id)' : 'INTEGER');
  await ensureColumn(db, 'users', 'blocked_at', ts.replace('DEFAULT CURRENT_TIMESTAMP', ''));
  await ensureColumn(db, 'users', 'last_login_at', ts.replace('DEFAULT CURRENT_TIMESTAMP', ''));

  await run(`UPDATE users SET approval_status = 'APPROVED' WHERE approval_status IS NULL OR TRIM(approval_status) = ''`);
  await run(`UPDATE users SET auth_provider = 'LOCAL' WHERE auth_provider IS NULL OR TRIM(auth_provider) = ''`);
  await run(`UPDATE users SET is_blocked = 0 WHERE is_blocked IS NULL`);

  await run(`
    CREATE TABLE IF NOT EXISTS user_access_requests (
      id ${pk},
      user_id INTEGER,
      full_name TEXT,
      email TEXT NOT NULL,
      google_id TEXT,
      google_picture TEXT,
      requested_role TEXT DEFAULT 'picker',
      requested_warehouse_id INTEGER,
      status TEXT NOT NULL DEFAULT 'PENDING',
      remarks TEXT,
      requested_at ${ts},
      approved_by INTEGER,
      approved_at ${ts},
      rejected_by INTEGER,
      rejected_at ${ts}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_access_req_status ON user_access_requests(status, requested_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_access_req_email ON user_access_requests(lower(email))`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL AND TRIM(google_id) <> ''`);

  if (pg) {
    await run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email)) WHERE email IS NOT NULL AND TRIM(email) <> ''`
    ).catch(() => {});
  }
}

/** Google Drive OAuth connections (encrypted tokens at rest). */
async function migrateGoogleDriveOAuth(db) {
  const run = promisify(db.run.bind(db));
  const get = promisify(db.get.bind(db));
  const pg = isPostgresDb(db);
  const tsDef = pg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';

  if (pg) {
    const exists = await get(
      `SELECT 1 AS ok FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'google_drive_connections'`
    );
    if (!exists) {
      await run(`
        CREATE TABLE google_drive_connections (
          id BIGSERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          google_email TEXT,
          access_token TEXT,
          refresh_token TEXT NOT NULL,
          expiry_date TIMESTAMP,
          connected_at ${tsDef},
          created_at ${tsDef},
          updated_at ${tsDef}
        )
      `);
    }
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS google_drive_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        google_email TEXT,
        access_token TEXT,
        refresh_token TEXT NOT NULL,
        expiry_date DATETIME,
        connected_at ${tsDef},
        created_at ${tsDef},
        updated_at ${tsDef}
      )
    `);
  }

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_gdrive_conn_user ON google_drive_connections(user_id)`);
    await run(
      `CREATE INDEX IF NOT EXISTS idx_gdrive_conn_updated ON google_drive_connections(updated_at DESC)`
    );
  } catch (e) {
    console.warn('[migrateGoogleDriveOAuth] index:', e.message);
  }
}

/** Google Drive runtime settings editable from Admin Settings. */
async function migrateGoogleDriveSettings(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);
  const ts = pg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';

  await run(`
    CREATE TABLE IF NOT EXISTS google_drive_settings (
      id INTEGER PRIMARY KEY,
      root_folder_id TEXT,
      root_folder_name TEXT,
      updated_by_user_id INTEGER,
      created_at ${ts},
      updated_at ${ts}
    )
  `);

  await run(
    `INSERT INTO google_drive_settings (id, root_folder_id, root_folder_name, created_at, updated_at)
     VALUES (1, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO NOTHING`
  ).catch(() => {});
}

/** Google Drive (and future OneDrive) metadata for sales order document trees. */
async function migrateSalesOrderCloudStorage(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  await ensureColumn(db, 'warehouses', 'google_drive_folder_id', 'TEXT');

  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS sales_order_folders (
        id BIGSERIAL PRIMARY KEY,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        warehouse_code TEXT NOT NULL,
        sales_order_number TEXT NOT NULL,
        gapp_po TEXT,
        customer_po_number TEXT,
        customer_name TEXT,
        storage_provider TEXT NOT NULL DEFAULT 'GOOGLE_DRIVE',
        root_folder_id TEXT,
        sales_order_folder_id TEXT NOT NULL,
        sales_order_folder_name TEXT,
        sales_order_folder_path TEXT,
        customer_po_folder_id TEXT,
        invoices_folder_id TEXT,
        delivery_notes_folder_id TEXT,
        pod_folder_id TEXT,
        accounting_documents_folder_id TEXT,
        other_folder_id TEXT,
        folder_status TEXT NOT NULL DEFAULT 'Active',
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (warehouse_id, sales_order_number)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS sales_order_documents (
        id BIGSERIAL PRIMARY KEY,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        sales_order_folder_id BIGINT NOT NULL REFERENCES sales_order_folders(id) ON DELETE CASCADE,
        sales_order_number TEXT NOT NULL,
        outbound_number TEXT,
        dn_number TEXT,
        invoice_number TEXT,
        customer_po_number TEXT,
        accounting_document_number TEXT,
        document_type TEXT NOT NULL,
        document_title TEXT,
        original_file_name TEXT,
        stored_file_name TEXT NOT NULL,
        mime_type TEXT,
        file_size BIGINT,
        storage_provider TEXT NOT NULL DEFAULT 'GOOGLE_DRIVE',
        cloud_file_id TEXT NOT NULL,
        cloud_folder_id TEXT,
        cloud_web_url TEXT,
        cloud_download_url TEXT,
        folder_relative_path TEXT,
        temp_vps_path TEXT,
        upload_status TEXT NOT NULL DEFAULT 'UPLOADED',
        sync_status TEXT DEFAULT 'SYNCED',
        verification_status TEXT NOT NULL DEFAULT 'PENDING',
        uploaded_by INTEGER REFERENCES users(id),
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        verified_by INTEGER REFERENCES users(id),
        verified_at TIMESTAMP,
        replaced_document_id BIGINT REFERENCES sales_order_documents(id),
        version_no INTEGER NOT NULL DEFAULT 1,
        remarks TEXT,
        pod_type TEXT
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS sales_order_checklist (
        id BIGSERIAL PRIMARY KEY,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        checklist_key TEXT NOT NULL,
        sales_order_number TEXT NOT NULL,
        outbound_number TEXT,
        document_id BIGINT REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        completed_by INTEGER REFERENCES users(id),
        completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        remarks TEXT
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS sales_order_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        warehouse_code TEXT NOT NULL,
        sales_order_number TEXT NOT NULL,
        gapp_po TEXT,
        customer_po_number TEXT,
        customer_name TEXT,
        storage_provider TEXT NOT NULL DEFAULT 'GOOGLE_DRIVE',
        root_folder_id TEXT,
        sales_order_folder_id TEXT NOT NULL,
        sales_order_folder_name TEXT,
        sales_order_folder_path TEXT,
        customer_po_folder_id TEXT,
        invoices_folder_id TEXT,
        delivery_notes_folder_id TEXT,
        pod_folder_id TEXT,
        accounting_documents_folder_id TEXT,
        other_folder_id TEXT,
        folder_status TEXT NOT NULL DEFAULT 'Active',
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id),
        UNIQUE (warehouse_id, sales_order_number)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS sales_order_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        sales_order_folder_id INTEGER NOT NULL,
        sales_order_number TEXT NOT NULL,
        outbound_number TEXT,
        dn_number TEXT,
        invoice_number TEXT,
        customer_po_number TEXT,
        accounting_document_number TEXT,
        document_type TEXT NOT NULL,
        document_title TEXT,
        original_file_name TEXT,
        stored_file_name TEXT NOT NULL,
        mime_type TEXT,
        file_size INTEGER,
        storage_provider TEXT NOT NULL DEFAULT 'GOOGLE_DRIVE',
        cloud_file_id TEXT NOT NULL,
        cloud_folder_id TEXT,
        cloud_web_url TEXT,
        cloud_download_url TEXT,
        folder_relative_path TEXT,
        temp_vps_path TEXT,
        upload_status TEXT NOT NULL DEFAULT 'UPLOADED',
        sync_status TEXT DEFAULT 'SYNCED',
        verification_status TEXT NOT NULL DEFAULT 'PENDING',
        uploaded_by INTEGER,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        verified_by INTEGER,
        verified_at DATETIME,
        replaced_document_id INTEGER,
        version_no INTEGER NOT NULL DEFAULT 1,
        remarks TEXT,
        pod_type TEXT,
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
        FOREIGN KEY (sales_order_folder_id) REFERENCES sales_order_folders(id) ON DELETE CASCADE,
        FOREIGN KEY (uploaded_by) REFERENCES users(id),
        FOREIGN KEY (verified_by) REFERENCES users(id),
        FOREIGN KEY (replaced_document_id) REFERENCES sales_order_documents(id)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS sales_order_checklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        checklist_key TEXT NOT NULL,
        sales_order_number TEXT NOT NULL,
        outbound_number TEXT,
        document_id INTEGER,
        completed_by INTEGER,
        completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        remarks TEXT,
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
        FOREIGN KEY (document_id) REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        FOREIGN KEY (completed_by) REFERENCES users(id)
      )
    `);
  }

  await run(`CREATE INDEX IF NOT EXISTS idx_so_folders_wh_so ON sales_order_folders(warehouse_id, sales_order_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_so_docs_folder ON sales_order_documents(sales_order_folder_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_so_docs_wh_so ON sales_order_documents(warehouse_id, sales_order_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_so_docs_type ON sales_order_documents(document_type, upload_status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_so_checklist_wh_so ON sales_order_checklist(warehouse_id, sales_order_number)`);
}

async function migrateSalesOrderDocumentValidation(db) {
  await ensureColumn(db, 'sales_order_documents', 'validation_json', 'TEXT');
  await ensureColumn(db, 'sales_order_documents', 'source_pdf_name', 'TEXT');
  await ensureColumn(db, 'sales_order_documents', 'selected_pages_json', 'TEXT');
  await ensureColumn(db, 'sales_order_documents', 'generated_from_pdf', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'sales_order_documents', 'upload_source', 'TEXT');
}

/** SAP PO / Sales Order uploads + accessories on SAP stock. */
async function migrateSapPoModule(db) {
  const run = promisify(db.run.bind(db));
  await ensureColumn(db, 'sap_stock', 'accessories', 'TEXT');

  await run(`
    CREATE TABLE IF NOT EXISTS sap_po_upload_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      upload_date TEXT NOT NULL,
      uploaded_by INTEGER,
      upload_type TEXT NOT NULL DEFAULT 'PO',
      total_rows INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Uploaded',
      warehouse_id INTEGER,
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS sap_po_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_batch_id INTEGER NOT NULL,
      warehouse_id INTEGER,
      po_number TEXT,
      sales_order_number TEXT,
      item_number TEXT,
      material TEXT,
      sap_part_number TEXT,
      description TEXT,
      quantity REAL,
      pending_qty REAL,
      uom TEXT,
      accessories TEXT,
      plant TEXT,
      storage_location TEXT,
      delivery_date TEXT,
      line_status TEXT,
      remarks TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      uploaded_by INTEGER,
      FOREIGN KEY (upload_batch_id) REFERENCES sap_po_upload_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_po_batches_created ON sap_po_upload_batches(created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_po_lines_batch ON sap_po_lines(upload_batch_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_po_lines_po ON sap_po_lines(po_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_po_lines_so ON sap_po_lines(sales_order_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_po_lines_status ON sap_po_lines(line_status)`);
  await ensureColumn(db, 'sap_po_lines', 'vendor_number', 'TEXT');
  await ensureColumn(db, 'sap_po_lines', 'supplier_name', 'TEXT');
  await ensureColumn(db, 'sap_po_lines', 'material_group', 'TEXT');
  await ensureColumn(db, 'sap_po_lines', 'pending_value', 'REAL');
  await ensureColumn(db, 'sap_po_lines', 'unit_price', 'REAL');
  await ensureColumn(db, 'sap_po_lines', 'customer_reference', 'TEXT');
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_po_lines_vendor ON sap_po_lines(vendor_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sap_po_lines_cust_ref ON sap_po_lines(customer_reference)`);
}

/** Order picker/driver images subfolder under each SO Drive folder. */
async function migrateSalesOrderOrderImagesFolder(db) {
  await ensureColumn(db, 'sales_order_folders', 'order_images_folder_id', 'TEXT');
}

/** Per-outbound document workflow tracking (links to sales_order_documents). */
async function migrateOutboundDocumentWorkflows(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS outbound_document_workflows (
        id BIGSERIAL PRIMARY KEY,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        sales_order_number TEXT NOT NULL,
        outbound_number TEXT NOT NULL,
        invoice_number TEXT,
        dn_number TEXT,
        accounting_document_number TEXT,
        customer_po_number TEXT,
        sales_order_folder_id BIGINT REFERENCES sales_order_folders(id) ON DELETE SET NULL,
        invoice_document_id BIGINT REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        dn_document_id BIGINT REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        signed_pod_document_id BIGINT REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        accounting_document_id BIGINT REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        customer_po_document_id BIGINT REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        invoice_status TEXT NOT NULL DEFAULT 'MISSING',
        dn_status TEXT NOT NULL DEFAULT 'MISSING',
        pod_status TEXT NOT NULL DEFAULT 'MISSING',
        accounting_status TEXT NOT NULL DEFAULT 'MISSING',
        customer_po_status TEXT NOT NULL DEFAULT 'OPTIONAL',
        workflow_status TEXT NOT NULL DEFAULT 'OPEN',
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (warehouse_id, outbound_number)
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS outbound_document_workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        sales_order_number TEXT NOT NULL,
        outbound_number TEXT NOT NULL,
        invoice_number TEXT,
        dn_number TEXT,
        accounting_document_number TEXT,
        customer_po_number TEXT,
        sales_order_folder_id INTEGER,
        invoice_document_id INTEGER,
        dn_document_id INTEGER,
        signed_pod_document_id INTEGER,
        accounting_document_id INTEGER,
        customer_po_document_id INTEGER,
        invoice_status TEXT NOT NULL DEFAULT 'MISSING',
        dn_status TEXT NOT NULL DEFAULT 'MISSING',
        pod_status TEXT NOT NULL DEFAULT 'MISSING',
        accounting_status TEXT NOT NULL DEFAULT 'MISSING',
        customer_po_status TEXT NOT NULL DEFAULT 'OPTIONAL',
        workflow_status TEXT NOT NULL DEFAULT 'OPEN',
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
        FOREIGN KEY (sales_order_folder_id) REFERENCES sales_order_folders(id) ON DELETE SET NULL,
        FOREIGN KEY (invoice_document_id) REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        FOREIGN KEY (dn_document_id) REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        FOREIGN KEY (signed_pod_document_id) REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        FOREIGN KEY (accounting_document_id) REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        FOREIGN KEY (customer_po_document_id) REFERENCES sales_order_documents(id) ON DELETE SET NULL,
        UNIQUE (warehouse_id, outbound_number)
      )
    `);
  }

  await run(
    `CREATE INDEX IF NOT EXISTS idx_ob_doc_wf_wh_so ON outbound_document_workflows(warehouse_id, sales_order_number)`
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_ob_doc_wf_invoice ON outbound_document_workflows(warehouse_id, invoice_number)`
  );

  await ensureOutboundDocumentWorkflowExtraColumns(db);
}

/** Columns required by outbound document workflow / PO upload → Drive sync. */
async function ensureOutboundDocumentWorkflowExtraColumns(db) {
  const pg = isPostgresDb(db);
  const wfCols = [
    ['customer_name', 'TEXT'],
    ['driver_name', 'TEXT'],
    ['delivery_status', 'TEXT'],
    ['others_status', pg ? "TEXT DEFAULT 'OPTIONAL'" : "TEXT NOT NULL DEFAULT 'OPTIONAL'"],
    ['customer_po_required', pg ? 'INTEGER DEFAULT 0' : 'INTEGER NOT NULL DEFAULT 0'],
    ['completed_at', pg ? 'TIMESTAMP' : 'DATETIME'],
  ];
  for (const [col, ddl] of wfCols) {
    await ensureColumn(db, 'outbound_document_workflows', col, ddl);
  }
}

/** Document Flow module: audit log + extra workflow columns. */
async function migrateDocumentFlowExtras(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  await ensureOutboundDocumentWorkflowExtraColumns(db);

  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS document_flow_audit_logs (
        id BIGSERIAL PRIMARY KEY,
        document_flow_id BIGINT REFERENCES outbound_document_workflows(id) ON DELETE CASCADE,
        outbound_number TEXT NOT NULL,
        action TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS document_flow_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_flow_id INTEGER,
        outbound_number TEXT NOT NULL,
        action TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_flow_id) REFERENCES outbound_document_workflows(id) ON DELETE CASCADE
      )
    `);
  }
  await run(
    `CREATE INDEX IF NOT EXISTS idx_doc_flow_audit_ob ON document_flow_audit_logs(outbound_number)`
  );

  await migrateDocumentFlowSalesOrderTables(db);
}

/** Sales-order–centric document flow registry (local paths + status). */
async function migrateDocumentFlowSalesOrderTables(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS document_flows (
        id BIGSERIAL PRIMARY KEY,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        sales_order_number TEXT NOT NULL,
        customer_po_number TEXT,
        outbound_number TEXT,
        invoice_number TEXT,
        delivery_note_number TEXT,
        accounting_document_number TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        customer_po_required INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        UNIQUE (warehouse_id, sales_order_number)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS document_flow_files (
        id BIGSERIAL PRIMARY KEY,
        document_flow_id BIGINT REFERENCES document_flows(id) ON DELETE CASCADE,
        sales_order_number TEXT NOT NULL,
        outbound_number TEXT,
        document_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT,
        sales_order_document_id BIGINT,
        uploaded_by INTEGER REFERENCES users(id),
        uploaded_from TEXT,
        is_required INTEGER NOT NULL DEFAULT 0,
        is_uploaded INTEGER NOT NULL DEFAULT 1,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS document_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        sales_order_number TEXT NOT NULL,
        customer_po_number TEXT,
        outbound_number TEXT,
        invoice_number TEXT,
        delivery_note_number TEXT,
        accounting_document_number TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        customer_po_required INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
        UNIQUE (warehouse_id, sales_order_number)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS document_flow_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_flow_id INTEGER,
        sales_order_number TEXT NOT NULL,
        outbound_number TEXT,
        document_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT,
        sales_order_document_id INTEGER,
        uploaded_by INTEGER,
        uploaded_from TEXT,
        is_required INTEGER NOT NULL DEFAULT 0,
        is_uploaded INTEGER NOT NULL DEFAULT 1,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_flow_id) REFERENCES document_flows(id) ON DELETE CASCADE
      )
    `);
  }
  await run(
    `CREATE INDEX IF NOT EXISTS idx_document_flows_wh_so ON document_flows(warehouse_id, sales_order_number)`
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_document_flow_files_flow ON document_flow_files(document_flow_id)`
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_document_flow_files_so ON document_flow_files(sales_order_number)`
  );
  await migrateDocumentFlowBranchTables(db);
}

/** Per-outbound branches + document checklist (invoice, accounting, raw DN, POD). */
async function migrateDocumentFlowBranchTables(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS document_flow_branches (
        id BIGSERIAL PRIMARY KEY,
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
        sales_order_no TEXT NOT NULL,
        customer_po_no TEXT,
        outbound_no TEXT NOT NULL,
        delivery_note_no TEXT,
        invoice_no TEXT,
        accounting_document_no TEXT,
        transportation_type TEXT,
        branch_status TEXT NOT NULL DEFAULT 'incomplete',
        outbound_folder_drive_id TEXT,
        invoice_folder_drive_id TEXT,
        accounting_folder_drive_id TEXT,
        raw_delivery_note_folder_drive_id TEXT,
        pod_folder_drive_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (warehouse_id, sales_order_no, outbound_no)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS document_checklist (
        id BIGSERIAL PRIMARY KEY,
        branch_id BIGINT NOT NULL REFERENCES document_flow_branches(id) ON DELETE CASCADE,
        document_type TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        uploaded INTEGER NOT NULL DEFAULT 0,
        file_name TEXT,
        google_drive_file_id TEXT,
        google_drive_url TEXT,
        uploaded_by INTEGER REFERENCES users(id),
        uploaded_at TIMESTAMP,
        status TEXT NOT NULL DEFAULT 'missing',
        sales_order_document_id BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (branch_id, document_type)
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS document_flow_branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER NOT NULL,
        sales_order_no TEXT NOT NULL,
        customer_po_no TEXT,
        outbound_no TEXT NOT NULL,
        delivery_note_no TEXT,
        invoice_no TEXT,
        accounting_document_no TEXT,
        transportation_type TEXT,
        branch_status TEXT NOT NULL DEFAULT 'incomplete',
        outbound_folder_drive_id TEXT,
        invoice_folder_drive_id TEXT,
        accounting_folder_drive_id TEXT,
        raw_delivery_note_folder_drive_id TEXT,
        pod_folder_drive_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
        UNIQUE (warehouse_id, sales_order_no, outbound_no)
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS document_checklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch_id INTEGER NOT NULL,
        document_type TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        uploaded INTEGER NOT NULL DEFAULT 0,
        file_name TEXT,
        google_drive_file_id TEXT,
        google_drive_url TEXT,
        uploaded_by INTEGER,
        uploaded_at DATETIME,
        status TEXT NOT NULL DEFAULT 'missing',
        sales_order_document_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (branch_id) REFERENCES document_flow_branches(id) ON DELETE CASCADE,
        UNIQUE (branch_id, document_type)
      )
    `);
  }
  await run(
    `CREATE INDEX IF NOT EXISTS idx_doc_flow_branches_wh_so ON document_flow_branches(warehouse_id, sales_order_no)`
  );
  await run(`CREATE INDEX IF NOT EXISTS idx_doc_flow_branches_ob ON document_flow_branches(outbound_no)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_document_checklist_branch ON document_checklist(branch_id)`);
  await ensureDocumentFlowBranchExtraColumns(db);
}

/** Per-outbound Drive subfolder ids (Customer_PO, Order_Images, Other, …). */
async function ensureDocumentFlowBranchExtraColumns(db) {
  const branchCols = [
    ['customer_po_folder_drive_id', 'TEXT'],
    ['order_images_folder_drive_id', 'TEXT'],
    ['other_folder_drive_id', 'TEXT'],
  ];
  for (const [col, ddl] of branchCols) {
    await ensureColumn(db, 'document_flow_branches', col, ddl);
  }
}

/** Additive permissions for Sales Order Document Center (existing DBs). */
async function ensureDocumentCenterPermissionRows(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const docPerms = [
    ['can_view_document_center', 'View Sales Order Document Center'],
    ['can_upload_customer_po', 'Upload customer PO to Drive'],
    ['can_upload_invoice', 'Upload invoice to Drive'],
    ['can_upload_delivery_note', 'Upload delivery note to Drive'],
    ['can_upload_pod', 'Upload POD to Drive'],
    ['can_view_pod_page_picker', 'View POD Page Picker Center'],
    ['can_upload_pod_from_page_picker', 'Upload POD from Page Picker'],
    ['can_override_existing_pod', 'Override existing POD from Page Picker'],
    ['can_upload_accounting_document', 'Upload accounting document to Drive'],
    ['can_upload_order_images', 'Upload order images to Drive'],
    ['can_verify_pod', 'Verify POD documents'],
    ['can_replace_documents', 'Replace or version Drive documents'],
    ['can_download_documents', 'Download / export Drive document packages'],
    ['can_view_document_tracking_report', 'View document tracking report'],
  ];
  const adminCheckerManager = new Set([
    'can_view_document_center',
    'can_upload_customer_po',
    'can_upload_invoice',
    'can_upload_delivery_note',
    'can_upload_pod',
    'can_view_pod_page_picker',
    'can_upload_pod_from_page_picker',
    'can_override_existing_pod',
    'can_upload_accounting_document',
    'can_upload_order_images',
    'can_verify_pod',
    'can_replace_documents',
    'can_download_documents',
    'can_view_document_tracking_report',
  ]);
  const driverOn = new Set(['can_upload_pod']);
  const pickerOn = new Set(['can_upload_order_images', 'can_view_document_center']);
  const roles = [...ROLES_SEED, 'manager'];
  for (const role of roles) {
    for (const [key, label] of docPerms) {
      const row = await get(`SELECT id FROM role_permissions WHERE role = ? AND permission_key = ?`, [role, key]);
      if (row) continue;
      let enabled = 0;
      if (role === 'admin' || role === 'checker' || role === 'manager') {
        enabled = adminCheckerManager.has(key) ? 1 : 0;
      } else if (role === 'driver') {
        enabled = driverOn.has(key) ? 1 : 0;
      } else if (role === 'picker') {
        enabled = pickerOn.has(key) ? 1 : 0;
      } else if (role === 'viewer') {
        enabled =
          key === 'can_view_document_center' ||
          key === 'can_view_document_tracking_report' ||
          key === 'can_view_pod_page_picker'
            ? 1
            : 0;
      }
      await run(
        `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [role, key, label, enabled]
      );
    }
  }
}

/** Multiple files per outbound (sales) order, tagged by lifecycle stage. */
async function migrateOutboundOrderDocuments(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);
  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS outbound_order_documents (
        id BIGSERIAL PRIMARY KEY,
        outbound_order_id INTEGER NOT NULL REFERENCES outbound_orders(id) ON DELETE CASCADE,
        upload_stage TEXT NOT NULL DEFAULT 'order_created',
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_mime_type TEXT,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        uploaded_by INTEGER REFERENCES users(id)
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS outbound_order_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        outbound_order_id INTEGER NOT NULL,
        upload_stage TEXT NOT NULL DEFAULT 'order_created',
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_mime_type TEXT,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        uploaded_by INTEGER,
        FOREIGN KEY (outbound_order_id) REFERENCES outbound_orders(id) ON DELETE CASCADE,
        FOREIGN KEY (uploaded_by) REFERENCES users(id)
      )
    `);
  }
  await run(`CREATE INDEX IF NOT EXISTS idx_outbound_docs_order ON outbound_order_documents(outbound_order_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_outbound_docs_stage ON outbound_order_documents(outbound_order_id, upload_stage)`);
}

/** Login lockout + JWT revocation (logout invalidates jti server-side). */
async function migrateAuthSecurity(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);
  await ensureColumn(db, 'users', 'failed_login_attempts', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'users', 'locked_until', 'DATETIME');
  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        jti TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        expires_at TIMESTAMP NOT NULL
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at)`);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        jti TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at DATETIME NOT NULL
      )
    `);
    await run(`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at)`);
  }
}

async function migrateAuditLogs(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);
  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        warehouse_id INTEGER,
        user_id INTEGER,
        user_name TEXT,
        user_role TEXT,
        module_name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        reference_type TEXT,
        reference_id BIGINT,
        reference_number TEXT,
        status_before TEXT,
        status_after TEXT,
        old_value_json TEXT,
        new_value_json TEXT,
        remarks TEXT,
        ip_address TEXT,
        device_info TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        warehouse_id INTEGER,
        user_id INTEGER,
        user_name TEXT,
        user_role TEXT,
        module_name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        reference_type TEXT,
        reference_id INTEGER,
        reference_number TEXT,
        status_before TEXT,
        status_after TEXT,
        old_value_json TEXT,
        new_value_json TEXT,
        remarks TEXT,
        ip_address TEXT,
        device_info TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_warehouse ON audit_logs(warehouse_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_module ON audit_logs(module_name)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action_type)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_reference ON audit_logs(reference_type, reference_number)`);

  await repairPostgresMissingIdDefaults(db);
}

/** Huawei order workflow module permissions (additive for existing DBs). */
async function ensureHuaweiPermissionRows(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const extra = [
    ['can_huawei_view', 'View Huawei orders module'],
    ['can_huawei_upload', 'Upload Huawei packing lists'],
    ['can_huawei_confirm', 'Confirm Huawei orders after SAP match'],
    ['can_huawei_grn', 'Upload Huawei GRN and mark received'],
    ['can_huawei_dn', 'Create Huawei delivery notes'],
    ['can_huawei_deliver', 'Mark Huawei DSA / lines delivered'],
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

/** Dedicated Huawei order workflow (SAP/contract matching — separate from huawei_shipment packing flow). */
async function migrateHuaweiOrdersModule(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);
  const pk = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const fkUsers = pg ? 'INTEGER REFERENCES users(id)' : 'INTEGER';
  const tsDefault = pg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_orders (
      id ${pk},
      warehouse_id INTEGER,
      sapu TEXT,
      sap_so TEXT,
      customer_po TEXT,
      customer_name TEXT,
      contract_number TEXT,
      batch_dsa TEXT,
      size TEXT,
      status TEXT NOT NULL DEFAULT 'UPCOMING',
      match_status TEXT NOT NULL DEFAULT 'NOT_CHECKED',
      confirmation_status TEXT,
      received_status TEXT,
      delivered_status TEXT,
      remarks TEXT,
      last_match_run_id TEXT,
      created_by ${fkUsers},
      created_at ${tsDefault},
      updated_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_orders_status ON huawei_orders(status, updated_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_orders_batch ON huawei_orders(batch_dsa)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_orders_contract ON huawei_orders(contract_number)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_order_items (
      id ${pk},
      huawei_order_id INTEGER NOT NULL,
      sapu TEXT,
      sap_so TEXT,
      customer_po TEXT,
      contract_number TEXT,
      batch_dsa TEXT,
      part_number TEXT,
      sap_part_number TEXT,
      description TEXT,
      qty REAL,
      uom TEXT,
      box_number TEXT,
      gross_weight TEXT,
      gross_cbm TEXT,
      source_file TEXT,
      match_status TEXT NOT NULL DEFAULT 'NOT_CHECKED',
      remarks TEXT,
      created_at ${tsDefault},
      updated_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_order_items_order ON huawei_order_items(huawei_order_id)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_documents (
      id ${pk},
      huawei_order_id INTEGER NOT NULL,
      document_type TEXT NOT NULL,
      original_file_name TEXT,
      stored_file_name TEXT,
      local_path TEXT,
      google_file_id TEXT,
      google_web_view_link TEXT,
      uploaded_by ${fkUsers},
      uploaded_at ${tsDefault},
      remarks TEXT
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_documents_order ON huawei_documents(huawei_order_id, document_type)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_matching_results (
      id ${pk},
      huawei_order_id INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      match_type TEXT,
      part_number TEXT,
      sap_part_number TEXT,
      expected_qty REAL,
      actual_qty REAL,
      difference_qty REAL,
      match_status TEXT,
      source_reference TEXT,
      remarks TEXT,
      created_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_match_order ON huawei_matching_results(huawei_order_id, run_id)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_status_logs (
      id ${pk},
      huawei_order_id INTEGER NOT NULL,
      old_status TEXT,
      new_status TEXT,
      changed_by ${fkUsers},
      changed_at ${tsDefault},
      remarks TEXT
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_status_logs_order ON huawei_status_logs(huawei_order_id, changed_at DESC)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_summary_rows (
      id ${pk},
      huawei_order_id INTEGER NOT NULL,
      huawei_document_id INTEGER,
      account TEXT,
      contract_no TEXT,
      contract_name TEXT,
      mr_number TEXT,
      dn_number TEXT,
      cbm TEXT,
      batch_no TEXT,
      distributor TEXT,
      created_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_summary_order ON huawei_summary_rows(huawei_order_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_summary_dn ON huawei_summary_rows(huawei_order_id, dn_number)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_dn_lines (
      id ${pk},
      huawei_order_id INTEGER NOT NULL,
      huawei_document_id INTEGER,
      source_file TEXT,
      dsa_number TEXT,
      contract_number TEXT,
      sap_po TEXT,
      sap_so TEXT,
      mr_number TEXT,
      box_name TEXT,
      part_number TEXT,
      description TEXT,
      qty REAL,
      uom TEXT,
      weight_kg REAL,
      volume_cbm REAL,
      serial_numbers TEXT,
      serial_count INTEGER DEFAULT 0,
      line_no INTEGER,
      created_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_dn_lines_order ON huawei_dn_lines(huawei_order_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_dn_lines_dsa ON huawei_dn_lines(huawei_order_id, dsa_number)`);
  await ensureColumn(db, 'huawei_dn_lines', 'serial_count', pg ? 'INTEGER DEFAULT 0' : 'INTEGER DEFAULT 0');

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_customer_order_list (
      id ${pk},
      import_id TEXT,
      warehouse_id INTEGER,
      gapp_po_number TEXT,
      customer_po_number TEXT,
      partner_name TEXT,
      end_user TEXT,
      contract_no TEXT,
      note TEXT,
      no_of_box REAL,
      bill_no_pl_no TEXT,
      dsa_number TEXT,
      location TEXT,
      received_date TEXT,
      batch_amount REAL,
      gr_number TEXT,
      inventory_age TEXT,
      list_status TEXT,
      order_status_mapped TEXT,
      delivered_date TEXT,
      invoice_no TEXT,
      invoice_amount REAL,
      psi_status TEXT,
      source_file TEXT,
      source_row INTEGER,
      created_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_col_dsa ON huawei_customer_order_list(dsa_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_col_status ON huawei_customer_order_list(list_status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_col_import ON huawei_customer_order_list(import_id)`);
}

/** Huawei matcher v2: contracts, accessories, SAPPO-based matching, summary columns. */
async function migrateHuaweiV2Enhancement(db) {
  const run = promisify(db.run.bind(db));
  const pk = isPostgresDb(db) ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const tsDefault = isPostgresDb(db) ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_contracts (
      id ${pk},
      huawei_contract TEXT NOT NULL,
      project_name TEXT,
      customer_po_number TEXT NOT NULL,
      reseller_name TEXT,
      customer_name TEXT,
      created_at ${tsDefault},
      updated_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_contracts_hc ON huawei_contracts(huawei_contract)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_contracts_cpo ON huawei_contracts(customer_po_number)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_accessories (
      id ${pk},
      part_number TEXT NOT NULL,
      description TEXT,
      category TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at ${tsDefault},
      updated_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_accessories_part ON huawei_accessories(part_number)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_matching_runs (
      id ${pk},
      upload_batch_id INTEGER,
      total_orders INTEGER DEFAULT 0,
      total_items INTEGER DEFAULT 0,
      matched_count INTEGER DEFAULT 0,
      short_count INTEGER DEFAULT 0,
      excess_count INTEGER DEFAULT 0,
      not_matching_count INTEGER DEFAULT 0,
      accessory_count INTEGER DEFAULT 0,
      started_at ${tsDefault},
      completed_at TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'RUNNING',
      log_text TEXT
    )
  `);

  const orderCols = [
    ['huawei_contract', 'TEXT'],
    ['project_name', 'TEXT'],
    ['customer_po_number', 'TEXT'],
    ['reseller_name', 'TEXT'],
    ['dsa_number', 'TEXT'],
    ['sap_po', 'TEXT'],
    ['matching_status', 'TEXT'],
    ['total_lines', 'INTEGER'],
    ['total_unique_parts', 'INTEGER'],
    ['total_quantity', 'REAL'],
    ['total_matched_quantity', 'REAL'],
    ['total_short_quantity', 'REAL'],
    ['total_excess_quantity', 'REAL'],
    ['issue_summary', 'TEXT'],
    ['batch_no', 'TEXT'],
    ['batch_status', 'TEXT'],
    ['batch_check_status', 'TEXT'],
    ['batch_check_detail', 'TEXT'],
    ['has_accessory', 'INTEGER'],
    ['data_tier', 'TEXT'],
    ['data_locked', 'INTEGER DEFAULT 0'],
    ['matching_preview', 'INTEGER DEFAULT 0'],
  ];
  for (const [col, typ] of orderCols) {
    await ensureColumn(db, 'huawei_orders', col, typ);
  }
  await ensureColumn(db, 'huawei_dn_lines', 'data_tier', 'TEXT');
  await ensureColumn(db, 'huawei_order_items', 'data_tier', 'TEXT');
  await ensureColumn(db, 'huawei_matching_results', 'data_tier', 'TEXT');

  const runTierBackfill = promisify(db.run.bind(db));
  await runTierBackfill(
    `UPDATE huawei_orders SET data_tier = 'permanent', data_locked = 1
     WHERE UPPER(TRIM(status)) IN ('RECEIVED','DELIVERED') AND (data_tier IS NULL OR data_tier = 'staging')`
  );
  await runTierBackfill(
    `UPDATE huawei_orders SET data_tier = 'confirmed'
     WHERE UPPER(TRIM(status)) = 'CONFIRMED' AND (data_tier IS NULL OR data_tier = 'staging')`
  );
  await runTierBackfill(
    `UPDATE huawei_dn_lines SET data_tier = 'permanent'
     WHERE huawei_order_id IN (SELECT id FROM huawei_orders WHERE UPPER(TRIM(status)) IN ('RECEIVED','DELIVERED'))
       AND (data_tier IS NULL OR data_tier = 'staging')`
  );
  await runTierBackfill(
    `UPDATE huawei_dn_lines SET data_tier = 'confirmed'
     WHERE huawei_order_id IN (SELECT id FROM huawei_orders WHERE UPPER(TRIM(status)) = 'CONFIRMED')
       AND (data_tier IS NULL OR data_tier = 'staging')`
  );
  await runTierBackfill(
    `UPDATE huawei_order_items SET data_tier = COALESCE(
       (SELECT data_tier FROM huawei_orders o WHERE o.id = huawei_order_items.huawei_order_id), 'staging')
     WHERE data_tier IS NULL`
  );
  await runTierBackfill(
    `UPDATE huawei_matching_results SET data_tier = COALESCE(
       (SELECT data_tier FROM huawei_orders o WHERE o.id = huawei_matching_results.huawei_order_id), 'staging')
     WHERE data_tier IS NULL`
  );

  const itemCols = [
    ['huawei_contract', 'TEXT'],
    ['project_name', 'TEXT'],
    ['customer_po_number', 'TEXT'],
    ['reseller_name', 'TEXT'],
    ['dsa_number', 'TEXT'],
    ['sap_po', 'TEXT'],
    ['sap_po_quantity', 'REAL'],
    ['matched_quantity', 'REAL'],
    ['difference_quantity', 'REAL'],
    ['comment', 'TEXT'],
  ];
  for (const [col, typ] of itemCols) {
    await ensureColumn(db, 'huawei_order_items', col, typ);
  }
}

async function ensureHuaweiOrderModulePermissions(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const extra = [
    ['can_view_huawei', 'View Huawei module (orders, status, reports)'],
    ['can_create_huawei_order', 'Create Huawei orders'],
    ['can_edit_huawei_order', 'Edit Huawei orders'],
    ['can_upload_huawei_documents', 'Upload Huawei order documents'],
    ['can_run_huawei_matching', 'Run Huawei SAP/contract matching'],
    ['can_change_huawei_status', 'Change Huawei order workflow status'],
    ['can_export_huawei_reports', 'Export Huawei reports'],
  ];
  const managerOn = new Set([
    'can_view_huawei',
    'can_create_huawei_order',
    'can_edit_huawei_order',
    'can_upload_huawei_documents',
    'can_run_huawei_matching',
    'can_change_huawei_status',
    'can_export_huawei_reports',
  ]);
  const checkerOn = new Set([
    'can_view_huawei',
    'can_upload_huawei_documents',
    'can_run_huawei_matching',
    'can_change_huawei_status',
    'can_export_huawei_reports',
  ]);
  const viewerOn = new Set(['can_view_huawei', 'can_export_huawei_reports']);
  const roles = [...ROLES_SEED, 'manager'];
  for (const role of roles) {
    for (const [key, label] of extra) {
      const row = await get(`SELECT id FROM role_permissions WHERE role = ? AND permission_key = ?`, [role, key]);
      if (!row) {
        let enabled = 0;
        if (role === 'admin') enabled = 1;
        else if (role === 'manager') enabled = managerOn.has(key) ? 1 : 0;
        else if (role === 'checker') enabled = checkerOn.has(key) ? 1 : 0;
        else if (role === 'viewer') enabled = viewerOn.has(key) ? 1 : 0;
        await run(
          `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [role, key, label, enabled]
        );
      }
    }
  }
}

/** Huawei shipment packing lifecycle (separate from huawei_orders matcher workflow). */
async function migrateHuaweiWorkflow(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  const shipmentPk = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const linePk = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const fkUsers = pg ? 'INTEGER REFERENCES users(id)' : 'INTEGER';
  const tsDefault = pg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_upload_batch (
      id ${shipmentPk},
      source_filename TEXT,
      created_by_user_id ${fkUsers},
      notes TEXT,
      created_at ${tsDefault}
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_shipment (
      id ${shipmentPk},
      upload_batch_id INTEGER,
      contract_no TEXT,
      dsa_number TEXT NOT NULL,
      gapp_po_number TEXT,
      customer_po_number TEXT,
      partner_name TEXT,
      end_user TEXT,
      status TEXT NOT NULL DEFAULT 'upcoming',
      sap_match_status TEXT,
      sap_match_summary TEXT,
      sap_matched_at ${tsDefault},
      confirmed_at ${tsDefault},
      in_transit_at ${tsDefault},
      received_at ${tsDefault},
      delivered_at ${tsDefault},
      batch_amount REAL,
      gr_number TEXT,
      received_date TEXT,
      note TEXT,
      created_by_user_id ${fkUsers},
      created_at ${tsDefault},
      updated_at ${tsDefault}
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_huawei_shipment_status ON huawei_shipment(status, updated_at DESC)`
  );
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_huawei_shipment_dsa ON huawei_shipment(dsa_number)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_packing_line (
      id ${linePk},
      shipment_id INTEGER NOT NULL,
      box_name TEXT,
      part_number TEXT,
      description TEXT,
      quantity REAL,
      uom TEXT,
      gross_weight TEXT,
      gross_size TEXT,
      line_status TEXT NOT NULL DEFAULT 'open',
      created_at ${tsDefault},
      updated_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_packing_shipment ON huawei_packing_line(shipment_id)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_sap_match_line (
      id ${linePk},
      shipment_id INTEGER NOT NULL,
      part_number TEXT,
      packing_qty REAL,
      sap_qty REAL,
      match_ok INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      created_at ${tsDefault}
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_grn_upload (
      id ${shipmentPk},
      original_filename TEXT,
      uploaded_by_user_id ${fkUsers},
      row_count INTEGER DEFAULT 0,
      validation_status TEXT,
      validation_summary TEXT,
      created_at ${tsDefault}
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_grn_row (
      id ${linePk},
      grn_upload_id INTEGER NOT NULL,
      po_contract_no TEXT,
      dsa_number TEXT,
      total_amount REAL,
      matched_shipment_id INTEGER,
      match_ok INTEGER NOT NULL DEFAULT 0,
      message TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_delivery_note (
      id ${shipmentPk},
      shipment_id INTEGER NOT NULL,
      dn_number TEXT,
      file_path TEXT,
      created_by_user_id ${fkUsers},
      created_at ${tsDefault}
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_module_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at ${tsDefault}
    )
  `);
  if (pg) {
    await run(
      `INSERT INTO huawei_module_config (id, config_json) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING`
    );
  } else {
    await run(`INSERT OR IGNORE INTO huawei_module_config (id, config_json) VALUES (1, '{}')`);
  }
}

/** Warehouse manager role (operates one or more sites; assign via Warehouses admin). */
async function ensureManagerRolePermissions(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const role = 'manager';
  for (const [permission_key, permission_label] of PERMISSION_DEFS) {
    const row = await get(`SELECT id FROM role_permissions WHERE role = ? AND permission_key = ?`, [
      role,
      permission_key,
    ]);
    if (row) continue;
    const isEnabled =
      permission_key === 'can_manage_users'
        ? 0
        : permission_key === 'can_use_ai'
          ? 0
          : 1;
    await run(
      `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [role, permission_key, permission_label, isEnabled]
    );
  }
}

/** Additive permissions for existing DBs (seedDefaultRolePermissions only runs on empty table). */
async function ensureMobileRackPermissionRows(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const mobilePerms = [
    ['can_update_rack_mobile', 'Mobile: update stock by rack (batch scan)'],
    ['can_pick_from_rack_mobile', 'Mobile: pick from selected racks'],
    ['can_add_rack_stock_mobile', 'Mobile: add rack stock during pick'],
    ['can_adjust_rack_mobile', 'Mobile: adjust rack quantity (physical count correction)'],
    ['can_confirm_order_picked_mobile', 'Mobile: confirm order picked'],
    ['can_view_rack_update_report', 'View rack update report'],
    ['can_view_picking_by_rack_report', 'View picking by rack report'],
  ];
  const defaultOn = new Set([
    'can_update_rack_mobile',
    'can_pick_from_rack_mobile',
    'can_add_rack_stock_mobile',
    'can_adjust_rack_mobile',
    'can_confirm_order_picked_mobile',
    'can_view_rack_update_report',
    'can_view_picking_by_rack_report',
  ]);
  const rackRoles = [...ROLES_SEED, 'manager'];
  for (const role of rackRoles) {
    for (const [key, label] of mobilePerms) {
      const row = await get(`SELECT id FROM role_permissions WHERE role = ? AND permission_key = ?`, [role, key]);
      if (row) continue;
      const enabled =
        role === 'admin' || role === 'manager' || role === 'picker'
          ? defaultOn.has(key)
            ? 1
            : 0
          : role === 'checker'
            ? defaultOn.has(key) || key.includes('view')
              ? 1
              : 0
            : 0;
      await run(
        `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [role, key, label, enabled]
      );
    }
  }
}

/** Manager: outbound upload, send for pick, mark delivered (existing DBs). */
async function ensureManagerOutboundDeliveryRows(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const keys = ['can_upload_outbound', 'can_confirm_picked', 'can_view_orders'];
  for (const permission_key of keys) {
    const row = await get(`SELECT id, is_enabled FROM role_permissions WHERE role = ? AND permission_key = ?`, [
      'manager',
      permission_key,
    ]);
    if (row) {
      if (!Number(row.is_enabled)) {
        await run(
          `UPDATE role_permissions SET is_enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE role = ? AND permission_key = ?`,
          ['manager', permission_key]
        );
      }
      continue;
    }
    const label =
      permission_key === 'can_upload_outbound'
        ? 'Upload outbound'
        : permission_key === 'can_view_orders'
          ? 'View orders'
          : 'Confirm picked';
    await run(
      `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ['manager', permission_key, label]
    );
  }
}

async function ensureOrderPickStatusPermissionRows(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const keys = [
    ['can_view_order_pick_status', 'View order-wise pick status report'],
    ['can_print_order_pick_status', 'Print order-wise pick status report'],
    ['can_export_order_pick_status', 'Export order-wise pick status to Excel'],
    ['can_edit_pick_details', 'Edit pick details from pick status report'],
  ];
  const defaultOn = new Set([
    'can_view_order_pick_status',
    'can_print_order_pick_status',
    'can_export_order_pick_status',
    'can_edit_pick_details',
  ]);
  const pickerOn = new Set(['can_view_order_pick_status', 'can_print_order_pick_status']);
  const viewerOn = new Set(['can_view_order_pick_status', 'can_print_order_pick_status']);
  const roles = [...ROLES_SEED, 'manager'];
  for (const role of roles) {
    for (const [key, label] of keys) {
      const row = await get(`SELECT id FROM role_permissions WHERE role = ? AND permission_key = ?`, [role, key]);
      if (row) continue;
      let enabled = 0;
      if (role === 'admin' || role === 'manager' || role === 'checker') {
        enabled = defaultOn.has(key) ? 1 : 0;
      } else if (role === 'picker') {
        enabled = pickerOn.has(key) ? 1 : 0;
      } else if (role === 'viewer') {
        enabled = viewerOn.has(key) ? 1 : 0;
      }
      await run(
        `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [role, key, label, enabled]
      );
    }
  }
}

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

/** Viewer role: browse + download only (no picks, uploads, or DN edits). Re-applied on every migrate. */
async function ensureViewerReadOnlyRolePermissions(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const viewerEnabled = new Set([
    'can_access_web',
    'can_view_orders',
    'can_view_upcoming_orders',
    'can_view_main_stock',
    'can_view_stock_by_rack',
    'can_view_picked_table',
    'can_view_transportation',
    'can_view_driver_gps',
    'can_view_document_center',
    'can_view_document_tracking_report',
    'can_download_documents',
    'can_view_delivery_notes',
    'can_view_order_pick_status',
    'can_print_order_pick_status',
    'can_export_order_pick_status',
    'can_view_rack_update_report',
    'can_view_picking_by_rack_report',
  ]);

  for (const [permission_key, permission_label] of PERMISSION_DEFS) {
    const row = await get(`SELECT id FROM role_permissions WHERE role = 'viewer' AND permission_key = ?`, [
      permission_key,
    ]);
    if (!row) {
      await run(
        `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
         VALUES ('viewer', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [permission_key, permission_label, viewerEnabled.has(permission_key) ? 1 : 0]
      );
    }
  }

  for (const [permission_key] of PERMISSION_DEFS) {
    await run(
      `UPDATE role_permissions SET is_enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE role = 'viewer' AND permission_key = ?`,
      [viewerEnabled.has(permission_key) ? 1 : 0, permission_key]
    );
  }
}

/** Inbound shipment create/receive workflow (Postgres + SQLite). */
async function migrateShipmentsModule(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  const shipmentsPk = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const childPk = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

  await run(`
    CREATE TABLE IF NOT EXISTS shipments (
      id ${shipmentsPk},
      vendor_name TEXT NOT NULL,
      vendor_number TEXT,
      shipment_number TEXT NOT NULL,
      warehouse_id INTEGER NOT NULL,
      shipping_via TEXT,
      arrival_method TEXT,
      expected_arrival_date TEXT,
      waybill_number TEXT,
      invoice_number TEXT,
      sap_po_number TEXT,
      remarks TEXT,
      status TEXT NOT NULL DEFAULT 'UPCOMING',
      google_drive_folder_id TEXT,
      stock_applied INTEGER DEFAULT 0,
      receive_override_reason TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      received_at DATETIME,
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS shipment_items (
      id ${childPk},
      shipment_id INTEGER NOT NULL,
      part_number TEXT NOT NULL,
      description TEXT,
      expected_qty REAL NOT NULL,
      received_qty REAL DEFAULT 0,
      main_sap_part_number TEXT,
      sap_po_number TEXT,
      invoice_number TEXT,
      waybill_number TEXT,
      shipping_via TEXT,
      remarks TEXT,
      status TEXT DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS shipment_receiving_transactions (
      id ${childPk},
      shipment_id INTEGER NOT NULL,
      shipment_item_id INTEGER NOT NULL,
      part_number TEXT NOT NULL,
      received_qty REAL NOT NULL,
      pallet_number TEXT,
      received_by INTEGER,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      remarks TEXT,
      FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
      FOREIGN KEY (shipment_item_id) REFERENCES shipment_items(id) ON DELETE CASCADE,
      FOREIGN KEY (received_by) REFERENCES users(id)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS shipment_attachments (
      id ${childPk},
      shipment_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      file_type TEXT,
      google_drive_file_id TEXT,
      google_drive_url TEXT,
      folder_type TEXT NOT NULL,
      uploaded_by INTEGER,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_shipments_vendor ON shipments(vendor_name)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_shipments_number ON shipments(shipment_number)`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_vendor_number ON shipments(vendor_name, shipment_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_shipment_items_shipment ON shipment_items(shipment_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_shipment_items_part ON shipment_items(part_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_shipment_recv_tx_shipment ON shipment_receiving_transactions(shipment_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_shipment_attachments_shipment ON shipment_attachments(shipment_id)`);

  await ensureColumn(db, 'shipments', 'stock_applied', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'shipments', 'receive_override_reason', 'TEXT');
}

async function ensureDriverGpsPermissionRows(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const key = 'can_view_driver_gps';
  const label = 'View live driver GPS and location history';
  const roles = [...ROLES_SEED, 'manager'];
  for (const role of roles) {
    const row = await get(`SELECT id FROM role_permissions WHERE role = ? AND permission_key = ?`, [role, key]);
    if (row) continue;
    const enabled =
      role === 'admin' || role === 'manager' || role === 'checker' ? 1 : 0;
    await run(
      `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [role, key, label, enabled]
    );
  }
}

/** GR / receive fields + receive document uploads for huawei_orders workflow. */
async function migrateHuaweiReceiveWorkflow(db) {
  const run = promisify(db.run.bind(db));
  const pk = isPostgresDb(db) ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const tsDefault = isPostgresDb(db) ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';
  const fkUsers = isPostgresDb(db) ? 'INTEGER REFERENCES users(id)' : 'INTEGER';

  for (const [col, typ] of [
    ['gr_number', 'TEXT'],
    ['receive_amount', 'REAL'],
    ['received_at', 'TIMESTAMP'],
    ['receive_document_path', 'TEXT'],
  ]) {
    await ensureColumn(db, 'huawei_orders', col, typ);
  }

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_receive_documents (
      id ${pk},
      huawei_order_id INTEGER NOT NULL,
      file_name TEXT,
      storage_path TEXT NOT NULL,
      uploaded_by ${fkUsers},
      created_at ${tsDefault}
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_huawei_receive_docs_order ON huawei_receive_documents(huawei_order_id)`
  );
}

/** Refreshed DN/DSA upload staging, version history, upload batches. */
async function migrateHuaweiDnRefresh(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);
  const pk = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const tsDefault = pg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';
  const fkUsers = pg ? 'INTEGER REFERENCES users(id)' : 'INTEGER';
  const jsonType = pg ? 'JSONB' : 'TEXT';

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_upload_batches (
      id ${pk},
      upload_type TEXT NOT NULL DEFAULT 'dn_refresh',
      file_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      existing_order_id INTEGER,
      dsa_number TEXT,
      uploaded_by ${fkUsers},
      uploaded_at ${tsDefault},
      applied_at TIMESTAMP,
      cancelled_at TIMESTAMP,
      remarks TEXT,
      stored_file_path TEXT,
      has_qty_change INTEGER DEFAULT 0,
      has_part_change INTEGER DEFAULT 0,
      change_count INTEGER DEFAULT 0
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_huawei_upload_batches_status ON huawei_upload_batches(status, uploaded_at DESC)`
  );

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_dn_refresh_staging (
      id ${pk},
      upload_batch_id INTEGER NOT NULL,
      existing_order_id INTEGER,
      dsa_number TEXT,
      sap_po TEXT,
      part_number TEXT,
      description TEXT,
      old_box_number TEXT,
      new_box_number TEXT,
      old_quantity REAL,
      new_quantity REAL,
      old_uom TEXT,
      new_uom TEXT,
      change_type TEXT,
      change_summary TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by ${fkUsers},
      created_at ${tsDefault}
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_huawei_dn_refresh_staging_batch ON huawei_dn_refresh_staging(upload_batch_id)`
  );

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_order_item_versions (
      id ${pk},
      order_item_id INTEGER,
      order_id INTEGER NOT NULL,
      version_no INTEGER NOT NULL DEFAULT 1,
      upload_batch_id INTEGER,
      dsa_number TEXT,
      sap_po TEXT,
      part_number TEXT,
      description TEXT,
      box_number TEXT,
      quantity REAL,
      uom TEXT,
      previous_data_json ${jsonType},
      new_data_json ${jsonType},
      changed_by ${fkUsers},
      changed_at ${tsDefault},
      change_reason TEXT
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_huawei_order_item_versions_order ON huawei_order_item_versions(order_id, version_no DESC)`
  );
}

/** Permanent Customer Order Huawei (from summary confirm + DN item lines). */
async function migrateHuaweiCustomerOrders(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);
  const pk = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const tsDefault = pg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';
  const fkUsers = pg ? 'INTEGER REFERENCES users(id)' : 'INTEGER';

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_customer_orders (
      id ${pk},
      huawei_order_id INTEGER NOT NULL UNIQUE,
      warehouse_id INTEGER,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      dsa_number TEXT,
      sap_po TEXT,
      sap_so TEXT,
      huawei_contract TEXT,
      project_name TEXT,
      customer_po_number TEXT,
      account TEXT,
      contract_no TEXT,
      contract_name TEXT,
      mr_number TEXT,
      dn_number TEXT,
      cbm TEXT,
      batch_no TEXT,
      distributor TEXT,
      total_lines INTEGER,
      total_quantity REAL,
      matching_status TEXT,
      issue_summary TEXT,
      batch_amount REAL,
      gr_number TEXT,
      received_date TEXT,
      confirmed_at ${tsDefault},
      confirmed_by_user_id ${fkUsers},
      received_at TIMESTAMP,
      received_by_user_id ${fkUsers},
      remarks TEXT,
      created_at ${tsDefault},
      updated_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_hco_dsa ON huawei_customer_orders(dsa_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_hco_status ON huawei_customer_orders(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_hco_order ON huawei_customer_orders(huawei_order_id)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_customer_order_items (
      id ${pk},
      customer_order_id INTEGER NOT NULL,
      huawei_order_id INTEGER NOT NULL,
      dn_line_id INTEGER,
      line_status TEXT NOT NULL DEFAULT 'CONFIRMED',
      part_number TEXT,
      description TEXT,
      qty REAL,
      uom TEXT,
      box_name TEXT,
      sap_po TEXT,
      line_no INTEGER,
      match_status TEXT,
      sap_po_quantity REAL,
      comment TEXT,
      created_at ${tsDefault}
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_hcoi_customer ON huawei_customer_order_items(customer_order_id)`
  );
  await run(
    `CREATE INDEX IF NOT EXISTS idx_hcoi_order ON huawei_customer_order_items(huawei_order_id)`
  );

  for (const [col, typ] of [
    ['contract_number', 'TEXT'],
    ['dsa_number', 'TEXT'],
    ['sap_so', 'TEXT'],
    ['mr_number', 'TEXT'],
    ['huawei_contract', 'TEXT'],
    ['weight_kg', 'REAL'],
    ['volume_cbm', 'REAL'],
    ['size_label', 'TEXT'],
  ]) {
    await ensureColumn(db, 'huawei_customer_order_items', col, typ);
  }

  for (const [col, typ] of [
    ['weight_kg', 'REAL'],
    ['volume_cbm', 'REAL'],
    ['dn_line_id', 'INTEGER'],
    ['line_no', 'INTEGER'],
    ['mr_number', 'TEXT'],
  ]) {
    await ensureColumn(db, 'huawei_order_items', col, typ);
  }
}

/** Huawei workflow pages: GR records, Huawei DN tables, item location fields. */
async function migrateHuaweiWorkflowPages(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);
  const pk = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const tsDefault = pg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';
  const fkUsers = pg ? 'INTEGER REFERENCES users(id)' : 'INTEGER';

  for (const [col, typ] of [
    ['location', 'TEXT'],
    ['received_status', 'TEXT'],
    ['gr_number', 'TEXT'],
    ['gr_amount', 'REAL'],
    ['order_status', 'TEXT'],
  ]) {
    await ensureColumn(db, 'huawei_order_items', col, typ);
  }

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_gr_records (
      id ${pk},
      dsa_number TEXT NOT NULL,
      huawei_order_id INTEGER,
      amount REAL,
      gr_number TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      uploaded_by ${fkUsers},
      created_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_gr_dsa ON huawei_gr_records(dsa_number)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_gr_order ON huawei_gr_records(huawei_order_id)`);

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_delivery_notes (
      id ${pk},
      dn_number TEXT NOT NULL,
      customer_name TEXT,
      reseller_name TEXT,
      created_from TEXT,
      source_dsa_numbers TEXT,
      source_sap_po TEXT,
      contract_number TEXT,
      status TEXT NOT NULL DEFAULT 'CREATED',
      created_by ${fkUsers},
      created_at ${tsDefault}
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_huawei_hdn_dn ON huawei_delivery_notes(dn_number)`);
  await ensureColumn(db, 'huawei_delivery_notes', 'contract_number', 'TEXT');

  await run(`
    CREATE TABLE IF NOT EXISTS huawei_delivery_note_items (
      id ${pk},
      huawei_dn_id INTEGER NOT NULL,
      dsa_number TEXT,
      sap_po TEXT,
      part_number TEXT,
      description TEXT,
      quantity REAL,
      uom TEXT,
      location TEXT,
      huawei_order_item_id INTEGER,
      created_at ${tsDefault}
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_huawei_hdni_dn ON huawei_delivery_note_items(huawei_dn_id)`
  );
  await ensureColumn(db, 'huawei_delivery_note_items', 'box_name', 'TEXT');
  await ensureColumn(db, 'huawei_delivery_note_items', 'weight_kg', 'REAL');
  await ensureColumn(db, 'huawei_delivery_note_items', 'volume_cbm', 'REAL');
  await ensureColumn(db, 'huawei_delivery_note_items', 'huawei_dn_line_id', 'INTEGER');
}

/** Per-user table layout (column order, filters, sort) — survives refresh and restart. */
async function migrateUserTablePreferences(db) {
  const run = promisify(db.run.bind(db));
  const pk = isPostgresDb(db) ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const tsDefault = isPostgresDb(db) ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';
  const jsonType = isPostgresDb(db) ? 'JSONB' : 'TEXT';

  await run(`
    CREATE TABLE IF NOT EXISTS user_table_preferences (
      id ${pk},
      user_id INTEGER NOT NULL,
      module_name TEXT NOT NULL,
      table_key TEXT NOT NULL,
      visible_columns ${jsonType},
      hidden_columns ${jsonType},
      column_order ${jsonType},
      filters ${jsonType},
      sort_by TEXT,
      sort_direction TEXT,
      page_size INTEGER,
      summarize_enabled INTEGER,
      created_at ${tsDefault},
      updated_at ${tsDefault},
      UNIQUE(user_id, module_name, table_key)
    )
  `);
  if (isPostgresDb(db)) {
    await run(
      `CREATE INDEX IF NOT EXISTS idx_user_table_prefs_user ON user_table_preferences(user_id, module_name)`
    );
  } else {
    await run(
      `CREATE INDEX IF NOT EXISTS idx_user_table_prefs_user ON user_table_preferences(user_id, module_name)`
    );
  }
}

/** WhatsApp messenger archive (conversations + messages linked to company WhatsApp Web). */
async function migrateWhatsAppChatTables(db) {
  const run = promisify(db.run.bind(db));
  const pg = isPostgresDb(db);

  if (pg) {
    await run(`
      CREATE TABLE IF NOT EXISTS whatsapp_conversations (
        id BIGSERIAL PRIMARY KEY,
        phone_digits TEXT NOT NULL UNIQUE,
        whatsapp_chat_id TEXT,
        display_name TEXT,
        contact_type TEXT NOT NULL DEFAULT 'unknown',
        linked_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        linked_customer_location_id INTEGER REFERENCES customer_locations(id) ON DELETE SET NULL,
        last_message_preview TEXT,
        last_message_at TIMESTAMP,
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id BIGSERIAL PRIMARY KEY,
        conversation_id BIGINT NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
        direction TEXT NOT NULL,
        body TEXT,
        message_type TEXT NOT NULL DEFAULT 'text',
        media_filename TEXT,
        whatsapp_message_id TEXT UNIQUE,
        sent_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        delivery_context TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(
      `CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation ON whatsapp_messages(conversation_id, created_at)`
    );
  } else {
    await run(`
      CREATE TABLE IF NOT EXISTS whatsapp_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_digits TEXT NOT NULL UNIQUE,
        whatsapp_chat_id TEXT,
        display_name TEXT,
        contact_type TEXT NOT NULL DEFAULT 'unknown',
        linked_user_id INTEGER,
        linked_customer_location_id INTEGER,
        last_message_preview TEXT,
        last_message_at DATETIME,
        unread_count INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (linked_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (linked_customer_location_id) REFERENCES customer_locations(id) ON DELETE SET NULL
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        direction TEXT NOT NULL,
        body TEXT,
        message_type TEXT NOT NULL DEFAULT 'text',
        media_filename TEXT,
        whatsapp_message_id TEXT UNIQUE,
        sent_by_user_id INTEGER,
        delivery_context TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (conversation_id) REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (sent_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    await run(
      `CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation ON whatsapp_messages(conversation_id, created_at)`
    );
  }

  await ensureColumn(db, 'whatsapp_conversations', 'linked_customer_id', 'INTEGER');

  const histPk = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const histTs = pg ? 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';
  const fkCust = pg ? 'INTEGER REFERENCES customers(id) ON DELETE SET NULL' : 'INTEGER';
  const fkUser = pg ? 'INTEGER REFERENCES users(id) ON DELETE CASCADE' : 'INTEGER';

  await run(`
    CREATE TABLE IF NOT EXISTS whatsapp_user_contact_history (
      id ${histPk},
      user_id ${fkUser} NOT NULL,
      customer_id ${fkCust},
      contact_slot TEXT NOT NULL DEFAULT 'primary',
      phone_digits TEXT NOT NULL,
      company_name TEXT,
      contact_person TEXT,
      display_label TEXT,
      use_count INTEGER NOT NULL DEFAULT 1,
      last_used_at ${histTs},
      created_at ${histTs},
      UNIQUE(user_id, phone_digits)
    )
  `);
  await run(
    `CREATE INDEX IF NOT EXISTS idx_wa_contact_hist_user ON whatsapp_user_contact_history(user_id, last_used_at DESC)`
  );
}

/** Grant WhatsApp messenger to admin / checker / manager. */
async function ensureWhatsAppMessengerPermissionRows(db) {
  const get = promisify(db.get.bind(db));
  const run = promisify(db.run.bind(db));
  const key = 'can_use_whatsapp_messenger';
  const label = 'WhatsApp messenger (linked WhatsApp Web + chat archive)';
  for (const role of ['admin', 'picker', 'checker', 'viewer', 'driver', 'manager']) {
    const row = await get(`SELECT id FROM role_permissions WHERE role = ? AND permission_key = ?`, [role, key]);
    if (!row) {
      await run(
        `INSERT INTO role_permissions (role, permission_key, permission_label, is_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [role, key, label]
      );
    }
  }
}

module.exports = {
  migrateGodamSchema,
  migrateUserTablePreferences,
  seedDefaultRolePermissions,
  ensureOutboundDocumentWorkflowExtraColumns,
  migrateDocumentFlowSalesOrderTables,
  migrateDocumentFlowBranchTables,
  ensureDocumentFlowBranchExtraColumns,
  migrateWhatsAppChatTables,
  PERMISSION_DEFS,
  ROLES_SEED,
};
