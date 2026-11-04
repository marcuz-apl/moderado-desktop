export type ThemePreference = 'auto' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

/** Light runs from 07:00 inclusive until 19:00 exclusive, local time. */
export const LIGHT_FROM_HOUR = 7;
export const LIGHT_UNTIL_HOUR = 19;

export function parseThemePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

export function resolveTheme(preference: ThemePreference, now: Date): Theme {
  if (preference !== 'auto') return preference;
  const hour = now.getHours();
  return hour >= LIGHT_FROM_HOUR && hour < LIGHT_UNTIL_HOUR ? 'light' : 'dark';
}

/** The topbar control cycles auto → light → dark → auto, like Lomora's. */
export function nextThemePreference(preference: ThemePreference): ThemePreference {
  if (preference === 'auto') return 'light';
  return preference === 'light' ? 'dark' : 'auto';
}
