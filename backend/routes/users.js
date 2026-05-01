const express = require('express');
const bcrypt = require('bcryptjs');
const { promisify } = require('util');

const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

router.get('/', async (_req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, full_name, username, mobile_number, email, role, is_active,
              token_expiry_days, can_access_web, can_access_mobile, created_at, updated_at
       FROM users ORDER BY id ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const role = String(b.role || 'viewer').toLowerCase();
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });

    const hash = bcrypt.hashSync(password, 10);
    await dbRun(
      `INSERT INTO users (
        username, password_hash, role, full_name, mobile_number, email,
        is_active, token_expiry_days, can_access_web, can_access_mobile
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        username,
        hash,
        role,
        b.full_name || username,
        b.mobile_number || null,
        b.email || null,
        b.is_active === false || b.is_active === 0 ? 0 : 1,
        Number(b.token_expiry_days) || 30,
        b.can_access_web === false || b.can_access_web === 0 ? 0 : 1,
        b.can_access_mobile === false || b.can_access_mobile === 0 ? 0 : 1,
      ]
    );
    const row = await dbGet(`SELECT id FROM users WHERE username = ?`, [username]);
    const created = await dbGet(
      `SELECT id, full_name, username, mobile_number, email, role, is_active,
              token_expiry_days, can_access_web, can_access_mobile, created_at
       FROM users WHERE id = ?`,
      [row.id]
    );
    res.status(201).json(created);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    await dbRun(
      `UPDATE users SET
        full_name = COALESCE(?, full_name),
        username = COALESCE(?, username),
        mobile_number = ?,
        email = ?,
        role = COALESCE(?, role),
        is_active = ?,
        token_expiry_days = COALESCE(?, token_expiry_days),
        can_access_web = ?,
        can_access_mobile = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        b.full_name ?? null,
        b.username ? String(b.username).trim() : null,
        b.mobile_number ?? null,
        b.email ?? null,
        b.role ? String(b.role).toLowerCase() : null,
        b.is_active === undefined ? 1 : b.is_active ? 1 : 0,
        b.token_expiry_days !== undefined ? Number(b.token_expiry_days) : null,
        b.can_access_web === undefined ? 1 : b.can_access_web ? 1 : 0,
        b.can_access_mobile === undefined ? 1 : b.can_access_mobile ? 1 : 0,
        id,
      ]
    );
    const row = await dbGet(
      `SELECT id, full_name, username, mobile_number, email, role, is_active,
              token_expiry_days, can_access_web, can_access_mobile, created_at, updated_at
       FROM users WHERE id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await dbRun(`DELETE FROM push_devices WHERE user_id = ?`, [id]);
    await dbRun(`DELETE FROM users WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/disable', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await dbRun(`UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/reset-password', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const password = String(req.body?.password || '');
    if (!password) return res.status(400).json({ error: 'password required' });
    const hash = bcrypt.hashSync(password, 10);
    await dbRun(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [hash, id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
