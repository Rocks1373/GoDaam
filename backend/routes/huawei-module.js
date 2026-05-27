const express = require('express');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');

const db = require('../db');
const { JWT_SECRET } = require('../middleware/auth');
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

const router = express.Router();

const FALLBACK_URL =
  process.env.HUAWEI_GODAM_URL || process.env.GODAM_10_URL || 'http://127.0.0.1:8501';

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

router.get('/godam-url', async (req, res) => {
  try {
    const row = await dbGet('SELECT external_url FROM huawei_godam_settings WHERE id = 1');
    const url = normalizeUrl(row?.external_url) || FALLBACK_URL;
    res.json({ url, label: 'GoDam-1.0' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/godam-url', async (req, res) => {
  try {
    if (String(req.user?.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const url = normalizeUrl(req.body?.external_url);
    if (!url) return res.status(400).json({ error: 'external_url must be a valid http(s) URL' });
    await dbRun(
      `UPDATE huawei_godam_settings SET external_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
      [url]
    );
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/godam-open', async (req, res) => {
  try {
    const row = await dbGet('SELECT external_url FROM huawei_godam_settings WHERE id = 1');
    const url = normalizeUrl(row?.external_url) || FALLBACK_URL;
    const uid = req.user?.id ? Number(req.user.id) : null;
    await dbRun(
      `INSERT INTO huawei_godam_launch_log (user_id, target_url, created_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [Number.isFinite(uid) ? uid : null, url]
    );
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** HttpOnly cookie so the Streamlit reverse-proxy iframe can load without Bearer headers. */
router.post('/streamlit-access-grant', async (req, res) => {
  try {
    const token = jwt.sign(
      { typ: 'huawei_streamlit', sub: req.user?.id, role: req.user?.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    const base = 'huawei-godam-app';
    const cookiePath = `/${base}`;
    const secure =
      String(process.env.COOKIE_SECURE || '').trim() === '1' ||
      String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    res.cookie('huawei_streamlit_proxy', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: cookiePath,
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ ok: true, basePath: cookiePath });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
