import Constants from 'expo-constants';

/**
 * Optional default from EXPO_PUBLIC_API_URL / app.config extra (dev convenience only).
 * Production flow uses Configuration screen + AsyncStorage — not this helper.
 */
export function getDefaultApiBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  const extra = Constants.expoConfig?.extra as { apiUrl?: string } | undefined;
  const raw = fromEnv || extra?.apiUrl;
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
