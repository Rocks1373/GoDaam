const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { requireAnyPermission } = require('../middleware/auth');
const { resolveWarehouseIdForRequest, userHasWarehouseAccess } = require('../services/warehouseContext');
const {
  getOrEnsureSalesOrderFolder,
  exportManifest,
} = require('../services/salesOrderDocumentsService');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));

function decodeSoParam(raw) {
  try {
    return decodeURIComponent(String(raw || '').trim());
  } catch {
    return String(raw || '').trim();
  }
}

router.use(requireAnyPermission(['can_view_orders', 'can_upload_outbound', 'can_confirm_picked']));

router.get('/', async (req, res) => {
  try {
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const q = String(req.query.q || '').trim();
    const clauses = ['warehouse_id = ?'];
    const params = [warehouseId];
    if (q) {
      clauses.push(`(sales_order_number ILIKE ? OR COALESCE(customer_name,'') ILIKE ? OR COALESCE(gapp_po,'') ILIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    const rows = await dbAll(
      `SELECT * FROM sales_order_folders WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 500`,
      params
    );
    res.json({ folders: rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/ensure', requireAnyPermission(['can_upload_outbound', 'can_confirm_picked']), async (req, res) => {
  try {
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.body?.warehouse_id ?? req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const sales_order_number = String(req.body.sales_order_number || '').trim();
    if (!sales_order_number) return res.status(400).json({ error: 'sales_order_number is required' });
    const folder = await getOrEnsureSalesOrderFolder({
      warehouseId,
      salesOrderNumber: sales_order_number,
      userId: Number(req.user.sub),
      gapp_po: req.body.gapp_po || null,
      customer_po_number: req.body.customer_po_number || null,
      customer_name: req.body.customer_name || null,
    });
    res.json({ folder });
  } catch (e) {
    const code = /not configured|GOOGLE_DRIVE|credentials/i.test(String(e.message)) ? 503 : 400;
    res.status(code).json({ error: e.message });
  }
});

router.get('/:salesOrderNumber', async (req, res) => {
  try {
    const so = decodeSoParam(req.params.salesOrderNumber);
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const auto = req.query.ensure === '1' || String(req.query.ensure).toLowerCase() === 'true';
    let folder = null;
    if (auto) {
      folder = await getOrEnsureSalesOrderFolder({
        warehouseId,
        salesOrderNumber: so,
        userId: Number(req.user.sub),
        gapp_po: req.query.gapp_po || null,
        customer_po_number: req.query.customer_po_number || null,
        customer_name: req.query.customer_name || null,
      });
    } else {
      const dbGet = promisify(db.get.bind(db));
      folder = await dbGet(
        `SELECT * FROM sales_order_folders WHERE warehouse_id = ? AND TRIM(sales_order_number) = TRIM(?) LIMIT 1`,
        [warehouseId, so]
      );
    }
    res.json({ folder });
  } catch (e) {
    const code = /not configured|GOOGLE_DRIVE|credentials/i.test(String(e.message)) ? 503 : 400;
    res.status(code).json({ error: e.message });
  }
});

router.post('/:salesOrderNumber/export-manifest', requireAnyPermission(['can_upload_outbound', 'can_confirm_picked']), async (req, res) => {
  try {
    const so = decodeSoParam(req.params.salesOrderNumber);
    const warehouseId = await resolveWarehouseIdForRequest({
      userId: req.user.sub,
      role: req.user.role,
      explicitWarehouseId: req.body?.warehouse_id ?? req.query?.warehouse_id ?? req.get('X-Warehouse-Id'),
    });
    if (!warehouseId) return res.status(400).json({ error: 'warehouse_id required' });
    const ok = await userHasWarehouseAccess(Number(req.user.sub), req.user.role, warehouseId);
    if (String(req.user.role || '').toLowerCase() !== 'admin' && !ok) {
      return res.status(403).json({ error: 'Forbidden for this warehouse' });
    }
    const manifest = await exportManifest(warehouseId, so);
    res.json(manifest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
