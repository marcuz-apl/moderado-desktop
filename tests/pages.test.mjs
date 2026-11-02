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

test('the Docs page renders docs/manual.md through the existing Markdown renderer', async () => {
  const main = await readMain();
  const manual = await read('docs/manual.md');
  assert.match(main, /import manual from '\.\.\/\.\.\/docs\/manual\.md\?raw'/);
  assert.match(main, /markdown\.render\(manual\)/);
  assert.ok(manual.length > 800, 'the manual carries real content');
});

test('the manual is Getting started, then Reference, then License', async () => {
  const manual = await read('docs/manual.md');
  const sections = [...manual.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(sections, ['Getting started', 'Reference', 'License']);
  // The page heading already says "Docs", so the body must not repeat a title.
  assert.doesNotMatch(manual, /^# /m);
});

test('the rail names the page Docs', async () => {
  const html = await readHtml();
  const button = html.match(/<button class="activity-button" data-page="docs"[^>]*>/)?.[0] ?? '';
  assert.match(button, /aria-label="Docs"/);
  assert.match(button, /title="Docs"/);
  assert.match(html, /<h1>Docs<\/h1>/);
});

test('page mode drops the sidebar and the conversation', async () => {
  const style = await read('src/renderer/style.css');
  assert.match(style, /\.app\.page-mode\{grid-template-columns:52px minmax\(0,1fr\)\}/);
  assert.match(style, /\.app\.page-mode \.sidebar\{display:none\}/);
  assert.match(style, /\.main\.page-mode>\.topbar,\.main\.page-mode>\.transcript,\.main\.page-mode>\.composer-wrap\{display:none\}/);
  assert.match(style, /\.page\.active\{display:block\}/);
});

test('settings cards stack in three tight columns', async () => {
  const [html, style] = await Promise.all([readHtml(), read('src/renderer/style.css')]);
  const settings = html.slice(html.indexOf('id="page-settings"'), html.indexOf('id="page-docs"'));
  // Row-aligned grid rows left ~300px of dead space under the short cards, so
  // each column is its own stack: Connection | MCP + Appearance | Language + About.
  const columns = [...settings.matchAll(/<div class="page-col">([\s\S]*?)\n<\/div>/g)].map((match) =>
    [...match[1].matchAll(/<p class="eyebrow">([^<]+)<\/p>/g)].map((inner) => inner[1]));
  assert.deepEqual(columns, [
    ['CONNECTION'],
    ['MCP SERVERS', 'APPEARANCE'],
    ['LANGUAGE SERVERS', 'ABOUT'],
  ]);
  assert.match(style, /\.page-body\{display:flex;align-items:flex-start;gap:16px/);
  assert.match(style, /\.page-col\{display:flex;flex:1 1 0;flex-direction:column;min-width:0;gap:16px\}/);
  // Below 1000px the columns flatten into one list, so align-items must stretch.
  assert.match(style, /@media\(max-width:1000px\)\{\.page-body\{flex-direction:column;align-items:stretch\}\.page-col\{display:contents\}\}/);
});

test('rail buttons open pages and panels respectively', async () => {
  const main = await readMain();
  assert.match(main, /const page = button\.dataset\.page as AppPage \| undefined;/);
  assert.match(main, /if \(page\) switchPage\(page\);/);
  assert.match(main, /setPageMode\(null\);/);
});
