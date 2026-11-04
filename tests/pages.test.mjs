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

test('the About card keeps the product name, version, and one intro line', async () => {
  const [html, style, theme] = await Promise.all([readHtml(), read('src/renderer/style.css'), read('src/renderer/theme.css')]);
  const start = html.indexOf('class="settings-group about-group');
  const about = html.slice(start, html.indexOf('</div>', start));
  assert.match(about, /about-card/);
  assert.match(about, /<p class="workspace-name">Moderado Desktop<\/p>/);
  assert.match(about, /<span id="about-version"><\/span>/);
  assert.match(about, /<p class="hint about-intro">[^<]*agent sessions[^<]*<\/p>/, 'one line says what the app is');
  // The page footer carries the copyright now, so the card does not repeat it.
  assert.doesNotMatch(about, /©|Alfazen|copyright/i);
  assert.doesNotMatch(style, /\.about-copyright/);
  assert.doesNotMatch(theme, /\.about-copyright/);
});

test('the rail bottom opens Docs and Settings, and User lives in the Left Pane', async () => {
  const [html, main] = await Promise.all([readHtml(), readMain()]);
  const pages = html.slice(html.indexOf('class="rail-pages"'), html.indexOf('</aside>'));
  assert.match(pages, /data-page-link="docs"[\s\S]*data-page-link="settings"/);
  assert.doesNotMatch(pages, /data-page-link="profile"/, 'User is not a full page');
  assert.match(html, /data-rail="user"[^>]*aria-label="User" title="User"><svg aria-hidden="true"><use href="#icon-user"\/><\/svg>/);
  assert.match(pages, /data-rail="user"[\s\S]*data-page-link="docs"/, 'the pane view sits above Docs');
  assert.match(html, /data-left-view="user"/);
  const userPanel = html.slice(html.indexOf('data-left-view="user"'), html.indexOf('</aside>'));
  assert.match(userPanel, /ACCOUNT[\s\S]*GIT IDENTITY/);
  assert.doesNotMatch(userPanel, /CURRENT SESSION|PROVIDER|>MODE<|profile-session|profile-provider/, 'transient status duplicates the topbar and composer');
  assert.match(main, /\$\('profile-git'\)\.toggleAttribute\('hidden', work\)/, 'Git identity stays workspace-scoped');
  assert.doesNotMatch(main, /profile-session|profile-provider|profile-mode-description/, 'the removed fields left no dead lookups');
  assert.match(html, /<h1>Docs<\/h1>/);
  assert.match(html, /<h1>Settings<\/h1>/);
  assert.doesNotMatch(html, /id="page-profile"/);
  assert.match(main, /\$\('user-signin'\)\.addEventListener\('click'/);
  assert.match(main, /https:\/\/modr\.alfazen\.org\/account\?mode=signin/, 'the account page is the one place to sign in');
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

test('settings pairs its cards on shared rows so their heights match', async () => {
  const [html, style] = await Promise.all([readHtml(), read('src/renderer/style.css')]);
  const settings = html.slice(html.indexOf('id="page-settings"'), html.indexOf('id="page-docs"'));
  // Connection | Language over MCP | Appearance over About. Two grid rows give the
  // pairs equal heights: Appearance matches Language, and About matches MCP.
  assert.match(settings, /class="page-body settings-grid"/);
  const cards = [...settings.matchAll(/class="settings-group (?:[a-z-]+ )?([a-z-]+-card)"/g)].map((match) => match[1]);
  assert.deepEqual(cards, ['connection-card', 'language-card', 'mcp-card', 'appearance-card', 'about-card']);
  assert.match(style, /\.page-body\.settings-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\);grid-template-rows:auto auto/);
  assert.match(style, /\.settings-grid>\.connection-card\{grid-column:1;grid-row:1\/span 2\}/);
  assert.match(style, /\.settings-grid>\.language-card\{grid-column:2;grid-row:1\}/);
  assert.match(style, /\.settings-grid>\.mcp-card\{grid-column:2;grid-row:2\}/);
  assert.match(style, /\.settings-grid>\.appearance-card\{grid-column:3;grid-row:1\}/);
  assert.match(style, /\.settings-grid>\.about-card\{grid-column:3;grid-row:2\}/);
  // Below 1000px the three columns become one stack.
  assert.match(style, /@media\(max-width:1000px\)\{\.page-body\.settings-grid\{grid-template-columns:minmax\(0,1fr\)\}\.settings-grid>\.settings-group\{grid-column:1;grid-row:auto\}\}/);
});

test('the Settings and Docs body text share one size', async () => {
  const style = await read('src/renderer/style.css');
  assert.match(style, /\.markdown-body\{white-space:normal;font-size:13px;line-height:1\.65/, 'Docs body matches the settings scale');
  assert.match(style, /\.markdown-body h2\{font-size:16px\}/);
  assert.match(style, /\.page \.settings-group \.hint\{font-size:12px\}/, 'settings hints step up toward the Docs size');
});

test('Settings and Docs end with a footer carrying the current year', async () => {
  const [html, main, style, theme] = await Promise.all([readHtml(), readMain(), read('src/renderer/style.css'), read('src/renderer/theme.css')]);
  for (const id of ['page-settings', 'page-docs']) {
    const start = html.indexOf(`id="${id}"`);
    const page = html.slice(start, html.indexOf('</section>', start));
    // Inside the page and after the body, so it scrolls with the content it closes.
    assert.match(page, /<footer class="page-footer" data-page-footer><\/footer>$/, `${id} ends with the footer`);
  }
  // Read at render time, so the year follows the calendar rather than the build date.
  assert.match(main, /const footerYear = new Date\(\)\.getFullYear\(\);/);
  assert.match(main, /`\$\{footerYear\} Moderado Desktop by Moderado AI, an Alfazen platform, all rights reserved\.`/);
  assert.match(style, /\.page-footer\{max-width:1100px;margin:28px auto 0;/);
  assert.match(theme, /:root\[data-theme="light"\] \.page-footer\{/);
});

test('rail buttons open pages and the Back buttons leave them', async () => {
  const main = await readMain();
  assert.match(main, /function setPageMode\(page: AppPage \| null\): void/);
  assert.match(main, /document\.querySelectorAll<HTMLButtonElement>\('\.rail-pages \.rail-tab'\)/);
  assert.match(main, /switchPage\(page\)/);
  assert.match(main, /for \(const id of \['close-page', 'close-docs'\]\)/);
  assert.doesNotMatch(main, /\.activity-button/);
});
