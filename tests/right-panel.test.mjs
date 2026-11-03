import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the shell is a rail, a Left Pane, and a Right Pane', async () => {
  const html = await read('index.html');
  const tabs = [...html.matchAll(/data-rail="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['workspaces', 'files', 'git', 'schedules']);
  const pages = [...html.matchAll(/data-page-link="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(pages, ['settings', 'docs', 'profile']);
  const views = [...html.matchAll(/data-left-view="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(views, ['workspaces', 'files', 'git', 'schedules']);
  assert.match(html, /class="left-shell">[\s\S]*class="shell-head"/);
  assert.doesNotMatch(html, /id="sidebar-toggle"/);
  assert.match(html, /id="tools-toggle"[^>]*aria-haspopup="menu"/);
});

test('the side panel can be widened by dragging its edge', async () => {
  const [html, main, style] = await Promise.all([read('index.html'), read('src/renderer/main.ts'), read('src/renderer/style.css')]);
  assert.match(html, /id="sidebar-resizer"[^>]*role="separator"/);
  // The width is a variable so a drag is one property write, not a layout rewrite.
  assert.match(style, /\.left-shell\{grid-area:1\/1;display:grid;grid-template-columns:52px var\(--sidebar-width,260px\)/);
  assert.match(style, /\.left-shell\{[^}]*grid-template-rows:56px minmax\(0,1fr\)/);
  assert.match(style, /\.rail\{grid-area:rail;[^}]*border-right:1px solid #2a4258/);
  assert.match(style, /\.sidebar-resizer\{position:absolute;[^}]*cursor:col-resize/);
  assert.match(main, /--sidebar-width/);
  assert.match(main, /localStorage\.setItem\(sidebarWidthKey/, 'the width is remembered');
  assert.match(main, /Math\.max\(200, Math\.min\(560/, 'clamped so it cannot swallow the window');
  assert.match(main, /ArrowRight/, 'keyboard resizing');
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

test('the Right Pane is the Task Monitor behind three controls', async () => {
  const [html, style, main] = await Promise.all([read('index.html'), read('src/renderer/style.css'), read('src/renderer/main.ts')]);
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
  assert.match(style, /\.app\.task-monitor-open\{grid-template-columns:auto minmax\(0,1fr\) 320px\}/);
  assert.match(style, /\.monitor-head\{[^}]*justify-content:flex-end/);
  assert.match(main, /function setTaskMonitor\(open: boolean, focus = false\): void/);
  assert.match(main, /function renderTaskMonitor\(\): void/);
  assert.match(main, /HTMLButtonElement>\('terminal-panel'\)/, 'the terminal toggle reflects the drawer');
});

test('the edge tab mirrors the monitor open state, which survives a restart', async () => {
  const [html, main] = await Promise.all([read('index.html'), read('src/renderer/main.ts')]);
  assert.match(html, /id="terminal-panel"[^>]*aria-label="Terminal panel"/, 'the label names the panel instead of announcing a stale action');
  assert.doesNotMatch(html, /aria-label="Open terminal panel"/, 'a static open label would contradict aria-pressed');
  assert.match(main, /\$\('task-monitor-open'\)\.toggleAttribute\('hidden', open\)/, 'the edge tab hides while the monitor is open');
  assert.match(main, /\$\('task-monitor'\)\.toggleAttribute\('hidden', !open\)/, 'the monitor shows when it is open');
  assert.match(main, /localStorage\.setItem\('moderado-task-monitor', String\(open\)\)/, 'the open state is stored under one key');
  assert.match(main, /localStorage\.getItem\('moderado-task-monitor'\) !== 'false'/, 'and restored on boot, open unless closed');
});

test('the shell degrades without hiding the rail', async () => {
  const [style, theme] = await Promise.all([read('src/renderer/style.css'), read('src/renderer/theme.css')]);
  assert.match(style, /@media\(max-width:1199px\)\{\s*\.app\.task-monitor-open\{grid-template-columns:auto minmax\(0,1fr\)\}/);
  assert.match(style, /\.task-monitor\{position:absolute;right:0;top:0;bottom:0;width:min\(340px,calc\(100vw - 60px\)\)/);
  assert.match(style, /@media\(max-width:999px\)\{\s*\.left-shell\{grid-template-columns:52px 220px\}/);
  assert.match(style, /@media\(max-width:999px\)\{[\s\S]*?\.sidebar-resizer\{display:none\}/);
  assert.match(style, /@media\(max-width:999px\)\{[\s\S]*?\.topbar #workspace-context\{display:none\}/);
  assert.match(style, /@media\(max-width:999px\)\{[\s\S]*?\.topbar \.session-actions\{display:none\}/);
  assert.doesNotMatch(style, /sidebar-collapsed|task-monitor-width/);
  assert.doesNotMatch(style, /@media\(max-width:850px\)/);
  assert.doesNotMatch(style, /@media\(max-width:650px\)/);
  assert.doesNotMatch(theme, /@media\(max-width:650px\)/);
});
