/**
 * Full row wipe (schema preserved) for the main warehouse DB and Huawei SQLite.
 * Main warehouse: pass opts.dialect "postgres" when using warehousePostgresDb / pg scripts.
 */
const { translateSqlForPostgres } = require('../lib/sqlDialect');

async function getUserColumnNamesSqlite(all) {
  const cols = await all(`PRAGMA table_info(users)`);
  return cols.sort((a, b) => a.cid - b.cid).map((c) => c.name);
}

async function getUserColumnNamesPostgres(all) {
  const cols = await all(
    `SELECT column_name AS name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users'
     ORDER BY ordinal_position`
  );
  return cols.map((c) => c.name);
}

function rowValueForColumn(row, name) {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const lower = String(name).toLowerCase();
  const key = Object.keys(row).find((k) => String(k).toLowerCase() === lower);
  return key != null ? row[key] : null;
}

async function restoreAdminUsers(run, all, adminRows, dialect) {
  if (!adminRows.length) return;
  const colNames =
    dialect === 'postgres' ? await getUserColumnNamesPostgres(all) : await getUserColumnNamesSqlite(all);
  const quoted = colNames.map((n) => `"${String(n).replace(/"/g, '""')}"`).join(', ');
  const placeholders = colNames.map(() => '?').join(', ');
  const sql = `INSERT INTO users (${quoted}) VALUES (${placeholders})`;
  for (const row of adminRows) {
    const values = colNames.map((name) => rowValueForColumn(row, name));
    await run(sql, values);
  }
}

async function refreshUsersSequenceSqlite(run, get) {
  const maxRow = await get(`SELECT MAX(id) AS m FROM users`);
  const m = maxRow?.m;
  if (m == null) return;
  await run(`DELETE FROM sqlite_sequence WHERE name = 'users'`).catch(() => {});
  await run(`INSERT INTO sqlite_sequence (name, seq) VALUES ('users', ?)`, [m]);
}

async function refreshUsersSequencePostgres(run, get) {
  const seqRow = await get(`SELECT pg_get_serial_sequence('users', 'id') AS seq`);
  const seq = seqRow?.seq;
  if (!seq) return;
  const maxRow = await get(`SELECT COALESCE(MAX(id), 1) AS m FROM users`);
  const m = maxRow?.m;
  if (m == null) return;
  await run(`SELECT setval(?::regclass, ?::bigint, true)`, [String(seq), Number(m)]);
}

async function wipeMainWarehouseDbPostgres(dbRun, dbAll, dbGet, opts) {
  const keepAdmin = opts.keepAdmin !== false;
  let adminBackup = [];
  if (keepAdmin) {
    adminBackup = await dbAll(
      `SELECT * FROM users WHERE lower(trim(coalesce(role,''))) = 'admin'`
    );
  }

  const tables = await dbAll(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  const quoted = tables.map((row) => {
    const n = String(row.name);
    return `"${n.replace(/"/g, '""')}"`;
  });
  if (quoted.length) {
    await dbRun(`TRUNCATE TABLE ${quoted.join(', ')} RESTART IDENTITY CASCADE`);
  }

  if (keepAdmin && adminBackup.length) {
    await restoreAdminUsers(dbRun, dbAll, adminBackup, 'postgres');
    await refreshUsersSequencePostgres(dbRun, dbGet);
  }
}

/**
 * Deletes every row from every user table in the main warehouse DB.
 * @param {Function} dbRun promisified db.run
 * @param {Function} dbAll promisified db.all
 * @param {Function} dbGet promisified db.get
 * @param {{ keepAdmin?: boolean, dialect?: 'postgres'|'sqlite' }} opts keepAdmin preserves rows where role = admin (case-insensitive)
 */
async function wipeMainWarehouseDb(dbRun, dbAll, dbGet, opts = {}) {
  const dialect = String(opts.dialect || 'sqlite').toLowerCase();
  if (dialect === 'postgres' || dialect === 'postgresql') {
    return wipeMainWarehouseDbPostgres(dbRun, dbAll, dbGet, opts);
  }

  const keepAdmin = opts.keepAdmin !== false;
  let adminBackup = [];
  if (keepAdmin) {
    adminBackup = await dbAll(
      `SELECT * FROM users WHERE lower(trim(coalesce(role,''))) = 'admin'`
    );
  }

  await dbRun('PRAGMA foreign_keys = OFF');
  const tables = await dbAll(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );

  for (const row of tables) {
    const safe = String(row.name).replace(/"/g, '""');
    await dbRun(`DELETE FROM "${safe}"`);
  }

  const seq = await dbAll(`SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`);
  if (seq.length) await dbRun('DELETE FROM sqlite_sequence').catch(() => {});

  if (keepAdmin && adminBackup.length) {
    await restoreAdminUsers(dbRun, dbAll, adminBackup, 'sqlite');
    await refreshUsersSequenceSqlite(dbRun, dbGet);
  }

  await dbRun('PRAGMA foreign_keys = ON');
  await dbRun('VACUUM');
}

/**
 * Deletes every row from every table in the Huawei GoDam SQLite file (separate connection).
 */
async function wipeHuaweiGodamDb(dbRun, dbAll) {
  await dbRun('PRAGMA foreign_keys = OFF');
  const tables = await dbAll(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );
  for (const row of tables) {
    const safe = String(row.name).replace(/"/g, '""');
    await dbRun(`DELETE FROM "${safe}"`);
  }
  const seq = await dbAll(`SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`);
  if (seq.length) await dbRun('DELETE FROM sqlite_sequence').catch(() => {});
  await dbRun('PRAGMA foreign_keys = ON');
  await dbRun('VACUUM');
}

/** Standalone scripts: wrap a pg Client with the same ?-placeholder style as warehousePostgresDb. */
function createPgWipeHelpers(connectionString) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: String(connectionString).trim() });

  async function run(sql, params = []) {
    const { text, values } = translateSqlForPostgres(sql, params || []);
    await client.query(text, values);
  }

  async function all(sql, params = []) {
    const { text, values } = translateSqlForPostgres(sql, params || []);
    const res = await client.query(text, values);
    return res.rows;
  }

  async function get(sql, params = []) {
    const rows = await all(sql, params);
    return rows[0];
  }

  return {
    connect: () => client.connect(),
    close: () => client.end(),
    run,
    all,
    get,
  };
}

module.exports = {
  wipeMainWarehouseDb,
  wipeHuaweiGodamDb,
  createPgWipeHelpers,
};
