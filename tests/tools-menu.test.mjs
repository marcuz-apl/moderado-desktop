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
