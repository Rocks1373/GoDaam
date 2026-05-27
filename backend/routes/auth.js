const express = require('express');
const rateLimit = require('express-rate-limit');
const { promisify } = require('util');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');

const db = require('../db');
const {
  JWT_SECRET,
  JWT_MAX_LIFETIME_SECONDS,
  requireAuth,
} = require('../middleware/auth');
const { getPermissionMapForUserId, effectiveApprovalStatus } = require('../services/permissionService');
const { listWarehousesForUser } = require('../services/warehouseContext');
const { buildAuthResponse } = require('../services/authSessionService');
const { handleGoogleLogin } = require('../services/googleAuthLoginService');

const router = express.Router();
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));
const isPg = db.dialect === 'postgres';

const DUMMY_HASH =
  '$2a$10$CwTycUXWue0Thq9StjUM0uJ8h5oH8lTSO3jWLAydt7jwETI8h5UnG'; // bcrypt("invalid_password")

const loginBodySchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
});

/**
 * Rate-limit /login + /refresh to slow brute-force and credential-stuffing.
 */
const loginLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

const loginLimiterPerUser = rateLimit({
  windowMs: Number(process.env.AUTH_USER_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.AUTH_USER_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const u =
      req.body && typeof req.body.username === 'string' ? req.body.username : '__missing__';
    return `login_user:${u.toLowerCase().slice(0, 200)}`;
  },
  message: { error: 'Too many login attempts for this account. Please try again later.' },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const googleLoginSchema = z.object({
  googleToken: z.string().min(10).max(10000),
  idToken: z.string().min(10).max(10000).optional(),
});

function clampLifetimeSeconds(requestedDays) {
  const days = Number(requestedDays) > 0 ? Number(requestedDays) : 7;
  const requestedSeconds = days * 86400;
  return Math.min(requestedSeconds, JWT_MAX_LIFETIME_SECONDS);
}

function isLocked(user) {
  if (!user || !user.locked_until) return false;
  const t = new Date(user.locked_until).getTime();
  return Number.isFinite(t) && t > Date.now();
}

async function insertRevokedToken(jti, userId, expiresAtIso) {
  if (!jti || !userId || !expiresAtIso) return;
  if (isPg) {
    await dbRun(
      `INSERT INTO revoked_tokens (jti, user_id, expires_at) VALUES (?, ?, ?) ON CONFLICT (jti) DO NOTHING`,
      [String(jti), Number(userId), expiresAtIso]
    );
  } else {
    await dbRun(`INSERT OR IGNORE INTO revoked_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)`, [
      String(jti),
      Number(userId),
      expiresAtIso,
    ]);
  }
}

router.post('/login', loginLimiter, loginLimiterPerUser, async (req, res) => {
  try {
    const parsed = loginBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const { username, password } = parsed.data;

    const user = await dbGet(
      `SELECT id, username, password_hash, role, failed_login_attempts, locked_until,
              approval_status, is_blocked, is_active, token_expiry_days
       FROM users WHERE username = ?`,
      [username]
    );

    if (user && isLocked(user)) {
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(429).json({ error: 'Account temporarily locked. Try again later.' });
    }

    const hashToCompare = user ? user.password_hash : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hashToCompare);

    if (!user || !ok) {
      if (user) {
        const attempts = (Number(user.failed_login_attempts) || 0) + 1;
        const max = Math.max(1, Number(process.env.AUTH_LOCK_MAX_ATTEMPTS || 8));
        const lockMins = Math.max(1, Number(process.env.AUTH_LOCK_MINUTES || 30));
        const until = new Date(Date.now() + lockMins * 60 * 1000).toISOString();
        if (attempts >= max) {
          await dbRun(`UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?`, [
            attempts,
            until,
            user.id,
          ]);
        } else {
          await dbRun(`UPDATE users SET failed_login_attempts = ? WHERE id = ?`, [attempts, user.id]);
        }
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const approval = effectiveApprovalStatus(user);
    if (approval === 'PENDING') {
      return res.status(403).json({
        success: false,
        status: 'PENDING_APPROVAL',
        message: 'Your account is waiting for admin approval.',
      });
    }
    if (approval === 'REJECTED') {
      return res.status(403).json({
        success: false,
        status: 'REJECTED',
        message: 'Your access request was rejected.',
      });
    }
    if (approval === 'BLOCKED') {
      return res.status(403).json({
        success: false,
        status: 'BLOCKED',
        message: 'Your access has been blocked by administrator.',
      });
    }

    await dbRun(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?`, [user.id]);

    const fullUser = await dbGet(
      `SELECT id, username, role, full_name, email, approval_status, is_blocked, token_expiry_days
       FROM users WHERE id = ?`,
      [user.id]
    );
    const payload = await buildAuthResponse(fullUser);
    return res.json(payload);
  } catch (e) {
     
    console.error('[auth/login] error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/google-login', loginLimiter, async (req, res) => {
  try {
    const parsed = googleLoginSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const token = parsed.data.googleToken || parsed.data.idToken;
    const result = await handleGoogleLogin(token, { req });
    return res.json(result);
  } catch (e) {
    if (e.code === 'PENDING_APPROVAL' || e.statusCode === 403) {
      return res.status(403).json({
        success: false,
        status: e.code || 'PENDING_APPROVAL',
        message: e.message,
      });
    }
    const code = e.statusCode || 500;
    if (code >= 500) console.error('[auth/google-login] error:', e);
    return res.status(code).json({ error: e.message || 'Google login failed' });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const decoded = token ? jwt.decode(token) : null;
    const jti = decoded && decoded.jti ? String(decoded.jti) : null;
    const uid = decoded && decoded.sub != null ? Number(decoded.sub) : null;
    const expSec = decoded && decoded.exp != null ? Number(decoded.exp) : null;
    if (jti && uid && Number.isFinite(uid) && expSec) {
      const expiresAtIso = new Date(expSec * 1000).toISOString();
      await insertRevokedToken(jti, uid, expiresAtIso);
    }
    res.json({ ok: true });
  } catch (e) {
     
    console.error('[auth/logout] error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const changePasswordBodySchema = z.object({
  current_password: z.string().min(1).max(500),
  new_password: z.string().min(8).max(500),
});

/** Any authenticated user (web or mobile) may change their own password. */
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const parsed = changePasswordBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const { current_password, new_password } = parsed.data;
    const uid = Number(req.user?.sub);
    if (!uid) return res.status(401).json({ error: 'Unauthorized' });

    const user = await dbGet(`SELECT id, password_hash FROM users WHERE id = ?`, [uid]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(current_password, user.password_hash || '');
    if (!ok) {
      await bcrypt.compare(new_password, DUMMY_HASH);
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    if (current_password === new_password) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }

    const hash = bcrypt.hashSync(new_password, 10);
    await dbRun(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [hash, uid]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[auth/change-password] error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** Admin: persist preferred warehouse for uploads and session default (does not restrict access to other sites). */
router.patch('/me/default-warehouse', requireAuth, async (req, res) => {
  try {
    const mapped = await getPermissionMapForUserId(req.user.sub);
    if (!mapped) return res.status(401).json({ error: 'Unauthorized' });
    const role = String(mapped.user.role || '').toLowerCase();
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can set a default warehouse here' });
    }

    const raw = req.body?.warehouse_id;
    let wid = null;
    if (raw != null && raw !== '') {
      wid = Number(raw);
      if (!Number.isFinite(wid) || wid <= 0) {
        return res.status(400).json({ error: 'Invalid warehouse_id' });
      }
      const wh = await dbGet(
        `SELECT id FROM warehouses WHERE id = ? AND COALESCE(is_active, 1) = 1 LIMIT 1`,
        [wid]
      );
      if (!wh) return res.status(400).json({ error: 'Warehouse not found or inactive' });
    }

    await dbRun(`UPDATE users SET default_warehouse_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      wid,
      mapped.user.id,
    ]);

    res.json({
      ok: true,
      default_warehouse_id: wid,
    });
  } catch (e) {
    console.error('[auth/me/default-warehouse] error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const mapped = await getPermissionMapForUserId(req.user.sub);
    if (!mapped) return res.status(401).json({ error: 'Unauthorized' });

    const warehouses = await listWarehousesForUser(mapped.user.id, mapped.user.role);

    res.json({
      user: {
        id: mapped.user.id,
        username: mapped.user.username,
        role: String(mapped.user.role || '').toLowerCase(),
        full_name: mapped.user.full_name || mapped.user.username,
        email: mapped.user.email || null,
        mobile_number: mapped.user.mobile_number || null,
        approval_status: effectiveApprovalStatus(mapped.user),
        auth_provider: String(mapped.user.auth_provider || 'LOCAL').toUpperCase(),
        permissions: mapped.permissions,
        warehouses: warehouses || [],
        default_warehouse_id: mapped.user.default_warehouse_id ?? null,
      },
    });
  } catch (e) {
     
    console.error('[auth/me] error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/refresh', refreshLimiter, requireAuth, async (req, res) => {
  try {
    const mapped = await getPermissionMapForUserId(req.user.sub);
    if (!mapped) return res.status(401).json({ error: 'Unauthorized' });

    const expiresInSeconds = clampLifetimeSeconds(mapped.user.token_expiry_days);
    const jti = crypto.randomUUID();
    const token = jwt.sign(
      {
        sub: mapped.user.id,
        username: mapped.user.username,
        role: String(mapped.user.role || '').toLowerCase(),
        permissions: mapped.permissions,
        approval_status: effectiveApprovalStatus(mapped.user),
        jti,
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
     
    console.error('[auth/refresh] error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
