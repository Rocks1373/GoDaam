import axios from 'axios';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

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
  // Emulator / simulator: localhost is not the dev machine. (`Constants.isDevice` was removed from expo-constants; use expo-device.)
  const onAndroidEmulator = !Device.isDevice;
  if (loopback && onAndroidEmulator) {
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

export function setAuthHeader(token: string | null) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}
