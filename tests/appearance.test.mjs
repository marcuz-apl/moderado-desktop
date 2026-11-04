import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
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

test('the settings panel offers language, font family, text size, and UI scale', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<label for="language">Language<\/label>/);
  assert.match(html, /<option value="en">English<\/option>[\s\S]*<option value="fr">Français<\/option>/);
  assert.match(html, /<label for="font-family">Font family<\/label>/);
  for (const family of FONT_FAMILIES) assert.match(html, new RegExp(`<option value="${family}"`));
  assert.match(html, /<label for="text-size">Text size<\/label>/);
  for (const size of TEXT_SIZES) assert.match(html, new RegExp(`<option value="${size}"`));
  assert.match(html, /<label for="ui-scale">UI scale<\/label>/);
  for (const scale of UI_SCALES) assert.match(html, new RegExp(`<option value="${scale}"`));
  assert.doesNotMatch(html, /id="display-size"/, 'the retired control is gone');
});

test('the stylesheet turns appearance choices into one set of variables', async () => {
  const css = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
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
