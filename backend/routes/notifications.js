const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendExpoPushToTokens } = require('../services/notificationService');

const router = express.Router();
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

router.post('/register-device', requireAuth, async (req, res) => {
  try {
    const { expo_push_token, device_id, platform, device_name, device_model } = req.body || {};
    const token = String(expo_push_token || '').trim();
    if (!token) return res.status(400).json({ error: 'expo_push_token required' });
    const uid = req.user.sub;
    const did = device_id ? String(device_id) : token.slice(-24);
    const plat = platform || null;

    const existing = await dbGet(`SELECT id FROM push_devices WHERE user_id = ? AND device_id = ?`, [uid, did]);
    if (existing?.id) {
      await dbRun(
        `UPDATE push_devices SET expo_push_token = ?, platform = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [token, plat, existing.id]
      );
    } else {
      await dbRun(
        `INSERT INTO push_devices (user_id, expo_push_token, device_id, platform, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [uid, token, did, plat]
      );
    }
    console.log(
      `[push] registered user=${uid} platform=${plat || 'unknown'} device=${String(device_name || device_model || did).slice(0, 48)}`
    );
    res.json({
      ok: true,
      platform: plat,
      token_prefix: token.slice(0, 28),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Send a test push to all devices registered for the current user. */
router.post('/test-my-push', requireAuth, async (req, res) => {
  try {
    const uid = req.user.sub;
    const rows = await dbAll(
      `SELECT expo_push_token, platform, updated_at FROM push_devices WHERE user_id = ? ORDER BY updated_at DESC`,
      [uid]
    );
    if (!rows?.length) {
      return res.status(400).json({
        error: 'No push token on server. Open GoDaam Home, allow notifications, wait a few seconds, then try again.',
      });
    }
    const title = String(req.body?.title || 'GoDaam test').slice(0, 120);
    const body = String(req.body?.body || 'If you see this alert, phone push is working.').slice(0, 500);
    const result = await sendExpoPushToTokens(rows, title, body, { type: 'test_push' });
    res.json({
      ok: result.ok,
      devices: rows.length,
      result,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/send', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, body, expo_push_token } = req.body || {};
    if (!expo_push_token) return res.status(400).json({ error: 'expo_push_token required' });
    const result = await sendExpoPushToTokens(
      [{ expo_push_token }],
      title || 'GoDam',
      body || '',
      {}
    );
    res.json({ ok: result.ok, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const uid = req.user.sub;
    const row = await dbGet(
      `SELECT COUNT(1) AS c FROM notification_log WHERE user_id = ? AND read_at IS NULL`,
      [uid]
    );
    res.json({ count: Number(row?.c) || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

router.post('/mark-all-read', requireAuth, async (req, res) => {
  try {
    const uid = req.user.sub;
    await dbRun(`UPDATE notification_log SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL`, [
      uid,
    ]);
    const row = await dbGet(
      `SELECT COUNT(1) AS c FROM notification_log WHERE user_id = ? AND read_at IS NULL`,
      [uid]
    );
    res.json({ ok: true, unread_remaining: Number(row?.c) || 0 });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
