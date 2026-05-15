#!/usr/bin/env node
/**
 * Copy the main warehouse SQLite file to backend/backups/warehouse_backup_YYYYMMDD.db
 * Does not delete the source database.
 */
const fs = require('fs');
const path = require('path');

const src = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'warehouse.db'));
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const destDir = path.join(__dirname, '..', 'backups');
const dest = path.join(destDir, `warehouse_backup_${stamp}.db`);

if (!fs.existsSync(src)) {
  console.error('Source DB not found:', src);
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log('Backed up SQLite warehouse DB');
console.log('  from:', src);
console.log('  to:  ', dest);
