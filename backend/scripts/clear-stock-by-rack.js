#!/usr/bin/env node
/**
 * Deletes all rows from stock_in, stock_by_rack, and fifo_suggestions (FK to rack).
 * Stop ./dev.sh first if you get SQLITE_BUSY.
 *
 * Usage (from backend/): node scripts/clear-stock-by-rack.js --yes
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'warehouse.db');

async function main() {
  const yes = process.argv.includes('--yes');
  if (!yes) {
    console.log(`Database: ${path.resolve(DB_PATH)}`);
    console.log('This deletes ALL fifo_suggestions, stock_by_rack, and stock_in rows.');
    console.log('Re-run with --yes to execute.');
    process.exit(0);
  }

  const db = new sqlite3.Database(DB_PATH);
  const run = promisify(db.run.bind(db));
  const get = promisify(db.get.bind(db));
  const close = promisify(db.close.bind(db));

  try {
    await run('PRAGMA foreign_keys = OFF');
    const fifoBefore = await get('SELECT COUNT(1) AS c FROM fifo_suggestions').catch(() => ({ c: 0 }));
    const rackBefore = await get('SELECT COUNT(1) AS c FROM stock_by_rack').catch(() => ({ c: 0 }));
    const stockInBefore = await get('SELECT COUNT(1) AS c FROM stock_in').catch(() => ({ c: 0 }));

    await run('DELETE FROM fifo_suggestions');
    await run('DELETE FROM stock_by_rack');
    await run('DELETE FROM stock_in');

    await run(
      'DELETE FROM sqlite_sequence WHERE name IN ("fifo_suggestions", "stock_by_rack", "stock_in")'
    ).catch(() => {});
    await run('PRAGMA foreign_keys = ON');

    console.log(
      `Done. Removed fifo_suggestions: ${fifoBefore?.c ?? '?'}, stock_by_rack: ${rackBefore?.c ?? '?'}, stock_in: ${stockInBefore?.c ?? '?'} (before counts)`
    );
    console.log('Regenerate FIFO on outbounds and re-import rack stock as needed.');
  } finally {
    await close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
