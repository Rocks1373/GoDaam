const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || './warehouse.db';
const db = new sqlite3.Database(DB_PATH);

console.log('🗄️ Initializing Warehouse Database...');

/** Demo customer / main_stock / rack rows — off by default for clean deploy & post-wipe testing. Set GODAM_SEED_DEMO_DATA=1 to enable. */
function seedDemoDataEnabled() {
  const v = String(process.env.GODAM_SEED_DEMO_DATA || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function runGodamSeeds(db) {
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const adminRole = (process.env.ADMIN_ROLE || 'admin').toLowerCase();

  db.get('SELECT id FROM users WHERE username = ?', [adminUsername], (err, row) => {
    if (err) {
      console.error('❌ Failed checking admin user:', err.message);
      return;
    }
    if (row?.id) return;

    const password_hash = bcrypt.hashSync(adminPassword, 10);
    db.run(
      `INSERT INTO users (username, password_hash, role, full_name, is_active, token_expiry_days, can_access_web, can_access_mobile)
       VALUES (?, ?, ?, ?, 1, 30, 1, 1)`,
      [adminUsername, password_hash, adminRole, adminUsername],
      (err2) => {
        if (err2) console.error('❌ Failed seeding admin user:', err2.message);
        else console.log(`👤 Seeded admin user: ${adminUsername}`);
      }
    );
  });

  if (seedDemoDataEnabled()) {
    db.get('SELECT COUNT(1) as c FROM customers', (err, row) => {
      if (err) return;
      if ((row?.c || 0) > 0) return;
      db.run(
        `INSERT INTO customers (
        customer_number, company_name, city_name, address, gps,
        contact_person, contact_person_number, email_1, designation_job,
        second_name, second_number, second_email, designation_job_2, remarks,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          '120933',
          'Durrah Aghizat Alhaseb Company',
          'Riyadh',
          'King Saud University',
          'https://maps.app.goo.gl/example',
          'Noorah AlKhelwi',
          '+966539645442',
          'noorah@example.com',
          'Warehouse Contact',
          'Saeed Al Farej',
          '+966555093620',
          'saeed@example.com',
          'Manager',
          'Main customer',
        ]
      );
    });

    const seedMain = [
      ['CommScope', 'CommScope', 'VEN001', 'SAP-PN-100', 'PN-100', 'Patch Cord', 100, 20, 10, 70, 'PCS', 'Opening balance'],
      ['Schneider', 'Schneider', 'VEN002', 'SAP-PN-200', 'PN-200', 'Breaker', 50, 5, 0, 45, 'PCS', 'Opening balance'],
    ];
    for (const r of seedMain) {
      const part = r[4];
      db.get('SELECT id FROM main_stock WHERE part_number = ?', [part], (err, row) => {
        if (err) return;
        if (row?.id) return;
        db.run(
          `INSERT INTO main_stock
          (product, vendor_name, vendor_number, sap_part_number, part_number, description,
           received_qty, issued_qty, pending_delivery_qty, available_qty, uom, remarks, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          r
        );
      });
    }

    db.get('SELECT COUNT(1) as c FROM stock_by_rack_legacy', (err, row) => {
      if (err) return;
      if ((row?.c || 0) > 0) return;

      const stmt = db.prepare(
        `INSERT INTO stock_by_rack_legacy
        (part_number, sap_part_number, description, rack_location, entry_date,
         qty_received, qty_issued, available_qty, remarks, source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      );

      const seed = [
        ['PN-100', 'SAP-PN-100', 'Patch Cord', '32C', '2026-01-15', 2, 2, 0, 'Old stock'],
        ['PN-100', 'SAP-PN-100', 'Patch Cord', '34A', '2026-02-20', 25, 23, 2, 'Available'],
        ['PN-200', 'SAP-PN-200', 'Breaker', '12B', '2026-01-10', 50, 0, 50, 'Available'],
      ];

      for (const r of seed) stmt.run(r);
      stmt.finalize();
    });

    // Summary stock_by_rack for GoDam FIFO (matches legacy demo SKUs)
    db.get('SELECT COUNT(1) as c FROM stock_by_rack', (err, row) => {
      if (err) return;
      if ((row?.c || 0) > 0) return;
      const stmt = db.prepare(
        `INSERT INTO stock_by_rack
        (part_number, sap_part_number, description, rack_location, total_in_qty, total_out_qty, available_qty, first_entry_date, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      );
      const rows = [
        ['PN-100', 'SAP-PN-100', 'Patch Cord', '32C', 2, 2, 0, '2026-01-15'],
        ['PN-100', 'SAP-PN-100', 'Patch Cord', '34A', 25, 23, 2, '2026-02-20'],
        ['PN-200', 'SAP-PN-200', 'Breaker', '12B', 50, 0, 50, '2026-01-10'],
      ];
      for (const r of rows) stmt.run(r);
      stmt.finalize();
    });
  }

  // Carrier/Driver seed (for DN transportation dropdowns)
  db.get('SELECT COUNT(1) as c FROM carriers', (err, row) => {
    if (err) return;
    // Seed only if carriers table exists (migrate runs before seeds)
    const existingCount = row?.c || 0;
    // Ensure at least one GAPP carrier + drivers exist (required for Type=GAPP)
    db.get(`SELECT id FROM carriers WHERE lower(carrier_type) = 'gapp' LIMIT 1`, (err2, gappRow) => {
      if (err2) return;
      if (gappRow?.id) return;

      db.run(
        `INSERT INTO carriers (carrier_name, carrier_type, is_active, created_at, updated_at)
         VALUES ('GAPP', 'GAPP', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        function (err3) {
          if (err3) return;
          const carrierId = this.lastID;
          const stmt = db.prepare(
            `INSERT INTO carrier_drivers (carrier_id, driver_name, phone_number, vehicle, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
          );
          stmt.run([carrierId, 'Amjad', '+966562143424', 'Pick up']);
          stmt.run([carrierId, 'Mohammed Naser', '+966561896893', 'Dyna']);
          stmt.finalize();
        }
      );
    });

    // If the table is empty, also seed Rental/Courier masters (demo convenience only)
    if (!seedDemoDataEnabled() || existingCount > 0) return;
    const seedCarriers = [
      ['EAYN ALWIFAQ Transportation & Logistics services', 'Rental'],
      ['Raad AlShamali for Transport Co.', 'Rental'],
      ['AJEX Logistics Services Co.', 'Courier'],
      ['ARAMEX', 'Courier'],
      ['Self collection', 'Self Collection'],
    ];
    const stmtC = db.prepare(
      `INSERT INTO carriers (carrier_name, carrier_type, is_active, created_at, updated_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );
    for (const c2 of seedCarriers) stmtC.run(c2);
    stmtC.finalize();
  });
}

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON;');

// MAIN STOCK TABLE
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS main_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product TEXT,
      vendor_name TEXT,
      vendor_number TEXT,
      sap_part_number TEXT,
      part_number TEXT UNIQUE NOT NULL,
      description TEXT,
      total_qty REAL DEFAULT 0,
      received_qty REAL DEFAULT 0,
      issued_qty REAL DEFAULT 0,
      pending_delivery_qty REAL DEFAULT 0,
      available_qty REAL DEFAULT 0,
      uom TEXT,
      remarks TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ---------------------------------------------------------------------------
  // STOCK BY RACK TABLES
  // ---------------------------------------------------------------------------
  // This app historically used `stock_by_rack` as FIFO entry-level rows
  // (entry_id + entry_date). The required module uses `stock_by_rack` as a
  // rack-level summary (unique: part_number + rack_location) with movement
  // tables `stock_in` and `stock_out`.
  //
  // To avoid breaking FIFO Pick, we keep legacy FIFO rows in `stock_by_rack_legacy`
  // and create the new required summary table as `stock_by_rack`.

  // If an old DB already has legacy schema under `stock_by_rack`, migrate it.
  db.all(`PRAGMA table_info(stock_by_rack)`, (err, cols) => {
    if (err) return;
    const names = (cols || []).map((c) => c.name);
    const looksLegacy = names.includes('entry_id') && names.includes('entry_date');
    if (!looksLegacy) return;

    db.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='stock_by_rack_legacy'`,
      (err2, row) => {
        if (err2) return;
        if (row?.name) {
          // If we created an empty legacy table in a previous run,
          // drop it so the rename can succeed.
          db.get('SELECT COUNT(1) as c FROM stock_by_rack_legacy', (err3, cnt) => {
            if (err3) return;
            if ((cnt?.c || 0) > 0) return;
            db.run('DROP TABLE IF EXISTS stock_by_rack_legacy');
            db.run(`ALTER TABLE stock_by_rack RENAME TO stock_by_rack_legacy`);
          });
          return;
        }

        db.run(`ALTER TABLE stock_by_rack RENAME TO stock_by_rack_legacy`);
      }
    );
  });

  // Legacy FIFO table (entry-level rows)
  db.run(`
    CREATE TABLE IF NOT EXISTS stock_by_rack_legacy (
      entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_number TEXT NOT NULL,
      sap_part_number TEXT,
      description TEXT,
      rack_location TEXT NOT NULL,
      entry_date DATE NOT NULL,
      qty_received REAL DEFAULT 0,
      qty_issued REAL DEFAULT 0,
      available_qty REAL DEFAULT 0,
      remarks TEXT,
      source_type TEXT DEFAULT 'manual',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Composite uniqueness for legacy update-existing logic
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_by_rack_legacy_unique
    ON stock_by_rack_legacy(part_number, rack_location, entry_date)
  `);

  // New required summary table: current available stock by rack
  db.run(`
    CREATE TABLE IF NOT EXISTS stock_by_rack (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_number TEXT NOT NULL,
      sap_part_number TEXT,
      description TEXT,
      rack_location TEXT NOT NULL,
      total_in_qty REAL DEFAULT 0,
      total_out_qty REAL DEFAULT 0,
      available_qty REAL DEFAULT 0,
      first_entry_date DATE,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Unique: part_number + rack_location
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_by_rack_summary_unique
    ON stock_by_rack(part_number, rack_location)
  `);

  // Movement tables
  db.run(`
    CREATE TABLE IF NOT EXISTS stock_in (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_date DATE NOT NULL,
      part_number TEXT NOT NULL,
      sap_part_number TEXT,
      description TEXT,
      rack_location TEXT NOT NULL,
      qty_in REAL NOT NULL,
      source_type TEXT,
      reference_no TEXT,
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS stock_out (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_date DATE NOT NULL,
      part_number TEXT NOT NULL,
      sap_part_number TEXT,
      description TEXT,
      rack_location TEXT NOT NULL,
      qty_out REAL NOT NULL,
      outbound_number TEXT,
      reference_no TEXT,
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // OUTBOUND ORDERS TABLE
  db.run(`
    CREATE TABLE IF NOT EXISTS outbound_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbound_number TEXT UNIQUE NOT NULL,
      sales_order_number TEXT,
      customer_po_number TEXT,
      customer_name TEXT,
      vendor_name TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add DN-required columns to outbound_orders (safe for existing DBs)
  db.all(`PRAGMA table_info(outbound_orders)`, (err, cols) => {
    if (err) return;
    const names = new Set((cols || []).map((c) => c.name));
    const add = (name, type) => {
      if (names.has(name)) return;
      db.run(`ALTER TABLE outbound_orders ADD COLUMN ${name} ${type}`);
    };
    add('dn_date', 'DATE');
    add('gapp_po', 'TEXT');
    add('invoice_number', 'TEXT');
    add('delivery_address', 'TEXT');
    add('contact_person', 'TEXT');
    add('total_cases', 'TEXT');
    add('gross_weight', 'TEXT');
    add('volume', 'TEXT');
    add('dn_status', "TEXT DEFAULT 'Draft'");
  });

  // OUTBOUND ITEMS TABLE
  db.run(`
    CREATE TABLE IF NOT EXISTS outbound_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbound_id INTEGER,
      part_number TEXT NOT NULL,
      sap_part_number TEXT,
      description TEXT,
      required_qty REAL NOT NULL,
      picked_qty REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      FOREIGN KEY (outbound_id) REFERENCES outbound_orders(id)
    )
  `);

  // Add DN item fields to outbound_items (safe for existing DBs)
  db.all(`PRAGMA table_info(outbound_items)`, (err, cols) => {
    if (err) return;
    const names = new Set((cols || []).map((c) => c.name));
    const add = (name, type) => {
      if (names.has(name)) return;
      db.run(`ALTER TABLE outbound_items ADD COLUMN ${name} ${type}`);
    };
    add('uom', 'TEXT');
    add('serial_no', 'TEXT');
    add('condition', "TEXT DEFAULT 'New'");
  });

  // PICK SUGGESTIONS TABLE
  db.run(`
    CREATE TABLE IF NOT EXISTS pick_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbound_id INTEGER,
      part_number TEXT NOT NULL,
      rack_location TEXT,
      entry_id INTEGER,
      suggested_qty REAL NOT NULL,
      fifo_sequence INTEGER NOT NULL,
      status TEXT DEFAULT 'suggested',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (outbound_id) REFERENCES outbound_orders(id)
    )
  `);

  // Delivered guard (prevents double deduction)
  db.run(`
    CREATE TABLE IF NOT EXISTS delivered_outbounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbound_id INTEGER UNIQUE NOT NULL,
      delivered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (outbound_id) REFERENCES outbound_orders(id)
    )
  `);

  // Sold out items log (matches requirement to insert to sold_out)
  db.run(`
    CREATE TABLE IF NOT EXISTS sold_out (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date DATE,
      gapp_po TEXT,
      customer_po TEXT,
      invoice_number TEXT,
      customer_name TEXT,
      delivery_address TEXT,
      gps TEXT,
      part_number TEXT,
      description TEXT,
      sold_qty REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // USERS TABLE (Auth)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // GoDam: role permissions
  db.run(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      permission_key TEXT NOT NULL,
      permission_label TEXT,
      is_enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(role, permission_key)
    )
  `);

  // GoDam: FIFO lines from stock_by_rack (summary table)
  db.run(`
    CREATE TABLE IF NOT EXISTS fifo_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbound_order_id INTEGER NOT NULL,
      outbound_item_id INTEGER NOT NULL,
      material TEXT,
      sap_part_number TEXT,
      description TEXT,
      rack_location TEXT NOT NULL,
      stock_by_rack_id INTEGER NOT NULL,
      entry_date DATE,
      available_qty REAL,
      suggested_qty REAL NOT NULL,
      fifo_sequence INTEGER NOT NULL,
      is_admin_changed INTEGER DEFAULT 0,
      changed_by_admin_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (outbound_order_id) REFERENCES outbound_orders(id),
      FOREIGN KEY (outbound_item_id) REFERENCES outbound_items(id),
      FOREIGN KEY (stock_by_rack_id) REFERENCES stock_by_rack(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS picked_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbound_order_id INTEGER NOT NULL,
      outbound_item_id INTEGER NOT NULL,
      fifo_suggestion_id INTEGER,
      user_id INTEGER NOT NULL,
      user_name TEXT,
      material TEXT,
      sap_part_number TEXT,
      description TEXT,
      rack_location TEXT NOT NULL,
      picked_qty REAL NOT NULL,
      picked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      device_id TEXT,
      FOREIGN KEY (outbound_order_id) REFERENCES outbound_orders(id),
      FOREIGN KEY (outbound_item_id) REFERENCES outbound_items(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS picked_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbound_order_id INTEGER NOT NULL UNIQUE,
      delivery TEXT,
      sales_doc TEXT,
      customer_reference TEXT,
      sold_to TEXT,
      name_1 TEXT,
      confirmed_by_user_id INTEGER,
      confirmed_by_user_name TEXT,
      confirmed_at DATETIME,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (outbound_order_id) REFERENCES outbound_orders(id)
    )
  `);

  // Picker -> Admin change requests (rack/qty) for a FIFO line
  db.run(`
    CREATE TABLE IF NOT EXISTS pick_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbound_order_id INTEGER NOT NULL,
      outbound_item_id INTEGER NOT NULL,
      fifo_suggestion_id INTEGER,
      requested_rack_location TEXT,
      requested_qty REAL,
      reason TEXT,
      status TEXT DEFAULT 'Pending',
      requested_by_user_id INTEGER,
      requested_by_user_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      resolved_by_user_id INTEGER,
      resolution_note TEXT,
      FOREIGN KEY (outbound_order_id) REFERENCES outbound_orders(id),
      FOREIGN KEY (outbound_item_id) REFERENCES outbound_items(id),
      FOREIGN KEY (requested_by_user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS push_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      expo_push_token TEXT NOT NULL,
      device_id TEXT,
      platform TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, device_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT,
      body TEXT,
      data_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // CUSTOMERS (Customer Address Book) — one row per address; same customer_number allowed
  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_number TEXT,
      company_name TEXT NOT NULL,
      city_name TEXT,
      address TEXT,
      gps TEXT,
      contact_person TEXT,
      contact_person_number TEXT,
      contact_person_number_1 TEXT,
      email_1 TEXT,
      designation_job TEXT,
      second_name TEXT,
      second_number TEXT,
      second_email TEXT,
      designation_job_2 TEXT,
      designation_job_title_2 TEXT,
      remarks TEXT,
      address_type TEXT DEFAULT 'permanent',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const { migrateGodamSchema } = require('./schema-migrate');

  db.run('SELECT 1', () => {
    migrateGodamSchema(db)
      .catch((e) => console.error('❌ Schema migrate:', e.message))
      .finally(() => {
        runGodamSeeds(db);
      });
  });

  console.log('✅ All tables created successfully!');
  console.log(`📁 Database: ${path.resolve(DB_PATH)}`);
});

// NOTE: keep handle open during runtime (this module is required by server.js).
// Closing here can race with async seeding and crash/disable inserts.

module.exports = db;
