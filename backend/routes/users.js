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

/** Replace user_warehouses rows and set users.default_warehouse_id. Admins may have none (all warehouses). */
async function syncUserWarehouses(userId, role, body) {
  const r = String(role || '').toLowerCase();
  let ids;
  if (Array.isArray(body.warehouse_ids)) {
    ids = [...new Set(body.warehouse_ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
  } else if (r === 'admin') {
    ids = [];
  } else {
    const existing = await dbAll(`SELECT warehouse_id FROM user_warehouses WHERE user_id = ?`, [userId]);
    ids = (existing || []).map((row) => Number(row.warehouse_id)).filter((n) => Number.isFinite(n) && n > 0);
  }
  let def = body.default_warehouse_id != null && body.default_warehouse_id !== '' ? Number(body.default_warehouse_id) : null;
  if (def && !ids.includes(def)) def = ids[0] || null;
  if (!def && ids.length) def = ids[0];

  await dbRun(`DELETE FROM user_warehouses WHERE user_id = ?`, [userId]);

  if (r === 'admin') {
    await dbRun(`UPDATE users SET default_warehouse_id = ? WHERE id = ?`, [def || null, userId]);
    return;
  }
  if (!ids.length) {
    const err = new Error('Non-admin users must be assigned at least one warehouse');
    err.status = 400;
    throw err;
  }
  const rw = r || 'member';
  for (const wid of ids) {
    const isDef = def && wid === def ? 1 : 0;
    await dbRun(
      `INSERT OR IGNORE INTO user_warehouses (user_id, warehouse_id, role_in_warehouse, is_default)
       VALUES (?, ?, ?, ?)`,
      [userId, wid, rw, isDef]
    );
  }
  if (def) {
    await dbRun(`UPDATE user_warehouses SET is_default = 0 WHERE user_id = ? AND warehouse_id != ?`, [userId, def]);
    await dbRun(`UPDATE user_warehouses SET is_default = 1 WHERE user_id = ? AND warehouse_id = ?`, [userId, def]);
  }
  await dbRun(`UPDATE users SET default_warehouse_id = ? WHERE id = ?`, [def || null, userId]);
}

router.get('/', async (_req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, full_name, username, mobile_number, email, role, is_active,
              token_expiry_days, can_access_web, can_access_mobile, default_warehouse_id,
              created_at, updated_at
       FROM users ORDER BY id ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/warehouse-assignments', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const u = await dbGet(`SELECT id, default_warehouse_id, role FROM users WHERE id = ?`, [id]);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const rows = await dbAll(`SELECT * FROM user_warehouses WHERE user_id = ? ORDER BY warehouse_id`, [id]);
    res.json({
      default_warehouse_id: u.default_warehouse_id ?? null,
      warehouse_ids: (rows || []).map((x) => x.warehouse_id),
    });
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
    const uid = Number(row?.id);
    try {
      await syncUserWarehouses(uid, role, b);
    } catch (e2) {
      await dbRun(`DELETE FROM users WHERE id = ?`, [uid]).catch(() => {});
      return res.status(e2.status || 400).json({ error: e2.message });
    }
    const created = await dbGet(
      `SELECT id, full_name, username, mobile_number, email, role, is_active,
              token_expiry_days, can_access_web, can_access_mobile, default_warehouse_id, created_at
       FROM users WHERE id = ?`,
      [uid]
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
    const prev = await dbGet(`SELECT role FROM users WHERE id = ?`, [id]);
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
              token_expiry_days, can_access_web, can_access_mobile, default_warehouse_id, created_at, updated_at
       FROM users WHERE id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (b.warehouse_ids !== undefined || b.default_warehouse_id !== undefined) {
      await syncUserWarehouses(id, row.role || b.role, b);
    } else if (String(row.role || '').toLowerCase() === 'admin' && String(prev?.role || '').toLowerCase() !== 'admin') {
      await dbRun(`DELETE FROM user_warehouses WHERE user_id = ?`, [id]);
    }
    const out = await dbGet(
      `SELECT id, full_name, username, mobile_number, email, role, is_active,
              token_expiry_days, can_access_web, can_access_mobile, default_warehouse_id, created_at, updated_at
       FROM users WHERE id = ?`,
      [id]
    );
    res.json(out);
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
