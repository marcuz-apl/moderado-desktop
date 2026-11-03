# Qoder-style Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the activity-bar shell with a Qoder-style workbench: one left panel, a top-right Tools menu, a right Task Monitor, and a terminal drawer below the composer.

**Architecture:** The existing `switchPanel()` state machine stays. The 52 px activity rail is deleted and its destinations become tabs at the top of the left panel plus entries in a top-right popover. The xterm host moves from the left panel into `.main` after the composer. A new right `<aside>` renders Updates, Background processes, and Artifacts from data the app already has: session history, checkpoints, schedules, and the in-memory running-turn map. External editor and terminal launch is a small Rust module with fixed executable candidates and no shell.

**Tech Stack:** Tauri 2, Rust, TypeScript (no UI framework), xterm.js, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-03-qoder-style-shell.md`

## Global Constraints

- Do not add a dependency. UI uses the existing DOM APIs; external launch uses `std::process`.
- Do not add a database table or migration. The Task Monitor is derived state.
- All tests run offline. No test may spawn an editor or a terminal.
- The terminal drawer is Code-only. External launch may target any resolved workspace.
- The workspace jail, approval gate, keychain rules, and provider contracts are unchanged.
- External launch accepts no program name from the webview. Candidates are fixed in Rust.
- Keep the existing localStorage keys for navigation and sidebar width. Add only the two keys in the spec.
- Follow the existing test style: Node tests import pure TypeScript modules directly, or read source files as strings.
- Before the first `feat:` commit run `npm run version:patch`; later commits in the branch only advance the build counter.
- This plan does not fix the audit findings (checkpoint `"."`, UTF-8 stall, symlink checkpoints, and so on). Task 0 only restores a green baseline so every task can verify itself.

---

## File Map

| File | Responsibility |
| --- | --- |
| `src/renderer/tools-menu.ts` (new) | Pure menu action model, enablement rules, keyboard index math |
| `src/renderer/task-monitor.ts` (new) | Pure derivation of updates, artifacts, and background rows |
| `src/renderer/sessions-view.ts` | Remove `terminal` from `SidebarPanel` |
| `src/renderer/main.ts` | Shell wiring, menu, monitor, terminal drawer, running-state labels |
| `src/renderer/style.css` | New grid, left tabs, popover, monitor, drawer, responsive rules |
| `index.html` | Remove activity bar and terminal sidebar panel; add tabs, menu, monitor, drawer |
| `src-tauri/src/external.rs` (new) | Editor and terminal candidate lists plus detached launch |
| `src-tauri/src/lib.rs` | `mod external`, two commands, handler registration |
| `tests/tools-menu.test.mjs` (new) | Menu model tests |
| `tests/task-monitor.test.mjs` (new) | Monitor derivation tests |
| `tests/right-panel.test.mjs` | Rewrite from "nothing on the right" to the new shell |
| `tests/pages.test.mjs` | Settings/Docs now live in the Tools menu |
| `tests/session-kind.test.mjs` | Left tabs replace the shared rail |
| `docs/sidebar-design.md` | Record the revision so the design doc no longer contradicts the app |

---

### Task 0: Restore a green baseline

The working tree contains the terminal-key fix plus a test that fails only because a doc comment contains the word `activeSessionId`. Fix the assertion before touching the shell.

**Files:**
- Modify: `tests/right-panel.test.mjs:57-61`

**Interfaces:**
- Consumes: nothing.
- Produces: a green `npm test` baseline.

- [ ] **Step 1: Reproduce the failure**

Run: `node --test tests/right-panel.test.mjs`
Expected: FAIL with `the key must mirror what browserArgs sends`.

- [ ] **Step 2: Strip comments before asserting on the code**

Replace the current `assert.doesNotMatch(keyFn, ...)` call with:

```js
  const keyCode = keyFn
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(keyCode, /activeSessionId/, 'the key must mirror what browserArgs sends');
```

Keep the existing `assert.match(keyFn, /browserArgs\(\)/)` line unchanged. The comment is accurate; the assertion should test code, not prose.

- [ ] **Step 3: Run the test file**

Run: `node --test tests/right-panel.test.mjs`
Expected: all tests pass.

- [ ] **Step 4: Commit the terminal-key fix**

```bash
git add src-tauri/src/lib.rs src-tauri/src/terminal.rs src/renderer/main.ts tests/right-panel.test.mjs
git commit -m "fix: key the terminal by the id the backend created"
```

---

### Task 1: Menu action model

Create the pure module that both the markup and the keyboard handler use, so enablement rules are tested without a DOM.

**Files:**
- Create: `src/renderer/tools-menu.ts`
- Test: `tests/tools-menu.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `ToolAction`, `ToolContext`, `ToolItem`, `TOOL_ITEMS`, `toolDisabledReason(action, context)`, `nextMenuIndex(current, count, key)`.

- [ ] **Step 1: Write the failing test**

Create `tests/tools-menu.test.mjs`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/tools-menu.test.mjs`
Expected: FAIL because `tools-menu.ts` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/renderer/tools-menu.ts`:

```ts
export type ToolAction =
  | 'files'
  | 'task-monitor'
  | 'terminal-panel'
  | 'vscode'
  | 'system-terminal'
  | 'settings'
  | 'docs';

export type ToolGroup = 'panels' | 'open-in' | 'app';
export type ToolContext = { kind: 'work' | 'code'; hasWorkspace: boolean };
export type ToolItem = { action: ToolAction; label: string; group: ToolGroup; checkbox: boolean };

export const TOOL_ITEMS: readonly ToolItem[] = [
  { action: 'files', label: 'File browser', group: 'panels', checkbox: false },
  { action: 'task-monitor', label: 'Task monitor', group: 'panels', checkbox: true },
  { action: 'terminal-panel', label: 'Terminal panel', group: 'panels', checkbox: true },
  { action: 'vscode', label: 'Open in VS Code', group: 'open-in', checkbox: false },
  { action: 'system-terminal', label: 'Open system terminal', group: 'open-in', checkbox: false },
  { action: 'settings', label: 'Settings', group: 'app', checkbox: false },
  { action: 'docs', label: 'Docs', group: 'app', checkbox: false },
];

/** A disabled item still renders; the reason becomes its tooltip. */
export function toolDisabledReason(action: ToolAction, context: ToolContext): string | null {
  if (action === 'terminal-panel' && context.kind !== 'code') {
    return 'Commands run in Code sessions only.';
  }
  if ((action === 'vscode' || action === 'system-terminal') && !context.hasWorkspace) {
    return 'Select a project or task folder first.';
  }
  return null;
}

/** Roving focus for the popover: Home/End, arrows, and wraparound. */
export function nextMenuIndex(
  current: number,
  count: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (current < 0 || current >= count) return key === 'ArrowDown' ? 0 : count - 1;
  return key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count;
}
```

- [ ] **Step 4: Run the test**

Run: `node --test tests/tools-menu.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/tools-menu.ts tests/tools-menu.test.mjs
git commit -m "feat: model the tools menu actions"
```

---

### Task 2: Task Monitor derivation

Create the pure module that turns existing activity, checkpoints, and schedules into the three monitor sections. No DOM and no backend changes.

**Files:**
- Create: `src/renderer/task-monitor.ts`
- Test: `tests/task-monitor.test.mjs`

**Interfaces:**
- Consumes: structurally typed activity rows shaped like the renderer's `DisplayMessage`: `{ role, toolId?, toolName?, content, createdAt? }`.
- Produces: `toolTitle`, `shortText`, `elapsedLabel`, `updatesFromActivity`, `checkpointUpdates`, `mergeUpdates`, `artifactsFromActivity`, `artifactsFromTool`, `backgroundRows`, and the `Monitor*` types.

- [ ] **Step 1: Write the failing test**

Create `tests/task-monitor.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artifactsFromActivity,
  artifactsFromTool,
  backgroundRows,
  checkpointUpdates,
  elapsedLabel,
  mergeUpdates,
  shortText,
  toolTitle,
  updatesFromActivity,
} from '../src/renderer/task-monitor.ts';

const activity = (toolName, content, extra = {}) => ({
  role: 'Activity', toolName, content, toolId: `${toolName}-1`, createdAt: 1_000, ...extra,
});

test('tool titles stay human and short text is one line', () => {
  assert.equal(toolTitle('write_file'), 'Created a file');
  assert.equal(toolTitle('execute_command'), 'Ran a command');
  assert.equal(toolTitle(undefined), 'Tool activity');
  assert.equal(shortText('one\n two   three'), 'one');
  assert.equal(shortText('x'.repeat(20), 10), 'xxxxxxxxx…');
});

test('updates keep tool failures and hide read payloads', () => {
  const updates = updatesFromActivity([
    activity('read_file', '# source code that must not leak into the feed'),
    activity('write_file', 'Wrote src/main.ts'),
    activity('execute_command', JSON.stringify({ exitCode: 0, changedFiles: [] })),
    activity('search_files', 'Error: no match'),
  ], 5_000);
  assert.deepEqual(updates.map((item) => item.label), [
    'Searched files', 'Ran a command', 'Created a file', 'Read a file',
  ]);
  assert.equal(updates.find((item) => item.label === 'Searched files')?.kind, 'error');
  assert.equal(updates.find((item) => item.label === 'Read a file')?.detail, '');
  assert.equal(updates.find((item) => item.label === 'Created a file')?.detail, 'Wrote src/main.ts');
  assert.equal(updates.find((item) => item.label === 'Ran a command')?.detail, 'Exit 0');
});

test('checkpoints merge newest first and ids are deduplicated', () => {
  const checkpoints = checkpointUpdates([
    { id: 'b', path: 'src/b.ts', createdAt: 20 },
    { id: 'a', path: 'src/a.ts', createdAt: 10 },
  ]);
  assert.deepEqual(checkpoints.map((item) => item.detail), ['src/b.ts', 'src/a.ts']);
  const merged = mergeUpdates([
    updatesFromActivity([activity('write_file', 'Wrote x.ts')], 1_000),
    checkpoints,
    checkpoints,
  ]);
  assert.equal(merged.filter((item) => item.id === 'checkpoint:b').length, 1);
  assert.equal(merged[0]?.id, 'checkpoint:b');
  assert.equal(mergeUpdates([checkpoints[0]], 0).length, 0);
});

test('artifacts come from write, edit, and command results only', () => {
  assert.deepEqual(artifactsFromTool('write_file', 'Wrote src/a.ts', 10), [
    { path: 'src/a.ts', action: 'created', at: 10 },
  ]);
  assert.deepEqual(artifactsFromTool('edit_file', 'Edited src/a.ts with user-edited content', 20), [
    { path: 'src/a.ts', action: 'updated', at: 20 },
  ]);
  assert.deepEqual(artifactsFromTool('execute_command', JSON.stringify({ exitCode: 0, changedFiles: ['out/a.js', 'out/b.js'] }), 30), [
    { path: 'out/a.js', action: 'changed', at: 30 },
    { path: 'out/b.js', action: 'changed', at: 30 },
  ]);
  assert.deepEqual(artifactsFromTool('read_file', 'Wrote nothing', 40), []);
  assert.deepEqual(artifactsFromTool('write_file', 'Error: denied', 40), []);
  assert.deepEqual(artifactsFromTool('execute_command', 'not json', 40), []);
});

test('the latest action wins for a path and the list is newest first', () => {
  const artifacts = artifactsFromActivity([
    activity('write_file', 'Wrote src/a.ts', { createdAt: 10 }),
    activity('edit_file', 'Edited src/a.ts', { createdAt: 20 }),
    activity('write_file', 'Wrote src/b.ts', { createdAt: 15 }),
  ], 99);
  assert.deepEqual(artifacts, [
    { path: 'src/a.ts', action: 'updated', at: 20 },
    { path: 'src/b.ts', action: 'created', at: 15 },
  ]);
});

test('background rows combine the active turn and schedules without duplicates', () => {
  const run = { label: 'Scheduled: nightly', startedAt: 1_000, scheduled: true, scheduleId: 's1' };
  const schedules = [
    { id: 's1', prompt: 'nightly', inFlight: true, enabled: true, nextRunAt: 2_000, intervalSeconds: 60, lastError: null },
    { id: 's2', prompt: 'weekly', inFlight: false, enabled: true, nextRunAt: 130_000, intervalSeconds: 300, lastError: null },
    { id: 's3', prompt: 'paused', inFlight: false, enabled: false, nextRunAt: 0, intervalSeconds: null, lastError: 'boom' },
  ];
  const rows = backgroundRows(run, schedules, 61_000);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.state, 'running');
  assert.equal(rows[0]?.label, 'Scheduled: nightly');
  assert.ok(rows[0]?.detail.includes('1m'));
  assert.equal(rows[1]?.label, 'Scheduled: weekly');
  assert.equal(rows[1]?.detail, 'Next in 1m');
  assert.equal(rows[2]?.detail, 'Paused: boom');
  assert.deepEqual(backgroundRows(undefined, [], 0), []);
});

test('elapsed labels stay readable', () => {
  assert.equal(elapsedLabel(1_000, 1_000), '0s');
  assert.equal(elapsedLabel(1_000, 61_000), '1m');
  assert.equal(elapsedLabel(1_000, 3_661_000), '1h 1m');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/task-monitor.test.mjs`
Expected: FAIL because `task-monitor.ts` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/renderer/task-monitor.ts`:

```ts
export type MonitorActivity = {
  role: string;
  toolId?: string;
  toolName?: string;
  content: string;
  createdAt?: number;
};

export type MonitorUpdate = {
  id: string;
  at: number;
  kind: 'tool' | 'error' | 'checkpoint';
  label: string;
  detail: string;
};

export type MonitorArtifact = {
  path: string;
  action: 'created' | 'updated' | 'changed';
  at: number;
};

export type MonitorCheckpoint = { id: string; path: string; createdAt: number };
export type MonitorSchedule = {
  id: string;
  prompt: string;
  inFlight: boolean;
  enabled: boolean;
  nextRunAt: number;
  intervalSeconds: number | null;
  lastError: string | null;
};
export type MonitorRun = {
  label: string;
  startedAt: number;
  scheduled: boolean;
  scheduleId?: string;
};
export type MonitorProcess = {
  id: string;
  label: string;
  state: 'running' | 'scheduled';
  detail: string;
  startedAt?: number;
};

const TOOL_TITLES: Record<string, string> = {
  list_files: 'Browsed files',
  read_file: 'Read a file',
  search_files: 'Searched files',
  write_file: 'Created a file',
  edit_file: 'Edited a file',
  execute_command: 'Ran a command',
  web_search: 'Searched the web',
  git_diff: 'Showed the Git diff',
  find_references: 'Found references',
  get_definition: 'Found a definition',
};

export function toolTitle(name?: string): string {
  return name ? TOOL_TITLES[name] ?? name.replaceAll('_', ' ') : 'Tool activity';
}

export function shortText(value: string, limit = 120): string {
  const line = value.split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function elapsedLabel(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function toolDetail(name: string, content: string): string {
  if (name === 'write_file' || name === 'edit_file') return shortText(content);
  if (name === 'execute_command') {
    try {
      const parsed = JSON.parse(content) as { exitCode?: unknown };
      return typeof parsed.exitCode === 'number' ? `Exit ${parsed.exitCode}` : 'Completed';
    } catch {
      return '';
    }
  }
  return '';
}

export function updatesFromActivity(
  activities: readonly MonitorActivity[],
  now: number,
): MonitorUpdate[] {
  return activities
    .flatMap((activity, index) => {
      if (activity.role !== 'Activity' || !activity.toolName) return [];
      const failed = activity.content.startsWith('Error:');
      return [{
        id: `tool:${activity.toolId ?? index}`,
        at: activity.createdAt ?? now,
        kind: failed ? 'error' as const : 'tool' as const,
        label: toolTitle(activity.toolName),
        detail: failed ? shortText(activity.content) : toolDetail(activity.toolName, activity.content),
      }];
    })
    .sort((left, right) => right.at - left.at);
}

export function checkpointUpdates(checkpoints: readonly MonitorCheckpoint[]): MonitorUpdate[] {
  return checkpoints
    .map((checkpoint) => ({
      id: `checkpoint:${checkpoint.id}`,
      at: checkpoint.createdAt * 1000,
      kind: 'checkpoint' as const,
      label: 'Checkpoint',
      detail: checkpoint.path,
    }))
    .sort((left, right) => right.at - left.at);
}

export function mergeUpdates(groups: readonly MonitorUpdate[][], limit = 100): MonitorUpdate[] {
  const seen = new Set<string>();
  const merged: MonitorUpdate[] = [];
  for (const group of groups) {
    for (const update of group) {
      if (seen.has(update.id)) continue;
      seen.add(update.id);
      merged.push(update);
    }
  }
  return merged.sort((left, right) => right.at - left.at).slice(0, limit);
}

export function artifactsFromTool(name: string, content: string, at: number): MonitorArtifact[] {
  if (content.startsWith('Error:')) return [];
  if (name === 'write_file' || name === 'edit_file') {
    const prefix = name === 'write_file' ? 'Wrote ' : 'Edited ';
    if (!content.startsWith(prefix)) return [];
    const path = content.slice(prefix.length).replace(/ with user-edited content$/, '').trim();
    return path ? [{ path, action: name === 'write_file' ? 'created' : 'updated', at }] : [];
  }
  if (name === 'execute_command') {
    try {
      const parsed = JSON.parse(content) as { changedFiles?: unknown };
      if (!Array.isArray(parsed.changedFiles)) return [];
      return parsed.changedFiles
        .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
        .map((path) => ({ path, action: 'changed' as const, at }));
    } catch {
      return [];
    }
  }
  return [];
}

export function artifactsFromActivity(
  activities: readonly MonitorActivity[],
  now: number,
): MonitorArtifact[] {
  const byPath = new Map<string, MonitorArtifact>();
  for (const activity of activities) {
    if (activity.role !== 'Activity' || !activity.toolName) continue;
    const at = activity.createdAt ?? now;
    for (const artifact of artifactsFromTool(activity.toolName, activity.content, at)) {
      const previous = byPath.get(artifact.path);
      if (!previous || previous.at <= artifact.at) byPath.set(artifact.path, artifact);
    }
  }
  return [...byPath.values()].sort((left, right) => right.at - left.at);
}

export function backgroundRows(
  run: MonitorRun | undefined,
  schedules: readonly MonitorSchedule[],
  now: number,
): MonitorProcess[] {
  const rows: MonitorProcess[] = [];
  if (run) {
    rows.push({
      id: 'active-run',
      label: run.label,
      state: 'running',
      detail: `${run.scheduled ? 'Scheduled' : 'Active'} · ${elapsedLabel(run.startedAt, now)}`,
      startedAt: run.startedAt,
    });
  }
  for (const schedule of schedules) {
    if (run?.scheduled && run.scheduleId === schedule.id) continue;
    const minutes = Math.max(0, Math.round((schedule.nextRunAt * 1000 - now) / 60_000));
    const detail = schedule.inFlight
      ? 'Running now'
      : schedule.enabled
        ? minutes < 1 ? 'Next in <1m' : `Next in ${minutes}m`
        : schedule.lastError
          ? `Paused: ${shortText(schedule.lastError, 60)}`
          : 'Completed';
    rows.push({
      id: `schedule:${schedule.id}`,
      label: `Scheduled: ${shortText(schedule.prompt, 60)}`,
      state: schedule.inFlight ? 'running' : 'scheduled',
      detail,
    });
  }
  return rows.sort((left, right) => {
    if (left.state === right.state) return 0;
    return left.state === 'running' ? -1 : 1;
  });
}
```

- [ ] **Step 4: Run the test**

Run: `node --test tests/task-monitor.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/task-monitor.ts tests/task-monitor.test.mjs
git commit -m "feat: derive task monitor updates, artifacts, and processes"
```

---

### Task 3: Shell restructure, terminal drawer, and Tools menu

This is the core shell change. It has three sub-deliverables, each with its own failing test and commit: remove the rail, move the terminal, add the menu.

**Files:**
- Modify: `index.html`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/sessions-view.ts`
- Modify: `tests/right-panel.test.mjs`
- Modify: `tests/pages.test.mjs`
- Modify: `tests/session-kind.test.mjs`

**Interfaces:**
- Consumes: `ToolAction`, `toolDisabledReason`, `nextMenuIndex` from Task 1.
- Produces: `.sidebar-tab` navigation, `setSidebarCollapsed(collapsed)`, `setTerminalOpen(open)`, `termminalOpen` module state, `runTool(action)`, `syncToolMenu()`.

#### 3A: Remove the activity bar

- [ ] **Step 1: Rewrite the layout test first**

In `tests/right-panel.test.mjs`, replace the first test and the grid assertion in the resizer test with:

```js
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
```

In the resizer test, replace the old `52px` grid assertion with:

```js
  assert.match(style, /\.app\{grid-template-columns:var\(--sidebar-width,280px\) minmax\(0,1fr\)/);
  assert.match(style, /\.app\.sidebar-collapsed\{grid-template-columns:0 minmax\(0,1fr\)\}/);
```

In `tests/pages.test.mjs`, replace `the rail names the page Docs` with:

```js
test('the Tools menu names the Docs and Settings pages', async () => {
  const html = await readHtml();
  assert.match(html, /id="tools-menu"[\s\S]*data-tool="docs"/);
  assert.match(html, /id="tools-menu"[\s\S]*data-tool="settings"/);
  assert.match(html, /<h1>Docs<\/h1>/);
  assert.match(html, /<h1>Settings<\/h1>/);
});
```

Replace the page-mode grid assertion with:

```js
  assert.match(style, /\.app\.page-mode\{grid-template-columns:minmax\(0,1fr\)\}/);
```

In `tests/session-kind.test.mjs`, replace `both modes share one activity rail` with:

```js
test('both modes share one left panel', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const tabs = [...html.matchAll(/class="sidebar-tab[^"]*" data-panel="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['library', 'workspace', 'schedules', 'profile']);
  assert.doesNotMatch(html, /class="activity-bar"|class="activity-button"/);
  assert.doesNotMatch(html, /data-panel="explorer"|data-panel="checkpoints"|data-panel="source-control"/);
  assert.doesNotMatch(html, /data-panel="tasks"|data-panel="projects"/);
  assert.doesNotMatch(html, /data-panel-content="settings"/, 'settings no longer lives in the sidebar');
  assert.match(html, /data-panel-content="library"><header class="panel-heading"><h2 id="library-title">/);
});
```

Also update the earlier session-kind test that asserts `data-panel="workspace"...icon-folder` and `data-panel="library"...icon-projects`; remove those two `assert.match` lines. The tabs are now text buttons.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/right-panel.test.mjs tests/pages.test.mjs tests/session-kind.test.mjs`
Expected: failures for the missing sidebar tabs, missing menu, and the old grid.

- [ ] **Step 3: Replace the activity rail markup**

In `index.html`, delete the entire `<nav class="activity-bar" aria-label="Workbench views"> ... </nav>` block (lines 30-40). Do not touch the `<svg class="icon-sprite">` block; add two symbols next to the existing ones:

```html
        <symbol id="icon-panel" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></symbol>
        <symbol id="icon-tools" viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></symbol>
```

Immediately inside `<aside class="sidebar">`, before the `library` section, insert:

```html
        <nav class="sidebar-tabs" role="tablist" aria-label="Side panel views">
          <button class="sidebar-tab selected" data-panel="library" type="button" role="tab" aria-selected="true">Sessions</button>
          <button class="sidebar-tab" data-panel="workspace" type="button" role="tab" aria-selected="false">Files</button>
          <button class="sidebar-tab" data-panel="schedules" type="button" role="tab" aria-selected="false">Schedules</button>
          <button class="sidebar-tab" data-panel="profile" type="button" role="tab" aria-selected="false">Profile</button>
        </nav>
```

Add a back action to the Preview heading:

```html
<section class="sidebar-panel" data-panel-content="preview"><header class="panel-heading"><div><h2 id="file-preview-title">Preview</h2><p id="file-preview-path" class="path"></p></div><button id="preview-back" class="text-button" type="button">Back to files</button></header><div class="panel-body"><pre id="file-preview-content" class="file-preview-content">Select a file in Files to preview it here.</pre></div></section>
```

- [ ] **Step 4: Replace the topbar with the sidebar toggle and menu shell**

Replace the one-line topbar block with:

```html
        <header class="topbar">
          <div class="topbar-lead">
            <button id="sidebar-toggle" class="topbar-toggle" type="button" aria-label="Close side panel" aria-expanded="true" title="Toggle side panel">
              <svg aria-hidden="true"><use href="#icon-panel"/></svg>
            </button>
            <div class="topbar-title">
              <div class="kind-stack"><div class="kind-segment" role="group" aria-label="Work or Code mode"><button id="kind-work" type="button" class="selected" aria-pressed="true">Work</button><button id="kind-code" type="button" aria-pressed="false">Code</button></div><p class="eyebrow">AGENT SESSION</p><h1 id="session-title">Workspace conversation</h1></div>
              <p id="workspace-context" class="path">Managed task folder</p>
              <div class="session-actions"><button id="new-session" type="button" hidden>New Session</button><button id="rename-session" type="button">Rename</button><button id="delete-session" type="button">Delete</button></div>
            </div>
          </div>
          <div class="topbar-controls">
            <div class="tools-wrap">
              <button id="tools-toggle" class="topbar-toggle" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="tools-menu" aria-label="Tools" title="Tools"><svg aria-hidden="true"><use href="#icon-tools"/></svg></button>
              <div id="tools-menu" class="tools-menu" role="menu" aria-label="Tools" hidden>
                <p class="menu-label" role="presentation">Panels</p>
                <button type="button" role="menuitem" data-tool="files">File browser</button>
                <button type="button" role="menuitemcheckbox" data-tool="terminal-panel" aria-checked="false">Terminal panel</button>
                <p class="menu-label" role="presentation">App</p>
                <button type="button" role="menuitem" data-tool="settings">Settings</button>
                <button type="button" role="menuitem" data-tool="docs">Docs</button>
              </div>
            </div>
            <div class="mode-control" role="group" aria-label="Agent mode"><button id="plan-mode" type="button" aria-pressed="false">Plan</button><button id="act-mode" class="selected" type="button" aria-pressed="true">Act</button></div>
            <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Switch to dark theme" title="Light, follows local time — switch to dark"><svg class="theme-sun" aria-hidden="true"><use href="#icon-sun"/></svg><svg class="theme-moon" aria-hidden="true"><use href="#icon-moon"/></svg></button>
          </div>
        </header>
```

- [ ] **Step 5: Replace the shell CSS**

In `src/renderer/style.css`, delete the `.activity-bar`, `.activity-group`, and `.activity-button` rules from the workbench block. Replace the grid rules with:

```css
.app{grid-template-columns:var(--sidebar-width,280px) minmax(0,1fr);min-width:760px;position:relative}
.app.sidebar-collapsed{grid-template-columns:0 minmax(0,1fr)}
.sidebar-tabs{display:flex;flex:none;gap:2px;padding:8px 10px;border-bottom:1px solid #2a4258}
.sidebar-tab{flex:1;min-width:0;padding:6px 4px;border:0;border-radius:6px;background:transparent;color:#8ea8b7;font:600 11px "Segoe UI",sans-serif;cursor:pointer}
.sidebar-tab:hover{background:#1d354b;color:#e5f3f7}
.sidebar-tab.selected{background:#1d354b;color:#e5f3f7;box-shadow:inset 0 -2px #65cbbd}
```

Update the two media queries:

```css
@media(max-width:850px){.app{grid-template-columns:var(--sidebar-width,240px) minmax(0,1fr)}.app.sidebar-collapsed{grid-template-columns:0 minmax(0,1fr)}.sidebar{padding:0}}
@media(max-width:650px){.app{display:grid;grid-template-columns:minmax(0,1fr);height:100vh;min-width:0}.app.sidebar-collapsed{grid-template-columns:minmax(0,1fr)}.sidebar{position:absolute;z-index:5;left:0;top:0;bottom:0;width:min(280px,calc(100vw - 24px));box-shadow:12px 0 28px #0006}.main{grid-column:1;grid-row:1;min-height:0}}
```

Keep `.app.sidebar-collapsed .sidebar{visibility:hidden;pointer-events:none}`. In page mode, use:

```css
.app.page-mode{grid-template-columns:minmax(0,1fr)}
```

- [ ] **Step 6: Update the panel state and remove the rail handlers**

In `src/renderer/sessions-view.ts`, remove `'terminal'` from `SidebarPanel`:

```ts
export type SidebarPanel = 'library' | 'workspace' | 'preview' | 'schedules' | 'profile';
```

In `src/renderer/main.ts`, replace the activity-button selection in `switchPanel` with sidebar tabs:

```ts
function switchPanel(panel: SidebarPanel): void {
  setPageMode(null);
  activePanel = panel;
  setSidebarCollapsed(false);
  const selectedPanel = panel === 'preview' ? 'workspace' : panel;
  document.querySelectorAll<HTMLButtonElement>('.sidebar-tab').forEach((button) => {
    const selected = button.dataset.panel === selectedPanel;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll<HTMLElement>('.sidebar-panel').forEach((section) => {
    section.classList.toggle('active', section.dataset.panelContent === panel);
  });
  if (panel === 'workspace') applyWorkspaceView();
}
```

Replace `closePanel()` with:

```ts
function setSidebarCollapsed(collapsed: boolean): void {
  document.querySelector<HTMLElement>('.app')?.classList.toggle('sidebar-collapsed', collapsed);
  const toggle = $('sidebar-toggle');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? 'Open side panel' : 'Close side panel');
  try { localStorage.setItem('moderado-sidebar-collapsed', String(collapsed)); } catch { /* applies for this run */ }
}
```

Delete the block that appends a `◀` button to every `.panel-heading` (the `document.querySelectorAll<HTMLElement>('.panel-heading').forEach(...)` block near the turn listener). Replace the rail click handler with:

```ts
document.querySelectorAll<HTMLButtonElement>('.sidebar-tab').forEach((button) => {
  button.addEventListener('click', () => switchPanel(button.dataset.panel as SidebarPanel));
});
$('sidebar-toggle').addEventListener('click', () => {
  const collapsed = document.querySelector<HTMLElement>('.app')?.classList.contains('sidebar-collapsed') ?? false;
  setSidebarCollapsed(!collapsed);
});
$('preview-back').addEventListener('click', () => { switchPanel('workspace'); switchWorkspaceView('explorer'); });
```

In `setPageMode`, delete the `.activity-button` selection loop. Keep the page class toggles and the sidebar-panel clearing.

At startup, after the panel setup that currently calls `switchPanel(defaultPanel())`, add:

```ts
if (localStorage.getItem('moderado-sidebar-collapsed') === 'true') setSidebarCollapsed(true);
```

- [ ] **Step 7: Run the layout tests**

Run: `node --test tests/right-panel.test.mjs tests/pages.test.mjs tests/session-kind.test.mjs tests/tools-menu.test.mjs`
Expected: all pass except the terminal-drawer and menu assertions that Tasks 3B and 3C add. If the layout tests pass, commit:

```bash
npm run version:patch
git add index.html src/renderer/style.css src/renderer/main.ts src/renderer/sessions-view.ts tests/right-panel.test.mjs tests/pages.test.mjs tests/session-kind.test.mjs
git commit -m "feat: replace the activity rail with a single left panel"
```

#### 3B: Move the terminal into a drawer below the composer

- [ ] **Step 1: Write the failing drawer test**

In `tests/right-panel.test.mjs`, replace the test named `the shell starts when its panel is shown, and only in Code` with:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/right-panel.test.mjs`
Expected: FAIL because the drawer does not exist.

- [ ] **Step 3: Move the terminal markup**

Delete the `<section class="sidebar-panel" data-panel-content="terminal"> ... </section>` block from `index.html`. Insert this after the closing `</div>` of `.composer-wrap` and before `</main>`:

```html
        <section id="terminal-drawer" class="terminal-drawer" aria-label="Terminal" hidden>
          <header class="terminal-head">
            <div><h2>Terminal</h2><p id="terminal-note" class="hint">A real shell in the project folder. It runs as you, outside the agent sandbox.</p></div>
            <button id="terminal-close" class="icon-action" type="button" aria-label="Close terminal" title="Close terminal">×</button>
          </header>
          <div id="terminal-host" class="terminal-host"></div>
        </section>
```

- [ ] **Step 4: Add the drawer state and toggle**

In `src/renderer/main.ts`, next to the `pty` state, add:

```ts
let terminalOpen = false;
```

Add:

```ts
async function setTerminalOpen(open: boolean): Promise<void> {
  if (open && activeKind !== 'code') { setStatus('Commands run in Code sessions only.'); return; }
  terminalOpen = open;
  $('terminal-drawer').toggleAttribute('hidden', !open);
  syncToolMenu();
  if (!open) return;
  await ensureTerminal();
  requestAnimationFrame(() => { fitTerminal(); pty?.terminal.focus(); });
}
```

Replace the two `activePanel === 'terminal'` checks inside `ensureTerminal` with `terminalOpen`:

```ts
        if (!pty || !terminalOpen) return;
```

and:

```ts
  requestAnimationFrame(() => { if (terminalOpen) pty?.terminal.focus(); });
```

Add the close listener near the other terminal listeners:

```ts
$('terminal-close').addEventListener('click', () => { void setTerminalOpen(false); });
```

In `selectSession`, after `applyKindUi()` and `updateFolderContext()`, add:

```ts
    if (terminalOpen) {
      if (record.kind === 'work') void setTerminalOpen(false);
      else void ensureTerminal();
    }
```

In `applyKindUi`, when `work` is true, close the drawer:

```ts
  if (work) void setTerminalOpen(false);
```

Keep the existing note update. The drawer itself is Code-only, so the note is only visible in Code.

- [ ] **Step 5: Add the drawer CSS**

Append to `src/renderer/style.css`:

```css
.terminal-drawer{flex:none;height:260px;min-height:160px;display:flex;flex-direction:column;border-top:1px solid #2a4258;background:#0c1d2d}
.terminal-drawer[hidden]{display:none}
.terminal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:8px 12px;border-bottom:1px solid #2a4258}
.terminal-head h2{margin:0;font-size:12px}
.terminal-head .hint{margin:2px 0 0;padding:0}
.terminal-drawer .terminal-host{flex:1;min-height:0;padding:0 10px 10px}
```

- [ ] **Step 6: Run the drawer test**

Run: `node --test tests/right-panel.test.mjs`
Expected: the drawer test passes; the PTY key test still passes.

- [ ] **Step 7: Commit**

```bash
git add index.html src/renderer/style.css src/renderer/main.ts tests/right-panel.test.mjs
git commit -m "feat: open the terminal in a drawer below the composer"
```

#### 3C: Add the Tools menu

- [ ] **Step 1: Write the failing menu test**

Add to `tests/tools-menu.test.mjs`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/tools-menu.test.mjs`
Expected: FAIL because the menu markup is missing.

- [ ] **Step 3: Wire the menu behavior**

Add imports at the top of `src/renderer/main.ts`:

```ts
import { nextMenuIndex, toolDisabledReason, type ToolAction } from './tools-menu';
```

Add state and functions near the panel state:

```ts
let toolsOpen = false;

function menuToolButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('#tools-menu [data-tool]')];
}

function syncToolMenu(): void {
  const context = { kind: activeKind, hasWorkspace: Boolean(currentFolder()) };
  for (const button of menuToolButtons()) {
    const action = button.dataset.tool as ToolAction;
    const reason = toolDisabledReason(action, context);
    button.disabled = reason !== null;
    button.toggleAttribute('aria-disabled', reason !== null);
    button.title = reason ?? '';
    if (button.getAttribute('role') === 'menuitemcheckbox') {
      const checked = action === 'terminal-panel' ? terminalOpen : false;
      button.setAttribute('aria-checked', String(checked));
    }
  }
}

function openToolsMenu(): void {
  toolsOpen = true;
  $('tools-menu').toggleAttribute('hidden', false);
  $('tools-toggle').setAttribute('aria-expanded', 'true');
  syncToolMenu();
}

function closeToolsMenu(returnFocus = false): void {
  toolsOpen = false;
  $('tools-menu').toggleAttribute('hidden', true);
  $('tools-toggle').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('tools-toggle').focus();
}

function moveToolsFocus(key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): void {
  const items = menuToolButtons().filter((button) => !button.disabled);
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  items[nextMenuIndex(current, items.length, key)]?.focus();
}

function runTool(action: ToolAction): void {
  closeToolsMenu();
  if (action === 'files') { switchPanel('workspace'); switchWorkspaceView('explorer'); return; }
  if (action === 'terminal-panel') { void setTerminalOpen(!terminalOpen); return; }
  if (action === 'settings') { switchPage('settings'); return; }
  if (action === 'docs') { switchPage('docs'); return; }
}
```

Add listeners near the sidebar listeners:

```ts
$('tools-toggle').addEventListener('click', () => {
  if (toolsOpen) closeToolsMenu(true);
  else openToolsMenu();
});
$<HTMLDivElement>('tools-menu').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]');
  if (button) runTool(button.dataset.tool as ToolAction);
});
$<HTMLDivElement>('tools-menu').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closeToolsMenu(true); return; }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    moveToolsFocus(event.key);
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!toolsOpen) return;
  if (!(event.target as HTMLElement).closest('.tools-wrap')) closeToolsMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && toolsOpen) closeToolsMenu(true);
});
```

Call `syncToolMenu()` at the end of `updateControls()` and after `applyKindUi()` changes the mode.

- [ ] **Step 4: Add the menu CSS**

Append:

```css
.topbar-lead{display:flex;align-items:center;gap:12px;min-width:0}
.topbar-title{min-width:0}
.topbar-toggle{flex:none;width:32px;height:32px;display:grid;place-items:center;border:1px solid #37536a;border-radius:8px;background:#1d354b;color:#cde2e8;cursor:pointer}
.topbar-toggle:hover{border-color:#65cbbd}
.topbar-toggle svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.tools-wrap{position:relative;flex:none}
.tools-menu{position:absolute;right:0;top:calc(100% + 8px);width:220px;padding:6px;display:flex;flex-direction:column;gap:2px;background:#15293d;border:1px solid #527083;border-radius:10px;box-shadow:0 16px 40px #0008;z-index:30}
.tools-menu[hidden]{display:none}
.menu-label{margin:6px 8px 2px;color:#83aab9;font:700 9px "Segoe UI",sans-serif;letter-spacing:.16em;text-transform:uppercase}
.tools-menu button{padding:8px 9px;border:0;border-radius:6px;background:transparent;color:#d7e6ed;font:500 12px "Segoe UI",sans-serif;text-align:left;cursor:pointer}
.tools-menu button:hover:not(:disabled){background:#1d354b}
.tools-menu button:disabled{opacity:.45;cursor:not-allowed}
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/right-panel.test.mjs tests/pages.test.mjs tests/session-kind.test.mjs tests/tools-menu.test.mjs`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add index.html src/renderer/style.css src/renderer/main.ts tests/tools-menu.test.mjs
git commit -m "feat: add the top-right tools menu"
```

---

### Task 4: Task Monitor sidecar

Add the right panel with the three sections and feed it from the pure module.

**Files:**
- Modify: `index.html`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/main.ts`
- Modify: `tests/right-panel.test.mjs`

**Interfaces:**
- Consumes: `updatesFromActivity`, `checkpointUpdates`, `mergeUpdates`, `artifactsFromActivity`, `backgroundRows`, `shortText`, `elapsedLabel`, `toolTitle`, and `MonitorRun` from Task 2.
- Produces: `setTaskMonitor(open)`, `renderTaskMonitor()`, `runInfo` map, `schedulesBySession`, `checkpointsBySession`.

- [ ] **Step 1: Write the failing test**

Add to `tests/right-panel.test.mjs`:

```js
test('the task monitor is the only right-hand surface', async () => {
  const [html, style, main] = await Promise.all([read('index.html'), read('src/renderer/style.css'), read('src/renderer/main.ts')]);
  assert.match(html, /<aside id="task-monitor" class="task-monitor"[^>]*hidden/);
  const monitor = html.slice(html.indexOf('id="task-monitor"'), html.indexOf('</aside>', html.indexOf('id="task-monitor"')));
  assert.match(monitor, /<h3>Updates<\/h3>/);
  assert.match(monitor, /<h3>Background processes<\/h3>/);
  assert.match(monitor, /<h3>Artifacts<\/h3>/);
  assert.ok(monitor.indexOf('Updates') < monitor.indexOf('Background processes'));
  assert.ok(monitor.indexOf('Background processes') < monitor.indexOf('Artifacts'));
  assert.match(html, /data-tool="task-monitor"/);
  assert.match(style, /\.app\.task-monitor-open\{grid-template-columns:var\(--sidebar-width,280px\) minmax\(0,1fr\) var\(--task-monitor-width,320px\)\}/);
  assert.match(main, /function setTaskMonitor\(open: boolean\)/);
  assert.match(main, /function renderTaskMonitor\(\): void/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/right-panel.test.mjs`
Expected: FAIL because the monitor markup does not exist.

- [ ] **Step 3: Add the monitor markup**

In `index.html`, insert before the closing `</div>` of `.app` (after `</main>`):

```html
      <aside id="task-monitor" class="task-monitor" aria-label="Task monitor" hidden>
        <header class="monitor-head">
          <div><p class="eyebrow">TASK</p><h2>Monitor</h2></div>
          <button id="task-monitor-close" class="icon-action" type="button" aria-label="Close task monitor" title="Close task monitor">×</button>
        </header>
        <section class="monitor-section monitor-updates">
          <header><h3>Updates</h3></header>
          <div id="monitor-updates" class="monitor-list"></div>
        </section>
        <section class="monitor-section monitor-processes">
          <header><h3>Background processes</h3></header>
          <div id="monitor-processes" class="monitor-list"></div>
        </section>
        <section class="monitor-section monitor-artifacts">
          <header><h3>Artifacts</h3></header>
          <div id="monitor-artifacts" class="monitor-list"></div>
        </section>
      </aside>
```

Add the menu item after `data-tool="files"`:

```html
                <button type="button" role="menuitemcheckbox" data-tool="task-monitor" aria-checked="false">Task monitor</button>
```

- [ ] **Step 4: Add the monitor CSS**

Append:

```css
.app.task-monitor-open{grid-template-columns:var(--sidebar-width,280px) minmax(0,1fr) var(--task-monitor-width,320px)}
.app.sidebar-collapsed.task-monitor-open{grid-template-columns:0 minmax(0,1fr) var(--task-monitor-width,320px)}
.task-monitor{display:flex;flex-direction:column;min-width:0;background:#101f30;border-left:1px solid #2a4258;overflow:hidden}
.task-monitor[hidden]{display:none}
.monitor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px}
.monitor-head h2{margin:3px 0 0;font-size:14px}
.monitor-section{display:flex;flex-direction:column;min-height:0;border-top:1px solid #2a4258}
.monitor-section>header{padding:9px 14px 5px}
.monitor-section h3{margin:0;color:#9bb4c1;font-size:10px;letter-spacing:.14em;text-transform:uppercase}
.monitor-list{min-height:0;overflow:auto;padding:4px 10px 10px;display:flex;flex-direction:column;gap:4px}
.monitor-updates{flex:1 1 45%}
.monitor-processes{flex:0 1 auto;max-height:32%}
.monitor-artifacts{flex:1 1 35%}
.monitor-item{padding:7px 8px;border:1px solid #345064;border-radius:7px;background:#193047;color:#d7e6ed;font:11px/1.4 "Segoe UI",sans-serif;text-align:left}
.monitor-item strong{display:block;font-size:11px;color:#e1f2f4}
.monitor-item span{display:block;margin-top:2px;color:#8ea8b7;overflow-wrap:anywhere}
.monitor-item.error{border-color:#8a4b4b}
.monitor-item.running{border-color:#65cbbd}
.monitor-artifact{width:100%;cursor:pointer;font-family:"Cascadia Code",Consolas,monospace}
.monitor-artifact:hover{border-color:#65cbbd}
@media(max-width:1100px){
  .app.task-monitor-open{grid-template-columns:var(--sidebar-width,280px) minmax(0,1fr)}
  .app.sidebar-collapsed.task-monitor-open{grid-template-columns:0 minmax(0,1fr)}
  .task-monitor{position:absolute;right:0;top:0;bottom:0;width:min(340px,calc(100vw - 60px));z-index:8;box-shadow:-18px 0 40px #0007}
}
.app.page-mode .task-monitor{display:none}
```

- [ ] **Step 5: Add the monitor state and renderer**

In `src/renderer/main.ts`, add imports:

```ts
import {
  artifactsFromActivity,
  backgroundRows,
  checkpointUpdates,
  mergeUpdates,
  updatesFromActivity,
  type MonitorRun,
} from './task-monitor';
```

Add state near `running`:

```ts
const runInfo = new Map<string, MonitorRun>();
const schedulesBySession = new Map<string, Schedule[]>();
const checkpointsBySession = new Map<string, Checkpoint[]>();
let taskMonitorOpen = false;
```

Add functions:

```ts
function setTaskMonitor(open: boolean): void {
  taskMonitorOpen = open;
  document.querySelector<HTMLElement>('.app')?.classList.toggle('task-monitor-open', open);
  $('task-monitor').toggleAttribute('hidden', !open);
  try { localStorage.setItem('moderado-task-monitor', String(open)); } catch { /* applies for this run */ }
  syncToolMenu();
  if (open) renderTaskMonitor();
}

function monitorEmpty(text: string): HTMLParagraphElement {
  const empty = document.createElement('p');
  empty.className = 'hint';
  empty.textContent = text;
  return empty;
}

function renderTaskMonitor(): void {
  if (!taskMonitorOpen) return;
  const id = activeSessionId;
  const updatesList = $('monitor-updates');
  const processesList = $('monitor-processes');
  const artifactsList = $('monitor-artifacts');
  if (!id) {
    updatesList.replaceChildren(monitorEmpty('Select a session.'));
    processesList.replaceChildren(monitorEmpty('Select a session.'));
    artifactsList.replaceChildren(monitorEmpty('Select a session.'));
    return;
  }
  const now = Date.now();
  const updates = mergeUpdates([
    updatesFromActivity(views.get(id) ?? [], now),
    checkpointUpdates(checkpointsBySession.get(id) ?? []),
  ]);
  const artifacts = artifactsFromActivity(views.get(id) ?? [], now);
  const processes = backgroundRows(runInfo.get(id), schedulesBySession.get(id) ?? [], now);

  updatesList.replaceChildren(...(updates.length ? updates.map((update) => {
    const item = document.createElement('div');
    item.className = `monitor-item ${update.kind === 'error' ? 'error' : ''}`.trim();
    const label = document.createElement('strong');
    label.textContent = update.label;
    const detail = document.createElement('span');
    detail.textContent = update.detail || new Date(update.at).toLocaleTimeString();
    item.append(label, detail);
    return item;
  }) : [monitorEmpty('No activity yet in this session.')]));

  processesList.replaceChildren(...(processes.length ? processes.map((process) => {
    const item = document.createElement('div');
    item.className = `monitor-item ${process.state === 'running' ? 'running' : ''}`.trim();
    const label = document.createElement('strong');
    label.textContent = process.label;
    const detail = document.createElement('span');
    detail.textContent = process.detail;
    item.append(label, detail);
    return item;
  }) : [monitorEmpty('No background work.')]));

  artifactsList.replaceChildren(...(artifacts.length ? artifacts.map((artifact) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'monitor-item monitor-artifact';
    item.textContent = artifact.path;
    item.title = `${artifact.action} · ${artifact.path}`;
    item.addEventListener('click', () => {
      void previewProjectFile({ name: artifact.path.split('/').pop() ?? artifact.path, path: artifact.path, isDir: false });
    });
    return item;
  }) : [monitorEmpty('No files changed yet.')]));
}
```

- [ ] **Step 6: Cache schedules and checkpoints**

In `refreshSchedules`, after the `list_schedules` invoke and the active-session guard:

```ts
    schedulesBySession.set(id, schedules);
    renderTaskMonitor();
```

Also set an empty array when the session has no schedules, before the early return:

```ts
    schedulesBySession.set(id, schedules);
    if (!schedules.length) { list.textContent = 'No scheduled tasks.'; renderTaskMonitor(); return; }
```

In `refreshCheckpoints`, after the invoke and guard:

```ts
    checkpointsBySession.set(id, checkpoints);
    renderTaskMonitor();
    if (!checkpoints.length) { list.textContent = 'No checkpoints yet.'; return; }
```

- [ ] **Step 7: Track running labels**

Add:

```ts
function markRunning(id: string, label: string, scheduled = false, scheduleId?: string): void {
  running.add(id);
  runInfo.set(id, { label, startedAt: Date.now(), scheduled, scheduleId });
  renderTaskMonitor();
}

function clearRunning(id: string): void {
  running.delete(id);
  runInfo.delete(id);
  renderTaskMonitor();
}
```

Replace every direct `running.add(id)` and `running.delete(id)`:

- submit: `markRunning(id, \`Turn: ${shortText(text, 60)}\`);`
- submit finally: `if (!scheduledPending.has(id)) clearRunning(id);`
- turn listener error and terminal branch: `if (!scheduledPending.has(id)) clearRunning(id);`
- schedule-started: `markRunning(payload.sessionId, \`Scheduled: ${shortText(payload.prompt, 60)}\`, true, payload.scheduleId);`
- schedule-run: `else { scheduledPending.delete(payload.sessionId); clearRunning(payload.sessionId); }`

Import `shortText` from `./task-monitor`.

- [ ] **Step 8: Render on live events and session changes**

In the turn listener, after `setToolActivity(...)` calls, add `renderTaskMonitor();`. After the checkpoint listener refreshes checkpoints, `renderTaskMonitor()` is reached through `refreshCheckpoints`.

In `scheduleStarted` and `scheduleRun` listeners, call `renderTaskMonitor()` after `refreshSchedules()` (or after the status update).

In `selectSession`, after the existing `Promise.all([...refreshCheckpoints(), refreshSchedules(), ...])`, add:

```ts
    renderTaskMonitor();
```

- [ ] **Step 9: Enable the menu item**

In `runTool`, add:

```ts
  if (action === 'task-monitor') { setTaskMonitor(!taskMonitorOpen); return; }
```

In `syncToolMenu`, update the checkbox branch:

```ts
      const checked = action === 'task-monitor' ? taskMonitorOpen : action === 'terminal-panel' ? terminalOpen : false;
```

Add listeners:

```ts
$('task-monitor-close').addEventListener('click', () => setTaskMonitor(false));
```

At startup, after the sidebar-collapsed restore, add:

```ts
const storedMonitor = localStorage.getItem('moderado-task-monitor') === 'true';
setTaskMonitor(storedMonitor);
```

- [ ] **Step 10: Run the tests**

Run: `node --test tests/right-panel.test.mjs tests/task-monitor.test.mjs tests/tools-menu.test.mjs`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add index.html src/renderer/style.css src/renderer/main.ts tests/right-panel.test.mjs
git commit -m "feat: add the task monitor sidecar"
```

---

### Task 5: External launch backend

Add the Rust module and commands. This task is independent of the UI and can ship without menu items.

**Files:**
- Create: `src-tauri/src/external.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: inline `#[cfg(test)]` in `external.rs`

**Interfaces:**
- Consumes: a resolved workspace path.
- Produces: `external::open_editor(&Path) -> Result<(), String>`, `external::open_terminal(&Path) -> Result<(), String>`, Tauri commands `open_in_editor`, `open_system_terminal`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/external.rs` with the tests first, then the implementation:

```rust
//! Launch the workspace in an external editor or terminal.
//!
//! Programs are fixed candidates; the webview never supplies one. The workspace
//! is passed as an argv entry, never interpolated into a shell command.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub new_console: bool,
}

impl Launch {
    fn new(program: impl Into<PathBuf>, args: Vec<String>) -> Self {
        Self { program: program.into(), args, current_dir: None, new_console: false }
    }

    fn in_dir(mut self, root: &Path) -> Self {
        self.current_dir = Some(root.to_path_buf());
        self
    }
}

fn path_arg(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

pub fn editor_candidates(root: &Path) -> Vec<Launch> {
    let arg = path_arg(root);
    let mut candidates = Vec::new();
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let base = PathBuf::from(local).join("Programs");
        candidates.push(Launch::new(base.join("Microsoft VS Code").join("Code.exe"), vec![arg.clone()]));
        candidates.push(Launch::new(base.join("Microsoft VS Code Insiders").join("Code - Insiders.exe"), vec![arg.clone()]));
        candidates.push(Launch::new(base.join("cursor").join("Cursor.exe"), vec![arg.clone()]));
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(Launch::new("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", vec![arg.clone()]));
        candidates.push(Launch::new("/Applications/Cursor.app/Contents/Resources/app/bin/cursor", vec![arg.clone()]));
    }
    candidates.push(Launch::new("code", vec![arg.clone()]));
    candidates.push(Launch::new("code-insiders", vec![arg.clone()]));
    candidates.push(Launch::new("cursor", vec![arg]));
    candidates
}

pub fn terminal_candidates(root: &Path) -> Vec<Launch> {
    let arg = path_arg(root);
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        candidates.push(Launch::new("wt.exe", vec!["-d".into(), arg]));
        let mut fallback = Launch::new("cmd.exe", Vec::new()).in_dir(root);
        fallback.new_console = true;
        candidates.push(fallback);
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(Launch::new("open", vec!["-a".into(), "Terminal".into(), arg]));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        candidates.push(Launch::new("x-terminal-emulator", Vec::new()).in_dir(root));
        candidates.push(Launch::new("gnome-terminal", vec!["--working-directory".into(), arg.clone()]));
        candidates.push(Launch::new("konsole", vec!["--workdir".into(), arg.clone()]));
        candidates.push(Launch::new("xterm", Vec::new()).in_dir(root));
    }
    candidates
}

fn launch(candidates: &[Launch], missing: &str) -> Result<(), String> {
    for candidate in candidates {
        let mut command = Command::new(&candidate.program);
        command
            .args(&candidate.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(directory) = &candidate.current_dir {
            command.current_dir(directory);
        }
        #[cfg(windows)]
        if candidate.new_console {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0000_0010);
        }
        match command.spawn() {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not start {}: {error}", candidate.program.display())),
        }
    }
    Err(missing.into())
}

pub fn open_editor(root: &Path) -> Result<(), String> {
    launch(
        &editor_candidates(root),
        "No supported editor was found. Install VS Code or Cursor, or add its command to PATH.",
    )
}

pub fn open_terminal(root: &Path) -> Result<(), String> {
    launch(
        &terminal_candidates(root),
        "No supported terminal was found. Use the embedded terminal panel instead.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_candidates_always_pass_the_workspace_as_one_argument() {
        let root = Path::new("workspace");
        let candidates = editor_candidates(root);
        assert!(!candidates.is_empty());
        for candidate in &candidates {
            assert_eq!(candidate.args, vec!["workspace".to_string()]);
            assert!(candidate.current_dir.is_none());
        }
    }

    #[test]
    fn terminal_candidates_are_platform_appropriate() {
        let root = Path::new("workspace");
        let candidates = terminal_candidates(root);
        assert!(!candidates.is_empty());
        #[cfg(windows)]
        {
            assert_eq!(candidates[0].program, PathBuf::from("wt.exe"));
            assert_eq!(candidates[0].args, vec!["-d".to_string(), "workspace".to_string()]);
            assert!(candidates[1].new_console);
            assert_eq!(candidates[1].current_dir.as_deref(), Some(root));
        }
        #[cfg(target_os = "macos")]
        assert_eq!(candidates[0].program, PathBuf::from("open"));
    }
}
```

- [ ] **Step 2: Run the tests to verify they compile and pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml external::`
Expected: both tests pass. If the module is not declared yet, add `pub mod external;` to `src-tauri/src/lib.rs` first.

- [ ] **Step 3: Add the Tauri commands**

In `src-tauri/src/lib.rs`, add `pub mod external;` with the other modules. Near `browser_workspace`, add:

```rust
#[tauri::command]
fn open_in_editor(
    state: tauri::State<'_, AppState>,
    session_id: Option<String>,
    project_workspace: Option<String>,
    work_task_id: Option<String>,
) -> Result<(), String> {
    let root = browser_workspace(&state, session_id, project_workspace, work_task_id)?;
    external::open_editor(&root)
}

#[tauri::command]
fn open_system_terminal(
    state: tauri::State<'_, AppState>,
    session_id: Option<String>,
    project_workspace: Option<String>,
    work_task_id: Option<String>,
) -> Result<(), String> {
    let root = browser_workspace(&state, session_id, project_workspace, work_task_id)?;
    external::open_terminal(&root)
}
```

Register both in `invoke_handler`, next to `terminal_close`.

- [ ] **Step 4: Run Rust tests and clippy**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all tests pass.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/external.rs src-tauri/src/lib.rs
git commit -m "feat: launch the workspace in an external editor or terminal"
```

---

### Task 6: External launch menu items

Expose the two commands in the Tools menu, with the same enablement rules as the pure model.

**Files:**
- Modify: `index.html`
- Modify: `src/renderer/main.ts`
- Modify: `tests/tools-menu.test.mjs`

**Interfaces:**
- Consumes: `invoke('open_in_editor', browserArgs())`, `invoke('open_system_terminal', browserArgs())`.
- Produces: completed menu.

- [ ] **Step 1: Write the failing test**

Add to `tests/tools-menu.test.mjs`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/tools-menu.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Add the menu group**

In `index.html`, insert before the `App` group:

```html
                <p class="menu-label" role="presentation">Open in</p>
                <button type="button" role="menuitem" data-tool="vscode">Open in VS Code</button>
                <button type="button" role="menuitem" data-tool="system-terminal">Open system terminal</button>
```

- [ ] **Step 4: Add the actions**

In `runTool`, add:

```ts
  if (action === 'vscode') {
    void invoke('open_in_editor', browserArgs()).catch((error) => setStatus(String(error)));
    return;
  }
  if (action === 'system-terminal') {
    void invoke('open_system_terminal', browserArgs()).catch((error) => setStatus(String(error)));
    return;
  }
```

`syncToolMenu()` already disables both when `currentFolder()` is null through `toolDisabledReason`.

- [ ] **Step 5: Run the tests**

Run: `node --test tests/tools-menu.test.mjs`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add index.html src/renderer/main.ts tests/tools-menu.test.mjs
git commit -m "feat: open the workspace in VS Code or a system terminal"
```

---

### Task 7: Update the design doc and verify the whole app

**Files:**
- Modify: `docs/sidebar-design.md`
- No production code.

- [ ] **Step 1: Replace the obsolete Layout section**

In `docs/sidebar-design.md`, replace the `## Layout` body with:

```md
## Layout

- Revised 2026-11-03: the 52 px Activity Bar is removed. The left panel is the only
  navigation surface and carries a compact tab row: Sessions, Files, Schedules, and
  Profile. Preview opens from Files and keeps the Files tab selected.
- The left panel is resizable from 240 to 420 px and collapses from the topbar toggle.
- The conversation column owns the transcript, composer, and a terminal drawer below
  the composer. The drawer is Code-only and keeps its PTY alive while hidden.
- The right Task Monitor is a collapsible sidecar with Updates, Background processes,
  and Artifacts. It overlays the conversation below 1100 px.
- The top-right Tools menu owns File browser, Task monitor, Terminal panel, Open in
  VS Code, Open system terminal, Settings, and Docs. Settings and Docs remain
  full-width pages.
- At narrow widths the left panel overlays the conversation and the topbar toggle
  remains the way to open or close it.
```

Update the `## Verification` section to mention `tests/tools-menu.test.mjs` and
`tests/task-monitor.test.mjs` alongside the existing tests.

- [ ] **Step 2: Run the full verification**

Run: `npm test`
Expected: cargo tests pass, then all Node tests pass (including the rewritten layout tests).

Run: `npm run lint`
Expected: eslint, `tsc --noEmit`, and clippy all pass.

Run: `npm run build`
Expected: TypeScript and Vite build succeed, then the Tauri build completes.

- [ ] **Step 3: Manual smoke test**

Start `npm run dev` and verify:

1. No activity bar is visible at 1180 px or at the 760 px minimum.
2. The sidebar toggle collapses and reopens the left panel and remembers the state after a restart.
3. Files opens the Explorer; Changes and Checkpoints still work.
4. Task monitor opens on the right, shows Updates/Background processes/Artifacts, and closes from its header and the menu.
5. Terminal panel opens below the composer in a Code session, accepts input, fits on resize, and stays alive when closed and reopened.
6. Terminal panel is disabled in Work mode with the Code-only reason.
7. VS Code and System terminal launch the selected folder; disabling them without a folder works.
8. Settings and Docs still open and return to the conversation.
9. The 650 px and 1100 px breakpoints overlay rather than squash.

- [ ] **Step 4: Commit**

```bash
git add docs/sidebar-design.md
git commit -m "docs: record the Qoder-style shell revision"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
| --- | --- |
| Remove activity bar | 3A |
| Left panel tabs | 3A |
| Topbar sidebar toggle and persistence | 3A |
| Tools menu | 3C, 6 |
| File browser item | 3C |
| Task monitor item and sidecar | 4 |
| Terminal panel item and drawer | 3B, 3C |
| VS Code and OS terminal | 5, 6 |
| Updates section | 2, 4 |
| Background processes section | 2, 4 |
| Artifacts section | 2, 4 |
| Responsive/accessibility rules | 3A, 3C, 4 |
| Design doc update | 7 |

**Placeholder scan:** every new module has complete code; every modified function has the exact replacement; tests are written before implementation. Existing section bodies that move or stay are named explicitly rather than rewritten.

**Type consistency:** `ToolAction`, `ToolContext`, `TOOL_ITEMS`, `nextMenuIndex`, `toolDisabledReason` are defined in Task 1 and used unchanged in Tasks 3 and 6. `MonitorRun`, `MonitorUpdate`, `MonitorArtifact`, `MonitorProcess`, `backgroundRows`, `mergeUpdates`, `checkpointsUpdates` are defined in Task 2 and used unchanged in Task 4. `setTaskMonitor`, `renderTaskMonitor`, `setTerminalOpen`, `syncToolMenu`, `markRunning`, `clearRunning` are defined where first used and referenced by name later.
