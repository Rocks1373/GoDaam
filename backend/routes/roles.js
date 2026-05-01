const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { PERMISSION_DEFS } = require('../schema-migrate');

const router = express.Router();
router.use(requireAdmin);

const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

router.get('/:role/permissions', async (req, res) => {
  try {
    const role = String(req.params.role || '').toLowerCase();
    const rows = await dbAll(
      `SELECT id, role, permission_key, permission_label, is_enabled, created_at, updated_at
       FROM role_permissions WHERE lower(role) = ? ORDER BY permission_key`,
      [role]
    );
    if (!rows.length && role) {
      const seeded = PERMISSION_DEFS.map(([permission_key, permission_label]) => ({
        role,
        permission_key,
        permission_label,
        is_enabled: 1,
      }));
      return res.json(seeded);
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:role/permissions', async (req, res) => {
  try {
    const role = String(req.params.role || '').toLowerCase();
    const list = req.body?.permissions;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'permissions array required' });

    await dbRun('BEGIN IMMEDIATE');
    for (const p of list) {
      const key = String(p.permission_key || '').trim();
      if (!key) continue;
      const enabled = p.is_enabled === false || p.is_enabled === 0 ? 0 : 1;
      await dbRun(
        `UPDATE role_permissions SET is_enabled = ?, updated_at = CURRENT_TIMESTAMP
         WHERE lower(role) = ? AND permission_key = ?`,
        [enabled, role, key]
      );
    }
    await dbRun('COMMIT');

    const rows = await dbAll(
      `SELECT id, role, permission_key, permission_label, is_enabled, updated_at
       FROM role_permissions WHERE lower(role) = ? ORDER BY permission_key`,
      [role]
    );
    res.json(rows);
  } catch (e) {
    try {
      await dbRun('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
