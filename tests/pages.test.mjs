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

test('the About card carries the copyright on its bottom edge', async () => {
  const [html, style, theme] = await Promise.all([readHtml(), read('src/renderer/style.css'), read('src/renderer/theme.css')]);
  assert.match(html, /<p class="about-copyright">© 2026 Moderado AI, an Alfazen product<\/p>/);
  // The card is a column so the line can be pushed to its bottom, which is where
  // the stretched card's spare space would otherwise sit empty.
  assert.match(style, /\.about-group\{display:flex;flex-direction:column\}/);
  assert.match(style, /\.about-copyright\{margin:auto 0 0;/);
  assert.match(theme, /:root\[data-theme="light"\] \.about-copyright\{color:#536b77\}/);
});

test('the rail bottom opens the Settings, Docs, and Profile pages', async () => {
  const html = await readHtml();
  const pages = html.slice(html.indexOf('class="rail-pages"'), html.indexOf('</aside>'));
  assert.match(pages, /data-page-link="profile"[\s\S]*data-page-link="docs"[\s\S]*data-page-link="settings"/);
  assert.match(html, /<h1>Docs<\/h1>/);
  assert.match(html, /<h1>Settings<\/h1>/);
  assert.match(html, /<h1>Profile<\/h1>/);
  assert.doesNotMatch(html, /data-panel-content="profile"/);
});

test('page mode keeps the rail and Left Pane and drops the conversation', async () => {
  const style = await read('src/renderer/style.css');
  assert.match(style, /\.app\.page-mode\{grid-template-columns:auto minmax\(0,1fr\)\}/);
  // Without this guard, page mode at 1200px and wider keeps the hidden monitor's column.
  assert.match(style, /\.app\.page-mode\.task-monitor-open\{grid-template-columns:auto minmax\(0,1fr\)\}/, 'page mode wins over an open monitor');
  assert.doesNotMatch(style, /\.app\.page-mode \.sidebar\{display:none\}/);
  assert.match(style, /\.main\.page-mode>\.topbar,\.main\.page-mode>\.transcript,\.main\.page-mode>\.composer-wrap\{display:none\}/);
  assert.match(style, /\.main\.page-mode>\.terminal-drawer\{display:none\}/, 'page mode hides the terminal drawer');
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
    ['LANGUAGE SERVERS', 'MCP SERVERS'],
    ['APPEARANCE', 'ABOUT'],
  ]);
  // Columns share a height and their cards grow equally, so the three stacks end
  // on the same line instead of leaving a ragged 100px step.
  assert.match(style, /\.page-body\{display:flex;align-items:stretch;gap:16px/);
  assert.match(style, /\.page-col\{display:flex;flex:1 1 0;flex-direction:column;min-width:0;gap:16px\}/);
  assert.match(style, /\.page-col>\.settings-group\{flex:1 1 auto\}/);
  // Below 1000px the columns flatten into one list, so align-items must stretch.
  assert.match(style, /@media\(max-width:1000px\)\{\.page-body\{flex-direction:column;align-items:stretch\}\.page-col\{display:contents\}\}/);
});

test('rail buttons open pages and the Back buttons leave them', async () => {
  const main = await readMain();
  assert.match(main, /function setPageMode\(page: AppPage \| null\): void/);
  assert.match(main, /document\.querySelectorAll<HTMLButtonElement>\('\.rail-pages \.rail-tab'\)/);
  assert.match(main, /switchPage\(page\)/);
  assert.match(main, /for \(const id of \['close-page', 'close-docs', 'close-profile'\]\)/);
  assert.doesNotMatch(main, /\.activity-button/);
});
