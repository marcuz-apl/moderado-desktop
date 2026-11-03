# Activity Rail Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a persistent Activity Rail, merge it with the Left Pane under one 56 px header holding Work/Code, and give the Right Pane a three-control header around the Task Monitor.

**Architecture:** `.app` becomes a three-child grid: `.left-shell` (an internal 2 x 2 grid of a 52 px rail and a resizable Left Pane under one merged `.shell-head`), `.main` (topbar, transcript, composer, drawer, pages), and `.task-monitor`. One `LeftView` state (`workspaces | files | git | schedules`) selects the Left Pane contents; `GitView` selects Changes or Checkpoints inside Git. Pages keep the rail and Left Pane visible and hide the Right Pane.

**Tech Stack:** Tauri 2, vanilla TypeScript + Vite, plain CSS, Node test runner, Rust backend untouched.

**Spec:** `docs/superpowers/specs/2026-11-03-activity-rail-shell-design.md`

## Global Constraints

- No Rust changes, no schema change, no migration, no new dependency.
- Reuse the existing Tauri commands unchanged. The workspace jail, approval gate, external-launch allowlist, and keychain secret handling are untouched.
- Automated tests run offline. `npm test` includes cargo; use the listed `node --test` commands for the fast loop.
- Persistence: new `moderado-left-view` (`workspaces` default) and `moderado-git-view` (`changes` default); keep `moderado-sidebar-width`, `moderado-task-monitor` (default **true**), `moderado-navigation`, `moderado-last-kind`, `moderado-theme`, `moderado-display-size`. Remove `moderado-sidebar-collapsed` and `moderado-workspace-view` without migration.
- Layout: 52 px rail + 260 px Left Pane (clamp 200-560); all three header rows are 56 px; Right Pane fixed at 320 px.
- Responsive: >= 1200 px four columns; 1000-1199 px Right Pane overlays; 760-999 px Left Pane clamped to 220 px and Right Pane overlays; the rail is never hidden; the window minimum stays 760 px; unreachable `< 650 px` layout rules are removed.
- Visible labels match their DOM names: rail tabs `Workspaces`, `Files`, `Git`, `Schedules`; bottom buttons `Settings`, `Docs`, `Profile`.
- No push unless explicitly requested. Commits are part of this plan.

---

### Task 1: Activity Rail, merged header, and Left Pane views

**Files:**
- Modify: `src/renderer/sessions-view.ts`
- Modify: `index.html`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/theme.css`
- Test: `tests/session-kind.test.mjs`, `tests/right-panel.test.mjs`, `tests/pages.test.mjs`, `tests/tools-menu.test.mjs`, `tests/theme.test.mjs`

**Interfaces:**
- Consumes: existing `nextMenuIndex` from `src/renderer/tools-menu.ts`, existing `refreshProjectTree`, `refreshSourceControl`, `refreshCheckpoints`.
- Produces:
  - `export type LeftView = 'workspaces' | 'files' | 'git' | 'schedules'`
  - `export const LEFT_VIEWS: readonly LeftView[]`
  - `export const DEFAULT_LEFT_VIEW: LeftView`
  - `export function parseLeftView(value: string | null): LeftView`
  - `export type GitView = 'changes' | 'checkpoints'`
  - `export const GIT_VIEWS: readonly GitView[]`
  - `export function parseGitView(value: string | null): GitView`
  - `AppPage` becomes `'settings' | 'docs' | 'profile'`; `SidebarPanel`, `WorkspaceView`, `WORKSPACE_VIEWS`, `defaultPanel`, `parseWorkspaceView` are removed.
  - DOM ids consumed by Task 2: `#sidebar` (Left Pane), `#tools-toggle`, `#tools-menu` stay where they are for this task.
  - New main.ts functions: `selectLeftView`, `applyLeftView`, `applyFilesView`, `openPreview`, `closePreview`, `applyGitView`, `switchGitView`, `leavePage`, `viewingFiles`.

- [ ] **Step 1: Update the tests to the new contract**

Replace the import line in `tests/session-kind.test.mjs` with:

```js
import { DEFAULT_LEFT_VIEW, DEFAULT_SESSION_KIND, GIT_VIEWS, LEFT_VIEWS, needsWorkspacePicker, newSessionLabel, nextSessionKind, parseGitView, parseLeftView, parseSessionKind, profileModeDescription, projectNameFromWorkspace, projectsForSessions, scheduleWriteApprovalChoiceVisible, sessionsForProject, visibleSessions } from '../src/renderer/sessions-view.ts';
```

Replace the test `no panel is mode-specific any more` with:

```js
test('the rail chooses the Left Pane view and remembers it', () => {
  assert.equal(DEFAULT_LEFT_VIEW, 'workspaces');
  assert.deepEqual(LEFT_VIEWS, ['workspaces', 'files', 'git', 'schedules']);
  assert.equal(parseLeftView('files'), 'files');
  assert.equal(parseLeftView('git'), 'git');
  assert.equal(parseLeftView('schedules'), 'schedules');
  assert.equal(parseLeftView('source-control'), 'workspaces', 'retired names fall back');
  assert.equal(parseLeftView(null), 'workspaces');
  assert.deepEqual(GIT_VIEWS, ['changes', 'checkpoints']);
  assert.equal(parseGitView('checkpoints'), 'checkpoints');
  assert.equal(parseGitView('explorer'), 'changes', 'retired names fall back');
  assert.equal(parseGitView(null), 'changes');
});
```

Replace the test `top bar contains the Work/Code switch and Explorer owns the folder icon` with:

```js
test('the merged shell header holds Work/Code and the topbar does not', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(html, /class="left-shell">[\s\S]*class="shell-head">[\s\S]*class="kind-segment"[\s\S]*id="kind-work"[\s\S]*id="kind-code"/);
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>', html.indexOf('<header class="topbar">')));
  assert.doesNotMatch(topbar, /id="kind-work"|id="kind-code"|class="kind-segment"|id="sidebar-toggle"/);
  assert.match(html, /class="rail-tabs"[^>]*role="tablist"[^>]*aria-orientation="vertical"[\s\S]*data-rail="workspaces"[\s\S]*data-rail="files"[\s\S]*data-rail="git"[\s\S]*data-rail="schedules"/);
  assert.match(html, /class="rail-pages"[\s\S]*data-page-link="settings"[\s\S]*data-page-link="docs"[\s\S]*data-page-link="profile"/);
  assert.match(html, /class="session-actions">[\s\S]*id="new-session"/);
  assert.doesNotMatch(html, /empty-symbol[^<]*<img/);
  assert.match(main, /radio\.type = 'radio'/);
});
```

Replace the test `both modes share one left panel` with:

```js
test('both modes share one Left Pane and one rail', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const views = [...html.matchAll(/data-left-view="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(views, ['workspaces', 'files', 'git', 'schedules']);
  assert.doesNotMatch(html, /data-panel-content=/);
  assert.doesNotMatch(html, /id="sidebar-toggle"/);
  assert.doesNotMatch(html, /class="activity-bar"|class="activity-button"/);
  assert.match(html, /<aside class="sidebar" id="sidebar" aria-label="Left pane">/);
});
```

Replace the test `Library lists tasks and projects in one badged list` with:

```js
test('Workspaces lists tasks and projects in one badged list', async () => {
  const [html, main, style] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8'),
  ]);
  const panel = html.match(/data-left-view="workspaces">([\s\S]*?)<\/section>/)?.[1] ?? '';
  assert.match(panel, /<h2 id="workspaces-title">Workspaces<\/h2>/);
  assert.equal((panel.match(/class="panel-body session-list"/g) ?? []).length, 1, 'one list');
  assert.match(panel, /id="library-list"/);
  assert.doesNotMatch(panel, /id="task-list"|id="project-list"/);
  assert.match(panel, /id="task-operations"[\s\S]*id="project-operations"/);
  assert.match(main, /badge\.textContent = work \? 'Work' : 'Code'/);
  assert.match(main, /library-badge/);
  assert.match(main, /\.sort\(\(a, b\) => b\.updatedAt - a\.updatedAt\)/);
  assert.match(main, /function applyLibraryActions/);
  assert.match(style, /\.library-badge\{[^}]*text-transform:uppercase/);
});
```

Replace the test `Workspace holds the file, change and checkpoint views as tabs` with:

```js
test('Files and Git own their Left Pane contents', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const files = html.slice(html.indexOf('data-left-view="files"'), html.indexOf('data-left-view="git"'));
  assert.match(files, /id="files-view"[\s\S]*id="project-tree"/);
  assert.match(files, /id="preview-view"[^>]*hidden[\s\S]*id="preview-back"/);
  assert.doesNotMatch(files, /data-git-tab|panel-tab/, 'Files has no tab row');
  const git = html.slice(html.indexOf('data-left-view="git"'), html.indexOf('data-left-view="schedules"'));
  const tabs = [...git.matchAll(/data-git-tab="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['changes', 'checkpoints']);
  const views = [...git.matchAll(/data-git-view="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(views, ['changes', 'checkpoints']);
  for (const id of ['project-tree', 'project-root-name', 'source-branch', 'source-control-message',
    'source-changes', 'commit-history', 'checkpoint-list', 'refresh-project', 'refresh-source-control']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(main, /const viewingFiles = \(\): boolean => activeLeftView === 'files' && !previewOpen/);
  assert.match(main, /const viewingChanges = \(\): boolean => activeLeftView === 'git' && gitView === 'changes'/);
  assert.match(main, /localStorage\.getItem\(leftViewKey\)/, 'the view is remembered across launches');
  assert.match(main, /localStorage\.setItem\(gitViewKey, view\)/, 'the Git tab is remembered');
});
```

Replace the Workspaces selectors in the two tests `project operations stay under Projects ...` and `Work task actions stay in Tasks ...`:

```js
  const panel = html.match(/data-left-view="workspaces">([\s\S]*?)<\/section>/)?.[1] ?? '';
```

and replace

```js
  assert.match(style, /data-panel-content="library"\] \.session-item\.selected[^}]*background:transparent/);
```

with

```js
  assert.match(style, /data-left-view="workspaces"\] \.session-item\.selected[^}]*background:transparent/);
```

In `tests/right-panel.test.mjs`, replace the first test and the resizer/preview/task-monitor grid assertions:

```js
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
```

```js
  assert.match(style, /\.left-shell\{grid-area:1\/1;display:grid;grid-template-columns:52px var\(--sidebar-width,260px\)/);
  assert.match(style, /\.left-shell\{[^}]*grid-template-rows:56px minmax\(0,1fr\)/);
  assert.match(style, /\.rail\{grid-area:rail;[^}]*border-right:1px solid #2a4258/);
  assert.match(style, /\.sidebar-resizer\{position:absolute;[^}]*cursor:col-resize/);
  assert.match(main, /--sidebar-width/);
  assert.match(main, /localStorage\.setItem\(sidebarWidthKey/, 'the width is remembered');
  assert.match(main, /Math\.max\(200, Math\.min\(560/, 'clamped so it cannot swallow the window');
  assert.match(main, /ArrowRight/, 'keyboard resizing');
```

```js
test('selecting a file opens the Preview sub-view instead of a dialog', async () => {
  const [html, main] = await Promise.all([read('index.html'), read('src/renderer/main.ts')]);
  assert.doesNotMatch(html, /file-preview-dialog/, 'the modal is gone');
  assert.match(main, /function openPreview\(\): void/);
  assert.match(main, /previewOpen = true/);
  assert.match(main, /pty\.terminal\.options\.theme = terminalTheme\(\)/, 'a theme switch repaints the shell');
});
```

```js
  assert.match(style, /\.app\.task-monitor-open\{grid-template-columns:auto minmax\(0,1fr\) var\(--task-monitor-width,320px\)\}/);
```

In `tests/pages.test.mjs`, replace the page-mode test and the two Tools-menu tests:

```js
test('page mode keeps the rail and Left Pane and drops the conversation', async () => {
  const style = await read('src/renderer/style.css');
  assert.match(style, /\.app\.page-mode\{grid-template-columns:auto minmax\(0,1fr\)\}/);
  assert.doesNotMatch(style, /\.app\.page-mode \.sidebar\{display:none\}/);
  assert.match(style, /\.main\.page-mode>\.topbar,\.main\.page-mode>\.transcript,\.main\.page-mode>\.composer-wrap\{display:none\}/);
  assert.match(style, /\.main\.page-mode>\.terminal-drawer\{display:none\}/, 'page mode hides the terminal drawer');
  assert.match(style, /\.page\.active\{display:block\}/);
});
```

```js
test('the rail bottom opens the Settings, Docs, and Profile pages', async () => {
  const html = await readHtml();
  const pages = html.slice(html.indexOf('class="rail-pages"'), html.indexOf('</aside>'));
  assert.match(pages, /data-page-link="settings"[\s\S]*data-page-link="docs"[\s\S]*data-page-link="profile"/);
  assert.match(html, /<h1>Docs<\/h1>/);
  assert.match(html, /<h1>Settings<\/h1>/);
  assert.match(html, /<h1>Profile<\/h1>/);
  assert.doesNotMatch(html, /data-panel-content="profile"/);
});
```

```js
test('rail buttons open pages and the Back buttons leave them', async () => {
  const main = await readMain();
  assert.match(main, /function setPageMode\(page: AppPage \| null\): void/);
  assert.match(main, /document\.querySelectorAll<HTMLButtonElement>\('\.rail-pages \.rail-tab'\)/);
  assert.match(main, /switchPage\(page\)/);
  assert.match(main, /for \(const id of \['close-page', 'close-docs', 'close-profile'\]\)/);
  assert.doesNotMatch(main, /\.activity-button/);
});
```

In `tests/tools-menu.test.mjs`, replace the `the tools menu is wired to panel and page actions` test:

```js
test('the File browser action selects the Files rail tab', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /function syncToolMenu\(\): void/);
  assert.match(main, /function runTool\(action: ToolAction\): void/);
  assert.match(main, /if \(action === 'files'\) \{ selectLeftView\('files'\); return; \}/);
});
```

In `tests/theme.test.mjs`, replace the final shell-surface test's selector list:

```js
  for (const selector of [
    '.left-shell', '.shell-head', '.rail', '.rail-tab', '.rail-tab.selected',
    '.terminal-drawer', '.terminal-head', '.tools-menu',
    '.task-monitor', '.monitor-section', '.monitor-section h3',
    '.monitor-item', '.monitor-item strong', '.monitor-item span', '.monitor-item.error',
    '.monitor-item.running', '.monitor-artifact', '.monitor-artifact:hover',
  ]) {
    const escaped = selector.replace(/\./g, '\\.');
    assert.match(theme, new RegExp(`:root\\[data-theme="light"\\] ${escaped}(?![\\w-])`), `${selector} has no light rule`);
  }
  assert.doesNotMatch(theme, /:root\[data-theme="light"\] \.activity-(?:bar|button)/, 'the removed rail-free shell left no light rules behind');
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
node --test tests/session-kind.test.mjs tests/right-panel.test.mjs tests/pages.test.mjs tests/tools-menu.test.mjs tests/theme.test.mjs
```

Expected: FAIL — `parseLeftView` is not exported, `data-left-view` is absent, and `openPreview` is not defined.

- [ ] **Step 3: Replace the view model in `src/renderer/sessions-view.ts`**

Replace lines 1-36 with:

```ts
export type SessionKind = 'work' | 'code';
/** The rail destinations that own the Left Pane. */
export type LeftView = 'workspaces' | 'files' | 'git' | 'schedules';
export const LEFT_VIEWS: readonly LeftView[] = ['workspaces', 'files', 'git', 'schedules'];
/** Tabs inside the Git destination. */
export type GitView = 'changes' | 'checkpoints';
export const GIT_VIEWS: readonly GitView[] = ['changes', 'checkpoints'];
/** Full-width views that replace the conversation. */
export type AppPage = 'settings' | 'docs' | 'profile';

export type ProjectSessionLike = {
  id: string;
  name: string;
  workspace: string;
  kind: SessionKind;
  updatedAt: number;
};

export type ProjectSummary = {
  workspace: string;
  name: string;
  sessionCount: number;
  latestSessionId: string;
  updatedAt: number;
};

export const DEFAULT_SESSION_KIND: SessionKind = 'work';
export const DEFAULT_LEFT_VIEW: LeftView = 'workspaces';

/// Unknown or retired stored views open the default one.
export function parseLeftView(value: string | null): LeftView {
  return value === 'files' || value === 'git' || value === 'schedules' ? value : DEFAULT_LEFT_VIEW;
}

export function parseGitView(value: string | null): GitView {
  return value === 'checkpoints' ? value : 'changes';
}
```

Keep everything from `/// The rail remembers the mode...` (`parseSessionKind`) to the end of the file unchanged.

- [ ] **Step 4: Rewrite the left shell in `index.html`**

Replace lines 31-39 (the `<aside class="sidebar">` block) with:

```html
      <div class="left-shell">
        <header class="shell-head">
          <div class="brand"><span class="brand-mark">M</span><span class="brand-word">Moderado</span></div>
          <div class="kind-segment" role="group" aria-label="Work or Code mode"><button id="kind-work" type="button" class="selected" aria-pressed="true">Work</button><button id="kind-code" type="button" aria-pressed="false">Code</button></div>
        </header>
        <div class="rail">
          <nav class="rail-tabs" role="tablist" aria-orientation="vertical" aria-label="Left pane views">
            <button class="rail-tab selected" type="button" role="tab" aria-selected="true" aria-controls="sidebar" tabindex="0" data-rail="workspaces" aria-label="Workspaces" title="Workspaces"><svg aria-hidden="true"><use href="#icon-projects"/></svg></button>
            <button class="rail-tab" type="button" role="tab" aria-selected="false" aria-controls="sidebar" tabindex="-1" data-rail="files" aria-label="Files" title="Files"><svg aria-hidden="true"><use href="#icon-folder"/></svg></button>
            <button class="rail-tab" type="button" role="tab" aria-selected="false" aria-controls="sidebar" tabindex="-1" data-rail="git" aria-label="Git" title="Git"><svg aria-hidden="true"><use href="#icon-source"/></svg></button>
            <button class="rail-tab" type="button" role="tab" aria-selected="false" aria-controls="sidebar" tabindex="-1" data-rail="schedules" aria-label="Schedules" title="Schedules"><svg aria-hidden="true"><use href="#icon-clock"/></svg></button>
          </nav>
          <nav class="rail-pages" aria-label="App pages">
            <button class="rail-tab" type="button" data-page-link="settings" aria-label="Settings" title="Settings"><svg aria-hidden="true"><use href="#icon-settings"/></svg></button>
            <button class="rail-tab" type="button" data-page-link="docs" aria-label="Docs" title="Docs"><svg aria-hidden="true"><use href="#icon-book"/></svg></button>
            <button class="rail-tab" type="button" data-page-link="profile" aria-label="Profile" title="Profile"><svg aria-hidden="true"><use href="#icon-user"/></svg></button>
          </nav>
        </div>
        <aside class="sidebar" id="sidebar" aria-label="Left pane">
          <section class="sidebar-panel active" data-left-view="workspaces"><header class="panel-heading"><h2 id="workspaces-title">Workspaces</h2></header><div id="task-operations" class="task-operations"><button id="workspace-button" class="text-button" type="button">New Task</button><button id="rename-task" class="text-button" type="button" disabled>Rename</button><button id="delete-task" class="text-button" type="button" disabled>Delete</button></div><div id="project-operations" class="project-operations" hidden><button id="new-project" class="text-button" type="button">New</button><button id="open-project" class="text-button" type="button">Open</button><button id="rename-project" class="text-button" type="button" disabled>Rename</button><button id="remove-project" class="text-button" type="button" disabled>Remove</button></div><div id="library-list" class="panel-body session-list" aria-label="Tasks and projects"></div></section>
          <section class="sidebar-panel" data-left-view="files"><div id="files-view" class="files-view active"><div class="workspace-subhead"><p id="project-root-name" class="path">No project selected</p><button id="refresh-project" class="icon-action" type="button" aria-label="Refresh project files" title="Refresh">Refresh</button></div><div id="project-tree" class="panel-body project-tree" role="tree" aria-label="Project folder contents">Select a task or project to browse its files.</div></div><div id="preview-view" class="files-view" hidden><header class="panel-heading"><div><h2 id="file-preview-title">Preview</h2><p id="file-preview-path" class="path"></p></div><button id="preview-back" class="text-button" type="button">Back to files</button></header><div class="panel-body"><pre id="file-preview-content" class="file-preview-content">Select a file in Files to preview it here.</pre></div></div></section>
          <section class="sidebar-panel" data-left-view="git"><header class="panel-heading workspace-heading"><div class="panel-tabs" role="tablist" aria-label="Git views"><button id="git-tab-changes" class="panel-tab selected" type="button" role="tab" data-git-tab="changes" aria-selected="true">Changes</button><button id="git-tab-checkpoints" class="panel-tab" type="button" role="tab" data-git-tab="checkpoints" aria-selected="false">Checkpoints</button></div></header><div class="git-view active" data-git-view="changes"><div class="workspace-subhead"><p id="source-branch" class="path">Select a session</p><button id="refresh-source-control" class="icon-action" type="button" aria-label="Refresh Git status" title="Refresh">Refresh</button></div><div class="panel-body"><p id="source-control-message" class="hint">Open a workspace to inspect Git.</p><div id="source-changes" class="source-changes"></div><div id="git-actions" class="git-actions" hidden><input id="git-commit-message" type="text" placeholder="Commit message" aria-label="Commit message" autocomplete="off" spellcheck="false" /><div class="git-action-row"><button id="git-commit" class="text-button" type="button">Commit all changes</button><button id="git-push" class="text-button" type="button">Push</button></div><p id="git-credential" class="hint"></p></div><h3 class="panel-subheading">Recent commits</h3><div id="commit-history" class="commit-history"></div></div></div><div class="git-view" data-git-view="checkpoints" hidden><div id="checkpoint-list" class="panel-body checkpoint-list">No checkpoints yet.</div></div></section>
          <section class="sidebar-panel" data-left-view="schedules"><header class="panel-heading"><h2>Schedules</h2><button id="new-schedule" class="text-button" type="button">+ New</button></header><div id="schedule-list" class="panel-body schedule-list">Select a session.</div><div class="panel-actions"><button id="import-transcript" class="text-button" type="button">Import transcript</button></div></section>
          <div id="sidebar-resizer" class="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the Left Pane" tabindex="0"></div>
        </aside>
      </div>
```

Replace the topbar lead (lines 42-51) with:

```html
          <div class="topbar-lead">
            <div class="topbar-title"><p class="eyebrow">AGENT SESSION</p><h1 id="session-title">Workspace conversation</h1></div>
            <p id="workspace-context" class="path">Managed task folder</p>
            <div class="session-actions"><button id="new-session" type="button" hidden>New Session</button><button id="rename-session" type="button">Rename</button><button id="delete-session" type="button">Delete</button></div>
          </div>
```

Insert the Profile page after the Docs page, immediately before `</main>`:

```html
        <section class="page" data-page="profile" id="page-profile" tabindex="-1"><header class="page-head"><div><p class="eyebrow">PROFILE</p><h1>Profile</h1><p class="hint">Local to this device; a GitHub account is optional.</p></div><button id="close-profile" class="text-button" type="button">Back to conversation</button></header><div class="page-body"><div class="page-col"><div class="settings-group"><p class="eyebrow">MODE</p><p id="profile-mode-description" class="hint">Work profile is local to this device. A GitHub account is not required.</p><p class="eyebrow">CURRENT SESSION</p><p id="profile-session" class="workspace-name">No session selected</p><p class="eyebrow">PROVIDER</p><p id="profile-provider" class="path">Not configured</p><div id="profile-git" hidden><p class="eyebrow">GIT IDENTITY</p><p id="profile-git-name" class="workspace-name">Not a repository</p><p id="profile-git-remote" class="path"></p><p id="profile-git-credential" class="hint"></p></div></div></div></div></section>
```

- [ ] **Step 5: Rewrite the Left Pane state and helpers in `src/renderer/main.ts`**

Replace the import on line 20 with:

```ts
import { DEFAULT_LEFT_VIEW, parseGitView, parseLeftView, parseSessionKind, profileModeDescription, projectNameFromWorkspace, sessionForMode, scheduleWriteApprovalChoiceVisible, sessionsForProject, type SessionKind, type LeftView, type GitView, type AppPage } from './sessions-view';
```

Replace lines 107-112 with:

```ts
/** The rail destination that owns the Left Pane, remembered like the mode. */
const leftViewKey = 'moderado-left-view';
let activeLeftView: LeftView = parseLeftView(localStorage.getItem(leftViewKey));
/** Files shows the Preview sub-view instead of the tree. */
let previewOpen = false;
/** The tab inside the Git destination. */
const gitViewKey = 'moderado-git-view';
let gitView: GitView = parseGitView(localStorage.getItem(gitViewKey));
```

Replace the page-close loop on line 202-204 with:

```ts
for (const id of ['close-page', 'close-docs', 'close-profile']) {
  $(id).addEventListener('click', leavePage);
}
```

Delete `setSidebarCollapsed` (lines 1006-1012).

Replace `setPageMode` through `switchPanel` (lines 1101-1159) with:

```ts
function setPageMode(page: AppPage | null): void {
  activePage = page;
  const open = page !== null;
  document.querySelector<HTMLElement>('.app')?.classList.toggle('page-mode', open);
  document.querySelector<HTMLElement>('.main')?.classList.toggle('page-mode', open);
  document.querySelectorAll<HTMLElement>('.page').forEach((section) => {
    section.classList.toggle('active', section.dataset.page === page);
  });
  document.querySelectorAll<HTMLButtonElement>('.rail-pages .rail-tab').forEach((button) => {
    if (button.dataset.pageLink === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (open) {
    closeMention();
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.page.active .page-head .text-button')?.focus());
  }
}

function switchPage(page: AppPage): void {
  setPageMode(page);
}

/** Back from a page: the conversation returns, focused and ready to type. */
function leavePage(): void {
  setPageMode(null);
  prompt.focus();
}

const viewingFiles = (): boolean => activeLeftView === 'files' && !previewOpen;
const viewingChanges = (): boolean => activeLeftView === 'git' && gitView === 'changes';

/** Shows one rail destination and loads the data it needs. */
function applyLeftView(): void {
  document.querySelectorAll<HTMLButtonElement>('.rail-tabs .rail-tab').forEach((button) => {
    const selected = button.dataset.rail === activeLeftView;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll<HTMLElement>('[data-left-view]').forEach((section) => {
    section.classList.toggle('active', section.dataset.leftView === activeLeftView);
  });
  if (activeLeftView === 'files') applyFilesView();
  if (activeLeftView === 'git') applyGitView();
}

function selectLeftView(view: LeftView): void {
  setPageMode(null);
  activeLeftView = view;
  previewOpen = false;
  try { localStorage.setItem(leftViewKey, view); } catch { /* the pane still switches for this run */ }
  applyLeftView();
}

function applyFilesView(): void {
  const files = $('files-view');
  const preview = $('preview-view');
  files.classList.toggle('active', !previewOpen);
  files.toggleAttribute('hidden', previewOpen);
  preview.classList.toggle('active', previewOpen);
  preview.toggleAttribute('hidden', !previewOpen);
  if (!previewOpen) void refreshProjectTree();
}

/** Preview keeps the Files rail tab selected; only the sub-view changes. */
function openPreview(): void {
  setPageMode(null);
  if (activeLeftView !== 'files') {
    activeLeftView = 'files';
    try { localStorage.setItem(leftViewKey, 'files'); } catch { /* the pane still switches for this run */ }
  }
  previewOpen = true;
  applyLeftView();
}

function closePreview(): void {
  previewOpen = false;
  applyFilesView();
}

function applyGitView(): void {
  document.querySelectorAll<HTMLElement>('[data-git-view]').forEach((view) => {
    const active = view.dataset.gitView === gitView;
    view.classList.toggle('active', active);
    view.toggleAttribute('hidden', !active);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-git-tab]').forEach((tab) => {
    const active = tab.dataset.gitTab === gitView;
    tab.classList.toggle('selected', active);
    tab.setAttribute('aria-selected', String(active));
  });
  if (gitView === 'changes') void refreshSourceControl();
  else void refreshCheckpoints();
}

function switchGitView(view: GitView): void {
  gitView = view;
  try { localStorage.setItem(gitViewKey, view); } catch { /* the tab still switches for this run */ }
  applyGitView();
}
```

In `runTool`, replace the files branch with:

```ts
  if (action === 'files') { selectLeftView('files'); return; }
```

In `selectProject`, replace `switchPanel('library')` with `selectLeftView('workspaces')`.

In `selectWorkTask`, replace `switchPanel('library')` with `selectLeftView('workspaces')`.

In `previewProjectFile`, replace `switchPanel('preview')` with `openPreview()`.

In `setKind`, replace the first line with:

```ts
  if (kind === activeKind && !selectingContext) { if (activePage) setPageMode(null); return; }
```

and replace `switchPanel(defaultPanel())` with `selectLeftView(DEFAULT_LEFT_VIEW)`.

Rename every `viewingExplorer()` call to `viewingFiles()` (5 call sites: `enterDraft`, `selectSession`, the attach handler, the create-task path, and the turn-completion listener). Keep the `viewingChanges()` calls as they are.

In `initialize`, replace:

```ts
    switchPanel(defaultPanel());
    const storedMonitor = localStorage.getItem('moderado-task-monitor') === 'true';
    setTaskMonitor(storedMonitor);
```

with:

```ts
    selectLeftView(DEFAULT_LEFT_VIEW);
    const storedMonitor = localStorage.getItem('moderado-task-monitor') !== 'false';
    setTaskMonitor(storedMonitor);
```

and delete the line `setSidebarCollapsed(localStorage.getItem('moderado-sidebar-collapsed') === 'true');`.

Replace the sidebar listeners (lines 1813-1820) with:

```ts
function moveRailFocus(key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.rail-tabs .rail-tab'));
  if (!tabs.length) return;
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
  tabs[nextMenuIndex(current, tabs.length, key)]?.focus();
}
document.querySelectorAll<HTMLButtonElement>('.rail-tabs .rail-tab').forEach((button) => {
  button.addEventListener('click', () => selectLeftView(parseLeftView(button.dataset.rail ?? null)));
});
document.querySelector<HTMLElement>('.rail-tabs')?.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    moveRailFocus(event.key);
  }
});
document.querySelectorAll<HTMLButtonElement>('.rail-pages .rail-tab').forEach((button) => {
  button.addEventListener('click', () => {
    const page = button.dataset.pageLink as AppPage;
    if (activePage === page) { setPageMode(null); button.focus(); }
    else switchPage(page);
  });
});
$('preview-back').addEventListener('click', closePreview);
```

Replace the old workspace-tab listener:

```ts
document.querySelectorAll<HTMLButtonElement>('.panel-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchWorkspaceView(parseWorkspaceView(tab.dataset.view ?? null)));
});
```

with:

```ts
document.querySelectorAll<HTMLButtonElement>('[data-git-tab]').forEach((tab) => {
  tab.addEventListener('click', () => switchGitView(parseGitView(tab.dataset.gitTab ?? null)));
});
```

In the create-work-task handler, replace `switchPanel('library')` with `selectLeftView('workspaces')`.

In the new-project session handler, replace `switchPanel('library')` with `selectLeftView('workspaces')`.

- [ ] **Step 6: Style the rail shell in `src/renderer/style.css`**

Apply these exact replacements:

1. Replace `.app{display:grid;grid-template-columns:292px minmax(0,1fr);height:100vh;min-height:540px}` with:

```css
.app{display:grid;grid-template-columns:auto minmax(0,1fr);height:100vh;min-height:540px;min-width:760px;position:relative;overflow:hidden}
```

2. Delete `.app{grid-template-columns:var(--sidebar-width,280px) minmax(0,1fr);min-width:760px;position:relative}.app.sidebar-collapsed{grid-template-columns:0 minmax(0,1fr)}`.

3. Delete the four `.sidebar-tabs` / `.sidebar-tab` rules.

4. Replace `.sidebar{overflow:hidden;min-width:0;padding:0;display:flex;flex-direction:column;background:#14263b}` with:

```css
.sidebar{overflow:hidden;min-width:0;min-height:0;height:100%;padding:0;display:flex;flex-direction:column;background:#14263b}
```

5. Replace the `@media(max-width:850px){.app{grid-template-columns:225px minmax(0,1fr)}.sidebar{padding:20px 5%}.topbar{padding:22px}.transcript{padding:24px 5%}.composer-wrap{padding:0 5% 18px}}` block with:

```css
@media(max-width:850px){.topbar{padding:0 16px}.transcript{padding:24px 5%}.composer-wrap{padding:0 5% 18px}}
```

6. Delete the entire `@media(max-width:650px){...}` block that changes `.app`, `.sidebar`, `.brand`, `.sidebar-section`, `.settings`, `.sidebar-footer`, `.main`, `.diff`, `.empty-state`.

7. Delete `.app.sidebar-collapsed .sidebar`, `.app.sidebar-collapsed .transcript`, and `.app.sidebar-collapsed .composer-wrap` rules.

8. Replace `.app.page-mode{grid-template-columns:minmax(0,1fr)}.app.page-mode .sidebar{display:none}` with `.app.page-mode{grid-template-columns:auto minmax(0,1fr)}`.

9. Replace `.workspace-view{display:none;flex-direction:column;min-height:0;flex:1}.workspace-view.active{display:flex}` with:

```css
.files-view,.git-view{display:none;flex-direction:column;min-height:0;flex:1}.files-view.active,.git-view.active{display:flex}
```

10. Replace `.sidebar-panel[data-panel-content="preview"] .file-preview-content{...}` with `#preview-view .file-preview-content{...}` keeping the same declarations.

11. Replace every `.sidebar-panel[data-panel-content="library"]` selector with `.sidebar-panel[data-left-view="workspaces"]` (four occurrences).

12. Replace `.app.task-monitor-open{grid-template-columns:var(--sidebar-width,280px) minmax(0,1fr) var(--task-monitor-width,320px)}` with `.app.task-monitor-open{grid-template-columns:auto minmax(0,1fr) var(--task-monitor-width,320px)}` and delete `.app.sidebar-collapsed.task-monitor-open{...}`.

13. In the `@media(max-width:1100px)` block, replace `.app.task-monitor-open{grid-template-columns:var(--sidebar-width,280px) minmax(0,1fr)}` with `.app.task-monitor-open{grid-template-columns:auto minmax(0,1fr)}` and delete the `.app.sidebar-collapsed.task-monitor-open{...}` line. Delete the following `@media(max-width:650px){.app.task-monitor-open...}` block.

14. Replace `.app.page-mode.task-monitor-open{grid-template-columns:minmax(0,1fr)}` with `.app.page-mode.task-monitor-open{grid-template-columns:auto minmax(0,1fr)}`.

15. Delete `@media(max-width:650px){.sidebar-resizer{display:none}}` from the resizer rule.

Append this block at the end of `style.css`:

```css
/* The rail shell: one header band over the rail and the Left Pane. */
.left-shell{grid-area:1/1;display:grid;grid-template-columns:52px var(--sidebar-width,260px);grid-template-rows:56px minmax(0,1fr);grid-template-areas:"head head" "rail pane";min-width:0;min-height:0;height:100%;background:#14263b;border-right:1px solid #2a4258}
.shell-head{grid-area:head;display:flex;align-items:center;gap:10px;min-width:0;padding:0 10px;border-bottom:1px solid #2a4258}
.shell-head .brand{min-width:0;gap:8px;font-size:13px;letter-spacing:-.02em;overflow:hidden}
.shell-head .brand-mark{flex:none;width:26px;height:26px;border-radius:8px;font-size:16px}
.brand-word{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
.shell-head .kind-segment{flex:none;margin-left:auto}
.rail{grid-area:rail;display:flex;flex-direction:column;align-items:center;gap:4px;min-height:0;padding:8px 0;overflow:hidden;border-right:1px solid #2a4258}
.rail-tabs,.rail-pages{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%}
.rail-pages{margin-top:auto}
.rail-tab{display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;border-radius:8px;background:transparent;color:#8ea8b7;cursor:pointer}
.rail-tab:hover{background:#1d354b;color:#e5f3f7}
.rail-tab.selected,.rail-tab[aria-current="page"]{background:#1d354b;color:#65cbbd}
.rail-tabs .rail-tab.selected{box-shadow:inset 2px 0 #65cbbd}
.rail-tab svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.sidebar{grid-area:pane}
.topbar{height:56px;padding:0 20px;flex:none}
.topbar .topbar-title{min-width:0}
.topbar .topbar-title .eyebrow{margin-bottom:2px}
.topbar .topbar-title h1{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar #workspace-context{margin:0;max-width:min(38vw,520px)}
.topbar .session-actions{margin-top:0;flex:none}
#preview-view .file-preview-content{flex:1;min-height:0;max-height:none;margin:0;border:0;border-radius:0;padding:10px 14px}
```

- [ ] **Step 7: Add the light counterparts in `src/renderer/theme.css`**

Delete `:root[data-theme="light"] .sidebar-tabs{border-color:var(--light-border)}` and the three `.sidebar-tab` light rules. Insert, next to the remaining `.sidebar` rule:

```css
:root[data-theme="light"] .left-shell{background:var(--light-panel);border-color:var(--light-border)}
:root[data-theme="light"] .shell-head{border-color:var(--light-border)}
:root[data-theme="light"] .rail{border-color:var(--light-border)}
:root[data-theme="light"] .rail-tab{color:#45616c}
:root[data-theme="light"] .rail-tab:hover{background:#dbeaec;color:#123f42}
:root[data-theme="light"] .rail-tab.selected,
:root[data-theme="light"] .rail-tab[aria-current="page"]{background:#d5e9e8;color:#134846}
```

- [ ] **Step 8: Run the focused tests**

Run:

```bash
node --test tests/session-kind.test.mjs tests/right-panel.test.mjs tests/pages.test.mjs tests/tools-menu.test.mjs tests/theme.test.mjs
npx tsc --noEmit
```

Expected: PASS for the five files, and no TypeScript errors. `grep` must find no `defaultPanel`, `parseWorkspaceView`, `SidebarPanel`, `workspaceViewKey`, or `setSidebarCollapsed` left in `src/`.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/sessions-view.ts src/renderer/main.ts src/renderer/style.css src/renderer/theme.css index.html tests/session-kind.test.mjs tests/right-panel.test.mjs tests/pages.test.mjs tests/tools-menu.test.mjs tests/theme.test.mjs
git commit -m "feat: restore the activity rail and merged shell header"
```

---

### Task 2: Right Pane three-control header

**Files:**
- Modify: `index.html`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/tools-menu.ts`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/theme.css`
- Test: `tests/right-panel.test.mjs`, `tests/tools-menu.test.mjs`, `tests/theme.test.mjs`

**Interfaces:**
- Consumes: `selectLeftView('files')` from Task 1; existing `setTerminalOpen`, `setTaskMonitor`, `renderTaskMonitor`, `openToolsMenu`, `closeToolsMenu`, `moveToolsFocus`.
- Produces:
  - `ToolAction = 'files' | 'terminal-panel' | 'vscode' | 'system-terminal'`
  - `ToolItem = { action: ToolAction; label: string }`; `TOOL_ITEMS` is `['files', 'system-terminal', 'vscode']`
  - DOM: `#tools-toggle`, `#tools-menu`, `#terminal-panel`, `#task-monitor-close`, `#task-monitor-open`.
  - `setTaskMonitor(open: boolean, focus = false)`.

- [ ] **Step 1: Update the tests**

Replace `tests/tools-menu.test.mjs` with:

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
  assert.deepEqual(TOOL_ITEMS.map((item) => item.action), ['files', 'system-terminal', 'vscode']);
  assert.deepEqual(TOOL_ITEMS.map((item) => item.label), ['File browser', 'Open system terminal', 'Open in VS Code']);
});

test('the File browser action selects the Files rail tab', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /function syncToolMenu\(\): void/);
  assert.match(main, /function runTool\(action: ToolAction\): void/);
  assert.match(main, /if \(action === 'files'\) \{ selectLeftView\('files'\); return; \}/);
});

test('choosing a menu item returns focus to the trigger', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /function runTool\(action: ToolAction\): void \{\s*closeToolsMenu\(true\);/);
});

test('the right header renders the three controls and the three-item menu', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="tools-toggle"[^>]*aria-haspopup="menu"/);
  assert.match(html, /id="tools-menu"[^>]*role="menu"/);
  for (const action of ['files', 'system-terminal', 'vscode']) {
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
  assert.match(html, /data-tool="vscode">Open in VS Code/);
  assert.match(html, /data-tool="system-terminal">Open system terminal/);
  assert.match(main, /invoke\('open_in_editor', browserArgs\(\)\)/);
  assert.match(main, /invoke\('open_system_terminal', browserArgs\(\)\)/);
});
```

In `tests/right-panel.test.mjs`, replace the test `the task monitor is the only right-hand surface` with:

```js
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
  assert.match(main, /\$<'HTMLButtonElement'>\('terminal-panel'\)/, 'the terminal toggle reflects the drawer');
});
```

(If the last assertion is awkward in a plain `.mjs` file, use the literal `/HTMLButtonElement>\('terminal-panel'\)/` regex form instead.)

In `tests/theme.test.mjs`, add `.monitor-button`, `.monitor-head`, and `.monitor-edge` to the shell-surface selector list and remove `.monitor-head h2`:

```js
  for (const selector of [
    '.left-shell', '.shell-head', '.rail', '.rail-tab', '.rail-tab.selected',
    '.terminal-drawer', '.terminal-head', '.tools-menu',
    '.task-monitor', '.monitor-head', '.monitor-button', '.monitor-edge',
    '.monitor-section', '.monitor-section h3',
    '.monitor-item', '.monitor-item strong', '.monitor-item span', '.monitor-item.error',
    '.monitor-item.running', '.monitor-artifact', '.monitor-artifact:hover',
  ]) {
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
node --test tests/tools-menu.test.mjs tests/right-panel.test.mjs tests/theme.test.mjs
```

Expected: FAIL — the menu still has seven items and the monitor still has a title and a close button.

- [ ] **Step 3: Replace the menu model in `src/renderer/tools-menu.ts`**

Replace lines 1-22 with:

```ts
export type ToolAction = 'files' | 'terminal-panel' | 'vscode' | 'system-terminal';
export type ToolContext = { kind: 'work' | 'code'; hasWorkspace: boolean };
export type ToolItem = { action: ToolAction; label: string };

/** The Right Pane menu: the three things that are not rail destinations. */
export const TOOL_ITEMS: readonly ToolItem[] = [
  { action: 'files', label: 'File browser' },
  { action: 'system-terminal', label: 'Open system terminal' },
  { action: 'vscode', label: 'Open in VS Code' },
];
```

Keep `toolDisabledReason` and `nextMenuIndex` unchanged.

- [ ] **Step 4: Replace the Right Pane markup in `index.html`**

Add this symbol next to the other icons:

```html
        <symbol id="icon-collapse" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
```

Replace the whole `<aside id="task-monitor">` block (lines 119-136) with:

```html
      <aside id="task-monitor" class="task-monitor" aria-label="Task monitor" hidden>
        <header class="monitor-head">
          <div class="tools-wrap">
            <button id="tools-toggle" class="monitor-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="tools-menu" aria-label="Tools" title="Tools"><svg aria-hidden="true"><use href="#icon-tools"/></svg></button>
            <div id="tools-menu" class="tools-menu" role="menu" aria-label="Tools" hidden>
              <button type="button" role="menuitem" data-tool="files">File browser</button>
              <button type="button" role="menuitem" data-tool="system-terminal">Open system terminal</button>
              <button type="button" role="menuitem" data-tool="vscode">Open in VS Code</button>
            </div>
          </div>
          <button id="terminal-panel" class="monitor-button" type="button" aria-pressed="false" aria-label="Open terminal panel" title="Open terminal panel"><svg aria-hidden="true"><use href="#icon-terminal"/></svg></button>
          <button id="task-monitor-close" class="monitor-button" type="button" aria-label="Collapse task monitor" title="Collapse task monitor"><svg aria-hidden="true"><use href="#icon-collapse"/></svg></button>
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
      <button id="task-monitor-open" class="monitor-edge" type="button" aria-label="Open task monitor" title="Open task monitor" hidden><svg aria-hidden="true"><use href="#icon-panel"/></svg></button>
```

Delete the old Tools menu from the topbar (the `.tools-wrap` block, lines 53-67). The topbar controls keep Plan/Act and the theme toggle.

- [ ] **Step 5: Update `src/renderer/main.ts`**

Replace `setTaskMonitor` (lines 1014-1021) with:

```ts
function setTaskMonitor(open: boolean, focus = false): void {
  taskMonitorOpen = open;
  document.querySelector<HTMLElement>('.app')?.classList.toggle('task-monitor-open', open);
  $('task-monitor').toggleAttribute('hidden', !open);
  $('task-monitor-open').toggleAttribute('hidden', open);
  closeToolsMenu();
  try { localStorage.setItem('moderado-task-monitor', String(open)); } catch { /* applies for this run */ }
  syncToolMenu();
  if (open) renderTaskMonitor();
  if (focus) (open ? $('task-monitor-close') : $('task-monitor-open')).focus();
}
```

Replace `syncToolMenu` with:

```ts
function syncToolMenu(): void {
  const context = { kind: activeKind, hasWorkspace: Boolean(currentFolder()) };
  for (const button of menuToolButtons()) {
    const action = button.dataset.tool as ToolAction;
    const reason = toolDisabledReason(action, context);
    button.disabled = reason !== null;
    button.toggleAttribute('aria-disabled', reason !== null);
    button.title = reason ?? '';
  }
  const terminal = $<HTMLButtonElement>('terminal-panel');
  const terminalReason = toolDisabledReason('terminal-panel', context);
  terminal.disabled = terminalReason !== null;
  terminal.setAttribute('aria-disabled', String(terminalReason !== null));
  terminal.title = terminalReason ?? (terminalOpen ? 'Close terminal panel' : 'Open terminal panel');
  terminal.setAttribute('aria-pressed', String(terminalOpen));
}
```

Replace `runTool` with:

```ts
function runTool(action: ToolAction): void {
  closeToolsMenu(true);
  if (action === 'files') { selectLeftView('files'); return; }
  if (action === 'vscode') {
    void invoke('open_in_editor', browserArgs()).catch((error) => setStatus(String(error)));
    return;
  }
  if (action === 'system-terminal') {
    void invoke('open_system_terminal', browserArgs()).catch((error) => setStatus(String(error)));
  }
}
```

Replace the monitor listeners:

```ts
$('task-monitor-close').addEventListener('click', () => setTaskMonitor(false, true));
$('task-monitor-open').addEventListener('click', () => setTaskMonitor(true, true));
$('terminal-panel').addEventListener('click', () => { void setTerminalOpen(!terminalOpen); });
```

The existing `#tools-toggle` click, menu click/keydown, pointerdown, and Escape listeners stay unchanged.

- [ ] **Step 6: Style and theme the Right Pane**

In `style.css`, replace `.monitor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px}` and `.monitor-head h2{margin:3px 0 0;font-size:14px}` with:

```css
.monitor-head{display:flex;align-items:center;justify-content:flex-end;gap:6px;height:56px;padding:0 10px;border-bottom:1px solid #2a4258}
.monitor-button{display:grid;place-items:center;width:34px;height:34px;padding:0;border:1px solid #37536a;border-radius:8px;background:#1d354b;color:#cde2e8;cursor:pointer}
.monitor-button:hover:not(:disabled){border-color:#65cbbd}
.monitor-button:disabled{opacity:.5;cursor:not-allowed}
.monitor-button[aria-pressed="true"]{border-color:#65cbbd;color:#65cbbd}
.monitor-button svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.monitor-edge{position:absolute;right:0;top:50%;transform:translateY(-50%);z-index:9;display:grid;place-items:center;width:24px;height:64px;padding:0;border:1px solid #2a4258;border-right:0;border-radius:8px 0 0 8px;background:#101f30;color:#8ea8b7;cursor:pointer}
.monitor-edge:hover{color:#65cbbd;border-color:#65cbbd}
.monitor-edge svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.monitor-edge[hidden]{display:none}
```

Replace `.app.task-monitor-open{grid-template-columns:auto minmax(0,1fr) var(--task-monitor-width,320px)}` with `.app.task-monitor-open{grid-template-columns:auto minmax(0,1fr) 320px}`.

Delete the `.topbar-toggle` rule and `.topbar-toggle:hover` / `.topbar-toggle svg` rules. Keep `.tools-wrap` and `.tools-menu`.

In `theme.css`, delete `:root[data-theme="light"] .topbar-toggle{...}`, `.topbar-toggle:hover`, and `.monitor-head h2` rules. Add:

```css
:root[data-theme="light"] .monitor-head{border-color:var(--light-border)}
:root[data-theme="light"] .monitor-button{background:#e3eff1;border-color:var(--light-border);color:#4c6571}
:root[data-theme="light"] .monitor-button[aria-pressed="true"]{border-color:var(--light-accent);color:var(--light-accent)}
:root[data-theme="light"] .monitor-edge{background:var(--light-panel);border-color:var(--light-border);color:#4c6571}
:root[data-theme="light"] .monitor-edge:hover{color:#134846;border-color:var(--light-accent)}
```

- [ ] **Step 7: Run the focused tests**

```bash
node --test tests/tools-menu.test.mjs tests/right-panel.test.mjs tests/theme.test.mjs tests/pages.test.mjs
npx tsc --noEmit
```

Expected: PASS and no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add index.html src/renderer/main.ts src/renderer/tools-menu.ts src/renderer/style.css src/renderer/theme.css tests/tools-menu.test.mjs tests/right-panel.test.mjs tests/theme.test.mjs
git commit -m "feat: give the right pane its three-control header"
```

---

### Task 3: Responsive shell and dead-rule cleanup

**Files:**
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/theme.css`
- Test: `tests/right-panel.test.mjs`

**Interfaces:**
- Consumes: the four-column grid from Tasks 1-2.
- Produces: breakpoints at 1199 px and 999 px; no `sidebar-collapsed`, `task-monitor-width`, 850 px, or 650 px shell rules.

- [ ] **Step 1: Add the failing responsive assertions**

Append to `tests/right-panel.test.mjs`:

```js
test('the shell degrades without hiding the rail', async () => {
  const [style, theme] = await Promise.all([read('src/renderer/style.css'), read('src/renderer/theme.css')]);
  assert.match(style, /@media\(max-width:1199px\)\{\s*\.app\.task-monitor-open\{grid-template-columns:auto minmax\(0,1fr\)\}/);
  assert.match(style, /\.task-monitor\{position:absolute;right:0;top:0;bottom:0;width:min\(340px,calc\(100vw - 60px\)\)/);
  assert.match(style, /@media\(max-width:999px\)\{\s*\.left-shell\{grid-template-columns:52px 220px\}/);
  assert.match(style, /@media\(max-width:999px\)\{[^}]*\.sidebar-resizer\{display:none\}/);
  assert.match(style, /@media\(max-width:999px\)\{[^}]*\.topbar #workspace-context\{display:none\}/);
  assert.match(style, /@media\(max-width:999px\)\{[^}]*\.topbar \.session-actions\{display:none\}/);
  assert.doesNotMatch(style, /sidebar-collapsed|task-monitor-width/);
  assert.doesNotMatch(style, /@media\(max-width:850px\)/);
  assert.doesNotMatch(style, /@media\(max-width:650px\)/);
  assert.doesNotMatch(theme, /@media\(max-width:650px\)/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --test tests/right-panel.test.mjs
```

Expected: FAIL — the stylesheet still uses 1100/850/650 px and `--task-monitor-width`.

- [ ] **Step 3: Replace the responsive blocks**

In `style.css`, replace the `@media(max-width:850px){.topbar{padding:0 16px}.transcript{padding:24px 5%}.composer-wrap{padding:0 5% 18px}}` block with:

```css
@media(max-width:999px){
  .left-shell{grid-template-columns:52px 220px}
  .sidebar-resizer{display:none}
  .topbar{padding:0 16px}
  .topbar #workspace-context{display:none}
  .topbar .session-actions{display:none}
  .transcript{padding:24px 5%}
  .composer-wrap{padding:0 5% 18px}
}
```

Replace the whole `@media(max-width:1100px){...}` block with:

```css
@media(max-width:1199px){
  .app.task-monitor-open{grid-template-columns:auto minmax(0,1fr)}
  .task-monitor{position:absolute;right:0;top:0;bottom:0;width:min(340px,calc(100vw - 60px));z-index:8;box-shadow:-18px 0 40px #0007}
}
```

Delete `.app.page-mode.task-monitor-open{grid-template-columns:auto minmax(0,1fr)}` only if the 1199 block already yields the same columns; keep it — page mode must win at every width. Its current declaration is already `auto minmax(0,1fr)`.

Remove the last `@media(max-width:650px){#schedule-form .form-grid{grid-template-columns:1fr}.schedule-section{margin-top:16px}}` block from `style.css` (unreachable at the 760 px window minimum).

In `theme.css`, delete `@media(max-width:650px){.topbar{flex-wrap:wrap;gap:12px}.topbar-controls{width:100%;justify-content:flex-end}}`.

- [ ] **Step 4: Run the shell tests and the whole Node suite**

```bash
node --test tests/right-panel.test.mjs
node scripts/run-node-tests.mjs
```

Expected: all Node tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/style.css src/renderer/theme.css tests/right-panel.test.mjs
git commit -m "fix: make the rail shell responsive at every window width"
```

---

### Task 4: Design docs and full verification

**Files:**
- Modify: `docs/sidebar-design.md`
- Test: full suite (`npm test`, `npm run lint`, `npm run build`)

**Interfaces:**
- Consumes: the shipped shell from Tasks 1-3.
- Produces: documentation that matches the shipped rail shell; no code change.

- [ ] **Step 1: Update `docs/sidebar-design.md`**

Replace the `## Layout` section (lines 9-22) with:

```markdown
## Layout

Revised 2026-11-03: the window is four vertical regions — Activity Rail, Left Pane,
Workspace, and Right Pane.

- The 52 px Activity Rail and the resizable Left Pane (200-560 px, 260 px default)
  share one 56 px merged header. The header carries the Moderado mark and wordmark
  plus the Work/Code segmented control. Below the header the rail and the Left Pane
  are separate columns.
- The rail's top group selects the Left Pane contents: Workspaces, Files, Git, and
  Schedules. Its bottom group opens Settings, Docs, and Profile as full-width pages;
  activating the active page button returns to the conversation.
- The conversation column owns the 56 px topbar (session title, workspace context,
  actions, Plan/Act, theme), the transcript, the composer, and a terminal drawer
  below the composer. The drawer is Code-only and keeps its PTY alive while hidden.
- The Right Pane is the Task Monitor at a fixed 320 px. Its 56 px header has exactly
  three controls: Tools (File browser, Open system terminal, Open in VS Code), the
  terminal-panel toggle, and the collapse triangle. Collapsing leaves a 24 x 64 px
  edge tab that reopens it.
- Pages render inside the workspace column with the rail and Left Pane visible and
  the Right Pane hidden.
- At 1199 px and below the Right Pane overlays the workspace; at 999 px and below
  the Left Pane is clamped to 220 px and the topbar compacts. The rail never hides,
  and the window minimum stays 760 px.
```

Replace the `### Settings` paragraph's opening sentence with:

```markdown
Settings opens as a full-width page from the rail bottom; group the Connection and
Web Search controls there with an About section that carries the app's version and build.
```

Leave the rest of the Settings paragraph and the source-control paragraphs unchanged; the Git view now lives under the Git rail tab instead of the Workspace panel, so change `### Source Control`'s first sentence to:

```markdown
For a Git repository whose root equals the selected workspace, the Git rail tab shows
the current branch, changed and untracked files, and the 50 most recent commits with
short hash, subject, author, and local date.
```

Replace the `## Verification` automated bullet list with:

```markdown
- Rust tests cover folder ordering, workspace path and symlink rejection, file preview bounds, a local Git repository with a commit and a dirty file, and rejection of a nested workspace in a parent repository.
- Frontend checks cover the rail tabs and their keyboard roving, the merged header, each Left Pane destination, the Files preview sub-view, the Git Changes/Checkpoints switch, the three-control Right Pane header and its edge tab, page mode keeping the rail and Left Pane, the Tools menu actions, and the light counterparts of every new surface. `tests/session-kind.test.mjs`, `tests/right-panel.test.mjs`, `tests/pages.test.mjs`, `tests/tools-menu.test.mjs`, and `tests/theme.test.mjs` carry those checks.
- Run `npm test`, `npm run lint`, `npm run build`, and a Tauri startup check. Inspect the layout at 760 px, 1180 px, and a wide desktop width.
```

- [ ] **Step 2: Run the full verification**

```bash
npm test
npm run lint
npm run build
```

Expected: cargo tests green (the known intermittent `provider::tests::stalled_stream_returns_error` may flake once; rerun it before reporting a failure), all Node tests pass, ESLint and Clippy clean, and the Tauri build completes. Nothing is pushed.

- [ ] **Step 3: Manual smoke**

1. The rail, Left Pane, workspace, and Right Pane render as four regions with one aligned 56 px header band.
2. Work/Code in the merged header switches modes; it is absent from the topbar.
3. Each rail tab opens its view; Git shows Changes and Checkpoints; Files has no tab row; selecting a file opens Preview and Back to files returns.
4. Settings, Docs, and Profile open as pages with the rail and Left Pane visible; Back returns to the conversation.
5. The Right Pane's Tools menu launches VS Code and the system terminal; File browser selects Files.
6. The terminal icon toggles the drawer; the triangle collapses the pane, the edge tab reopens it, and the choice survives a restart.
7. At 1180 px the Right Pane overlays; below 1000 px the topbar compacts; at 800 px the Left Pane stays at 220 px and the rail never disappears.

- [ ] **Step 4: Commit**

```bash
git add docs/sidebar-design.md
git commit -m "docs: document the activity rail shell"
```

---

## Self-review

**Spec coverage:** Layout (Task 1 CSS), merged header (Task 1 markup), rail tabs and bottom pages (Task 1), Left Pane destinations and resizer (Task 1), Workspace topbar changes (Task 1), Right Pane header and edge tab (Task 2), pages keep rail and hide monitor (Tasks 1-2 CSS), persistence keys (Tasks 1-2), accessibility roles/roving/focus (Tasks 1-2), responsive rules (Task 3), docs (Task 4). Backend untouched. Every spec section maps to a task.

**Placeholder scan:** no TBD/TODO; every code step carries literal code or an exact selector replacement. The one conditional note in Task 2's test (the generic type assertion) gives the literal fallback regex.

**Type consistency:** `LeftView`, `GitView`, `DEFAULT_LEFT_VIEW`, `parseLeftView`, `parseGitView`, `viewingFiles`, `selectLeftView`, `openPreview`, `closePreview`, `switchGitView`, and `setTaskMonitor(open, focus)` are defined once in Task 1 and consumed under the same names in Tasks 2-4. `ToolAction` keeps `terminal-panel` for the disabled-reason helper even though it is no longer a menu row; the menu model contains only the three actions the spec names.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-03-activity-rail-shell.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh implementer per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.
