#!/usr/bin/env node
/**
 * Ensures admin user exists with a valid bcrypt hash (avoids shell mangling $ in hashes).
 * Usage: node scripts/ensure-admin.js
 * Env: ADMIN_USERNAME (default admin), ADMIN_PASSWORD (default admin123)
 * When DATABASE_URL is set: applies the same Postgres schema migration as the API (fresh DB has no `users` yet),
 * then creates or updates the admin row.
 * Otherwise: uses SQLite file DB_PATH (default backend/warehouse.db).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3');
const { translateSqlForPostgres } = require('../lib/sqlDialect');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'warehouse.db');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const username = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD || 'admin123';
const hash = bcrypt.hashSync(password, 10);

/** Run migrateGodamSchema once via the shared pool (safe before `node server.js`). */
async function migratePostgresWarehouseSchema() {
  const db = require('../warehousePostgresDb');
  const { migrateGodamSchema } = require('../schema-migrate');
  await new Promise((resolve, reject) => {
    db.run('SELECT 1', async (err) => {
      if (err) return reject(err);
      try {
        await migrateGodamSchema(db);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function ensurePostgres() {
  const { Client } = require('pg');
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const get = async (sql, params = []) => {
      const { text, values } = translateSqlForPostgres(sql, params);
      const res = await client.query(text, values);
      return res.rows[0];
    };
    const run = async (sql, params = []) => {
      const { text, values } = translateSqlForPostgres(sql, params);
      await client.query(text, values);
    };
    const row = await get('SELECT id FROM users WHERE username = ?', [username]);
    if (row?.id) {
      await run(
        `UPDATE users SET password_hash = ?, is_active = 1, role = 'admin',
        can_access_web = 1, can_access_mobile = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
        [hash, row.id]
      );
      console.log(`Updated password for '${username}' (PostgreSQL)`);
      return;
    }
    await run(
      `INSERT INTO users (username, password_hash, role, full_name, is_active, token_expiry_days, can_access_web, can_access_mobile)
     VALUES (?, ?, 'admin', ?, 1, 30, 1, 1)`,
      [username, hash, username]
    );
    console.log(`Created admin '${username}' (PostgreSQL)`);
  } finally {
    await client.end();
  }
}

function ensureSqlite() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    const done = (err) => {
      db.close((closeErr) => {
        if (err || closeErr) reject(err || closeErr);
        else resolve();
      });
    };
    db.get('SELECT id FROM users WHERE username = ?', [username], (err, row) => {
      if (err) {
        console.error(err.message);
        done(err);
        return;
      }
      if (row?.id) {
        db.run(
          `UPDATE users SET password_hash = ?, is_active = 1, role = 'admin',
        can_access_web = 1, can_access_mobile = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
          [hash, row.id],
          (e2) => {
            if (e2) {
              console.error(e2.message);
              done(e2);
              return;
            }
            console.log(`Updated password for '${username}' (${DB_PATH})`);
            done(null);
          }
        );
        return;
      }
      db.run(
        `INSERT INTO users (username, password_hash, role, full_name, is_active, token_expiry_days, can_access_web, can_access_mobile)
     VALUES (?, ?, 'admin', ?, 1, 30, 1, 1)`,
        [username, hash, username],
        (e3) => {
          if (e3) {
            console.error(e3.message);
            done(e3);
            return;
          }
          console.log(`Created admin '${username}' (${DB_PATH})`);
          done(null);
        }
      );
    });
  });
}

async function main() {
  if (DATABASE_URL) {
    await migratePostgresWarehouseSchema();
    await ensurePostgres();
  } else {
    await ensureSqlite();
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
