import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

export const THEME_IDS = /** @type {const} */ (['light', 'dark', 'ocean', 'warm']);
/** @typedef {(typeof THEME_IDS)[number]} ThemeId */

const STORAGE_KEY = 'godam_ui_theme';
const DEFAULT_THEME = /** @type {ThemeId} */ ('dark');

/** @type {Record<ThemeId, string>} */
export const THEME_LABELS = {
  light: 'Light',
  dark: 'Dark',
  ocean: 'Ocean',
  warm: 'Warm',
};

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && THEME_IDS.includes(/** @type {ThemeId} */ (v))) return /** @type {ThemeId} */ (v);
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStored);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const setTheme = useCallback((/** @type {ThemeId} */ id) => {
    if (THEME_IDS.includes(id)) setThemeState(id);
  }, []);

  const value = useMemo(() => ({ theme, setTheme, themes: THEME_IDS, labels: THEME_LABELS }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** @returns {{ theme: ThemeId, setTheme: (t: ThemeId) => void, themes: typeof THEME_IDS, labels: typeof THEME_LABELS }} */
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
