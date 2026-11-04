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
  assert.match(main, /invoke<\{ email: string \}>\('moderado_sign_in', \{ baseUrl: url \}\)/, 'sign-in uses the Base URL the Connection card shows');
  assert.match(main, /invoke\('moderado_sign_out', \{ baseUrl: url \}\)/, 'sign-out revokes the key of that same Base URL');
  assert.match(main, /`moderado-account-email:\$\{url\}`/, 'each gateway keeps its own signed-in email');
  assert.match(main, /\$\('user-account-name'\)\.textContent = accountEmail \|\| t\('Not signed in'\)/);
  assert.doesNotMatch(main, /account\?mode=signin/, 'the pane no longer sends the user to a page that forgets them');
});

test('page mode keeps the rail, collapses both panes, and drops the conversation', async () => {
  const style = await read('src/renderer/style.css');
  assert.match(style, /\.app\.page-mode\{grid-template-columns:auto minmax\(0,1fr\)\}/);
  // Without this guard, page mode at 1200px and wider keeps the hidden monitor's column.
  assert.match(style, /\.app\.page-mode\.task-monitor-open\{grid-template-columns:auto minmax\(0,1fr\)\}/, 'page mode wins over an open monitor');
  assert.match(style, /\.app\.page-mode \.left-shell\{grid-template-columns:52px 0;grid-template-rows:0 minmax\(0,1fr\)\}/, 'the Left Pane gives its width to the page');
  assert.match(style, /\.app\.page-mode \.shell-head,\.app\.page-mode \.sidebar,\.app\.page-mode \.sidebar-resizer\{display:none\}/, 'the merged header and pane leave with the workspace');
  assert.match(style, /\.app\.page-mode \.task-monitor\{display:none\}/, 'the Right Pane leaves too');
  assert.match(style, /\.main\.page-mode>\.topbar,\.main\.page-mode>\.transcript,\.main\.page-mode>\.composer-wrap\{display:none\}/);
  assert.match(style, /\.main\.page-mode>\.terminal-drawer\{display:none\}/, 'page mode hides the terminal drawer');
  assert.match(style, /\.page\.active\{display:block\}/);
});

test('settings pairs its cards on shared rows so their heights match', async () => {
  const [html, style] = await Promise.all([readHtml(), read('src/renderer/style.css')]);
  const settings = html.slice(html.indexOf('id="page-settings"'), html.indexOf('id="page-docs"'));
  // Connection | MCP over Language | Appearance over About. MCP sits in the top
  // row so adding servers grows into the taller row instead of past the fold.
  assert.match(settings, /class="page-body settings-grid"/);
  const cards = [...settings.matchAll(/class="settings-group (?:[a-z-]+ )?([a-z-]+-card)"/g)].map((match) => match[1]);
  assert.deepEqual(cards, ['connection-card', 'mcp-card', 'language-card', 'appearance-card', 'about-card']);
  assert.match(style, /\.page-body\.settings-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\);grid-template-rows:auto auto/);
  assert.match(style, /\.settings-grid>\.connection-card\{grid-column:1;grid-row:1\/span 2\}/);
  assert.match(style, /\.settings-grid>\.mcp-card\{grid-column:2;grid-row:1\}/);
  assert.match(style, /\.settings-grid>\.language-card\{grid-column:2;grid-row:2\}/);
  assert.match(style, /\.settings-grid>\.appearance-card\{grid-column:3;grid-row:1\}/);
  assert.match(style, /\.settings-grid>\.about-card\{grid-column:3;grid-row:2\}/);
  // Below 1000px the three columns become one stack.
  assert.match(style, /@media\(max-width:1000px\)\{\.page-body\.settings-grid\{grid-template-columns:minmax\(0,1fr\)\}\.settings-grid>\.settings-group\{grid-column:1;grid-row:auto\}\}/);
});

test('the Settings and Docs body text share one size', async () => {
  const style = await read('src/renderer/style.css');
  assert.match(style, /\.markdown-body\{white-space:normal;font-size:calc\(13px\*var\(--text-scale\)\);line-height:1\.65/, 'Docs body matches the settings scale');
  assert.match(style, /\.markdown-body h2\{font-size:calc\(16px\*var\(--text-scale\)\)\}/);
  assert.match(style, /\.page \.settings-group \.hint\{font-size:calc\(12px\*var\(--text-scale\)\)\}/, 'settings hints step up toward the Docs size');
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

test('the Connection card saves model selections under the model pickers and edits every Base URL', async () => {
  const [html, main, provider] = await Promise.all([readHtml(), readMain(), read('src-tauri/src/provider.rs')]);
  const card = html.slice(html.indexOf('class="settings-group connection-card"'), html.indexOf('id="page-docs"'));
  // Load Models sits above the Plan picker for every provider.
  assert.match(card, /<div class="settings-row">\s*<button id="load-models"[^>]*>Load Models<\/button>\s*<\/div>\s*<label for="plan-model">Plan model<\/label>/);
  // The save action sits after the Plan and Act pickers, closing the card.
  assert.match(card, /<select id="act-model"[\s\S]*?<div class="settings-row">\s*<button id="save-provider-settings"[^>]*>Save Model Selections<\/button>/);
  assert.doesNotMatch(card, />Save Settings</);
  // The moved row left no broken nesting: every card stays inside the grid.
  const pageStart = html.indexOf('id="page-settings"');
  const page = html.slice(pageStart, html.indexOf('</section>', pageStart));
  assert.equal((page.match(/<div\b/g) || []).length, (page.match(/<\/div>/g) || []).length, 'div tags balance in the Settings page');
  // Base URL is typeable for every provider.
  assert.doesNotMatch(main, /editableUrl|endpoint\.readOnly/, 'the renderer no longer pins fixed providers');
  assert.doesNotMatch(provider, /editable_url/, 'the catalog resolves the entered Base URL for every provider');
});

test('the Connection card centers both model buttons and enlarges their text', async () => {
  const style = await read('src/renderer/style.css');
  assert.match(style, /\.connection-card \.settings-row\{justify-content:center\}/);
  assert.match(style, /\.connection-card \.settings-row button\{flex:0 1 auto;padding:8px 14px;text-align:center;font-size:calc\(14px\*var\(--text-scale\)\)\}/);
  // Other settings rows keep their full-width, left-aligned buttons.
  assert.match(style, /\.settings-row\{display:flex;gap:10px;margin-top:10px\}/);
  assert.match(style, /\.settings-row button\{flex:1\}/);
});

test('the MCP Servers card keeps the Add server form enabled inside it', async () => {
  const [html, main] = await Promise.all([readHtml(), readMain()]);
  const card = html.slice(html.indexOf('class="settings-group mcp-card"'), html.indexOf('class="settings-group language-card"'));
  assert.match(card, /<div id="mcp-servers"><\/div>[\s\S]*?<button id="add-mcp-server"[^>]*>Add server<\/button>/, 'Add server lives in the card next to the server list');
  // An empty config still shows one editable row, so the form is ready without a click.
  assert.match(main, /function emptyMcpServer\(\): McpServerConfig/);
  assert.match(main, /const servers = config\.servers\.length \? config\.servers : \[emptyMcpServer\(\)\]/);
  assert.match(main, /\$\('add-mcp-server'\)\.addEventListener\('click', \(\) => \{\s*\$\('mcp-servers'\)\.append\(mcpRow\(emptyMcpServer\(\)\)\);/);
  // Blank rows stay out of the saved config instead of failing Rust validation.
  assert.match(main, /\.filter\(\(server\) => Boolean\(server\.id \|\| server\.command \|\| server\.url\)\)/);
});

test('the User pane signs in against the Base URL in the Connection card', async () => {
  const main = await readMain();
  // A typed dev URL must switch the identity and the sign-in target, not keep prod.
  assert.match(main, /function accountGateway\(\): \{ mode: GatewayMode; url: string \}/);
  assert.match(main, /const entered = endpoint\.value\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\)/);
  assert.match(main, /if \(entered === GATEWAY_URLS\.dev\) return \{ mode: 'dev', url: entered \}/);
  assert.match(main, /for \(const event of \['change', 'input'\]\) endpoint\.addEventListener\(event, refreshAccount\)/);
  assert.match(main, /const identity = await invoke<\{ email: string \}>\('moderado_sign_in', \{ baseUrl: url \}\)/);
  assert.match(main, /await invoke\('moderado_sign_out', \{ baseUrl: url \}\)/);
  assert.doesNotMatch(main, /moderado_sign_in', \{ baseUrl: GATEWAY_URLS\[gatewayMode\]/);
  // Old mode-keyed and unkeyed prod emails still load after the key change.
  assert.match(main, /localStorage\.getItem\(legacyModeKey\(mode\)\)/);
});

test('rail buttons open pages and the Back buttons leave them', async () => {
  const main = await readMain();
  assert.match(main, /function setPageMode\(page: AppPage \| null\): void/);
  assert.match(main, /document\.querySelectorAll<HTMLButtonElement>\('\.rail-pages \.rail-tab'\)/);
  assert.match(main, /switchPage\(page\)/);
  assert.match(main, /for \(const id of \['close-page', 'close-docs'\]\)/);
  assert.doesNotMatch(main, /\.activity-button/);
});

test('a sent question is indented by two tabs', async () => {
  const style = await read('src/renderer/style.css');
  // Two 40px tab stops push the You bubble in from the transcript's left edge.
  assert.match(style, /\.message\.you\{padding-left:calc\(2\*40px\)\}/);
});

test('questions typed during a turn wait in a Steer queue above the composer', async () => {
  const [html, main, style] = await Promise.all([readHtml(), readMain(), read('src/renderer/style.css')]);
  assert.match(html, /<div id="queued-turns" class="queued-turns" aria-label="Queued questions" aria-live="polite" hidden><\/div>/);
  assert.match(style, /\.queued-steer\{/);
  assert.match(style, /\.queued-turn\.steering\{/);
  // Sending stays available while a turn runs; only setup gates it now.
  assert.match(main, /send\.disabled = !canSend\(initialized, creatingSession \|\| selectingContext\)/);
  assert.doesNotMatch(main, /send\.disabled = !canSend\(initialized, busy \|\|/);
  // A busy session queues the question instead of dropping it.
  assert.match(main, /if \(activeSessionId && running\.has\(activeSessionId\)\) \{\s*enqueueTurn\(activeSessionId, text, sent\);/);
  assert.match(main, /function enqueueTurn\(id: string, text: string, attachments: AttachmentRecord\[\]\): void/);
  assert.match(main, /const queuedTurns = new Map<string, QueuedTurn\[\]>\(\)/);
  // Every queued row leads with its Steer button.
  assert.match(main, /steer\.className = 'queued-steer'/);
  assert.match(main, /steer\.textContent = item\.steer \? 'Next' : 'Steer'/);
  assert.match(main, /row\.append\(steer, text, remove\)/);
  // Steer promotes a question to the front of the queue.
  assert.match(main, /function steerQueuedTurn\(index: number\): void/);
  assert.match(main, /item\.steer = true;\s*queue\.unshift\(item\)/);
  // The next question starts only after the running turn has finished.
  assert.match(main, /async function drainQueuedTurn\(id: string\): Promise<void>/);
  assert.match(main, /if \(!fromQueue\) void drainQueuedTurn\(id\)/);
  assert.match(main, /if \(id !== activeSessionId \|\| running\.has\(id\) \|\| dispatchingQueuedTurn\.has\(id\)\) return/);
});

test('Work mode exposes the Run commands auto-approve alongside Code', async () => {
  const [html, main] = await Promise.all([readHtml(), readMain()]);
  assert.match(html, /<label id="approve-command-option" class="auto-approve-option" title="[^"]*"><input id="approve-command" type="checkbox" checked \/>Run commands<\/label>/);
  // The toggle shows in Work mode too; MCP servers stay Code-only.
  assert.match(main, /\$\('approve-mcp-option'\)\.toggleAttribute\('hidden', work\)/);
  assert.doesNotMatch(main, /\$\('approve-command-option'\)\.toggleAttribute\('hidden', work\)/);
});
