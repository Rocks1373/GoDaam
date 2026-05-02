import AsyncStorage from '@react-native-async-storage/async-storage';

const TOKEN_KEY = 'godam_token';
const EXPIRES_KEY = 'godam_token_expires_at';

export async function saveAuth(token: string, expiresAt?: string | null) {
  const ops: [string, string][] = [[TOKEN_KEY, token]];
  if (expiresAt) ops.push([EXPIRES_KEY, expiresAt]);
  await AsyncStorage.multiSet(ops);
}

export async function loadAuth(): Promise<{ token: string | null; expiresAt: string | null }> {
  const [[, token], [, expiresAt]] = await AsyncStorage.multiGet([TOKEN_KEY, EXPIRES_KEY]);
  return { token, expiresAt };
}

export async function clearAuth() {
  await AsyncStorage.multiRemove([TOKEN_KEY, EXPIRES_KEY]);
}

export function isExpiredIso(expiresAt: string | null | undefined) {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() > t;
}
