/**
 * Declarative API mount table — single place to audit auth chains for /api/*.
 * Mounted from server.js after DB and CORS are ready.
 */
const {
  requireAuth,
  requireWebAccess,
  requireAdmin,
  requirePermission,
  requireMobileAccess,
  requireMobileAppKey,
} = require('./middleware/auth');
const { requireScannerAgent } = require('./middleware/scannerAgentAuth');

/**
 * @param {import('express').Express} app
 * @param {{ db: unknown; markOutboundDelivered: Function; reverseOutboundDelivered: Function }} ctx
 */
function mountApiRoutes(app, ctx) {
  const { db, markOutboundDelivered, reverseOutboundDelivered } = ctx;

  const webAuth = [requireAuth, requireWebAccess];

  app.use('/api/sales-order-folders', ...webAuth, require('./routes/sales-order-folders'));
  app.use('/api/sales-order-documents', ...webAuth, require('./routes/sales-order-documents'));
  app.use('/api/scanner-agent', requireScannerAgent, require('./routes/scanner-agent'));
  app.use('/api/main-stock', ...webAuth, require('./routes/main-stock'));
  app.use('/api/inbound', ...webAuth, require('./routes/inbound'));
  app.use('/api/bom', ...webAuth, require('./routes/bom'));
  app.use('/api/reports', ...webAuth, require('./routes/reports'));
  app.use('/api/dashboard', ...webAuth, require('./routes/dashboard'));
  app.use('/api/sold-out', ...webAuth, require('./routes/sold-out'));
  app.use('/api/stock-comparison-report', ...webAuth, require('./routes/stock-comparison-report'));
  app.use('/api/sap-stock', ...webAuth, require('./routes/sap-stock'));
  app.use('/api/huawei-module', ...webAuth, require('./routes/huawei-module'));
  app.use('/api/huawei-godam', ...webAuth, require('./routes/huawei-godam'));
  app.use('/api/godam-excel', ...webAuth, require('./routes/godam-excel'));
  app.use('/api/stock-by-rack', ...webAuth, require('./routes/stock-by-rack'));
  app.use('/api/stock-in', ...webAuth, require('./routes/stock-in'));
  app.use('/api/stock-out', ...webAuth, require('./routes/stock-out'));
  app.use('/api/outbound', ...webAuth, require('./routes/outbound'));
  app.use('/api/pick-suggestion', ...webAuth, require('./routes/pick-suggestion'));
  app.use('/api/customers', ...webAuth, require('./routes/customers'));
  app.use('/api/delivery-note', ...webAuth, require('./routes/delivery-note'));
  app.use('/api/delivery-notes', ...webAuth, require('./routes/delivery-notes'));
  app.use('/api/mobile', require('./routes/mobile'));
  app.use(
    '/api/mobile/ocr',
    requireMobileAppKey,
    requireAuth,
    requireMobileAccess,
    require('./routes/ocr')
  );
  app.use('/api', ...webAuth, require('./routes/customer-locations'));
  app.use('/api/vendors', ...webAuth, require('./routes/vendors'));
  app.use('/api/vendor-items', ...webAuth, require('./routes/vendor-items'));
  app.use('/api/carriers', ...webAuth, require('./routes/carriers'));
  app.use('/api/drivers', ...webAuth, require('./routes/drivers'));
  app.use('/api/transportation', ...webAuth, require('./routes/transportation'));
  app.use('/api/files/uploads', ...webAuth, require('./routes/secure-uploads'));
  app.use('/api/users', ...webAuth, require('./routes/users'));
  app.use('/api/warehouses', ...webAuth, require('./routes/warehouses'));
  app.use('/api/roles', ...webAuth, require('./routes/roles'));
  app.use('/api/admin/picked-orders', ...webAuth, requireAdmin, require('./routes/admin-picked'));
  app.use('/api/admin/mobile-app', ...webAuth, requireAdmin, require('./routes/admin-mobile-app'));
  app.use('/api/admin/audit-logs', ...webAuth, requireAdmin, require('./routes/admin-audit-logs'));
  app.use('/api/pick-change-requests', ...webAuth, requireAdmin, require('./routes/pick-change-requests'));
  app.use('/api/ai', ...webAuth, require('./routes/ai'));
  app.use('/api/notifications', requireAuth, require('./routes/notifications'));

  app.post(
    '/api/orders/:id/mark-delivered',
    requireAuth,
    requireWebAccess,
    requirePermission('can_upload_outbound'),
    async (req, res) => {
      const orderId = Number(req.params.id);
      if (!orderId) return res.status(400).json({ error: 'Invalid id' });
      try {
        const result = await markOutboundDelivered(db, orderId, { requireInvoice: true });
        res.json(result);
      } catch (e) {
        const code = e.statusCode || 500;
        res.status(code).json({ error: e.message, shortages: e.shortages });
      }
    }
  );

  app.post(
    '/api/orders/:id/reverse-delivery',
    requireAuth,
    requireWebAccess,
    requirePermission('can_upload_outbound'),
    async (req, res) => {
      const orderId = Number(req.params.id);
      if (!orderId) return res.status(400).json({ error: 'Invalid id' });
      try {
        const result = await reverseOutboundDelivered(db, orderId);
        res.json(result);
      } catch (e) {
        const code = e.statusCode || 500;
        res.status(code).json({ error: e.message });
      }
    }
  );
}

module.exports = { mountApiRoutes };
