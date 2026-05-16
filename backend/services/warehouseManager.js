const { promisify } = require('util');
const db = require('../db');

const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));

/**
 * Assign a user as warehouse manager: links warehouses.manager_user_id, user_warehouses, users.role/default WH.
 */
async function assignWarehouseManager(warehouseId, userId) {
  const wid = Number(warehouseId);
  const uid = Number(userId);
  if (!wid || !uid) throw new Error('warehouse id and user_id are required');

  const wh = await dbGet(`SELECT id, warehouse_code FROM warehouses WHERE id = ?`, [wid]);
  if (!wh) throw new Error('Warehouse not found');
  const user = await dbGet(`SELECT id, username, role FROM users WHERE id = ?`, [uid]);
  if (!user) throw new Error('User not found');

  await dbRun(
    `INSERT OR IGNORE INTO user_warehouses (user_id, warehouse_id, role_in_warehouse, is_default)
     VALUES (?, ?, 'manager', 1)`,
    [uid, wid]
  );
  await dbRun(`UPDATE user_warehouses SET role_in_warehouse = 'manager', is_default = 1 WHERE user_id = ? AND warehouse_id = ?`, [
    uid,
    wid,
  ]);
  await dbRun(`UPDATE user_warehouses SET is_default = 0 WHERE user_id = ? AND warehouse_id != ?`, [uid, wid]);
  await dbRun(`UPDATE users SET role = 'manager', default_warehouse_id = ? WHERE id = ?`, [wid, uid]);
  await dbRun(
    `UPDATE warehouses SET manager_user_id = ?, manager_name = COALESCE((SELECT full_name FROM users WHERE id = ?), manager_name), updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [uid, uid, wid]
  );

  return dbGet(
    `SELECT w.*, u.username AS manager_username, u.full_name AS manager_full_name
     FROM warehouses w
     LEFT JOIN users u ON u.id = w.manager_user_id
     WHERE w.id = ?`,
    [wid]
  );
}

async function listWarehouseStaff(warehouseId) {
  const wid = Number(warehouseId);
  return dbAll(
    `SELECT uw.*, u.username, u.full_name, u.role, u.mobile_number, u.is_active
     FROM user_warehouses uw
     JOIN users u ON u.id = uw.user_id
     WHERE uw.warehouse_id = ?
     ORDER BY u.role, u.username`,
    [wid]
  );
}

module.exports = { assignWarehouseManager, listWarehouseStaff };
