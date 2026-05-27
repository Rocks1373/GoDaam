#!/usr/bin/env node
/**
 * If PostgreSQL has no `users` table or zero users, and SQLite warehouse.db exists,
 * run migrate-sqlite-to-postgres.js once so dev can start on a fresh PG volume.
 * Does nothing if PG already has users (avoids wiping PG on every dev start).
 */
const path = require('path');
const backendRoot = path.join(__dirname, '..');
const repoRoot = path.join(backendRoot, '..');
// backend/.env first, then repo-root .env (only fills vars not already set — backend wins on overlap).
require('dotenv').config({ path: path.join(backendRoot, '.env') });
require('dotenv').config({ path: path.join(repoRoot, '.env') });
const fs = require('fs');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const SQLITE_PATH = path.resolve(
  process.env.SQLITE_PATH || process.env.DB_PATH || path.join(__dirname, '..', 'warehouse.db')
);

async function pgIsEmpty() {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT COUNT(*)::int AS c
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'`
    );
    if (Number(r.rows[0]?.c) === 0) return true;
    const u = await c.query('SELECT COUNT(*)::int AS c FROM users');
    return Number(u.rows[0]?.c) === 0;
  } catch {
    return true;
  } finally {
    await c.end();
  }
}

async function main() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production' && process.env.ALLOW_PG_BOOTSTRAP !== '1') {
    console.log(
      '[pg-bootstrap] Skipped in production (NODE_ENV=production). Deploy uses existing PostgreSQL only — never copies SQLite over prod.'
    );
    return;
  }
  if (!DATABASE_URL) {
    console.log('[pg-bootstrap] DATABASE_URL not set; skip.');
    return;
  }
  if (!fs.existsSync(SQLITE_PATH)) {
    console.log('[pg-bootstrap] No SQLite file at', SQLITE_PATH, '- skip (create users via app or restore).');
    return;
  }
  let empty;
  try {
    empty = await pgIsEmpty();
  } catch (e) {
    console.warn('[pg-bootstrap] Could not reach PostgreSQL:', e.message);
    process.exitCode = 0;
    return;
  }
  if (!empty) {
    console.log('[pg-bootstrap] PostgreSQL already has data; skip SQLite copy.');
    return;
  }
  console.log('[pg-bootstrap] PostgreSQL empty; copying schema + data from', SQLITE_PATH);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'migrate-sqlite-to-postgres.js')], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, SQLITE_PATH, DATABASE_URL },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
