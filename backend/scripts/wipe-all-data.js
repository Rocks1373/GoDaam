#!/usr/bin/env node
/**
 * Deletes every row from every application table (schema preserved).
 * Uses a standalone SQLite connection so it does not race db.js seeding.
 *
 * Usage (from backend/):
 *   node scripts/wipe-all-data.js           # dry run / instructions
 *   node scripts/wipe-all-data.js --yes     # wipe
 *
 * Stop the API/dev server first if you see "database is locked".
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'warehouse.db');

async function main() {
  const yes = process.argv.includes('--yes');
  if (!yes) {
    console.log(`Database file: ${path.resolve(DB_PATH)}`);
    console.log('This removes ALL rows from ALL tables (users, stock, orders, carriers, etc.).');
    console.log('Schema and migrations stay intact.');
    console.log('\nRe-run with --yes to execute.');
    console.log('Tip: stop ./dev.sh or any process using this DB if you get SQLITE_BUSY.');
    process.exit(0);
  }

  const db = new sqlite3.Database(DB_PATH);
  const run = promisify(db.run.bind(db));
  const all = promisify(db.all.bind(db));
  const close = promisify(db.close.bind(db));

  try {
    await run('PRAGMA foreign_keys = OFF');
    const tables = await all(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );

    for (const row of tables) {
      const name = row.name;
      const safe = name.replace(/"/g, '""');
      await run(`DELETE FROM "${safe}"`);
    }

    const seq = await all(`SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`);
    if (seq.length) await run('DELETE FROM sqlite_sequence');

    await run('PRAGMA foreign_keys = ON');
    await run('VACUUM');

    console.log(`Wiped ${tables.length} tables in ${path.resolve(DB_PATH)}`);
    console.log('Restart the API: default admin user is re-created if missing (ADMIN_USERNAME / ADMIN_PASSWORD env).');
    console.log('Demo stock/customer/FIFO seed runs only when GODAM_SEED_DEMO_DATA=1 (see db.js).');
  } finally {
    await close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
