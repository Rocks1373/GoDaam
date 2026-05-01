const express = require('express');
const { promisify } = require('util');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('../db');
const { JWT_SECRET, requireAuth } = require('../middleware/auth');
const { getPermissionMapForUserId } = require('../services/permissionService');

const router = express.Router();
const dbGet = promisify(db.get.bind(db));

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

    const user = await dbGet('SELECT id, username, password_hash, role FROM users WHERE username = ?', [username]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const mapped = await getPermissionMapForUserId(user.id);
    if (!mapped) return res.status(403).json({ error: 'Account inactive or unavailable' });

    const days = Number(mapped.user.token_expiry_days) || 30;
    const expiresInSeconds = Math.min(days * 86400, 365 * 86400);
    const token = jwt.sign(
      {
        sub: user.id,
        username: user.username,
        role: String(user.role || '').toLowerCase(),
        permissions: mapped.permissions,
      },
      JWT_SECRET,
      { expiresIn: expiresInSeconds }
    );

    const expires_at = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    return res.json({
      token,
      expires_at,
      token_expiry_days: days,
      user: {
        id: user.id,
        username: user.username,
        role: String(user.role || '').toLowerCase(),
        full_name: mapped.user.full_name || user.username,
        permissions: mapped.permissions,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

router.post('/logout', (_req, res) => {
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const mapped = await getPermissionMapForUserId(req.user.sub);
    if (!mapped) return res.status(401).json({ error: 'Unauthorized' });

    res.json({
      user: {
        id: mapped.user.id,
        username: mapped.user.username,
        role: String(mapped.user.role || '').toLowerCase(),
        full_name: mapped.user.full_name || mapped.user.username,
        email: mapped.user.email || null,
        mobile_number: mapped.user.mobile_number || null,
        permissions: mapped.permissions,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/refresh', requireAuth, async (req, res) => {
  try {
    const mapped = await getPermissionMapForUserId(req.user.sub);
    if (!mapped) return res.status(401).json({ error: 'Unauthorized' });

    const days = Number(mapped.user.token_expiry_days) || 30;
    const expiresInSeconds = Math.min(days * 86400, 365 * 86400);
    const token = jwt.sign(
      {
        sub: mapped.user.id,
        username: mapped.user.username,
        role: String(mapped.user.role || '').toLowerCase(),
        permissions: mapped.permissions,
      },
      JWT_SECRET,
      { expiresIn: expiresInSeconds }
    );
    const expires_at = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    res.json({
      token,
      expires_at,
      user: {
        id: mapped.user.id,
        username: mapped.user.username,
        permissions: mapped.permissions,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
