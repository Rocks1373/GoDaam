const {
  getExpoTokensForPermission,
  getUserIdsWhoHaveAnyPermission,
  sendExpoPushToTokens,
  logNotification,
} = require('./notificationService');
const { promisify } = require('util');
const db = require('../db');
const dbAll = promisify(db.all.bind(db));

/** Web / warehouse staff: upload outbound + pick confirm users get delivery alerts */
async function notifyWebDeliveryStaff(title, body, data = {}) {
  const permKeys = ['can_upload_outbound', 'can_confirm_picked'];
  const rowsP = await getExpoTokensForPermission('can_upload_outbound');
  const rowsC = await getExpoTokensForPermission('can_confirm_picked');
  const map = new Map();
  for (const r of [...(rowsP || []), ...(rowsC || [])]) {
    if (r.expo_push_token) map.set(r.expo_push_token, r);
  }
  await sendExpoPushToTokens([...map.values()], title, body, { ...data, channel: 'delivery' });
  const userIds = await getUserIdsWhoHaveAnyPermission(permKeys);
  const seen = new Set();
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    await logNotification(uid, title, body, { ...data, channel: 'delivery' });
  }
}

/** All admin user ids (for in-app log). */
async function getAdminUserIds() {
  const rows = await dbAll(`SELECT id FROM users WHERE lower(role) = 'admin' AND COALESCE(is_active,1) = 1`);
  return (rows || []).map((r) => r.id);
}

module.exports = {
  notifyWebDeliveryStaff,
  getAdminUserIds,
};
