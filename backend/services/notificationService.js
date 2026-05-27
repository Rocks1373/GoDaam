const { Expo } = require('expo-server-sdk');
const { promisify } = require('util');
const db = require('../db');
const { getDefaultWarehouseId } = require('./warehouseContext');

const expo = new Expo();

/** Android 8+ — must match godam-mobile GODAM_PUSH_CHANNEL_ID */
const ANDROID_CHANNEL_ID = 'godam-alerts-v2';

async function logNotification(userId, title, body, data) {
  const run = promisify(db.run.bind(db));
  let wid = data != null && data.warehouse_id != null && data.warehouse_id !== '' ? Number(data.warehouse_id) : null;
  if (!Number.isFinite(wid) || wid <= 0) {
    wid = await getDefaultWarehouseId();
  }
  await run(
    `INSERT INTO notification_log (user_id, title, body, data_json, warehouse_id) VALUES (?, ?, ?, ?, ?)`,
    [userId || null, title || '', body || '', data ? JSON.stringify(data) : null, wid]
  );
}

async function getExpoTokensForPermission(permissionKey, warehouseId = null) {
  const all = promisify(db.all.bind(db));
  const wid = warehouseId != null && Number(warehouseId) > 0 ? Number(warehouseId) : null;
  const sql = wid
    ? `
    SELECT DISTINCT pd.expo_push_token, pd.user_id
    FROM push_devices pd
    JOIN users u ON u.id = pd.user_id
    WHERE COALESCE(u.is_active, 1) = 1
      AND (
        lower(u.role) = 'admin'
        OR (
          EXISTS (
            SELECT 1 FROM role_permissions rp
            WHERE lower(rp.role) = lower(u.role)
              AND rp.permission_key = ?
              AND rp.is_enabled = 1
          )
          AND EXISTS (
            SELECT 1 FROM user_warehouses uw
            WHERE uw.user_id = u.id AND uw.warehouse_id = ?
          )
        )
      )
  `
    : `
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
  `;
  const params = wid ? [permissionKey, wid] : [permissionKey];
  const rows = await all(sql, params);
  return (rows || []).filter((r) => r.expo_push_token && Expo.isExpoPushToken(r.expo_push_token));
}

async function getExpoTokensForRoles(roleList, warehouseId = null) {
  const all = promisify(db.all.bind(db));
  const placeholders = roleList.map(() => '?').join(',');
  const wid = warehouseId != null && Number(warehouseId) > 0 ? Number(warehouseId) : null;
  const sql = wid
    ? `
    SELECT DISTINCT pd.expo_push_token, pd.user_id
    FROM push_devices pd
    JOIN users u ON u.id = pd.user_id
    WHERE COALESCE(u.is_active, 1) = 1
      AND (
        lower(u.role) = 'admin'
        OR (
          lower(u.role) IN (${placeholders})
          AND EXISTS (SELECT 1 FROM user_warehouses uw WHERE uw.user_id = u.id AND uw.warehouse_id = ?)
        )
      )
  `
    : `
    SELECT DISTINCT pd.expo_push_token, pd.user_id
    FROM push_devices pd
    JOIN users u ON u.id = pd.user_id
    WHERE COALESCE(u.is_active, 1) = 1
      AND lower(u.role) IN (${placeholders})
  `;
  const base = roleList.map((r) => String(r).toLowerCase());
  const params = wid ? [...base, wid] : base;
  const rows = await all(sql, params);
  return (rows || []).filter((r) => r.expo_push_token && Expo.isExpoPushToken(r.expo_push_token));
}

async function getUserIdsWhoHaveAnyPermission(permissionKeys, warehouseId = null) {
  if (!permissionKeys?.length) return [];
  const all = promisify(db.all.bind(db));
  const placeholders = permissionKeys.map(() => '?').join(',');
  const wid = warehouseId != null && Number(warehouseId) > 0 ? Number(warehouseId) : null;
  const sql = wid
    ? `
    SELECT DISTINCT u.id
    FROM users u
    WHERE COALESCE(u.is_active, 1) = 1
      AND (
        lower(u.role) = 'admin'
        OR (
          EXISTS (
            SELECT 1 FROM role_permissions rp
            WHERE lower(rp.role) = lower(u.role)
              AND rp.permission_key IN (${placeholders})
              AND rp.is_enabled = 1
          )
          AND EXISTS (SELECT 1 FROM user_warehouses uw WHERE uw.user_id = u.id AND uw.warehouse_id = ?)
        )
      )
  `
    : `
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
  `;
  const params = wid ? [...permissionKeys, wid] : permissionKeys;
  const rows = await all(sql, params);
  return (rows || []).map((r) => r.id).filter((id) => id != null);
}

async function sendExpoPushToTokens(rows, title, body, data = {}) {
  if (!rows || !rows.length) {
    return { ok: false, sent: 0, tickets: [], errors: ['no_tokens'] };
  }
  const messages = [];
  for (const r of rows) {
    if (!r.expo_push_token || !Expo.isExpoPushToken(r.expo_push_token)) continue;
    messages.push({
      to: r.expo_push_token,
      sound: 'default',
      priority: 'high',
      title,
      body,
      data,
      channelId: ANDROID_CHANNEL_ID,
      android: {
        channelId: ANDROID_CHANNEL_ID,
        sound: 'default',
        priority: 'high',
      },
    });
  }
  if (!messages.length) {
    return { ok: false, sent: 0, tickets: [], errors: ['no_valid_expo_tokens'] };
  }

  const chunks = expo.chunkPushNotifications(messages);
  const tickets = [];
  const errors = [];
  let msgIndex = 0;
  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      for (let i = 0; i < ticketChunk.length; i += 1) {
        const ticket = ticketChunk[i];
        const to = chunk[i]?.to;
        tickets.push({ ...ticket, to });
        if (ticket?.status === 'error') {
          const detail = ticket.details?.error || ticket.message || 'unknown';
          errors.push({ to, error: detail });
          console.error('[push] ticket error:', detail, to ? String(to).slice(0, 36) : '');
        } else if (ticket?.status === 'ok') {
          console.log('[push] ticket ok:', ticket.id, to ? String(to).slice(0, 36) : '');
        }
      }
      msgIndex += chunk.length;
    } catch (e) {
      const msg = String(e.message || e);
      errors.push({ error: msg });
      console.error('[push] send chunk failed:', msg);
    }
  }
  return {
    ok: errors.length === 0,
    sent: messages.length,
    tickets,
    errors,
  };
}

async function resolveOutboundWarehouseId(data) {
  const get = promisify(db.get.bind(db));
  let wid = data?.warehouse_id != null && data.warehouse_id !== '' ? Number(data.warehouse_id) : null;
  if ((!wid || !Number.isFinite(wid)) && data?.outbound_order_id) {
    const o = await get(`SELECT warehouse_id FROM outbound_orders WHERE id = ?`, [Number(data.outbound_order_id)]);
    wid = Number(o?.warehouse_id) || null;
  }
  if (!wid || !Number.isFinite(wid)) wid = await getDefaultWarehouseId();
  return wid;
}

/** Notify pickers for new pick orders (scoped to outbound warehouse). */
async function notifyPickOrder(title, body, data = {}) {
  const wid = await resolveOutboundWarehouseId(data);
  const payload = { notif_category: 'orders', warehouse_id: wid, ...data };
  const pickRows = await getExpoTokensForPermission('can_pick_orders', wid);
  const viewRows = await getExpoTokensForPermission('can_view_orders', wid);
  const map = new Map();
  for (const r of [...pickRows, ...viewRows]) {
    if (r.expo_push_token) map.set(r.expo_push_token, r);
  }
  await sendExpoPushToTokens([...map.values()], title, body, payload);
  const userIds = await getUserIdsWhoHaveAnyPermission(['can_pick_orders', 'can_view_orders'], wid);
  const seen = new Set();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, payload);
  }
}

/** Notify pickers, checkers, admins (mobile-capable) on pick progress */
async function notifyPickProgress(title, body, data = {}) {
  const wid = await resolveOutboundWarehouseId(data);
  const payload = { notif_category: 'orders', warehouse_id: wid, ...data };
  const picker = await getExpoTokensForPermission('can_pick_orders', wid);
  const checker = await getExpoTokensForPermission('can_confirm_picked', wid);
  const adminRows = await getExpoTokensForRoles(['admin'], null);
  const map = new Map();
  for (const r of [...picker, ...checker, ...adminRows]) {
    if (r.expo_push_token) map.set(r.expo_push_token, r);
  }
  const rows = [...map.values()];
  await sendExpoPushToTokens(rows, title, body, payload);
  const userIds = await getUserIdsWhoHaveAnyPermission(['can_pick_orders', 'can_confirm_picked'], wid);
  const seen = new Set();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, payload);
  }
}

async function notifyAdminChecker(title, body, data = {}) {
  const wid =
    data?.warehouse_id != null && data.warehouse_id !== ''
      ? Number(data.warehouse_id)
      : await resolveOutboundWarehouseId(data);
  const payload = { notif_category: 'picked', warehouse_id: wid, ...data };
  const adminRows = await getExpoTokensForRoles(['admin'], null);
  const checker = await getExpoTokensForPermission('can_confirm_picked', wid);
  const map = new Map();
  for (const r of [...adminRows, ...checker]) {
    if (r.expo_push_token) map.set(r.expo_push_token, r);
  }
  const rows = [...map.values()];
  await sendExpoPushToTokens(rows, title, body, payload);
  const userIds = await getUserIdsWhoHaveAnyPermission(['can_confirm_picked'], wid);
  const seen = new Set();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, payload);
  }
}

/** Inbound uploaded → putaway in racks: notify receiving staff + pickers (warehouse). */
async function notifyInboundPutaway(title, body, data = {}) {
  let wid = data?.warehouse_id != null && data.warehouse_id !== '' ? Number(data.warehouse_id) : null;
  if (!wid || !Number.isFinite(wid)) wid = await getDefaultWarehouseId();
  const payload = { notif_category: 'inbound', warehouse_id: wid, ...data };
  const receivers = await getExpoTokensForPermission('can_receive_stock', wid);
  const pickers = await getExpoTokensForPermission('can_pick_orders', wid);
  const map = new Map();
  for (const r of [...receivers, ...pickers]) {
    if (r.expo_push_token) map.set(r.expo_push_token, r);
  }
  const rows = [...map.values()];
  await sendExpoPushToTokens(rows, title, body, payload);
  const userIds = await getUserIdsWhoHaveAnyPermission(['can_receive_stock', 'can_pick_orders'], wid);
  const seen = new Set();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, payload);
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

/** Notify all admins when a new Google access request is created. */
async function notifyAdminsAccessRequest({ full_name, email, google_id, requested_role }) {
  const title = 'New user access request';
  const body = `${full_name || 'User'} (${email}) requested access${requested_role ? ` as ${requested_role}` : ''}.`;
  const payload = {
    notif_category: 'access_request',
    email,
    google_id,
    requested_role: requested_role || 'picker',
  };
  const adminRows = await getExpoTokensForRoles(['admin'], null);
  await sendExpoPushToTokens(adminRows, title, body, payload);
  const all = promisify(db.all.bind(db));
  const admins = await all(`SELECT id FROM users WHERE lower(role) = 'admin' AND COALESCE(is_active, 1) = 1`);
  const seen = new Set();
  for (const a of admins || []) {
    const uid = Number(a.id);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, payload);
  }
}

module.exports = {
  logNotification,
  notifyPickOrder,
  notifyPickProgress,
  notifyAdminChecker,
  notifyInboundPutaway,
  notifyAdminsAccessRequest,
  sendExpoPushToTokens,
  sendExpoPushToUserIds,
  getExpoTokensForPermission,
  getUserIdsWhoHaveAnyPermission,
};
