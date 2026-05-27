import axios, { isAxiosError, type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { getDefaultApiBaseUrl, isDeprecatedApiBase, normalizeToApiBase } from '../config/apiConfig';
import { BACKEND_API_URL_KEY } from '../storage/backendUrlStorage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSavedBackendApiUrl, saveBackendApiUrl } from '../storage/backendUrlStorage';
import { getSelectedWarehouseId } from '../storage/warehouseStorage';
import { clearAuth, loadAuth, saveAuth } from '../storage/tokenStorage';
import { notifySessionExpired } from './sessionEvents';

type AuthRetryConfig = InternalAxiosRequestConfig & { _authRetried?: boolean };

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
export function resolveApiBaseForDevice(apiBase: string): string {
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

export type GodamAxiosConfig = {
  /** Inbound receiving lists all assigned warehouses; omit X-Warehouse-Id for these calls. */
  skipWarehouseHeader?: boolean;
};

export const api = axios.create({
  baseURL: '',
  timeout: DEFAULT_TIMEOUT_MS,
});

const CELLULAR_PORT_HINT =
  'Many mobile networks block non-standard ports (e.g. :8080) on cellular data — try Wi‑Fi first. For reliable access everywhere, put the API behind HTTPS on port 443.';

function enrichNetworkError(err: AxiosError): AxiosError {
  const noResponse = !err.response;
  if (noResponse) {
    if (err.code === 'ECONNABORTED') {
      err.message = `Request timed out (${DEFAULT_TIMEOUT_MS / 1000}s). ${CELLULAR_PORT_HINT}`;
    } else {
      err.message = `Cannot reach server (${err.code || 'network'}). ${CELLULAR_PORT_HINT}`;
    }
  }
  return err;
}

function isAuthRoute(url: string | undefined): boolean {
  const u = String(url || '');
  return (
    u.includes('/auth/login') ||
    u.includes('/auth/google-login') ||
    u.includes('/auth/refresh')
  );
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshAuthToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const { token } = await loadAuth();
    if (!token) return null;
    const base = getApiBaseUrl();
    if (!base) return null;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (mobileApiKey) headers['X-Mobile-Api-Key'] = mobileApiKey;
      const res = await axios.post(`${base}/auth/refresh`, {}, { headers, timeout: DEFAULT_TIMEOUT_MS });
      const next = res.data?.token;
      const expiresAt = res.data?.expires_at;
      if (!next || typeof next !== 'string') return null;
      await saveAuth(next, expiresAt);
      setAuthHeader(next);
      return next;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function forceLogout(message: string): Promise<void> {
  await clearAuth();
  setAuthHeader(null);
  notifySessionExpired(message);
}

api.interceptors.response.use(
  (r) => r,
  async (err: AxiosError) => {
    enrichNetworkError(err);
    const status = err.response?.status;
    const config = err.config as AuthRetryConfig | undefined;
    if (status === 401 && config && !config._authRetried && !isAuthRoute(config.url)) {
      const next = await refreshAuthToken();
      if (next) {
        config._authRetried = true;
        config.headers = config.headers || {};
        (config.headers as Record<string, string>).Authorization = `Bearer ${next}`;
        return api.request(config);
      }
      await forceLogout('Your session ended. Please sign in again.');
    }
    return Promise.reject(err);
  }
);

/** Apply saved or normalized URL to axios (full path ending in `/api`). */
export function configureApiBaseUrl(apiBaseRaw: string): void {
  const normalized = normalizeToApiBase(apiBaseRaw);
  if (!normalized) return;
  api.defaults.baseURL = resolveApiBaseForDevice(normalized);
}

/**
 * Configure axios from AsyncStorage. First install has no URL — show Configuration
 * before Login; user saves Backend API Base URL (…/api) once.
 */
export async function initApiClientFromStorage(): Promise<boolean> {
  const saved = await getSavedBackendApiUrl();
  if (saved) {
    const normalizedSaved = normalizeToApiBase(saved);
    if (normalizedSaved && !isDeprecatedApiBase(normalizedSaved)) {
      configureApiBaseUrl(normalizedSaved);
      return true;
    }
    await AsyncStorage.removeItem(BACKEND_API_URL_KEY);
  }

  // First install (or after clearing bad URL): embedded default from app.config / baseline.
  const fallback = getDefaultApiBaseUrl();
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

/** Best-effort message for API failures (JSON `error`, network, HTML 404, etc.). */
export function formatApiError(err: unknown): string {
  if (isAxiosError(err)) {
    const d = err.response?.data;
    if (d && typeof d === 'object') {
      const o = d as Record<string, unknown>;
      if (typeof o.error === 'string' && o.error.trim()) return o.error.trim();
      if (typeof o.message === 'string' && o.message.trim()) return o.message.trim();
    }
    if (typeof d === 'string' && d.trim()) {
      const t = d.trim();
      const cannotRoute = t.match(/Cannot\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i);
      if (cannotRoute) {
        const path = cannotRoute[2].replace(/<[^>]*>/g, '');
        return `This server does not expose ${cannotRoute[1]} ${path} (old API build). Deploy the latest backend from this repo and restart the Node process (e.g. sudo systemctl restart godaam-backend).`;
      }
      return t.length > 240 ? `${t.slice(0, 240)}…` : t;
    }
    if (err.message?.trim()) return err.message.trim();
    if (err.response?.status) return `Request failed (HTTP ${err.response.status}). Is the backend updated?`;
    return 'Request failed.';
  }
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return String(err ?? 'Unknown error');
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

api.interceptors.request.use(async (config) => {
  const skip = (config as GodamAxiosConfig).skipWarehouseHeader;
  if (!skip) {
    const wid = await getSelectedWarehouseId();
    if (wid) {
      config.headers = config.headers || {};
      (config.headers as Record<string, string>)['X-Warehouse-Id'] = String(wid);
    }
  }
  return config;
});

export function setAuthHeader(token: string | null) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}
