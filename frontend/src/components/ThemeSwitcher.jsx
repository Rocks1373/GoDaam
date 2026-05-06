import { Palette } from 'lucide-react';
import { THEME_IDS, THEME_LABELS, useTheme } from '../context/ThemeContext';

export default function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-md border border-theme-border bg-theme-muted px-1 py-0.5"
      title="Color theme"
    >
      <Palette size={14} className="text-theme-fg-muted flex-shrink-0 ml-0.5" aria-hidden />
      <select
        aria-label="Color theme"
        className="max-w-[88px] bg-transparent py-1 pl-1 pr-6 text-[10px] font-bold text-theme-fg-secondary rounded border-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[var(--ring-primary)]"
        value={theme}
        onChange={(e) => setTheme(/** @type {import('../context/ThemeContext').ThemeId} */ (e.target.value))}
      >
        {THEME_IDS.map((id) => (
          <option key={id} value={id}>
            {THEME_LABELS[id]}
          </option>
        ))}
      </select>
    </div>
  );
}
