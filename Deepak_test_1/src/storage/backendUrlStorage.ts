import AsyncStorage from '@react-native-async-storage/async-storage';

/** Persisted full API base URL including `/api`, e.g. `https://godam.divadivya.cloud/api` */
export const BACKEND_API_URL_KEY = 'backend_api_url';

export async function getSavedBackendApiUrl(): Promise<string | null> {
  const v = await AsyncStorage.getItem(BACKEND_API_URL_KEY);
  return v?.trim() || null;
}

export async function saveBackendApiUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(BACKEND_API_URL_KEY, url.trim());
}

export async function clearSavedBackendApiUrl(): Promise<void> {
  await AsyncStorage.removeItem(BACKEND_API_URL_KEY);
}
