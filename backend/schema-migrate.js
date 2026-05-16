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
  const wh2 = await get(`SELECT id FROM warehouses WHERE lower(warehouse_code) = 'wh2' LIMIT 1`);
  if (!wh2) {
    await run(
      `INSERT INTO warehouses (warehouse_code, warehouse_name, location, manager_name, remarks, is_active)
       VALUES ('WH2', 'Warehouse 2', NULL, NULL, 'Second warehouse site', 1)`
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
  await ensureManagerRolePermissions(db);
  await migrateWarehouseLayer(db);
  await migrateAuditLogs(db);
  await migrateOutboundOrderDocuments(db);
  await migrateSalesOrderCloudStorage(db);
  await migrateAuthSecurity(db);
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
