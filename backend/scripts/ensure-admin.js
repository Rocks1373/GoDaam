#!/usr/bin/env node
/**
 * Ensures admin user exists with a valid bcrypt hash (avoids shell mangling $ in hashes).
 * Usage: node scripts/ensure-admin.js
 * Env: ADMIN_USERNAME (default admin), ADMIN_PASSWORD (default admin123), DB_PATH optional
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'warehouse.db');
const username = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD || 'admin123';

const db = new sqlite3.Database(DB_PATH);
const hash = bcrypt.hashSync(password, 10);

function finish(code = 0) {
  db.close(() => process.exit(code));
}

db.get('SELECT id FROM users WHERE username = ?', [username], (err, row) => {
  if (err) {
    console.error(err.message);
    finish(1);
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
          finish(1);
          return;
        }
        console.log(`Updated password for '${username}' (${DB_PATH})`);
        finish(0);
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
        finish(1);
        return;
      }
      console.log(`Created admin '${username}' (${DB_PATH})`);
      finish(0);
    }
  );
});
