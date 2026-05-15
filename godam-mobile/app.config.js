/**
 * Optional EXPO_PUBLIC_API_URL for dev tooling only. The app does not auto-connect:
 * users set Backend API Base URL once on the Configuration screen (stored in AsyncStorage).
 *
 * Optional EXPO_PUBLIC_*_B64 vars (UTF-8 base64) are decoded here at build time so test/offline
 * `.env` files can avoid storing plaintext URLs on disk — the release bundle still contains the
 * resolved values (not a security boundary).
 *
 * EAS cannot patch this file automatically; keep `extra.eas.projectId` in app.json when using EAS Build.
 */
const appJson = require('./app.json');
const { VPS_BASELINE_ORIGIN } = require('./baseline-api.js');

function decodeEnvB64(name) {
  const v = process.env[name];
  if (!v || typeof v !== 'string') return '';
  const t = v.trim().replace(/\s+/g, '');
  if (!t) return '';
  try {
    return Buffer.from(t, 'base64').toString('utf8').trim();
  } catch {
    return '';
  }
}

const apiUrl =
  (process.env.EXPO_PUBLIC_API_URL && String(process.env.EXPO_PUBLIC_API_URL).trim()) ||
  decodeEnvB64('EXPO_PUBLIC_API_URL_B64') ||
  VPS_BASELINE_ORIGIN;

const mobileApiKey =
  (process.env.EXPO_PUBLIC_MOBILE_API_KEY && String(process.env.EXPO_PUBLIC_MOBILE_API_KEY).trim()) ||
  decodeEnvB64('EXPO_PUBLIC_MOBILE_API_KEY_B64') ||
  '';

module.exports = {
  expo: {
    ...appJson.expo,
    extra: {
      ...(appJson.expo.extra || {}),
      apiUrl,
      mobileApiKey,
    },
  },
};
