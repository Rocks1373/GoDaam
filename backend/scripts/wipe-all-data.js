#!/usr/bin/env node
/**
 * Deletes every row from every application table in the main warehouse (schema preserved).
 *
 * Uses PostgreSQL when DATABASE_URL is set (matches production / backend/db.js).
 * Otherwise uses the SQLite file at DB_PATH (legacy / migration tooling only).
 *
 * Usage (from backend/):
 *   node scripts/wipe-all-data.js                    # dry run / instructions
 *   node scripts/wipe-all-data.js --yes              # wipe everything (including users)
 *   node scripts/wipe-all-data.js --yes --keep-admin # wipe all data but keep user rows where role is admin
 *
 * Stop the API/dev server first if you see locks or connection errors.
 *
 * Huawei batch DB (huawei_godam.db): node scripts/wipe-huawei-godam-data.js --yes
 * One-shot (repo root): bash scripts/fresh-databases.sh
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');
const { wipeMainWarehouseDb, createPgWipeHelpers } = require('../services/wipeWarehouseData');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'warehouse.db');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();

async function wipePostgres(keepAdmin) {
  const pg = createPgWipeHelpers(DATABASE_URL);
  await pg.connect();
  try {
    const tables = await pg.all(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    await wipeMainWarehouseDb(pg.run.bind(pg), pg.all.bind(pg), pg.get.bind(pg), {
      keepAdmin,
      dialect: 'postgres',
    });
    console.log(`Wiped ${tables.length} tables in PostgreSQL (DATABASE_URL).`);
    if (keepAdmin) {
      const n = (await pg.all(`SELECT COUNT(1) AS c FROM users`))[0]?.c;
      console.log(`Users table now has ${n} row(s) (admin preserved).`);
    } else {
      console.log('Restart the API: default admin user is re-created if missing (ADMIN_USERNAME / ADMIN_PASSWORD env).');
    }
  } finally {
    await pg.close().catch(() => {});
  }
}

async function wipeSqlite(keepAdmin) {
  const db = new sqlite3.Database(DB_PATH);
  const run = promisify(db.run.bind(db));
  const all = promisify(db.all.bind(db));
  const get = promisify(db.get.bind(db));
  const close = promisify(db.close.bind(db));

  try {
    if (keepAdmin) {
      const adminBackup = await all(
        `SELECT * FROM users WHERE lower(trim(coalesce(role,''))) = 'admin'`
      );
      console.log(`--keep-admin: will preserve ${adminBackup.length} admin user row(s)`);
      if (!adminBackup.length) {
        console.warn('No admin users found before wipe; users table will be empty after wipe. Run: node scripts/ensure-admin.js');
      }
    }

    const tables = await all(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
    await wipeMainWarehouseDb(run, all, get, { keepAdmin, dialect: 'sqlite' });
    console.log(`Wiped ${tables.length} tables in ${path.resolve(DB_PATH)}`);
    if (keepAdmin) {
      const n = (await all(`SELECT COUNT(1) AS c FROM users`))[0]?.c;
      console.log(`Users table now has ${n} row(s) (admin preserved).`);
    } else {
      console.log('Restart the API: default admin user is re-created if missing (ADMIN_USERNAME / ADMIN_PASSWORD env).');
    }
  } finally {
    await close().catch(() => {});
  }
}

async function main() {
  const yes = process.argv.includes('--yes');
  const keepAdmin = process.argv.includes('--keep-admin');
  if (!yes) {
    if (DATABASE_URL) {
      console.log('Target: PostgreSQL (DATABASE_URL is set).');
    } else {
      console.log(`Target: SQLite file ${path.resolve(DB_PATH)}`);
    }
    console.log('This removes ALL rows from ALL tables (users, stock, orders, carriers, etc.).');
    console.log('With --yes --keep-admin, only user rows where role is admin are preserved (everything else cleared).');
    console.log('Schema and migrations stay intact.');
    console.log('\nRe-run with --yes to wipe everything.');
    console.log('Re-run with --yes --keep-admin to wipe except admin user rows.');
    if (!DATABASE_URL) {
      console.log('Tip: stop ./dev.sh or any process using this DB if you get SQLITE_BUSY.');
    }
    process.exit(0);
  }

  if (DATABASE_URL) {
    await wipePostgres(keepAdmin);
  } else {
    await wipeSqlite(keepAdmin);
  }
  console.log('Demo stock/customer/FIFO seed runs only when GODAM_SEED_DEMO_DATA=1 (see backend/db.js).');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
