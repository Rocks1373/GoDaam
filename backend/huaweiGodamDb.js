/**
 * Separate SQLite DB for Huawei GoDam-1.0 batches (does not use warehouse.db).
 * Env: HUAWEI_GODAM_DB_PATH (default backend/huawei_godam.db)
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.HUAWEI_GODAM_DB_PATH || path.join(__dirname, 'huawei_godam.db');
const hgDb = new sqlite3.Database(DB_PATH);

hgDb.serialize(() => {
  hgDb.run('PRAGMA foreign_keys = ON');

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_processing_batch (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME,
      created_by_user_id INTEGER,
      status TEXT NOT NULL DEFAULT 'uploaded',
      error_message TEXT,
      summary_original_filename TEXT,
      po_original_filename TEXT,
      so_original_filename TEXT,
      vcust_original_filename TEXT,
      contracts_original_filename TEXT,
      accessories_original_filename TEXT,
      rules_json TEXT,
      storage_dir_relative TEXT,
      matcher_stdout TEXT,
      matcher_stats_json TEXT
    )
  `);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_batch_created ON hg_processing_batch(created_at DESC)`);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_batch_user ON hg_processing_batch(created_by_user_id)`);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_contract_row (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      contract_no TEXT NOT NULL,
      project_name TEXT,
      customer_po_no TEXT,
      contract_version TEXT,
      reseller_name TEXT,
      end_customer_name TEXT,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE,
      UNIQUE(batch_id, contract_no)
    )
  `);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_contract_batch ON hg_contract_row(batch_id)`);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_po_line (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      po_number TEXT NOT NULL,
      po_item TEXT,
      material TEXT NOT NULL,
      open_qty REAL,
      short_text TEXT,
      material_group TEXT,
      plant TEXT,
      storage_location TEXT,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE
    )
  `);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_po_batch_po_mat ON hg_po_line(batch_id, po_number, material)`);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_so_line (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      sales_document TEXT NOT NULL,
      customer_reference TEXT,
      sold_to_party TEXT,
      sold_to_name TEXT,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE
    )
  `);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_so_batch_doc ON hg_so_line(batch_id, sales_document)`);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_vcust_row (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      customer_code TEXT NOT NULL,
      customer_name TEXT,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE,
      UNIQUE(batch_id, customer_code)
    )
  `);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_summary_row (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      account TEXT,
      contract_no TEXT,
      contract_name TEXT,
      mr_number TEXT,
      dn_number TEXT,
      cbm TEXT,
      batch_no TEXT,
      distributor TEXT,
      remarks TEXT,
      po TEXT,
      so TEXT,
      number_of_boxes REAL,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE
    )
  `);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_summary_batch_dn ON hg_summary_row(batch_id, dn_number)`);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_dn_document (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      original_filename TEXT NOT NULL,
      dn_number TEXT,
      contract_no TEXT,
      mr_no TEXT,
      customer_po_raw TEXT,
      so_number TEXT,
      po_numbers_json TEXT,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE
    )
  `);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_dn_batch ON hg_dn_document(batch_id, dn_number)`);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_dn_contract ON hg_dn_document(contract_no)`);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_dn_line (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dn_document_id INTEGER NOT NULL,
      material TEXT NOT NULL,
      qty REAL,
      description TEXT,
      serials_json TEXT,
      FOREIGN KEY (dn_document_id) REFERENCES hg_dn_document(id) ON DELETE CASCADE
    )
  `);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_dnline_doc ON hg_dn_line(dn_document_id, material)`);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_match_detail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      po_number TEXT,
      dn_number TEXT,
      contract_number TEXT,
      part_number TEXT,
      description TEXT,
      dn_qty REAL,
      po_open_qty REAL,
      remark TEXT,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE
    )
  `);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_detail_batch ON hg_match_detail(batch_id, po_number)`);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_match_ignored (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      source TEXT,
      dn_number TEXT,
      contract_number TEXT,
      po_number TEXT,
      part_number TEXT,
      description TEXT,
      dn_qty REAL,
      po_qty REAL,
      reason TEXT,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE
    )
  `);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_duplicate_dn_po (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      dn_number TEXT,
      po_number TEXT,
      part_number TEXT,
      reason TEXT,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE
    )
  `);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_po_matchrollup (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      po_number TEXT NOT NULL,
      total_qty REAL,
      matched_dn_count INTEGER,
      rejected_dn_count INTEGER,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE,
      UNIQUE(batch_id, po_number)
    )
  `);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS hg_artifact (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      sha256 TEXT,
      FOREIGN KEY (batch_id) REFERENCES hg_processing_batch(id) ON DELETE CASCADE
    )
  `);
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_hg_art_batch ON hg_artifact(batch_id, kind)`);

  // ============================================================
  // Huawei module: customer order list (header) + DN item details
  // These tables are used by the Delivery Note creation flow:
  // PO -> DSA dropdown (Received only) -> load item lines -> generate DN.
  // ============================================================

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS huawei_customer_order_header (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      status TEXT,
      delivered_date TEXT,
      invoice_no TEXT,
      invoice_amount REAL,
      psi_status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  hgDb.run(
    `CREATE INDEX IF NOT EXISTS idx_huawei_coh_po_status ON huawei_customer_order_header(gapp_po_number, status)`
  );
  hgDb.run(`CREATE INDEX IF NOT EXISTS idx_huawei_coh_dsa ON huawei_customer_order_header(dsa_number)`);

  hgDb.run(`
    CREATE TABLE IF NOT EXISTS huawei_delivery_item_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      header_id INTEGER,
      gapp_po_number TEXT,
      customer_po_number TEXT,
      dsa_number TEXT,
      contract_no TEXT,
      so_number TEXT,
      partner_name TEXT,
      end_user TEXT,
      batch TEXT,
      part_number TEXT,
      description TEXT,
      quantity REAL,
      uom TEXT,
      volume TEXT,
      cbm TEXT,
      status TEXT,
      source_file TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (header_id) REFERENCES huawei_customer_order_header(id) ON DELETE SET NULL
    )
  `);
  hgDb.run(
    `CREATE INDEX IF NOT EXISTS idx_huawei_items_header ON huawei_delivery_item_details(header_id, status)`
  );
  hgDb.run(
    `CREATE INDEX IF NOT EXISTS idx_huawei_items_po_dsa ON huawei_delivery_item_details(gapp_po_number, dsa_number, status)`
  );
});

console.log(`📂 Huawei GoDam DB: ${path.resolve(DB_PATH)}`);

module.exports = hgDb;
