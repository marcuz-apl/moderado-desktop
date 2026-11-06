import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readStylesheet } from './style.mjs';
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_TEXT_SIZE,
  DEFAULT_UI_SCALE,
  FONT_FAMILIES,
  TEXT_SIZES,
  UI_SCALES,
  parseFontFamily,
  parseTextSize,
  parseUiScale,
  zoomFor,
  textScaleFor,
  CONTEXT_SCALE_MIN,
  CONTEXT_SCALE_MAX,
  CONTEXT_SCALE_STEP,
  DEFAULT_CONTEXT_SCALE,
  parseContextScale,
  stepContextScale,
} from '../src/renderer/appearance.ts';

test('only the offered font families are accepted', () => {
  for (const family of FONT_FAMILIES) assert.equal(parseFontFamily(family), family);
  assert.equal(parseFontFamily(null), DEFAULT_FONT_FAMILY);
  assert.equal(parseFontFamily(''), DEFAULT_FONT_FAMILY);
  assert.equal(parseFontFamily('Comic Sans'), DEFAULT_FONT_FAMILY, 'an unknown face falls back to sans');
});

test('only the offered text sizes are accepted', () => {
  for (const size of TEXT_SIZES) assert.equal(parseTextSize(size), size);
  assert.equal(parseTextSize(null), DEFAULT_TEXT_SIZE);
  assert.equal(parseTextSize('huge'), DEFAULT_TEXT_SIZE);
});

test('the UI scale accepts its names and the retired percentages', () => {
  for (const scale of UI_SCALES) assert.equal(parseUiScale(scale), scale);
  assert.equal(parseUiScale('125'), 'large', 'the retired Display size keeps its intent');
  assert.equal(parseUiScale('100'), 'medium');
  assert.equal(parseUiScale('200'), DEFAULT_UI_SCALE, 'a value outside the old list is ignored');
  assert.equal(parseUiScale(null), DEFAULT_UI_SCALE);
});

test('the zoom value matches the scale name', () => {
  assert.equal(zoomFor('medium'), '100%');
  assert.equal(zoomFor('large'), '125%');
});

test('textScaleFor mirrors the CSS presets', async () => {
  assert.equal(textScaleFor('small'), 0.9);
  assert.equal(textScaleFor('medium'), 1);
  assert.equal(textScaleFor('large'), 1.15);
  const css = await readStylesheet();
  assert.match(css, /:root\[data-text-size="small"\]\{--text-scale:\.9\}/);
  assert.match(css, /:root\[data-text-size="large"\]\{--text-scale:1\.15\}/);
});

test('the live context scale snaps, steps and clamps', () => {
  assert.equal(parseContextScale(null), DEFAULT_CONTEXT_SCALE);
  assert.equal(parseContextScale('garbage'), DEFAULT_CONTEXT_SCALE);
  assert.equal(parseContextScale('0'), DEFAULT_CONTEXT_SCALE);
  assert.equal(parseContextScale('1.13'), 1.15, 'stored values snap to the 5% grid');
  assert.equal(parseContextScale('99'), CONTEXT_SCALE_MAX);
  assert.equal(parseContextScale('0.01'), CONTEXT_SCALE_MIN);
  assert.equal(stepContextScale(1, 1), 1.05);
  assert.equal(stepContextScale(1, -1), 0.95);
  assert.equal(stepContextScale(CONTEXT_SCALE_MAX, 1), CONTEXT_SCALE_MAX);
  assert.equal(stepContextScale(CONTEXT_SCALE_MIN, -1), CONTEXT_SCALE_MIN);
  assert.equal(CONTEXT_SCALE_STEP, 0.05);
});

test('the settings panel offers language, font family, text size, and UI scale', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<label for="language">Language<\/label>/);
  assert.match(html, /<option value="en">English<\/option>[\s\S]*<option value="fr">Français<\/option>/);
  // The language list keeps the requested order after English and French.
  const languageOrder = ['zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'de', 'ru'];
  const select = html.match(/<select id="language"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';
  const positions = languageOrder.map((code) => select.indexOf(`<option value="${code}"`));
  assert.ok(positions.every((position) => position >= 0), 'every requested language has an option');
  assert.deepStrictEqual([...positions].sort((a, b) => a - b), positions, 'languages keep the requested order');
  assert.match(html, /<label for="font-family">Font family<\/label>/);
  for (const family of FONT_FAMILIES) assert.match(html, new RegExp(`<option value="${family}"`));
  assert.match(html, /<label for="text-size">Text size<\/label>/);
  for (const size of TEXT_SIZES) assert.match(html, new RegExp(`<option value="${size}"`));
  assert.match(html, /<label for="ui-scale">UI scale<\/label>/);
  for (const scale of UI_SCALES) assert.match(html, new RegExp(`<option value="${scale}"`));
  assert.doesNotMatch(html, /id="display-size"/, 'the retired control is gone');
});

test('the stylesheet turns appearance choices into one set of variables', async () => {
  const css = await readStylesheet();
  assert.match(css, /:root\{--font-ui:/);
  assert.match(css, /--text-scale:1/);
  assert.match(css, /:root\[data-font="arial"\]\{--font-ui:Arial,Helvetica,sans-serif\}/);
  assert.match(css, /:root\[data-font="serif"\]\{--font-ui:Georgia,"Times New Roman",serif\}/);
  assert.match(css, /:root\[data-font="new-roman"\]\{--font-ui:"Times New Roman",Times,serif\}/);
  assert.match(css, /:root\[data-text-size="small"\]\{--text-scale:\.9\}/);
  assert.match(css, /:root\[data-text-size="large"\]\{--text-scale:1\.15\}/);
  assert.match(css, /font-size:calc\(14px\*var\(--text-scale\)\)/, 'sizes follow the text scale');
  assert.equal(css.match(/"Segoe UI"/g)?.length, 1, 'the default face is declared only in the token');
});

test('the renderer applies and remembers every appearance choice', async () => {
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /root\.dataset\.font = fontFamily/);
  assert.match(main, /root\.dataset\.textSize = textSize/);
  assert.match(main, /root\.style\.zoom = zoomFor\(uiScale\)/);
  assert.match(main, /localStorage\.setItem\(fontFamilyKey, fontFamily\)/);
  assert.match(main, /localStorage\.setItem\(textSizeKey, textSize\)/);
  assert.match(main, /localStorage\.setItem\(uiScaleKey, uiScale\)/);
  assert.match(main, /localStorage\.getItem\(uiScaleKey\) \?\? localStorage\.getItem\('moderado-display-size'\)/, 'the old preference migrates');
});

test('switching languages never strands a translated label as English source', async () => {
  const readSource = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [registry, html] = await Promise.all([
    readSource('src/renderer/i18n/index.ts'),
    readSource('index.html'),
  ]);
  assert.doesNotMatch(registry, /let previous: Language/, 'source tracking does not depend on the last two languages');
  assert.doesNotMatch(registry, /__i18nDebug/, 'no debug hook ships in the renderer');
  // Copy written by t() at render time is already translated; it must never be
  // recorded as an English source by the tree walk.
  assert.match(html, /<p id="user-account-name"[^>]*data-no-i18n>/);
  assert.match(html, /<button id="user-signin"[^>]*data-no-i18n>/);
  // The language list is written in each language's own name, so it must never
  // be translated (or recorded as English source) by the tree walk.
  assert.match(html, /<select id="language" data-no-i18n>/);

  // Run the shipped sourceOf body against the real packs: text nodes around a
  // nested span keep a trailing space, while pack keys are trimmed. That gap
  // used to turn "API key " into a permanent "API 密钥 " source.
  const body = registry.match(/function sourceOf\(recorded: string \| undefined, value: string\): string \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'sourceOf is present and extractable');
  const languages = ['fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'de', 'ru'];
  const packs = {};
  for (const language of languages) {
    const source = await readSource(`src/renderer/i18n/${language}.ts`);
    const pack = {};
    const entry = /^  '((?:[^'\\]|\\.)*)': '((?:[^'\\]|\\.)*)',?$/gm;
    for (let match = entry.exec(source); match; match = entry.exec(source)) pack[match[1]] = match[2];
    packs[language] = pack;
  }
  const lookup = (language, phrase) => packs[language]?.[phrase] ?? phrase;
  const sourceOf = new Function('LANGUAGES', 'lookup', 'recorded', 'value', body);
  const recognize = (recorded, value) => sourceOf(languages, lookup, recorded, value);
  assert.equal(recognize(undefined, 'API key '), 'API key ', 'a fresh English node becomes the source');
  assert.equal(recognize('API key ', 'API 密钥 '), 'API key ', 'the Chinese label keeps its source');
  assert.equal(recognize('API key ', 'API-Schlüssel '), 'API key ', 'a switch from any language keeps its source');
  assert.equal(recognize('API key ', 'Clé API '), 'API key ', 'French works too');
  assert.equal(recognize('API key ', 'Saved. '), 'Saved. ', 'genuinely new copy replaces the source');
  const lsp = 'Configure LSP servers for the diagnostics tool as JSON. Each entry maps file extensions to a command, for example ';
  assert.match(registry, /const source = recorded\.trim\(\)/, 'comparison uses the trimmed core');
  assert.match(registry, /LANGUAGES\.some\(\(language\) => lookup\(language, source\) === content\)/);
  assert.equal(recognize(lsp, `${packs['zh-Hans'][lsp.trim()]} `), lsp, 'the long LSP hint also round-trips');
});

test('every language pack covers the same phrases as the French reference pack', async () => {
  const readPack = (name) => readFile(new URL(`../src/renderer/i18n/${name}`, import.meta.url), 'utf8');
  const keysOf = (source) => (source.match(/(?:^|\n)\s*'((?:[^'\\]|\\.)*)':/g) ?? [])
    .map((entry) => entry.replace(/(?:^|\n)\s*'|':$/g, ''));
  const registry = await readPack('index.ts');
  assert.match(registry, /LANGUAGES = \['en', 'fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'de', 'ru'\] as const/);
  assert.match(registry, /'zh-Hans': '简体中文'/);
  assert.match(registry, /ru: 'Русский'/);
  const reference = keysOf(await readPack('fr.ts'));
  assert.ok(reference.length > 100, 'the reference pack keeps its full key set');
  for (const pack of ['zh-Hans.ts', 'zh-Hant.ts', 'ja.ts', 'ko.ts', 'es.ts', 'de.ts', 'ru.ts']) {
    const keys = keysOf(await readPack(pack));
    const missing = reference.filter((key) => !keys.includes(key));
    assert.deepStrictEqual(missing, [], `${pack} covers every phrase in fr.ts`);
  }
});
