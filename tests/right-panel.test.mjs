import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the left rail keeps the workspace views; the right panel holds only preview and terminal', async () => {
  const html = await read('index.html');
  const rail = [...html.matchAll(/class="activity-button" data-panel="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rail, ['library', 'workspace', 'schedules', 'profile']);
  assert.match(html, /data-panel-content="workspace"/, 'files, changes and checkpoints stay on the left');

  const panel = html.slice(html.indexOf('class="right-panel"'), html.indexOf('</aside>', html.indexOf('class="right-panel"')));
  const views = [...panel.matchAll(/data-right-view="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(views, ['preview', 'terminal'], 'no duplicated context views');
  const tabs = [...panel.matchAll(/data-right-tab="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['preview', 'terminal']);
});

test('the terminal is a real PTY, not a command runner', async () => {
  const [html, main, lib, terminal] = await Promise.all([
    read('index.html'), read('src/renderer/main.ts'), read('src-tauri/src/lib.rs'), read('src-tauri/src/terminal.rs'),
  ]);
  // The UI mounts an emulator instead of a one-shot input.
  assert.match(html, /id="terminal-host"/);
  assert.doesNotMatch(html, /id="terminal-input"|id="terminal-run"/, 'the command executor is gone');
  assert.match(main, /new Terminal\(/);
  assert.match(main, /from '@xterm\/addon-fit'/);
  assert.match(main, /invoke\('terminal_write'/);
  // The backend runs a shell on a PTY and streams it.
  assert.match(terminal, /native_pty_system\(\)/);
  assert.match(terminal, /spawn_command/);
  assert.match(terminal, /"terminal-output"/);
  assert.match(lib, /fn terminal_open\(/);
  assert.match(lib, /fn terminal_resize\(/);
  assert.doesNotMatch(lib, /fn run_command\(/, 'the sandboxed one-shot runner is gone');
});

test('the shell is Code-only, like every other command path', async () => {
  const [main, lib] = await Promise.all([read('src/renderer/main.ts'), read('src-tauri/src/lib.rs')]);
  assert.match(main, /Commands run in Code sessions only/);
  // terminal_open resolves through the same Code-only workspace guard.
  const body = lib.slice(lib.indexOf('fn terminal_open('), lib.indexOf('fn terminal_write('));
  assert.match(body, /code_workspace\(&state/);
});

test('the terminal colours follow the theme', async () => {
  const main = await read('src/renderer/main.ts');
  assert.match(main, /function terminalTheme\(\)/);
  assert.match(main, /pty\.terminal\.options\.theme = terminalTheme\(\)/, 'a theme switch repaints the shell');
});
