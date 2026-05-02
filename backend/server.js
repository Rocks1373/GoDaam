require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize DB (creates tables if missing)
require('./db');

// Middleware — browser clients only; native apps often omit Origin (allowed below).
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:19006',
  'http://127.0.0.1:19006',
  'http://localhost:8090',
  'http://127.0.0.1:8090',
];

function buildCorsOptions() {
  const raw = process.env.CORS_ORIGIN;
  if (raw === '*') {
    return { origin: true, credentials: true };
  }
  const list = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CORS_ORIGINS;
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      return cb(null, list.includes(origin));
    },
    credentials: true,
  };
}

app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Public routes
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'warehouse-backend' });
});
app.use('/api/auth', require('./routes/auth'));

// Protected routes (login required)
const { requireAuth, requireWebAccess, requireAdmin, requirePermission, requireMobileAccess } = require('./middleware/auth');
const { markOutboundDelivered, reverseOutboundDelivered } = require('./services/markOutboundDelivered');
const db = require('./db');

const webAuth = [requireAuth, requireWebAccess];

app.use('/api/main-stock', ...webAuth, require('./routes/main-stock'));
app.use('/api/inbound', ...webAuth, require('./routes/inbound'));
app.use('/api/reports', ...webAuth, require('./routes/reports'));
app.use('/api/sold-out', ...webAuth, require('./routes/sold-out'));
app.use('/api/stock-comparison-report', ...webAuth, require('./routes/stock-comparison-report'));
app.use('/api/stock-by-rack', ...webAuth, require('./routes/stock-by-rack'));
app.use('/api/stock-in', ...webAuth, require('./routes/stock-in'));
app.use('/api/stock-out', ...webAuth, require('./routes/stock-out'));
app.use('/api/outbound', ...webAuth, require('./routes/outbound'));
app.use('/api/pick-suggestion', ...webAuth, require('./routes/pick-suggestion'));
app.use('/api/customers', ...webAuth, require('./routes/customers'));
app.use('/api/delivery-note', ...webAuth, require('./routes/delivery-note'));
app.use('/api/delivery-notes', ...webAuth, require('./routes/delivery-notes'));
app.use('/api', ...webAuth, require('./routes/customer-locations'));
app.use('/api/vendors', ...webAuth, require('./routes/vendors'));
app.use('/api/vendor-items', ...webAuth, require('./routes/vendor-items'));
app.use('/api/carriers', ...webAuth, require('./routes/carriers'));
app.use('/api/drivers', ...webAuth, require('./routes/drivers'));

app.use('/api/users', ...webAuth, require('./routes/users'));
app.use('/api/roles', ...webAuth, require('./routes/roles'));
app.use('/api/admin/picked-orders', ...webAuth, requireAdmin, require('./routes/admin-picked'));
app.use('/api/admin/maintenance', ...webAuth, requireAdmin, require('./routes/admin-maintenance'));
app.use('/api/pick-change-requests', ...webAuth, requireAdmin, require('./routes/pick-change-requests'));

app.use('/api/mobile', require('./routes/mobile'));
app.use('/api/mobile/ocr', requireAuth, requireMobileAccess, require('./routes/ocr'));
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

// Serve downloadable templates (CSV/XLSX) if present
app.use('/templates', express.static(path.join(__dirname, 'templates')));

// Basic error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const server = app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `\n❌ Port ${PORT} is already in use (another backend or ./dev.sh is running).\n` +
        `   Fix: stop the other process, or use a different port:\n` +
        `   PORT=3002 npm run start --workspace backend\n` +
        `   → then point EXPO_PUBLIC_API_URL / Vite proxy at that port.\n`
    );
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
