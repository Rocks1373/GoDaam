import axios from 'axios';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

/**
 * Some AVD / Play Store images report `Device.isDevice === true` even on emulators.
 * Heuristics match standard Android Studio device names (sdk_gphone*, "Android SDK built for*").
 * Physical devices: use a LAN IP in EXPO_PUBLIC_API_URL — never rely on localhost.
 */
function isAndroidEmulatorForLocalhostRewrite(): boolean {
  if (Platform.OS !== 'android') return false;
  if (!Device.isDevice) return true;
  const model = String(Device.modelName || '').toLowerCase();
  const mfr = String(Device.manufacturer || '').toLowerCase();
  const brand = String(Device.brand || '').toLowerCase();
  const product = String(Device.productName || '').toLowerCase();
  const blob = `${model} ${mfr} ${brand} ${product}`;
  if (/\b(gphone|google_sdk|emulator|genymotion|vbox|sdk_gphone)\b/.test(blob)) return true;
  if (model.startsWith('sdk_') || model.includes('emulator')) return true;
  if (mfr === 'google' && (model.includes('sdk') || model.includes('gphone'))) return true;
  if (model.includes('android sdk built for')) return true;
  return false;
}

function resolveApiOrigin(raw: string): string {
  const trimmed = raw.replace(/\/$/, '');
  if (Platform.OS !== 'android') return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (loopback && isAndroidEmulatorForLocalhostRewrite()) {
    url.hostname = '10.0.2.2';
    return url.origin;
  }

  return trimmed;
}

const raw =
  process.env.EXPO_PUBLIC_API_URL ||
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ||
  'http://localhost:3001';

export const API_ORIGIN = resolveApiOrigin(raw);

export const api = axios.create({
  baseURL: `${API_ORIGIN}/api`,
  timeout: 45000,
});

/** Same value as server MOBILE_APP_API_KEY (optional). Set in EAS/env when building APK/IPA. */
const mobileApiKey = process.env.EXPO_PUBLIC_MOBILE_API_KEY;
if (mobileApiKey && String(mobileApiKey).trim()) {
  api.defaults.headers.common['X-Mobile-Api-Key'] = String(mobileApiKey).trim();
}

export function setAuthHeader(token: string | null) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}
