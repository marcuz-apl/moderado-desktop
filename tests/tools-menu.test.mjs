import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_ITEMS, nextMenuIndex, toolDisabledReason } from '../src/renderer/tools-menu.ts';

test('the terminal drawer is Code-only and external launchers need a workspace', () => {
  assert.equal(toolDisabledReason('terminal-panel', { kind: 'work', hasWorkspace: true }), 'Commands run in Code sessions only.');
  assert.equal(toolDisabledReason('terminal-panel', { kind: 'code', hasWorkspace: true }), null);
  assert.equal(toolDisabledReason('vscode', { kind: 'code', hasWorkspace: false }), 'Select a project or task folder first.');
  assert.equal(toolDisabledReason('system-terminal', { kind: 'work', hasWorkspace: false }), 'Select a project or task folder first.');
  assert.equal(toolDisabledReason('vscode', { kind: 'work', hasWorkspace: true }), null);
  assert.equal(toolDisabledReason('file-browser', { kind: 'work', hasWorkspace: false }), 'Select a project or task folder first.');
  assert.equal(toolDisabledReason('file-browser', { kind: 'code', hasWorkspace: true }), null);
});

test('keyboard navigation wraps and handles an empty focus', () => {
  assert.equal(nextMenuIndex(-1, 4, 'ArrowDown'), 0);
  assert.equal(nextMenuIndex(-1, 4, 'ArrowUp'), 3);
  assert.equal(nextMenuIndex(3, 4, 'ArrowDown'), 0);
  assert.equal(nextMenuIndex(0, 4, 'ArrowUp'), 3);
  assert.equal(nextMenuIndex(1, 4, 'Home'), 0);
  assert.equal(nextMenuIndex(1, 4, 'End'), 3);
  assert.equal(nextMenuIndex(0, 0, 'ArrowDown'), -1);
});

test('the Right Pane menu has exactly three actions', () => {
  assert.deepEqual(TOOL_ITEMS.map((item) => item.action), ['file-browser', 'system-terminal', 'vscode']);
  assert.deepEqual(TOOL_ITEMS.map((item) => item.label), ['Open File Browser', 'Open system terminal', 'Open in VS Code']);
});

test('the Open File Browser action launches the OS file manager', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const rust = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(main, /function syncToolMenu\(\): void/);
  assert.match(main, /function runTool\(action: ToolAction\): void/);
  assert.match(main, /if \(action === 'file-browser'\) \{\s*void invoke\('open_file_browser', browserArgs\(\)\)/);
  assert.match(rust, /fn open_file_browser\(/);
  assert.match(rust, /external::open_file_browser\(&root\)/);
});

test('choosing a menu item returns focus to the trigger', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /function runTool\(action: ToolAction\): void \{\s*closeToolsMenu\(true\);/);
});

test('opening the menu moves focus to the first enabled item', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const open = main.slice(main.indexOf('function openToolsMenu()'), main.indexOf('function closeToolsMenu'));
  assert.match(open, /moveToolsFocus\('ArrowDown'\)/, 'arrow keys work without tabbing first');
  // moveToolsFocus returns early on an empty list, so a closed-out menu keeps focus.
  assert.match(main, /const items = menuToolButtons\(\)\.filter\(\(button\) => !button\.disabled\);\s*if \(!items\.length\) return;/);
});

test('the right header renders the three controls and the three-item menu', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="tools-toggle"[^>]*aria-haspopup="menu"/);
  assert.match(html, /id="tools-menu"[^>]*role="menu"/);
  for (const action of ['file-browser', 'system-terminal', 'vscode']) {
    assert.match(html, new RegExp(`data-tool="${action}"`), `missing ${action}`);
  }
  assert.doesNotMatch(html, /data-tool="settings"|data-tool="docs"|data-tool="task-monitor"|data-tool="terminal-panel"/);
  assert.match(html, /id="terminal-panel"[^>]*aria-pressed="false"/);
  assert.match(html, /id="task-monitor-close"[^>]*aria-label="Collapse task monitor"/);
});

test('the menu exposes both external launchers', async () => {
  const { readFile } = await import('node:fs/promises');
  const [html, main] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /data-tool="file-browser">Open File Browser/);
  assert.match(html, /data-tool="vscode">Open in VS Code/);
  assert.match(html, /data-tool="system-terminal">Open system terminal/);
  assert.match(main, /invoke\('open_in_editor', browserArgs\(\)\)/);
  assert.match(main, /invoke\('open_file_browser', browserArgs\(\)\)/);
  assert.match(main, /invoke\('open_system_terminal', browserArgs\(\)\)/);
});
