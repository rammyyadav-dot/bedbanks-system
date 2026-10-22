'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { THEME_COOKIE, THEME_PREFERENCES, parseThemePreference, type ThemePreference } from '@/lib/theme/tokens';

const options: Record<ThemePreference, { label: string; Icon: typeof Sun }> = {
  light: { label: 'Light', Icon: Sun },
  dark: { label: 'Dark', Icon: Moon },
  system: { label: 'System', Icon: Monitor },
};

/**
 * Appearance preference. It is a per-browser display choice (not session or access state), so it is a plain
 * cookie the server reads to render <html data-theme>; the click applies it immediately without a round trip.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference>('light');
  useEffect(() => { setTheme(parseThemePreference(document.documentElement.dataset.theme)); }, []);

  function choose(next: ThemePreference) {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax; Secure`;
  }

  return (
    <div role="group" aria-label="Appearance" className="theme-toggle">
      {THEME_PREFERENCES.map((value) => {
        const { label, Icon } = options[value];
        return (
          <button key={value} type="button" aria-pressed={theme === value} onClick={() => choose(value)}>
            <Icon size={12} aria-hidden="true" />{label}
          </button>
        );
      })}
    </div>
  );
}
