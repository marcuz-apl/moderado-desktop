import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the shell has one left panel, one right monitor, and no activity rail', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /class="activity-bar"|class="activity-button"/, 'the icon rail is gone');
  const tabs = [...html.matchAll(/class="sidebar-tab[^"]*" data-panel="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['library', 'workspace', 'schedules', 'profile']);
  const panels = [...html.matchAll(/data-panel-content="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(panels, ['library', 'workspace', 'preview', 'schedules', 'profile']);
  assert.match(html, /id="sidebar-toggle"[^>]*aria-expanded="true"/);
  assert.match(html, /id="tools-toggle"[^>]*aria-haspopup="menu"/);
  assert.match(html, /<section class="sidebar-panel" data-panel-content="preview">/);
});

test('the side panel can be widened by dragging its edge', async () => {
  const [html, main, style] = await Promise.all([read('index.html'), read('src/renderer/main.ts'), read('src/renderer/style.css')]);
  assert.match(html, /id="sidebar-resizer"[^>]*role="separator"/);
  // The width is a variable so a drag is one property write, not a layout rewrite.
  assert.match(style, /\.app\{grid-template-columns:var\(--sidebar-width,280px\) minmax\(0,1fr\)/);
  assert.match(style, /\.app\.sidebar-collapsed\{grid-template-columns:0 minmax\(0,1fr\)\}/);
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

test('the shell starts when its panel is shown, and only in Code', async () => {
  const [main, lib] = await Promise.all([read('src/renderer/main.ts'), read('src-tauri/src/lib.rs')]);
  assert.match(main, /if \(panel === 'terminal' && activeKind === 'code'\) void ensureTerminal\(\);/);
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

test('selecting a file opens the Preview panel instead of a dialog', async () => {
  const [html, main] = await Promise.all([read('index.html'), read('src/renderer/main.ts')]);
  assert.doesNotMatch(html, /file-preview-dialog/, 'the modal is gone');
  assert.match(main, /switchPanel\('preview'\)/);
  assert.match(main, /pty\.terminal\.options\.theme = terminalTheme\(\)/, 'a theme switch repaints the shell');
});
