export const THEME_IDS = ['light', 'dark', 'ocean', 'warm'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export type ThemeDefinition = {
  background: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  textMuted: string;
  textSecondary: string;
  primary: string;
  primaryHover: string;
  primarySoft: string;
  primaryBorder: string;
  pillText: string;
  iconMuted: string;
  tileIconBg: string;
  danger: string;
  warningBg: string;
  warningBorder: string;
  warningText: string;
  headerBg: string;
  headerTitle: string;
  inputBg: string;
  link: string;
  shadow: string;
};

export const THEME_LABELS: Record<ThemeId, string> = {
  light: 'Light',
  dark: 'Dark',
  ocean: 'Ocean',
  warm: 'Warm',
};

/** Mirrors web `data-theme` palettes for a consistent experience. */
export const THEMES: Record<ThemeId, ThemeDefinition> = {
  light: {
    background: '#f1f5f9',
    surface: '#ffffff',
    surfaceMuted: '#f1f5f9',
    border: '#e2e8f0',
    text: '#0f172a',
    textMuted: '#64748b',
    textSecondary: '#334155',
    primary: '#2563eb',
    primaryHover: '#1d4ed8',
    primarySoft: '#eff6ff',
    primaryBorder: '#bfdbfe',
    pillText: '#1e3a8a',
    iconMuted: '#64748b',
    tileIconBg: '#eff6ff',
    danger: '#dc2626',
    warningBg: '#fffbeb',
    warningBorder: '#fde68a',
    warningText: '#92400e',
    headerBg: '#ffffff',
    headerTitle: '#0f172a',
    inputBg: '#ffffff',
    link: '#1d4ed8',
    shadow: '#0f172a',
  },
  dark: {
    background: '#0f172a',
    surface: '#1e293b',
    surfaceMuted: '#334155',
    border: '#334155',
    text: '#f1f5f9',
    textMuted: '#94a3b8',
    textSecondary: '#e2e8f0',
    primary: '#3b82f6',
    primaryHover: '#60a5fa',
    primarySoft: '#1e3a5f',
    primaryBorder: '#2563eb',
    pillText: '#dbeafe',
    iconMuted: '#94a3b8',
    tileIconBg: '#1e3a5f',
    danger: '#f87171',
    warningBg: '#422006',
    warningBorder: '#92400e',
    warningText: '#fde68a',
    headerBg: '#1e293b',
    headerTitle: '#f1f5f9',
    inputBg: '#0f172a',
    link: '#93c5fd',
    shadow: '#020617',
  },
  ocean: {
    background: '#ecfeff',
    surface: '#ffffff',
    surfaceMuted: '#cffafe',
    border: '#a5f3fc',
    text: '#134e4a',
    textMuted: '#0f766e',
    textSecondary: '#115e59',
    primary: '#0d9488',
    primaryHover: '#0f766e',
    primarySoft: '#ccfbf1',
    primaryBorder: '#5eead4',
    pillText: '#134e4a',
    iconMuted: '#0f766e',
    tileIconBg: '#ccfbf1',
    danger: '#dc2626',
    warningBg: '#fffbeb',
    warningBorder: '#fde68a',
    warningText: '#92400e',
    headerBg: '#ffffff',
    headerTitle: '#134e4a',
    inputBg: '#ffffff',
    link: '#0f766e',
    shadow: '#134e4a',
  },
  warm: {
    background: '#fffbeb',
    surface: '#ffffff',
    surfaceMuted: '#fef3c7',
    border: '#fde68a',
    text: '#78350f',
    textMuted: '#b45309',
    textSecondary: '#92400e',
    primary: '#d97706',
    primaryHover: '#b45309',
    primarySoft: '#fef3c7',
    primaryBorder: '#fcd34d',
    pillText: '#92400e',
    iconMuted: '#b45309',
    tileIconBg: '#fef3c7',
    danger: '#dc2626',
    warningBg: '#fff7ed',
    warningBorder: '#fdba74',
    warningText: '#9a3412',
    headerBg: '#fffbeb',
    headerTitle: '#78350f',
    inputBg: '#ffffff',
    link: '#b45309',
    shadow: '#78350f',
  },
};
