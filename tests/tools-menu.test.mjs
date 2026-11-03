import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_ITEMS, nextMenuIndex, toolDisabledReason } from '../src/renderer/tools-menu.ts';

test('the terminal drawer is Code-only and external launchers need a workspace', () => {
  assert.equal(toolDisabledReason('terminal-panel', { kind: 'work', hasWorkspace: true }), 'Commands run in Code sessions only.');
  assert.equal(toolDisabledReason('terminal-panel', { kind: 'code', hasWorkspace: true }), null);
  assert.equal(toolDisabledReason('vscode', { kind: 'code', hasWorkspace: false }), 'Select a project or task folder first.');
  assert.equal(toolDisabledReason('system-terminal', { kind: 'work', hasWorkspace: false }), 'Select a project or task folder first.');
  assert.equal(toolDisabledReason('vscode', { kind: 'work', hasWorkspace: true }), null);
  assert.equal(toolDisabledReason('files', { kind: 'work', hasWorkspace: false }), null);
  assert.equal(toolDisabledReason('task-monitor', { kind: 'work', hasWorkspace: false }), null);
  assert.equal(toolDisabledReason('settings', { kind: 'work', hasWorkspace: false }), null);
  assert.equal(toolDisabledReason('docs', { kind: 'work', hasWorkspace: false }), null);
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

test('the tools menu is wired to panel and page actions', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /function syncToolMenu\(\): void/);
  assert.match(main, /function runTool\(action: ToolAction\): void/);
  assert.match(main, /if \(action === 'files'\) \{ switchPanel\('workspace'\); switchWorkspaceView\('explorer'\); return; \}/);
});

test('the top-right menu renders the panel and app actions from the model', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="tools-toggle"[^>]*aria-haspopup="menu"/);
  assert.match(html, /id="tools-menu"[^>]*role="menu"/);
  for (const action of ['files', 'terminal-panel', 'settings', 'docs']) {
    assert.match(html, new RegExp(`data-tool="${action}"`), `missing ${action}`);
  }
  assert.match(html, /role="menuitemcheckbox" data-tool="terminal-panel" aria-checked="false"/);
});

test('the menu exposes both external launchers', async () => {
  const { readFile } = await import('node:fs/promises');
  const [html, main] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /data-tool="vscode">Open in VS Code/);
  assert.match(html, /data-tool="system-terminal">Open system terminal/);
  assert.match(main, /invoke\('open_in_editor', browserArgs\(\)\)/);
  assert.match(main, /invoke\('open_system_terminal', browserArgs\(\)\)/);
});

test('the menu keeps one stable order', () => {
  assert.deepEqual(TOOL_ITEMS.map((item) => item.action), [
    'files', 'task-monitor', 'terminal-panel',
    'vscode', 'system-terminal',
    'settings', 'docs',
  ]);
  assert.deepEqual(TOOL_ITEMS.map((item) => item.group), [
    'panels', 'panels', 'panels',
    'open-in', 'open-in',
    'app', 'app',
  ]);
  assert.deepEqual(TOOL_ITEMS.filter((item) => item.checkbox).map((item) => item.action), ['task-monitor', 'terminal-panel']);
});
