const cookie = require('cookie');
const jwt = require('jsonwebtoken');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { JWT_SECRET } = require('./middleware/auth');

function streamlitBasePath() {
  const raw = process.env.HUAWEI_GODAM_STREAMLIT_BASE_PATH || 'huawei-godam-app';
  return String(raw).replace(/^\/+|\/+$/g, '') || 'huawei-godam-app';
}

function streamlitOrigin() {
  const port = Number(process.env.HUAWEI_GODAM_STREAMLIT_PORT || 8501);
  return `http://127.0.0.1:${Number.isFinite(port) ? port : 8501}`;
}

function verifyHuaweiStreamlitAccess(req) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer) {
    try {
      jwt.verify(bearer, JWT_SECRET);
      return true;
    } catch {
      /* fall through */
    }
  }
  const cookies = cookie.parse(req.headers.cookie || '');
  const tok = cookies.huawei_streamlit_proxy;
  if (!tok) return false;
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    return payload && payload.typ === 'huawei_streamlit';
  } catch {
    return false;
  }
}

function streamlitProxyGate(req, res, next) {
  if (!verifyHuaweiStreamlitAccess(req)) {
    res.status(401).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>GoDam plugin</title></head>
<body style="font-family:system-ui;padding:1.5rem">
<p>Sign in to the warehouse app first, then open <strong>GoDam 1.0</strong> from the sidebar.</p>
<p><a href="/login">Go to login</a></p>
</body></html>`);
    return;
  }
  next();
}

function createHuaweiGodamStreamlitProxy() {
  const base = streamlitBasePath();
  const target = streamlitOrigin();
  const proxy = createProxyMiddleware({
    target,
    ws: true,
    changeOrigin: true,
    // Express strips the mount path before passing to this middleware, so req.url is "/" while
    // Streamlit is configured with --server.baseUrlPath (expects "/base/..."). Forwarding "/" makes
    // Streamlit redirect to site "/", which nginx serves as the SPA → nested app inside the iframe.
    pathRewrite: (_path, req) => {
      const raw = (req.originalUrl || req.url || '/').split('?')[0];
      return raw.startsWith('/') ? raw : `/${raw}`;
    },
  });
  return { base, proxy, target };
}

function attachStreamlitUpgrade(server, proxyMiddleware, basePath) {
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url || '').split('?')[0];
    if (!p.startsWith(`/${basePath}`)) return;
    if (!verifyHuaweiStreamlitAccess(req)) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    proxyMiddleware.upgrade(req, socket, head);
  });
}

module.exports = {
  streamlitBasePath,
  streamlitOrigin,
  verifyHuaweiStreamlitAccess,
  streamlitProxyGate,
  createHuaweiGodamStreamlitProxy,
  attachStreamlitUpgrade,
};
