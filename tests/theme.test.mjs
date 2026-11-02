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

const readTheme = () => readFile(new URL('../src/renderer/theme.css', import.meta.url), 'utf8');

/** [ids, classes+attributes, elements] so an override can be compared. */
function specificity(selector) {
  const body = selector.replace(/:root/g, '').trim();
  const ids = (body.match(/#[\w-]+/g) ?? []).length;
  const classes = (body.match(/\.[\w-]+|\[[^\]]+\]|:(?!root)[\w-]+/g) ?? []).length;
  const elements = (body.match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
  return [ids, classes, elements];
}

function outranks(candidate, target) {
  const [a, b] = [specificity(candidate), specificity(target)];
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

test('the light theme covers the pages and the newer composer controls', async () => {
  const theme = await readTheme();
  // Surfaces added after the light theme was first written. Each one is a dark
  // fill or a dark border in style.css, so without a counterpart it would show
  // as a heavy block on the light page.
  for (const selector of [
    ':root[data-theme="light"] .page .settings-group',
    ':root[data-theme="light"] .page-head .text-button',
    ':root[data-theme="light"] .composer-attach',
    ':root[data-theme="light"] .composer-stop .stop-play',
    ':root[data-theme="light"] .mention-menu',
    ':root[data-theme="light"] .mention-item',
    ':root[data-theme="light"] .attachment-chip',
    ':root[data-theme="light"] .kind-segment',
    ':root[data-theme="light"] .model-usage',
  ]) {
    assert.ok(theme.includes(selector), `missing light rule: ${selector}`);
  }
});

test('a light override out-specifies the dark rule it replaces', async () => {
  const theme = await readTheme();
  const card = ':root[data-theme="light"] .page .settings-group';
  assert.ok(theme.includes(card), 'the settings card has a light fill');
  // .page .settings-group is the dark rule; an id-less class pair would lose.
  assert.ok(outranks(card, '.page .settings-group'), 'card override must win the cascade');
  assert.ok(outranks(':root[data-theme="light"] .composer-stop .stop-play', '.composer-stop .stop-play'));
  assert.ok(outranks(':root[data-theme="light"] .mention-item:hover', '.mention-item:hover'));
});
