import axios, { type AxiosError } from 'axios';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { getDefaultApiBaseUrl, normalizeToApiBase } from '../config/apiConfig';
import { getSavedBackendApiUrl, saveBackendApiUrl } from '../storage/backendUrlStorage';

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

/** Map localhost → 10.0.2.2 for Android emulator; `apiBase` ends with `/api`. */
function resolveAndroidLocalhost(apiBase: string): string {
  const trimmed = apiBase.replace(/\/$/, '');
  if (Platform.OS !== 'android') return trimmed;
  try {
    const u = new URL(trimmed);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (loopback && isAndroidEmulatorForLocalhostRewrite()) {
      u.hostname = '10.0.2.2';
      return `${u.origin}/api`;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

const DEFAULT_TIMEOUT_MS = 30000;

export const api = axios.create({
  baseURL: 'http://127.0.0.1:9',
  timeout: DEFAULT_TIMEOUT_MS,
});

const CELLULAR_PORT_HINT =
  'Many mobile networks block non-standard ports (e.g. :8080) on cellular data — try Wi‑Fi first. For reliable access everywhere, put the API behind HTTPS on port 443.';

api.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    const noResponse = !err.response;
    if (noResponse) {
      if (err.code === 'ECONNABORTED') {
        err.message = `Request timed out (${DEFAULT_TIMEOUT_MS / 1000}s). ${CELLULAR_PORT_HINT}`;
      } else {
        err.message = `Cannot reach server (${err.code || 'network'}). ${CELLULAR_PORT_HINT}`;
      }
    }
    return Promise.reject(err);
  }
);

/** Apply saved or normalized URL to axios (full path ending in `/api`). */
export function configureApiBaseUrl(apiBaseRaw: string): void {
  const normalized = normalizeToApiBase(apiBaseRaw);
  if (!normalized) return;
  api.defaults.baseURL = resolveAndroidLocalhost(normalized);
}

/**
 * Configure axios from AsyncStorage. First install has no URL — show Configuration
 * before Login; user saves Backend API Base URL (…/api) once.
 */
export async function initApiClientFromStorage(): Promise<boolean> {
  const saved = await getSavedBackendApiUrl();
  if (saved) {
    const normalizedSaved = normalizeToApiBase(saved);
    if (normalizedSaved) {
      configureApiBaseUrl(normalizedSaved);
      return true;
    }
  }

  // Hardcoded fallback for first install / emulator testing.
  // - iOS simulator: localhost works
  // - Android emulator: localhost is rewritten to 10.0.2.2 via resolveAndroidLocalhost()
  const fallback = getDefaultApiBaseUrl() || normalizeToApiBase('http://localhost:3001');
  if (!fallback) return false;
  await saveBackendApiUrl(fallback);
  configureApiBaseUrl(fallback);
  return true;
}

/** Apply a URL already validated by Configuration / Profile (includes `/api`). */
export async function persistAndConfigureApiBase(urlEndingWithApi: string): Promise<void> {
  await saveBackendApiUrl(urlEndingWithApi);
  configureApiBaseUrl(urlEndingWithApi);
}

export function getApiBaseUrl(): string {
  return (api.defaults.baseURL || '').replace(/\/$/, '');
}

/** Human-readable origin (no `/api`) for error hints */
export function getDisplayApiOrigin(): string {
  const b = getApiBaseUrl();
  return b.replace(/\/api$/i, '') || b;
}

function resolveMobileApiKey(): string {
  const fromEnv = process.env.EXPO_PUBLIC_MOBILE_API_KEY;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const extra = Constants.expoConfig?.extra as { mobileApiKey?: string } | undefined;
  const k = extra?.mobileApiKey;
  if (k && String(k).trim()) return String(k).trim();
  return '';
}

const mobileApiKey = resolveMobileApiKey();
if (mobileApiKey) {
  api.defaults.headers.common['X-Mobile-Api-Key'] = mobileApiKey;
}

export function setAuthHeader(token: string | null) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}
