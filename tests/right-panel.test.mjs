import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readStylesheet } from './style.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the shell is a rail, a Left Pane, and a Right Pane', async () => {
  const html = await read('index.html');
  const tabs = [...html.matchAll(/data-rail="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['library', 'files', 'git', 'schedules', 'user']);
  const pages = [...html.matchAll(/data-page-link="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(pages, ['docs', 'settings']);
  const views = [...html.matchAll(/data-left-view="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(views, ['library', 'files', 'git', 'schedules', 'user']);
  assert.match(html, /class="left-shell">[\s\S]*class="shell-head"/);
  assert.match(html, /id="sidebar-toggle"[^>]*aria-controls="sidebar"[^>]*aria-expanded="true"/, 'the header carries the Left Pane toggle');
  assert.match(html, /id="tools-toggle"[^>]*aria-haspopup="menu"/);
});

test('the side panel can be widened by dragging its edge', async () => {
  const [html, main, style] = await Promise.all([read('index.html'), read('src/renderer/main.ts'), readStylesheet()]);
  assert.match(html, /id="sidebar-resizer"[^>]*role="separator"/);
  // The width is a variable so a drag is one property write, not a layout rewrite.
  assert.match(style, /\.left-shell\{grid-area:1\/1;display:grid;grid-template-columns:52px var\(--sidebar-width,var\(--pane-width\)\)/);
  assert.match(style, /\.left-shell\{[^}]*grid-template-rows:56px minmax\(0,1fr\)/);
  assert.match(style, /\.rail\{grid-area:rail;[^}]*border-right:1px solid #2a4258/);
  assert.match(style, /\.sidebar-resizer\{position:absolute;[^}]*cursor:col-resize/);
  assert.match(main, /--sidebar-width/);
  assert.match(main, /localStorage\.setItem\(sidebarWidthKey/, 'the width is remembered');
  assert.match(main, /Math\.max\(260, Math\.min\(560/, 'clamped so it cannot swallow the window');
  assert.match(main, /ArrowRight/, 'keyboard resizing');
  assert.match(main, /localStorage\.removeItem\(sidebarWidthKey\)/, 'double-click drops the manual width');
  assert.match(main, /let sidebarWidth = 0;/, 'without a pin the pane follows the window');
});

test('both panes are 260px at 1440 and grow with the window', async () => {
  const style = await readStylesheet();
  // 260 / 1440 = 18.0556vw: the panes keep that share above 1440px and stay 260px below it.
  assert.match(style, /:root\{[^}]*--pane-width:max\(260px,18\.0556vw\)/);
  assert.match(style, /\.app\.task-monitor-open\{grid-template-columns:auto minmax\(0,1fr\) var\(--pane-width\)\}/);
});

test('the Left Pane collapses to the rail and remembers the choice', async () => {
  const [main, style] = await Promise.all([read('src/renderer/main.ts'), readStylesheet()]);
  assert.match(style, /\.app\.sidebar-collapsed \.left-shell\{grid-template-columns:52px 0\}/, 'only the pane closes; the rail stays');
  assert.match(style, /\.app\.sidebar-collapsed \.sidebar,[\s\S]*?display:none/, 'the pane content leaves no empty strip');
  assert.match(main, /localStorage\.setItem\(sidebarCollapsedKey, String\(collapsed\)\)/);
  assert.match(main, /localStorage\.getItem\(sidebarCollapsedKey\) === 'true'/, 'the collapsed state survives a restart');
  assert.match(main, /aria-expanded', String\(!collapsed\)/);
  assert.match(main, /if \(sidebarCollapsed\) setSidebarCollapsed\(false\)/, 'a rail click reopens the pane');
});

test('the terminal is a real PTY, not a command runner', async () => {
  const [html, main, lib, terminal] = await Promise.all([
    read('index.html'), read('src/renderer/main.ts'), read('src-tauri/src/lib.rs'), read('src-tauri/src/terminal.rs'),
  ]);
  assert.match(html, /id="terminal-host"/);
  assert.doesNotMatch(html, /id="terminal-input"|id="terminal-run"/, 'the command executor is gone');
  assert.match(main, /new Terminal\(/);
  assert.match(main, /from '@xterm\/addon-fit'/);
  assert.match(main, /invoke\('terminal_write'/);
  assert.match(terminal, /native_pty_system\(\)/);
  assert.match(terminal, /spawn_command/);
  assert.match(lib, /fn terminal_open\(/);
  assert.doesNotMatch(lib, /fn run_command\(/);
});

test('the shell starts when its drawer opens, and only in Code', async () => {
  const [html, main, lib] = await Promise.all([read('index.html'), read('src/renderer/main.ts'), read('src-tauri/src/lib.rs')]);
  assert.match(html, /<section id="terminal-drawer" class="terminal-drawer"[^>]*hidden>/);
  assert.ok(html.indexOf('id="terminal-drawer"') > html.indexOf('class="composer-wrap"'), 'the drawer sits below the composer');
  assert.doesNotMatch(html, /data-panel-content="terminal"/, 'the sidebar terminal is gone');
  assert.match(main, /async function setTerminalOpen\(open: boolean\)/);
  assert.match(main, /if \(open && activeKind !== 'code'\)/);
  assert.match(main, /if \(!pty \|\| !terminalOpen\) return;/, 'resize only when the drawer is visible');
  assert.match(main, /Commands run in Code sessions only/);
  const body = lib.slice(lib.indexOf('fn terminal_open('), lib.indexOf('fn terminal_write('));
  assert.match(body, /code_workspace\(&state/);
});

test('typing reaches the shell the backend actually created', async () => {
  const [main, lib, terminal] = await Promise.all([
    read('src/renderer/main.ts'), read('src-tauri/src/lib.rs'), read('src-tauri/src/terminal.rs'),
  ]);
  const keyFn = main.slice(main.indexOf('function terminalKey()'), main.indexOf('function terminalTheme()'));
  // A Code session sends no session id, so keying by the active session pointed
  // at a terminal that was never created: the shell started, keys went nowhere.
  const keyCode = keyFn
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(keyCode, /activeSessionId/, 'the key must mirror what browserArgs sends');
  assert.match(keyFn, /browserArgs\(\)/);
  assert.match(main, /pty\.key = await invoke<string>\('terminal_open'/, 'the id the backend returns is adopted');
  const body = lib.slice(lib.indexOf('fn terminal_open('), lib.indexOf('fn terminal_write('));
  assert.match(body, /\) -> Result<String, String>/, 'the backend reports its key');
  assert.match(lib, /terminal::key\(session_id, project_workspace, &root\)/, 'one place owns the rule');
  assert.match(terminal, /pub fn key\(/);
  assert.doesNotMatch(main, /invoke\('terminal_write'[^\n]*\.catch\(\(\) => \{\}\)/, 'a failed write is not silent');
});

test('selecting a file opens the Preview sub-view instead of a dialog', async () => {
  const [html, main] = await Promise.all([read('index.html'), read('src/renderer/main.ts')]);
  assert.doesNotMatch(html, /file-preview-dialog/, 'the modal is gone');
  assert.match(main, /function openPreview\(\): void/);
  assert.match(main, /previewOpen = true/);
  assert.match(main, /pty\.terminal\.options\.theme = terminalTheme\(\)/, 'a theme switch repaints the shell');
});

test('the light terminal maps ANSI gray and white to readable ink', async () => {
  const main = await read('src/renderer/main.ts');
  const body = main.slice(main.indexOf('function terminalTheme()'), main.indexOf('function fitTerminal()'));
  assert.match(body, /background: '#ffffff'/, 'the light shell is a white sheet');
  assert.match(body, /white: '#3a5561'/, 'ANSI white is dark ink so echoed commands are visible');
  assert.match(body, /brightWhite: '#203744'/);
  assert.match(body, /brightYellow: '#9c6f00'/, 'the prompt palette is tuned for light, not reused from dark');
  assert.match(main, /minimumContrastRatio: 4\.5/, 'xterm enforces a contrast floor for every palette entry');
});

test('the Right Pane is the Task Monitor behind three controls', async () => {
  const [html, style, main] = await Promise.all([read('index.html'), readStylesheet(), read('src/renderer/main.ts')]);
  assert.match(html, /<aside id="task-monitor" class="task-monitor"[^>]*hidden/);
  const start = html.indexOf('id="task-monitor"');
  const monitor = html.slice(start, html.indexOf('</aside>', start));
  assert.match(monitor, /<h3>Updates<\/h3>/);
  assert.match(monitor, /<h3>Background processes<\/h3>/);
  assert.match(monitor, /<h3>Artifacts<\/h3>/);
  assert.ok(monitor.indexOf('Updates') < monitor.indexOf('Background processes'));
  assert.ok(monitor.indexOf('Background processes') < monitor.indexOf('Artifacts'));
  assert.doesNotMatch(monitor, /<h2>/, 'the header has no title text');
  const controls = [...monitor.matchAll(/id="(tools-toggle|terminal-panel|task-monitor-close)"/g)].map((match) => match[1]);
  assert.deepEqual(controls, ['tools-toggle', 'terminal-panel', 'task-monitor-close']);
  assert.match(html, /id="task-monitor-open"[^>]*aria-label="Open task monitor"[^>]*hidden/);
  assert.match(style, /\.app\.task-monitor-open\{grid-template-columns:auto minmax\(0,1fr\) var\(--pane-width\)\}/);
  assert.match(style, /\.monitor-head\{[^}]*justify-content:flex-end/);
  assert.match(main, /function setTaskMonitor\(open: boolean, focus = false, pin\?: boolean\): void/);
  assert.match(main, /function renderTaskMonitor\(\): void/);
  assert.match(main, /HTMLButtonElement>\('terminal-panel'\)/, 'the terminal toggle reflects the drawer');
});

test('switching modes decides the Right Pane unless the user pinned it', async () => {
  const main = await read('src/renderer/main.ts');
  assert.match(main, /if \(kind === 'code'\) setTaskMonitor\(true\);\s*else if \(!taskMonitorPinned\) setTaskMonitor\(false\);/, 'Code opens it; Work closes it unless a manual open pinned it');
  assert.match(main, /let taskMonitorPinned = localStorage\.getItem\(taskMonitorPinKey\) === 'true'/, 'the manual choice survives a restart');
  assert.match(main, /\$\('task-monitor-open'\)\.addEventListener\('click', \(\) => setTaskMonitor\(true, true, true\)\)/, 'the edge tab counts as a manual open');
  assert.match(main, /\$\('task-monitor-close'\)\.addEventListener\('click', \(\) => setTaskMonitor\(false, true, false\)\)/, 'collapsing releases the pin');
});

test('the edge tab mirrors the monitor open state, which survives a restart', async () => {
  const [html, main] = await Promise.all([read('index.html'), read('src/renderer/main.ts')]);
  assert.match(html, /id="terminal-panel"[^>]*aria-label="Terminal panel"/, 'the label names the panel instead of announcing a stale action');
  assert.doesNotMatch(html, /aria-label="Open terminal panel"/, 'a static open label would contradict aria-pressed');
  assert.match(main, /\$\('task-monitor-open'\)\.toggleAttribute\('hidden', open\)/, 'the edge tab hides while the monitor is open');
  assert.match(main, /\$\('task-monitor'\)\.toggleAttribute\('hidden', !open\)/, 'the monitor shows when it is open');
  assert.match(main, /localStorage\.setItem\('moderado-task-monitor', String\(open\)\)/, 'the open state is stored under one key');
  assert.match(main, /setTaskMonitor\(taskMonitorPinned \|\| \(activeKind === 'code' && storedMonitor\)\)/, 'boot opens it for a pinned pane or Code, not for Work alone');
});

test('the shell degrades without hiding the rail', async () => {
  const [style, theme] = await Promise.all([readStylesheet(), read('src/renderer/theme.css')]);
  assert.match(style, /@media\(max-width:1199px\)\{\s*\.app\.task-monitor-open\{grid-template-columns:auto minmax\(0,1fr\)\}/);
  // The overlay starts below the topbar, so Plan/Act and the theme toggle stay clickable.
  assert.match(style, /@media\(max-width:1199px\)\{[\s\S]*?\.task-monitor\{position:absolute;right:0;top:56px;bottom:0;width:min\(var\(--pane-width\),calc\(100vw - 60px\)\)/);
  // The composer reserves the overlay footprint; Send/stop must stay reachable.
  assert.match(style, /@media\(max-width:1199px\)\{[\s\S]*?\.app\.task-monitor-open \.composer-wrap\{padding-right:calc\(min\(var\(--pane-width\),calc\(100vw - 60px\)\) \+ 12px\)\}/);
  assert.match(style, /@media\(max-width:999px\)\{\s*\.left-shell\{grid-template-columns:52px 220px\}/);
  assert.match(style, /@media\(max-width:999px\)\{[^@]*?\.sidebar-resizer\{display:none\}/);
  assert.match(style, /@media\(max-width:999px\)\{[^@]*?\.topbar #workspace-context\{display:none\}/);
  assert.match(style, /\.app\.page-mode\.task-monitor-open\{grid-template-columns:auto minmax\(0,1fr\)\}/, 'page mode closes the monitor column instead of leaving a dead strip');
  const start999 = style.indexOf('@media(max-width:999px){');
  const block999 = style.slice(start999, style.indexOf('\n}', start999));
  assert.doesNotMatch(block999, /\.session-actions\{[^}]*display:none/, 'New/Rename/Delete stay reachable below 1000px');
  assert.doesNotMatch(style, /\.topbar \.session-actions\{display:none\}/, 'New/Rename/Delete stay reachable at every width');
  assert.doesNotMatch(style, /task-monitor-width/);
  assert.doesNotMatch(style, /@media\(max-width:850px\)/);
  assert.doesNotMatch(style, /@media\(max-width:650px\)/);
  assert.doesNotMatch(theme, /@media\(max-width:650px\)/);
});
