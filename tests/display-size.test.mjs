import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_DISPLAY_SIZE, DISPLAY_SIZES, parseDisplaySize, zoomFor } from '../src/renderer/display-size.ts';

test('only the offered sizes are accepted', () => {
  for (const size of DISPLAY_SIZES) assert.equal(parseDisplaySize(String(size)), size);
  assert.equal(parseDisplaySize(null), DEFAULT_DISPLAY_SIZE);
  assert.equal(parseDisplaySize(''), DEFAULT_DISPLAY_SIZE);
  assert.equal(parseDisplaySize('abc'), DEFAULT_DISPLAY_SIZE);
  assert.equal(parseDisplaySize('200'), DEFAULT_DISPLAY_SIZE, 'a value outside the list is ignored');
  assert.equal(parseDisplaySize('100.5'), DEFAULT_DISPLAY_SIZE);
});

test('the zoom value matches the percentage', () => {
  assert.equal(zoomFor(100), '100%');
  assert.equal(zoomFor(125), '125%');
});

test('the settings panel offers the display size', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<label for="display-size">Display size<\/label>/);
  assert.match(html, /<option value="125">125%<\/option>/);
  assert.match(html, /<option value="100">100%<\/option>/);
});
