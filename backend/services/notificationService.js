const { Expo } = require('expo-server-sdk');
const { promisify } = require('util');
const db = require('../db');

const expo = new Expo();

async function logNotification(userId, title, body, data) {
  const run = promisify(db.run.bind(db));
  await run(
    `INSERT INTO notification_log (user_id, title, body, data_json) VALUES (?, ?, ?, ?)`,
    [userId || null, title || '', body || '', data ? JSON.stringify(data) : null]
  );
}

/**
 * Expo push tokens for users who have a permission enabled (and active).
 * Always includes admins.
 */
async function getExpoTokensForPermission(permissionKey) {
  const all = promisify(db.all.bind(db));
  const sql = `
    SELECT DISTINCT pd.expo_push_token, pd.user_id
    FROM push_devices pd
    JOIN users u ON u.id = pd.user_id
    WHERE COALESCE(u.is_active, 1) = 1
      AND ExpoPushToken_is_placeholder(pd.expo_push_token) = 0
      AND (
        lower(u.role) = 'admin'
        OR EXISTS (
          SELECT 1 FROM role_permissions rp
          WHERE lower(rp.role) = lower(u.role)
            AND rp.permission_key = ?
            AND rp.is_enabled = 1
        )
      )
  `;
  // SQLite has no ExpoPushToken_is_placeholder — filter in JS
  const rows = await all(
    `
    SELECT DISTINCT pd.expo_push_token, pd.user_id
    FROM push_devices pd
    JOIN users u ON u.id = pd.user_id
    WHERE COALESCE(u.is_active, 1) = 1
      AND (
        lower(u.role) = 'admin'
        OR EXISTS (
          SELECT 1 FROM role_permissions rp
          WHERE lower(rp.role) = lower(u.role)
            AND rp.permission_key = ?
            AND rp.is_enabled = 1
        )
      )
  `,
    [permissionKey]
  );

  return (rows || []).filter((r) => r.expo_push_token && Expo.isExpoPushToken(r.expo_push_token));
}

async function getExpoTokensForRoles(roleList) {
  const all = promisify(db.all.bind(db));
  const placeholders = roleList.map(() => '?').join(',');
  const rows = await all(
    `
    SELECT DISTINCT pd.expo_push_token, pd.user_id
    FROM push_devices pd
    JOIN users u ON u.id = pd.user_id
    WHERE COALESCE(u.is_active, 1) = 1
      AND lower(u.role) IN (${placeholders})
  `,
    roleList.map((r) => String(r).toLowerCase())
  );
  return (rows || []).filter((r) => r.expo_push_token && Expo.isExpoPushToken(r.expo_push_token));
}

/**
 * User IDs who should receive in-app notification rows (web + mobile).
 * Admin always included; others need at least one enabled permission in the list.
 */
async function getUserIdsWhoHaveAnyPermission(permissionKeys) {
  if (!permissionKeys?.length) return [];
  const all = promisify(db.all.bind(db));
  const placeholders = permissionKeys.map(() => '?').join(',');
  const rows = await all(
    `
    SELECT DISTINCT u.id
    FROM users u
    WHERE COALESCE(u.is_active, 1) = 1
      AND (
        lower(u.role) = 'admin'
        OR EXISTS (
          SELECT 1 FROM role_permissions rp
          WHERE lower(rp.role) = lower(u.role)
            AND rp.permission_key IN (${placeholders})
            AND rp.is_enabled = 1
        )
      )
  `,
    permissionKeys
  );
  return (rows || []).map((r) => r.id).filter((id) => id != null);
}

async function sendExpoPushToTokens(rows, title, body, data = {}) {
  if (!rows || !rows.length) return [];
  const messages = [];
  for (const r of rows) {
    messages.push({
      to: r.expo_push_token,
      sound: 'default',
      title,
      body,
      data,
    });
  }

  const chunks = expo.chunkPushNotifications(messages);
  const receipts = [];
  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      receipts.push(...ticketChunk);
    } catch (e) {
      console.error('Expo push error:', e.message);
    }
  }
  return receipts;
}

/** Notify pickers for new pick orders */
async function notifyPickOrder(title, body, data) {
  const rows = await getExpoTokensForPermission('can_pick_orders');
  await sendExpoPushToTokens(rows, title, body, data);
  const userIds = await getUserIdsWhoHaveAnyPermission(['can_pick_orders']);
  const seen = new Set();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, data);
  }
}

/** Notify pickers, checkers, admins (mobile-capable) on pick progress */
async function notifyPickProgress(title, body, data) {
  const picker = await getExpoTokensForPermission('can_pick_orders');
  const checker = await getExpoTokensForPermission('can_confirm_picked');
  const adminRows = await getExpoTokensForRoles(['admin']);
  const map = new Map();
  for (const r of [...picker, ...checker, ...adminRows]) {
    map.set(r.expo_push_token, r);
  }
  const rows = [...map.values()];
  await sendExpoPushToTokens(rows, title, body, data);
  const userIds = await getUserIdsWhoHaveAnyPermission(['can_pick_orders', 'can_confirm_picked']);
  const seen = new Set();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, data);
  }
}

async function notifyAdminChecker(title, body, data) {
  const adminRows = await getExpoTokensForRoles(['admin']);
  const checker = await getExpoTokensForPermission('can_confirm_picked');
  const map = new Map();
  for (const r of [...adminRows, ...checker]) {
    map.set(r.expo_push_token, r);
  }
  const rows = [...map.values()];
  await sendExpoPushToTokens(rows, title, body, data);
  const userIds = await getUserIdsWhoHaveAnyPermission(['can_confirm_picked']);
  const seen = new Set();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, data);
  }
}

/** Inbound uploaded → putaway in racks: notify receiving staff + pickers (warehouse). */
async function notifyInboundPutaway(title, body, data) {
  const receivers = await getExpoTokensForPermission('can_receive_stock');
  const pickers = await getExpoTokensForPermission('can_pick_orders');
  const map = new Map();
  for (const r of [...receivers, ...pickers]) {
    if (r.expo_push_token) map.set(r.expo_push_token, r);
  }
  const rows = [...map.values()];
  await sendExpoPushToTokens(rows, title, body, data);
  const userIds = await getUserIdsWhoHaveAnyPermission(['can_receive_stock', 'can_pick_orders']);
  const seen = new Set();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, data);
  }
}

/** Push + in-app log for specific user ids (e.g. matched driver). */
async function sendExpoPushToUserIds(userIds, title, body, data = {}) {
  if (!userIds?.length) return [];
  const all = promisify(db.all.bind(db));
  const ph = userIds.map(() => '?').join(',');
  const rows = await all(
    `SELECT DISTINCT expo_push_token, user_id FROM push_devices WHERE user_id IN (${ph}) AND expo_push_token IS NOT NULL`,
    userIds
  );
  const valid = (rows || []).filter((r) => r.expo_push_token && Expo.isExpoPushToken(r.expo_push_token));
  await sendExpoPushToTokens(valid, title, body, data);
  const seen = new Set();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, data);
  }
  return valid;
}

module.exports = {
  logNotification,
  notifyPickOrder,
  notifyPickProgress,
  notifyAdminChecker,
  notifyInboundPutaway,
  sendExpoPushToTokens,
  sendExpoPushToUserIds,
  getExpoTokensForPermission,
  getUserIdsWhoHaveAnyPermission,
};
