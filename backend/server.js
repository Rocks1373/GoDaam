require('dotenv').config();

// IMPORTANT: middleware/auth performs JWT_SECRET preflight on require — keep this near the top.
// If the secret is missing/weak/placeholder the process will exit(1) before any port is opened.
require('./middleware/auth');

const express = require('express');
require('express-async-errors');
const cors = require('cors');
const helmet = require('helmet');
const hpp = require('hpp');
const compression = require('compression');
const pino = require('pino');
const pinoHttp = require('pino-http');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');

const HUAWEI_STREAMLIT_ENABLED = false;
const HUAWEI_GODAM_STREAMLIT_BASE = 'huawei-godam-app';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = String(process.env.HOST || '0.0.0.0');
const NODE_ENV = String(process.env.NODE_ENV || 'development').toLowerCase();
const IS_PROD = NODE_ENV === 'production';

// Express runs behind nginx/Caddy in production; trust the first proxy so
// rate-limiter sees the real client IP and req.ip is correct.
app.set('trust proxy', 1);

// Initialize DBs (creates tables if missing).
require('./db');             // Postgres only — see backend/db.js

/**
 * CORS configuration.
 *
 * Production hardening: refuse to use CORS_ORIGIN=* (or CORS_ALLOW_ALL=1) when
 * NODE_ENV=production. In dev we keep the wildcard for ergonomics.
 */
const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5175',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:19006',
  'http://127.0.0.1:19006',
  'http://localhost:8090',
  'http://127.0.0.1:8090',
];

function buildCorsOptions() {
  const rawOrigin = String(process.env.CORS_ORIGIN || '').trim();
  const allowAllRequested =
    process.env.CORS_ALLOW_ALL === '1' || rawOrigin === '*';

  if (allowAllRequested && IS_PROD) {
    console.error(
      'FATAL: CORS_ORIGIN=* / CORS_ALLOW_ALL=1 is not allowed in production. ' +
        'Set CORS_ORIGIN to a comma-separated list of allowed origins (e.g. https://app.example.com).'
    );
    process.exit(1);
  }

  if (allowAllRequested) {
    return {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Mobile-Api-Key',
        'X-Requested-With',
        'X-Warehouse-Id',
      ],
    };
  }

  const list = rawOrigin
    ? rawOrigin.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CORS_ORIGINS;

  return {
    origin(origin, cb) {
      // Allow non-browser clients (mobile, server-to-server) which omit Origin.
      if (!origin) return cb(null, true);
      if (list.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} is not allowed`));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Mobile-Api-Key',
      'X-Requested-With',
      'X-Warehouse-Id',
    ],
    credentials: true,
  };
}

// --- Security middleware (mounted first) ---
app.use(
  helmet({
    // We serve JSON APIs + a Streamlit reverse proxy; the strictest defaults
    // (notably crossOriginEmbedderPolicy) break iframe embedding, so we keep
    // CSP turned off here and rely on nginx CSP headers in production.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(cors(buildCorsOptions()));
app.use(cookieParser());
app.use(hpp());
app.use(compression());
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => String(req.headers['x-request-id'] || '').trim() || crypto.randomUUID(),
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Huawei GoDam Streamlit proxy integration has been deleted.
const webAdminOrigin = String(process.env.WEB_ADMIN_ORIGIN || 'http://127.0.0.1:5173').replace(/\/$/, '');
app.get([`/${HUAWEI_GODAM_STREAMLIT_BASE}`, `/${HUAWEI_GODAM_STREAMLIT_BASE}/*`], (_req, res) => {
  res.redirect(302, `${webAdminOrigin}/huawei`);
});

const db = require('./db');

// Per-request transaction scope — prevents Postgres pool exhaustion from leaked BEGINs.
if (typeof db.requestTxMiddleware === 'function') {
  app.use(db.requestTxMiddleware());
}

// --- Public routes ---
app.get('/api/health', async (_req, res) => {
  const base = {
    status: 'ok',
    message: 'GoDam API running',
    env: IS_PROD ? 'production' : NODE_ENV,
  };
  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT 1 AS ok', [], (err, r) => (err ? reject(err) : resolve(r)));
    });
    res.json({ ...base, database: row?.ok === 1 ? 'connected' : 'unknown' });
  } catch (e) {
    res.status(503).json({
      status: 'degraded',
      message: 'GoDam API running but database unreachable',
      env: IS_PROD ? 'production' : NODE_ENV,
      database_error: IS_PROD ? 'connection failed' : String(e.message || e),
    });
  }
});
app.use('/api/auth', require('./routes/auth'));
app.use('/api/v1/huawei', require('./huawei-module/routes/huaweiRoutes'));
app.use('/api/mobile-app', require('./routes/mobile-app-public'));
const { handleGoogleOAuthCallback } = require('./routes/google-oauth');
app.get('/api/google/oauth/callback', handleGoogleOAuthCallback);
app.get('/api/storage/google-oauth/callback', handleGoogleOAuthCallback);

// --- Protected routes (login required) ---
const {
  markOutboundDelivered,
  reverseOutboundDelivered,
} = require('./services/markOutboundDelivered');
const { mountApiRoutes } = require('./mountApiRoutes');

mountApiRoutes(app, { db, markOutboundDelivered, reverseOutboundDelivered });

// Serve downloadable templates (CSV/XLSX). These are public, read-only,
// non-sensitive seed files shipped with the backend.
app.use('/templates', express.static(path.join(__dirname, 'templates'), {
  fallthrough: false,
  index: false,
}));

// Central 404 for unhandled /api/* routes.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler. Logs server-side, returns a generic message in production.
 
app.use((err, req, res, _next) => {
  const reqId = req.id || req.headers['x-request-id'] || undefined;
   
  console.error('[unhandled]', reqId || '', err);
  const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = IS_PROD
    ? status >= 500
      ? 'Internal server error'
      : err.message || 'Request failed'
    : err.message || 'Internal server error';
  const body = { error: message };
  if (reqId) body.requestId = String(reqId);
  res.status(status).json(body);
});

module.exports = app;

if (require.main === module) {
  const { purgeHuaweiStagingData } = require('./services/purgeHuaweiStagingData');
  const { purgeRejectedHuaweiOrdersOlderThan } = require('./services/clearHuaweiStagingWorkflow');
  const rejectedRetentionDays = Math.max(
    1,
    Number(process.env.HUAWEI_REJECTED_RETENTION_DAYS || 7) || 7
  );
  const runHuaweiStagingPurge = () => {
    purgeHuaweiStagingData()
      .then((r) => {
        if (r.dn_lines || r.order_items || r.matching_results) {
          console.log('[huawei-purge] staging cleanup', r);
        }
      })
      .catch((err) => console.error('[huawei-purge]', err.message));
    purgeRejectedHuaweiOrdersOlderThan({ retentionDays: rejectedRetentionDays })
      .then((r) => {
        if (r.orders_deleted > 0) {
          console.log('[huawei-purge] rejected orders removed', r);
        }
      })
      .catch((err) => console.error('[huawei-purge] rejected', err.message));
  };
  setTimeout(runHuaweiStagingPurge, 120_000);
  setInterval(runHuaweiStagingPurge, 24 * 60 * 60 * 1000).unref();

  const server = app.listen(PORT, HOST, () => {
    console.log(`Backend listening on ${HOST}:${PORT}  (env=${IS_PROD ? 'production' : NODE_ENV})`);
    console.log('[huawei] Streamlit disabled — DN matching: open web app /huawei');
  });
  const { attachRealtimeHub } = require('./services/realtimeHub');
  const { startFollowupReminderScheduler } = require('./services/followupReminderService');
  attachRealtimeHub(server, { cors: buildCorsOptions() });
  startFollowupReminderScheduler();

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the other process or run with PORT=<n>.`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });

  function shutdown(signal) {
    console.log(`Received ${signal}, shutting down...`);
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 10_000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
