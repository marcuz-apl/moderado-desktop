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

test('every dark surface on the settings page has a light counterpart', async () => {
  const [theme, style, html] = await Promise.all([
    readTheme(),
    readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
  ]);
  const page = html.slice(html.indexOf('id="page-settings"'), html.indexOf('id="page-docs"'));
  const ids = new Set([...page.matchAll(/id="([a-z0-9-]+)"/g)].map((match) => match[1]));
  const classes = new Set([...page.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(' ')));

  const luminance = (hex) => {
    const value = hex.replace('#', '');
    const full = value.length === 3 ? [...value].map((char) => char + char).join('') : value;
    const [r, g, b] = [0, 2, 4].map((index) => {
      const channel = Number.parseInt(full.slice(index, index + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrastOnWhite = (hex) => 1.05 / (luminance(hex) + 0.05);
  // A rule is covered when the light theme names the same id or class.
  const covered = (selector) => {
    const tokens = [...selector.matchAll(/([.#])([\w-]+)/g)].map((match) => match[1] + match[2]);
    return tokens.some((token) => new RegExp(`${token.replace('.', '\\.')}(?![\\w-])`).test(theme));
  };

  const gaps = [];
  for (const [, rawSelector, declarations] of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rawSelector.replace(/^\s*@media[^{]*\{/, '').trim();
    if (!selector || selector.includes('data-theme')) continue;
    const touchesPage = [...selector.matchAll(/#([\w-]+)|\.([\w-]+)/g)].some((match) =>
      match[1] ? ids.has(match[1]) : classes.has(match[2]));
    if (!touchesPage || covered(selector)) continue;
    for (const declaration of declarations.split(';')) {
      const [property, value = ''] = declaration.split(':').map((part) => part.trim());
      const hex = value.match(/#([0-9a-fA-F]{3,6})\b/)?.[1];
      if (!hex) continue;
      // A dark fill, or text that would be unreadable on the light card.
      const darkFill = /^background(-color)?$/.test(property) && luminance(hex) < 0.3;
      const faintText = property === 'color' && contrastOnWhite(hex) < 4.5;
      if (darkFill || faintText) gaps.push(`${selector} { ${property}: ${value} }`);
    }
  }
  assert.deepEqual(gaps, [], `settings page surfaces with no light rule:\n${gaps.join('\n')}`);
});

test('the focus ring stays visible in the light theme', async () => {
  const theme = await readTheme();
  assert.match(theme, /:root\[data-theme="light"\] button:focus-visible\{outline-color:#08766d\}/);
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

test('the shell surfaces added after the first light pass have light counterparts', async () => {
  const theme = await readTheme();
  // Each surface the rail removal, drawer, tools menu and task monitor introduced ships
  // dark first; without a light rule it keeps its dark chip or ink in the default daytime theme.
  for (const selector of [
    '.sidebar-tab', '.terminal-drawer', '.terminal-head', '.tools-menu', '.topbar-toggle',
    '.task-monitor', '.monitor-head h2', '.monitor-section', '.monitor-section h3',
    '.monitor-item', '.monitor-item strong', '.monitor-item span', '.monitor-item.error',
    '.monitor-item.running', '.monitor-artifact', '.monitor-artifact:hover',
  ]) {
    const escaped = selector.replace(/\./g, '\\.');
    assert.match(theme, new RegExp(`:root\\[data-theme="light"\\] ${escaped}(?![\\w-])`), `${selector} has no light rule`);
  }
  assert.doesNotMatch(theme, /:root\[data-theme="light"\] \.activity-(?:bar|button)/, 'the removed rail left no light rules behind');
});
