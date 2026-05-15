/**
 * PostgreSQL connection for GoDam warehouse DB with sqlite3-style callbacks
 * (get / all / run / serialize / prepare) so existing routes keep working.
 *
 * Requires DATABASE_URL and a schema populated from SQLite (see scripts/migrate-sqlite-to-postgres.js).
 */
const { AsyncLocalStorage } = require('async_hooks');
const { Pool } = require('pg');
const { translateSqlForPostgres } = require('./lib/sqlDialect');

class PgStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  run(params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    return this.db.run(this.sql, params || [], callback);
  }

  finalize(callback) {
    if (typeof callback === 'function') callback(null);
  }
}

function shouldAppendReturningId(sql) {
  const s = String(sql).trim();
  if (!/^\s*insert\s+into\s+/i.test(s)) return false;
  if (/\breturning\b/i.test(s)) return false;
  if (/^\s*insert\s+into\s+outbound_order_seen\b/i.test(s)) return false;
  return true;
}

function shouldRetryWithoutReturning(err) {
  const msg = String(err?.message || '');
  return err?.code === '42703' || /returning/i.test(msg);
}

function poolOptionsFromEnv(connectionString) {
  const max = Number(process.env.PG_POOL_MAX || 25) || 25;
  const connectionTimeoutMillis = Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10_000) || 10_000;
  const idleTimeoutMillis = Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000) || 30_000;
  return {
    connectionString,
    max,
    connectionTimeoutMillis,
    idleTimeoutMillis,
  };
}

class WarehousePostgresDb {
  constructor() {
    const url = process.env.DATABASE_URL || '';
    if (!String(url).trim()) {
      throw new Error('DATABASE_URL is required when DB_TYPE=postgres');
    }
    this.pool = new Pool(poolOptionsFromEnv(url.trim()));
    this.dialect = 'postgres';
    this.txStore = new AsyncLocalStorage();
  }

  serialize(callback) {
    if (typeof callback === 'function') callback();
  }

  prepare(sql) {
    return new PgStatement(this, sql);
  }

  _activeClient() {
    const store = this.txStore.getStore();
    return store?.client && !store.released ? store.client : this.pool;
  }

  _isBegin(text) {
    return /^\s*BEGIN\b/i.test(String(text));
  }

  _isCommit(text) {
    return /^\s*COMMIT\b/i.test(String(text));
  }

  _isRollback(text) {
    return /^\s*ROLLBACK\b/i.test(String(text));
  }

  _query(client, sql, params = [], { appendReturningId = false } = {}) {
    let text;
    let values;
    try {
      ({ text, values } = translateSqlForPostgres(sql, params || []));
    } catch (e) {
      return Promise.reject(e);
    }
    let execText = text;
    const canAppendReturningId = appendReturningId && shouldAppendReturningId(text);
    if (canAppendReturningId) {
      execText = `${text.trim()} RETURNING id`;
    }
    return client.query(execText, values).catch((err) => {
      if (!canAppendReturningId || !shouldRetryWithoutReturning(err)) throw err;
      return client.query(text, values);
    });
  }

  async withTransaction(work) {
    const client = await this.pool.connect();
    const tx = {
      dialect: this.dialect,
      get: async (sql, params = []) => {
        const res = await this._query(client, sql, params);
        return res.rows[0];
      },
      all: async (sql, params = []) => {
        const res = await this._query(client, sql, params);
        return res.rows;
      },
      run: async (sql, params = []) => {
        const res = await this._query(client, sql, params);
        return {
          changes: res.rowCount != null ? res.rowCount : 0,
          lastID: 0,
        };
      },
    };

    try {
      await client.query('BEGIN');
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback failure */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  get(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    let text;
    let values;
    try {
      ({ text, values } = translateSqlForPostgres(sql, params || []));
    } catch (e) {
      return callback.call(null, e);
    }
    this._activeClient()
      .query(text, values)
      .then((res) => {
        callback.call(null, null, res.rows[0]);
      })
      .catch((err) => {
        callback.call(null, err);
      });
  }

  all(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    let text;
    let values;
    try {
      ({ text, values } = translateSqlForPostgres(sql, params || []));
    } catch (e) {
      return callback.call(null, e);
    }
    this._activeClient()
      .query(text, values)
      .then((res) => {
        callback.call(null, null, res.rows);
      })
      .catch((err) => {
        callback.call(null, err);
      });
  }

  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const ctx = { lastID: 0, changes: 0 };
    let text;
    let values;
    try {
      ({ text, values } = translateSqlForPostgres(sql, params || []));
    } catch (e) {
      return callback.call(ctx, e);
    }
    if (this._isBegin(text)) {
      this.pool
        .connect()
        .then((client) => {
          this.txStore.enterWith({ client, released: false });
          return client.query(text, values).then((res) => ({ client, res }));
        })
        .then(({ res }) => {
          ctx.changes = res.rowCount != null ? res.rowCount : 0;
          callback.call(ctx, null);
        })
        .catch((err) => {
          const store = this.txStore.getStore();
          if (store?.client && !store.released) {
            store.released = true;
            store.client.release();
          }
          callback.call(ctx, err);
        });
      return;
    }

    const store = this.txStore.getStore();
    const client = store?.client && !store.released ? store.client : this.pool;
    const finishTransaction = this._isCommit(text) || this._isRollback(text);
    let execText = text;
    if (shouldAppendReturningId(text)) {
      execText = `${text.trim()} RETURNING id`;
    }
    client
      .query(execText, values)
      .then((res) => {
        ctx.changes = res.rowCount != null ? res.rowCount : 0;
        const id = res.rows && res.rows[0] && res.rows[0].id != null ? Number(res.rows[0].id) : 0;
        ctx.lastID = id;
        if (finishTransaction && store?.client && !store.released) {
          store.released = true;
          store.client.release();
          store.client = null;
        }
        callback.call(ctx, null);
      })
      .catch((err) => {
        if (shouldAppendReturningId(text) && shouldRetryWithoutReturning(err)) {
          client
            .query(text, values)
            .then((res2) => {
              ctx.changes = res2.rowCount != null ? res2.rowCount : 0;
              ctx.lastID = 0;
              if (finishTransaction && store?.client && !store.released) {
                store.released = true;
                store.client.release();
                store.client = null;
              }
              callback.call(ctx, null);
            })
            .catch((e2) => callback.call(ctx, e2));
          return;
        }
        if (finishTransaction && store?.client && !store.released) {
          store.released = true;
          store.client.release();
          store.client = null;
        }
        callback.call(ctx, err);
      });
  }

  close(callback) {
    this.pool
      .end()
      .then(() => {
        if (typeof callback === 'function') callback(null);
      })
      .catch(() => {
        if (typeof callback === 'function') callback(null);
      });
  }
}

const db = new WarehousePostgresDb();

console.log('🗄️ Warehouse database: PostgreSQL (DATABASE_URL)');

const { migrateGodamSchema } = require('./schema-migrate');

db.run('SELECT 1', async (err) => {
  if (err) {
    console.error('❌ PostgreSQL ping failed:', err.message);
    return;
  }
  try {
    await migrateGodamSchema(db);
  } catch (e) {
    console.error('❌ Schema migrate (postgres):', e.message);
  }
});

module.exports = db;
