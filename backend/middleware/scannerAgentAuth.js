const crypto = require('crypto');

/**
 * Shared secret for Local Scanner Agent only (header X-Scanner-Agent-Token).
 * Set SCANNER_AGENT_TOKEN and SCANNER_AGENT_USER_ID (existing users.id used as uploaded_by).
 * Optionally restrict warehouses: SCANNER_AGENT_WAREHOUSE_IDS=1,2,3
 */
function requireScannerAgent(req, res, next) {
  const expected = String(process.env.SCANNER_AGENT_TOKEN || '').trim();
  if (!expected) {
    return res.status(503).json({ error: 'Scanner agent is not configured (set SCANNER_AGENT_TOKEN on the server).' });
  }
  const got = String(req.headers['x-scanner-agent-token'] || '').trim();
  let ok = false;
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(got, 'utf8');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    ok = false;
  }
  if (!ok) {
    return res.status(401).json({ error: 'Invalid or missing X-Scanner-Agent-Token' });
  }
  const uid = Number(process.env.SCANNER_AGENT_USER_ID || 0);
  if (!uid || !Number.isFinite(uid)) {
    return res.status(503).json({ error: 'SCANNER_AGENT_USER_ID must be set to a valid users.id' });
  }
  req.user = {
    sub: uid,
    role: 'admin',
    permissions: {
      can_access_web: true,
      can_view_orders: true,
      can_upload_outbound: true,
      can_confirm_picked: true,
    },
  };
  next();
}

module.exports = { requireScannerAgent };
