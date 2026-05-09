import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';

/** Mirrors expo-text-extractor public API (avoid importing the package at compile time). */
type TextExtractorModule = {
  readonly isSupported: boolean;
  extractTextFromImage(uri: string): Promise<string[]>;
};

let cached: TextExtractorModule | null | 'missing' = null;

/**
 * Loads expo-text-extractor only when the native binary includes it.
 * Never call `require('expo-text-extractor')` in Expo Go — it crashes (native module absent).
 */
function loadExtractor(): TextExtractorModule | null {
  if (Platform.OS === 'web') return null;
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return null;
  if (cached === 'missing') return null;
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('expo-text-extractor') as unknown as TextExtractorModule;
    return cached;
  } catch {
    cached = 'missing';
    return null;
  }
}

/** True when on-device OCR can run (dev/release build with native module linked; not Expo Go). */
export function isOcrNativeUsable(): boolean {
  const mod = loadExtractor();
  return mod != null && mod.isSupported;
}

export async function extractTextFromImageSafe(uri: string): Promise<string[]> {
  const mod = loadExtractor();
  if (!mod || !mod.isSupported) return [];
  return mod.extractTextFromImage(uri);
}

/** Expo Go app (Store Client). On-device native OCR is not available; server OCR is used instead. */
export function isExpoGo(): boolean {
  return Platform.OS !== 'web' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}

/** Inline hint when OCR entry is not available (web only). */
export function getOcrUnavailableHint(): string | null {
  if (Platform.OS === 'web') {
    return 'OCR runs in the iOS/Android app, not in the browser.';
  }
  return null;
}
