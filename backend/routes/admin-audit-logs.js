const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const dbRun = promisify(db.run.bind(db));

function isPostgres() {
  return db && db.dialect === 'postgres';
}

/** Manual retention cleanup only — never auto-scheduled from app code. */
router.delete('/cleanup', requireAdmin, async (req, res) => {
  try {
    const days = Number(req.query.older_than_days);
    const confirm = String(req.query.confirm || '').trim();
    if (!Number.isFinite(days) || days < 30) {
      return res.status(400).json({ error: 'Query older_than_days is required and must be >= 30' });
    }
    if (confirm !== 'DELETE_AUDIT_LOGS') {
      return res.status(400).json({ error: 'Set confirm=DELETE_AUDIT_LOGS to proceed' });
    }
    const d = Math.floor(days);
    if (isPostgres()) {
      await dbRun(`DELETE FROM audit_logs WHERE created_at < NOW() - ($1::integer * INTERVAL '1 day')`, [d]);
    } else {
      await dbRun(`DELETE FROM audit_logs WHERE datetime(created_at) < datetime('now', ?)`, [`-${d} days`]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
