import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DefaultTheme, DarkTheme, type Theme as NavTheme } from '@react-navigation/native';

import {
  THEME_IDS,
  THEME_LABELS,
  THEMES,
  type ThemeDefinition,
  type ThemeId,
} from './palettes';

const STORAGE_KEY = 'godam_mobile_theme';

type ThemeContextValue = {
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
  palette: ThemeDefinition;
  navigationTheme: NavTheme;
  labels: typeof THEME_LABELS;
  ids: typeof THEME_IDS;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function buildNavigationTheme(palette: ThemeDefinition, dark: boolean): NavTheme {
  const base = dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.primary,
      background: palette.background,
      card: palette.surface,
      text: palette.text,
      border: palette.border,
      notification: palette.danger,
    },
  };
}

async function readStoredTheme(): Promise<ThemeId> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw && (THEME_IDS as readonly string[]).includes(raw)) return raw as ThemeId;
  } catch {
    /* ignore */
  }
  return 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeIdState] = useState<ThemeId>('light');

  useEffect(() => {
    readStoredTheme().then(setThemeIdState).catch(() => {});
  }, []);

  const setThemeId = useCallback((id: ThemeId) => {
    setThemeIdState(id);
    AsyncStorage.setItem(STORAGE_KEY, id).catch(() => {});
  }, []);

  const palette = THEMES[themeId];
  const navigationTheme = useMemo(
    () => buildNavigationTheme(palette, themeId === 'dark'),
    [palette, themeId]
  );

  const value = useMemo(
    () => ({
      themeId,
      setThemeId,
      palette,
      navigationTheme,
      labels: THEME_LABELS,
      ids: THEME_IDS,
    }),
    [themeId, setThemeId, palette, navigationTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
