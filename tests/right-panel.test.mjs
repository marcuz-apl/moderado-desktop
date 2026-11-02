import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('every view lives in the left rail; nothing floats on the right', async () => {
  const html = await read('index.html');
  const rail = [...html.matchAll(/class="activity-button" data-panel="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rail, ['library', 'workspace', 'preview', 'terminal', 'schedules', 'profile']);
  const panels = [...html.matchAll(/data-panel-content="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(panels, rail, 'each rail icon owns a panel');
  assert.doesNotMatch(html, /class="right-panel"|right-launcher|topbar-icon/, 'no right-hand surface');
  assert.match(html, /<section class="sidebar-panel" data-panel-content="preview">/);
  assert.match(html, /<section class="sidebar-panel" data-panel-content="terminal">/);
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

test('selecting a file opens the Preview panel instead of a dialog', async () => {
  const [html, main] = await Promise.all([read('index.html'), read('src/renderer/main.ts')]);
  assert.doesNotMatch(html, /file-preview-dialog/, 'the modal is gone');
  assert.match(main, /switchPanel\('preview'\)/);
  assert.match(main, /pty\.terminal\.options\.theme = terminalTheme\(\)/, 'a theme switch repaints the shell');
});
