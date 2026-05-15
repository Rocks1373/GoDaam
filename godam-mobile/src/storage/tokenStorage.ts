import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'godam_token';
const EXPIRES_KEY = 'godam_token_expires_at';

async function secureSet(key: string, value: string) {
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

async function secureGet(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function secureDelete(key: string) {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    /* ignore */
  }
}

/** Migrate one-time from AsyncStorage to SecureStore. */
async function migrateLegacyFromAsyncStorage(): Promise<void> {
  const [[, legacyToken], [, legacyExp]] = await AsyncStorage.multiGet([TOKEN_KEY, EXPIRES_KEY]);
  if (legacyToken) {
    await secureSet(TOKEN_KEY, legacyToken);
    if (legacyExp) await secureSet(EXPIRES_KEY, legacyExp);
    await AsyncStorage.multiRemove([TOKEN_KEY, EXPIRES_KEY]);
  }
}

export async function saveAuth(token: string, expiresAt?: string | null) {
  await migrateLegacyFromAsyncStorage();
  await secureSet(TOKEN_KEY, token);
  if (expiresAt) await secureSet(EXPIRES_KEY, expiresAt);
  else await secureDelete(EXPIRES_KEY);
}

export async function loadAuth(): Promise<{ token: string | null; expiresAt: string | null }> {
  await migrateLegacyFromAsyncStorage();
  const token = await secureGet(TOKEN_KEY);
  const expiresAt = await secureGet(EXPIRES_KEY);
  return { token, expiresAt };
}

export async function clearAuth() {
  await secureDelete(TOKEN_KEY);
  await secureDelete(EXPIRES_KEY);
  await AsyncStorage.multiRemove([TOKEN_KEY, EXPIRES_KEY]);
}

export function isExpiredIso(expiresAt: string | null | undefined) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return !Number.isFinite(t) || t <= Date.now();
}
