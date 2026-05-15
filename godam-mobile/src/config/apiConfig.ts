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
