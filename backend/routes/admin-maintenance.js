const express = require('express');
const path = require('path');
const { promisify } = require('util');
const db = require('../db');
const { clearOutboundDomain, BROWSE_WHITELIST } = require('../services/outboundDomainClear');

const router = express.Router();
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

const CONFIRM_PHRASE = 'DELETE ALL OUTBOUND DATA';

router.get('/outbound-stats', async (_req, res) => {
  try {
    const counts = {};
    for (const table of BROWSE_WHITELIST) {
      const row = await dbGet(`SELECT COUNT(1) AS c FROM ${table}`);
      counts[table] = Number(row?.c) || 0;
    }
    const dbPath = process.env.DB_PATH || './warehouse.db';
    res.json({
      counts,
      dbPathResolved: path.resolve(dbPath),
      dbFileName: path.basename(path.resolve(dbPath)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/browse/:table', async (req, res) => {
  const table = String(req.params.table || '');
  if (!/^[a-z_]+$/.test(table) || !BROWSE_WHITELIST.has(table)) {
    return res.status(400).json({ error: 'Invalid or unsupported table' });
  }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  try {
    const rows = await dbAll(`SELECT * FROM ${table} LIMIT ?`, [limit]);
    res.json({ table, limit, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/clear-outbound-domain', async (req, res) => {
  const phrase = String(req.body?.confirmPhrase ?? '').trim();
  if (phrase !== CONFIRM_PHRASE) {
    return res.status(400).json({
      error: 'Confirmation phrase mismatch',
      expectedPhrase: CONFIRM_PHRASE,
      hint: 'Paste the exact phrase into the confirmation field on the admin page.',
    });
  }
  try {
    await clearOutboundDomain(dbRun);
    const counts = {};
    for (const t of BROWSE_WHITELIST) {
      const row = await dbGet(`SELECT COUNT(1) AS c FROM ${t}`);
      counts[t] = Number(row?.c) || 0;
    }
    console.warn('[admin-maintenance] Cleared entire outbound domain; post-clear counts:', counts);
    res.json({ ok: true, cleared: true, counts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
