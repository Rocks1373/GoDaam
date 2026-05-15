const DEFAULT_AGENT = import.meta.env.VITE_SCANNER_AGENT_URL || 'http://127.0.0.1:38471';

function baseUrl(url) {
  return String(url || DEFAULT_AGENT).replace(/\/$/, '');
}

export async function scannerAgentHealth(agentUrl) {
  const base = baseUrl(agentUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${base}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, detail: r.status };
    const j = await r.json().catch(() => ({}));
    return { ok: true, detail: j };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, detail: String(e.message || 'unreachable') };
  }
}

/**
 * @param {Record<string, unknown>} payload - warehouse_id, sales_order_number, document_type, optional refs
 * @param {string} [agentUrl]
 */
export async function submitScannerAgentJob(payload, agentUrl) {
  const base = baseUrl(agentUrl);
  const r = await fetch(`${base}/v1/scan-job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data.error || data.message || `Scanner agent returned ${r.status}`);
  }
  return data;
}

export { DEFAULT_AGENT as defaultScannerAgentUrl };
