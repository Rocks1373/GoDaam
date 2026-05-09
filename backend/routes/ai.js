const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { readKnowledgeCached, getKnowledgeStatus } = require('../services/aiKnowledge');

const router = express.Router();

const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

function isAiAllowedUser(req) {
  const role = String(req.user?.role || '').toLowerCase().trim();
  // Support "head admin" / "head_admin" if you introduce it later.
  if (role === 'admin' || role === 'head_admin' || role === 'head admin') return true;
  const perms = req.user?.permissions || {};
  return Boolean(perms.can_use_ai);
}

function requireAuthOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

function pluginUrl() {
  return String(process.env.AI_PLUGIN_URL || 'http://127.0.0.1:8011').replace(/\/+$/, '');
}

function pluginSecret() {
  return String(process.env.AI_PLUGIN_SHARED_SECRET || '').trim();
}

function summarizeText(raw, maxLen = 240) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

async function callPlugin(pathname, { method = 'POST', body } = {}) {
  if (typeof fetch !== 'function') {
    const err = new Error('Node fetch() is unavailable in this runtime');
    err.statusCode = 500;
    throw err;
  }
  const url = pluginUrl() + pathname;
  const secret = pluginSecret();
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['X-AI-Plugin-Secret'] = secret;
  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!resp.ok) {
    const err = new Error(json?.error || `AI plugin error (${resp.status})`);
    err.statusCode = resp.status;
    err.plugin = json;
    throw err;
  }
  return json;
}

async function logAiAction(req, entry) {
  const userId = Number(req.user?.sub) || null;
  const username = req.user?.username || null;
  const role = req.user?.role || null;
  const {
    command,
    tool_name,
    tool_args,
    result,
    status = 'ok',
    error_message = null,
  } = entry;
  await dbRun(
    `INSERT INTO ai_action_logs
      (user_id, username, role, command, tool_name, tool_args_json, result_json, status, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      userId,
      username,
      role,
      command || null,
      tool_name || null,
      tool_args ? JSON.stringify(tool_args) : null,
      result ? JSON.stringify(result) : null,
      status,
      error_message,
    ]
  );
}

async function logAiWidgetUsage(req, { message, response_summary, tools_used }) {
  const userId = Number(req.user?.sub) || null;
  const username = req.user?.username || null;
  const role = req.user?.role || null;
  await dbRun(
    `INSERT INTO ai_agent_logs (user_id, username, role, message, response_summary, tools_used)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      username,
      role,
      String(message || '').slice(0, 8000),
      String(response_summary || '').slice(0, 2000),
      tools_used ? JSON.stringify(tools_used).slice(0, 4000) : null,
    ]
  );
}

// GET /api/ai/health
router.get('/health', requireAuthOnly, async (_req, res) => {
  try {
    const url = pluginUrl();
    const out = await callPlugin('/logs?limit=1', { method: 'GET' }).catch(() => null);
    return res.json({ ok: true, pluginUrl: url, pluginReachable: Boolean(out) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/ai/knowledge-status
router.get('/knowledge-status', requireAuthOnly, async (_req, res) => {
  return res.json(getKnowledgeStatus());
});

// POST /api/ai/chat
// Accepts either legacy `{command}` or new `{message,pageContext,entityId,userRole}` payloads.
router.post('/chat', requireAuthOnly, async (req, res) => {
  const message = String(req.body?.message || req.body?.command || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });
  try {
    const knowledge = readKnowledgeCached({ maxChars: 160_000 });
    const context = {
      ...(req.body?.context || {}),
      pageContext: req.body?.pageContext || null,
      entityId: req.body?.entityId || null,
      userRole: req.body?.userRole || req.user?.role || null,
      knowledge: knowledge.ok
        ? {
            path: knowledge.path,
            updatedAt: knowledge.mtimeMs ? new Date(knowledge.mtimeMs).toISOString() : null,
            text: knowledge.text,
          }
        : { error: knowledge.error || 'knowledge missing' },
    };

    const payload = {
      command: message,
      context,
      confirm_token: req.body?.confirm_token || null,
      user: {
        id: req.user?.sub || null,
        username: req.user?.username || null,
        role: req.user?.role || null,
      },
      request_meta: {
        ip: req.ip,
        ua: req.headers['user-agent'] || '',
      },
    };
    const out = await callPlugin('/chat', { method: 'POST', body: payload });
    // plugin returns structured tool/action info; log here for audit.
    await logAiAction(req, {
      command: message,
      tool_name: out?.tool_name || out?.decision?.tool_name || null,
      tool_args: out?.tool_args || out?.decision?.tool_args || null,
      result: out,
      status: 'ok',
    });
    await logAiWidgetUsage(req, {
      message,
      response_summary: summarizeText(out?.summary || out?.result?.message || out?.result?.ok || out?.ok ? 'OK' : ''),
      tools_used: { tool_name: out?.tool_name || null },
    }).catch(() => {});

    // Shape response for web widget.
    return res.json({
      answer: out?.summary || JSON.stringify(out?.result || out).slice(0, 4000),
      diagnostics: out?.result ? [out.result] : [],
      suggestedActions: out?.needs_confirmation
        ? [
            {
              type: 'confirm_required',
              tool_name: out.tool_name,
              tool_args: out.tool_args,
              confirmation_reason: out.confirmation_reason,
            },
          ]
        : [],
      raw: out,
    });
  } catch (e) {
    await logAiAction(req, {
      command: message,
      tool_name: null,
      tool_args: null,
      result: { error: e.plugin || e.message },
      status: 'error',
      error_message: e.message,
    }).catch(() => {});
    const code = e.statusCode || 500;
    return res.status(code).json({ error: e.message, detail: e.plugin || null });
  }
});

// POST /api/ai/run-diagnostic  { name, args?, confirm_token? }
router.post('/run-diagnostic', requireAuthOnly, async (req, res) => {
  if (!isAiAllowedUser(req)) return res.status(403).json({ error: 'Forbidden' });
  const tool_name = String(req.body?.name || '').trim();
  if (!tool_name) return res.status(400).json({ error: 'name is required' });
  try {
    const payload = {
      tool_name,
      tool_args: req.body?.args || {},
      confirm_token: req.body?.confirm_token || null,
      user: {
        id: req.user?.sub || null,
        username: req.user?.username || null,
        role: req.user?.role || null,
      },
    };
    const out = await callPlugin('/run-tool', { method: 'POST', body: payload });
    await logAiAction(req, { command: null, tool_name, tool_args: payload.tool_args, result: out, status: 'ok' });
    return res.json(out);
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ error: e.message, detail: e.plugin || null });
  }
});

// POST /api/ai/run-tool  { tool_name, tool_args, confirm_token? } (legacy admin endpoint)
router.post('/run-tool', requireAuthOnly, async (req, res) => {
  if (!isAiAllowedUser(req)) return res.status(403).json({ error: 'Forbidden' });
  const tool_name = String(req.body?.tool_name || '').trim();
  if (!tool_name) return res.status(400).json({ error: 'tool_name is required' });
  try {
    const payload = {
      tool_name,
      tool_args: req.body?.tool_args || {},
      confirm_token: req.body?.confirm_token || null,
      user: {
        id: req.user?.sub || null,
        username: req.user?.username || null,
        role: req.user?.role || null,
      },
    };
    const out = await callPlugin('/run-tool', { method: 'POST', body: payload });
    await logAiAction(req, {
      command: null,
      tool_name,
      tool_args: payload.tool_args,
      result: out,
      status: 'ok',
    });
    return res.json(out);
  } catch (e) {
    await logAiAction(req, {
      command: null,
      tool_name,
      tool_args: req.body?.tool_args || {},
      result: { error: e.plugin || e.message },
      status: 'error',
      error_message: e.message,
    }).catch(() => {});
    const code = e.statusCode || 500;
    return res.status(code).json({ error: e.message, detail: e.plugin || null });
  }
});

// GET /api/ai/check-orders?mode=manual
router.get('/check-orders', requireAuthOnly, async (req, res) => {
  if (!isAiAllowedUser(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const mode = String(req.query.mode || 'manual');
    const out = await callPlugin('/check-orders', { method: 'POST', body: { mode } });
    await logAiAction(req, { command: `check-orders:${mode}`, tool_name: 'check_orders', tool_args: { mode }, result: out });
    return res.json(out);
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ error: e.message, detail: e.plugin || null });
  }
});

// GET /api/ai/logs?limit=200
router.get('/logs', requireAuthOnly, async (req, res) => {
  if (!isAiAllowedUser(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const rows = await dbAll(
      `SELECT id, user_id, username, role, command, tool_name, tool_args_json, status, error_message, created_at
       FROM ai_action_logs
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`,
      [limit]
    );
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;

