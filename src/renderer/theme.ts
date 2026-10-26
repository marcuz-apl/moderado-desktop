export type ThemePreference = 'auto' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export function parseThemePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

export function resolveTheme(preference: ThemePreference, now: Date): Theme {
  if (preference !== 'auto') return preference;
  const hour = now.getHours();
  return hour >= 7 && hour < 19 ? 'light' : 'dark';
}
