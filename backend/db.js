/**
 * GoDam main warehouse DB entrypoint — PostgreSQL only.
 *
 * Production requires DATABASE_URL and a schema populated via the migration scripts.
 * SQLite is not a supported runtime for the main warehouse. The `sqlite3` package remains
 * for the Huawei plugin DB, one-shot migrate-sqlite-to-postgres.js, and a few CLI scripts
 * that optionally target a legacy warehouse.db file when DATABASE_URL is unset.
 */
const required = ['DATABASE_URL'];
const missing = required.filter((k) => !process.env[k] || !String(process.env[k]).trim());
if (missing.length) {
  console.error(
    `FATAL: missing required environment variables: ${missing.join(', ')}.\n` +
      `       Set them in your environment or in backend/.env. See backend/.env.example.`
  );
  process.exit(1);
}

const dbType = String(process.env.DB_TYPE || 'postgres').toLowerCase();
if (dbType !== 'postgres' && dbType !== 'postgresql') {
  console.error(
    `FATAL: unsupported DB_TYPE="${dbType}". This build is Postgres-only — ` +
      `set DB_TYPE=postgres (or unset DB_TYPE) in your environment.`
  );
  process.exit(1);
}

module.exports = require('./warehousePostgresDb');
