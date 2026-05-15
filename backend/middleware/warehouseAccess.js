const { userHasWarehouseAccess } = require('../services/warehouseContext');

/**
 * Express middleware: ensure the authenticated user may access `warehouseId`.
 * `getWarehouseId(req)` should return a number or null (null skips check for read routes that aggregate).
 */
function requireWarehouseAccess(getWarehouseId) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const role = String(req.user.role || '').toLowerCase();
      if (role === 'admin') return next();
      const wid = await Promise.resolve(getWarehouseId(req));
      if (wid == null || !Number(wid)) return res.status(400).json({ error: 'warehouse_id required' });
      const ok = await userHasWarehouseAccess(req.user.sub, role, wid);
      if (!ok) return res.status(403).json({ error: 'Forbidden for this warehouse' });
      return next();
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  };
}

module.exports = { requireWarehouseAccess };
