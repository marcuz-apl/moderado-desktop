import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readHtml = () => read('index.html');
const readMain = () => read('src/renderer/main.ts');

test('settings and the manual are full-width pages, not sidebar panels', async () => {
  const html = await readHtml();
  assert.match(html, /<section class="page" data-page="settings" id="page-settings">/);
  assert.match(html, /<section class="page" data-page="docs" id="page-docs">/);
  const settings = html.slice(html.indexOf('id="page-settings"'), html.indexOf('id="page-docs"'));
  assert.match(settings, /CONNECTION/);
  assert.match(settings, /MCP SERVERS/);
  assert.match(settings, /APPEARANCE/);
  assert.doesNotMatch(html, /data-panel-content="settings"/);
});

test('the manual renders docs/getting-started.md through the existing Markdown renderer', async () => {
  const main = await readMain();
  const manual = await read('docs/getting-started.md');
  assert.match(main, /import gettingStarted from '\.\.\/\.\.\/docs\/getting-started\.md\?raw'/);
  assert.match(main, /markdown\.render\(gettingStarted\)/);
  assert.match(manual, /^# Getting started/);
  assert.ok(manual.length > 800, 'the manual carries real content');
});

test('page mode drops the sidebar and the conversation', async () => {
  const style = await read('src/renderer/style.css');
  assert.match(style, /\.app\.page-mode\{grid-template-columns:52px minmax\(0,1fr\)\}/);
  assert.match(style, /\.app\.page-mode \.sidebar\{display:none\}/);
  assert.match(style, /\.main\.page-mode>\.topbar,\.main\.page-mode>\.transcript,\.main\.page-mode>\.composer-wrap\{display:none\}/);
  assert.match(style, /\.page\.active\{display:block\}/);
});

test('rail buttons open pages and panels respectively', async () => {
  const main = await readMain();
  assert.match(main, /const page = button\.dataset\.page as AppPage \| undefined;/);
  assert.match(main, /if \(page\) switchPage\(page\);/);
  assert.match(main, /setPageMode\(null\);/);
});
