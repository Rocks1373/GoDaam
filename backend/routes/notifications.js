const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requireAuth, requireAdmin, requireMobileAccess } = require('../middleware/auth');
const { sendExpoPushToTokens } = require('../services/notificationService');

const router = express.Router();
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

router.post('/register-device', requireAuth, requireMobileAccess, async (req, res) => {
  try {
    const { expo_push_token, device_id, platform } = req.body || {};
    const token = String(expo_push_token || '').trim();
    if (!token) return res.status(400).json({ error: 'expo_push_token required' });
    const uid = req.user.sub;
    const did = device_id ? String(device_id) : token.slice(-24);

    const existing = await dbGet(`SELECT id FROM push_devices WHERE user_id = ? AND device_id = ?`, [uid, did]);
    if (existing?.id) {
      await dbRun(
        `UPDATE push_devices SET expo_push_token = ?, platform = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [token, platform || null, existing.id]
      );
    } else {
      await dbRun(
        `INSERT INTO push_devices (user_id, expo_push_token, device_id, platform)
         VALUES (?, ?, ?, ?)`,
        [uid, token, did, platform || null]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/send', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, body, expo_push_token } = req.body || {};
    if (!expo_push_token) return res.status(400).json({ error: 'expo_push_token required' });
    await sendExpoPushToTokens([{ expo_push_token }], title || 'GoDam', body || '', {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const uid = req.user.sub;
    const unreadOnly = String(req.query?.unread_only || '') === 'true';
    const rows = await dbAll(
      `SELECT id, title, body, data_json, created_at, read_at
       FROM notification_log
       WHERE user_id = ?
         AND (? = 0 OR read_at IS NULL)
       ORDER BY id DESC LIMIT 100`,
      [uid, unreadOnly ? 1 : 0]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    const uid = req.user.sub;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    await dbRun(
      `UPDATE notification_log
       SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
       WHERE id = ? AND user_id = ?`,
      [id, uid]
    );
    const row = await dbGet(`SELECT id, read_at FROM notification_log WHERE id = ? AND user_id = ?`, [id, uid]);
    res.json({ ok: true, ...row });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
