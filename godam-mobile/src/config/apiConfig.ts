import Constants from 'expo-constants';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VPS_BASELINE_ORIGIN } = require('../../baseline-api.js') as { VPS_BASELINE_ORIGIN: string };

/**
 * Default API base from EXPO_PUBLIC_API_URL / app.config extra, else production VPS baseline.
 * Override for local dev: EXPO_PUBLIC_API_URL=http://127.0.0.1:3001
 */
export function getDefaultApiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  const extra = Constants.expoConfig?.extra as { apiUrl?: string } | undefined;
  const raw =
    (fromEnv && String(fromEnv).trim()) ||
    (extra?.apiUrl && String(extra.apiUrl).trim()) ||
    VPS_BASELINE_ORIGIN;
  if (!raw || typeof raw !== 'string') return '';
  return normalizeToApiBase(raw);
}

/**
 * Normalize user input or env origin to `{origin}/api`.
 * Accepts `https://host`, `https://host/`, or `https://host/api`.
 */
/** Saved URLs that fail on real phones (blocked :8080, old VPS IP, etc.). */
export function isDeprecatedApiBase(apiBase: string): boolean {
  const t = String(apiBase || '').trim().toLowerCase();
  if (!t) return false;
  if (/72\.61\.245\.23:8080/.test(t)) return true;
  if (/:\d{2,5}\/api$/.test(t) && !/:443\/api$/.test(t)) {
    try {
      const u = new URL(t.includes('://') ? t : `http://${t}`);
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      if (port !== 443 && port !== 80) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function normalizeToApiBase(input: string): string {
  const t = input.trim().replace(/\/+$/, '');
  if (!t) return '';
  if (/\/api$/i.test(t)) return t;
  try {
    const withScheme = t.includes('://') ? t : `http://${t}`;
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.origin}/api`;
  } catch {
    return '';
  }
}
