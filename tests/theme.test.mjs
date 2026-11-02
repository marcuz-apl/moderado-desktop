import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { oppositeTheme, parseThemePreference, resolveTheme } from '../src/renderer/theme.ts';

test('auto theme follows local morning and evening boundaries', () => {
  assert.equal(resolveTheme('auto', new Date(2026, 9, 26, 6, 59)), 'dark');
  assert.equal(resolveTheme('auto', new Date(2026, 9, 26, 7, 0)), 'light');
  assert.equal(resolveTheme('auto', new Date(2026, 9, 26, 18, 59)), 'light');
  assert.equal(resolveTheme('auto', new Date(2026, 9, 26, 19, 0)), 'dark');
});

test('manual theme choices override local time', () => {
  assert.equal(resolveTheme('light', new Date(2026, 9, 26, 23, 0)), 'light');
  assert.equal(resolveTheme('dark', new Date(2026, 9, 26, 12, 0)), 'dark');
});

test('unknown saved preference falls back to auto', () => {
  assert.equal(parseThemePreference('light'), 'light');
  assert.equal(parseThemePreference('dark'), 'dark');
  assert.equal(parseThemePreference('auto'), 'auto');
  assert.equal(parseThemePreference('unexpected'), 'auto');
  assert.equal(parseThemePreference(null), 'auto');
});

test('the icon toggle flips between light and dark', () => {
  assert.equal(oppositeTheme('light'), 'dark');
  assert.equal(oppositeTheme('dark'), 'light');
  assert.equal(oppositeTheme(oppositeTheme('light')), 'light');
});

test('auto is selectable again after a manual choice', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const select = html.match(/<select id="theme-mode">([\s\S]*?)<\/select>/)?.[1] ?? '';
  for (const value of ['auto', 'light', 'dark']) {
    assert.match(select, new RegExp(`<option value="${value}"`), value);
  }
  assert.match(main, /themeSelect\.value = themePreference/, 'the control reflects the stored preference');
  assert.match(main, /themeSelect\.addEventListener\('change'/, 'choosing a mode applies it');
});

test('auto re-checks while the window stays open', async () => {
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /setInterval\(\(\) => \{ if \(themePreference === 'auto'\) applyTheme\(\); \}, 60_000\)/);
  assert.match(main, /visibilitychange/);
});
