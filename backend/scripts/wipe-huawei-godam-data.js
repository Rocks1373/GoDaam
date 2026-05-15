#!/usr/bin/env node
/**
 * Deletes every row from every table in huawei_godam.db (schema preserved).
 * Separate from warehouse.db — see wipe-all-data.js for main app data.
 *
 * Usage (from backend/):
 *   node scripts/wipe-huawei-godam-data.js           # dry run / instructions
 *   node scripts/wipe-huawei-godam-data.js --yes   # wipe all rows
 *
 * Env: HUAWEI_GODAM_DB_PATH (default backend/huawei_godam.db)
 * Stop the API if you see SQLITE_BUSY.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');
const { wipeHuaweiGodamDb } = require('../services/wipeWarehouseData');

const DB_PATH = process.env.HUAWEI_GODAM_DB_PATH || path.join(__dirname, '..', 'huawei_godam.db');

async function main() {
  const yes = process.argv.includes('--yes');
  if (!yes) {
    console.log(`Huawei GoDam database file: ${path.resolve(DB_PATH)}`);
    console.log('This removes ALL rows from ALL tables in this file (batch uploads, matcher rows, etc.).');
    console.log('Schema stays intact; tables are recreated on next API start if missing.');
    console.log('\nRe-run with --yes to wipe.');
    process.exit(0);
  }

  const db = new sqlite3.Database(DB_PATH);
  const run = promisify(db.run.bind(db));
  const all = promisify(db.all.bind(db));
  const close = promisify(db.close.bind(db));

  try {
    const tables = await all(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    await wipeHuaweiGodamDb(run, all);
    console.log(`Wiped ${tables.length} tables in ${path.resolve(DB_PATH)}`);
  } finally {
    await close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
