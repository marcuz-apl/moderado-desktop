import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_LEFT_VIEW, DEFAULT_SESSION_KIND, GIT_VIEWS, LEFT_VIEWS, needsWorkspacePicker, newSessionLabel, nextSessionKind, parseGitView, parseLeftView, parseSessionKind, profileModeDescription, projectNameFromWorkspace, projectsForSessions, scheduleWriteApprovalChoiceVisible, sessionsForProject, visibleSessions } from '../src/renderer/sessions-view.ts';

const sessions = [
  { id: 'a', kind: 'work' },
  { id: 'b', kind: 'code' },
  { id: 'c', kind: 'work' },
];

test('the session list shows one kind at a time', () => {
  assert.deepEqual(visibleSessions(sessions, 'work').map((s) => s.id), ['a', 'c']);
  assert.deepEqual(visibleSessions(sessions, 'code').map((s) => s.id), ['b']);
  assert.deepEqual(visibleSessions([], 'work'), []);
});

test('only Code sessions ask for a project folder', () => {
  assert.equal(needsWorkspacePicker('code'), true);
  assert.equal(needsWorkspacePicker('work'), false);
});

test('Work is the default session kind and the selector toggles both ways', () => {
  assert.equal(DEFAULT_SESSION_KIND, 'work');
  assert.equal(nextSessionKind('work'), 'code');
  assert.equal(nextSessionKind('code'), 'work');
});

test('the Plan/Act selector hides in Work mode', async () => {
  const [html, main] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="agent-mode" class="mode-control"/);
  assert.match(main, /\$\('agent-mode'\)\.toggleAttribute\('hidden', work\)/);
});

test('new session action names the selected session kind', () => {
  assert.equal(newSessionLabel('work'), '+ New Work session');
  assert.equal(newSessionLabel('code'), '+ New Code session');
});

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

test('the merged shell header holds Work/Code and the topbar does not', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(html, /class="left-shell">[\s\S]*class="shell-head">[\s\S]*class="kind-segment"[\s\S]*id="kind-work"[\s\S]*id="kind-code"/);
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>', html.indexOf('<header class="topbar">')));
  assert.doesNotMatch(topbar, /id="kind-work"|id="kind-code"|class="kind-segment"|id="sidebar-toggle"/);
  assert.match(html, /class="rail-tabs"[^>]*role="tablist"[^>]*aria-orientation="vertical"[\s\S]*data-rail="workspaces"[\s\S]*data-rail="files"[\s\S]*data-rail="git"[\s\S]*data-rail="schedules"/);
  const railPages = html.slice(html.indexOf('class="rail-pages"'), html.indexOf('</aside>'));
  assert.match(railPages, /data-page-link="profile"[\s\S]*data-page-link="docs"[\s\S]*data-page-link="settings"/);
  assert.match(html, /class="session-actions">[\s\S]*id="new-session"/);
  assert.doesNotMatch(html, /empty-symbol[^<]*<img/);
  assert.match(main, /radio\.type = 'radio'/);
  // The design doc claims the rail's keyboard roving is covered by frontend checks.
  const railTabs = html.slice(html.indexOf('class="rail-tabs"'), html.indexOf('class="rail-pages"'));
  assert.equal((railTabs.match(/tabindex="0"/g) ?? []).length, 1, 'only the selected rail tab is tabbable');
  assert.equal((railTabs.match(/tabindex="-1"/g) ?? []).length, 3, 'every other rail view leaves the tab order');
  assert.equal((railTabs.match(/aria-selected="true"/g) ?? []).length, 1, 'one tab is selected');
  assert.equal((railTabs.match(/aria-selected="false"/g) ?? []).length, 3);
  assert.match(main, /function moveRailFocus\(key: 'ArrowDown' \| 'ArrowUp' \| 'Home' \| 'End'\): void \{[\s\S]*?tabs\[nextMenuIndex\(current, tabs\.length, key\)\]\?\.focus\(\)/, 'rail roving reuses the shared menu-index helper');
  assert.match(main, /\.rail-tabs'\)\?\.addEventListener\('keydown', \(event\) => \{\s*if \(event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp' \|\| event\.key === 'Home' \|\| event\.key === 'End'\) \{\s*event\.preventDefault\(\);\s*moveRailFocus\(event\.key\);/, 'arrow, Home and End keys move the rail');
  assert.match(main, /button\.setAttribute\('aria-selected', String\(selected\)\);\s*button\.tabIndex = selected \? 0 : -1;/, 'selection writes aria-selected and the roving tabindex');
});

test('both modes share one Left Pane and one rail', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const views = [...html.matchAll(/data-left-view="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(views, ['workspaces', 'files', 'git', 'schedules']);
  assert.doesNotMatch(html, /data-panel-content=/);
  assert.doesNotMatch(html, /id="sidebar-toggle"/);
  assert.doesNotMatch(html, /class="activity-bar"|class="activity-button"/);
  assert.match(html, /<aside class="sidebar" id="sidebar" role="tabpanel" aria-label="Left pane">/);
});

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
  assert.match(main, /const storedLeftView = activeLeftView[\s\S]*selectLeftView\(storedLeftView\)/, 'initialize restores the stored left view');
  assert.match(main, /localStorage\.setItem\(gitViewKey, view\)/, 'the Git tab is remembered');
});

test('a Work/Code switch never resets or persists the rail view', async () => {
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const setKindBody = main.match(/async function setKind\([\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(setKindBody.length > 0, 'the setKind body is captured');
  assert.doesNotMatch(setKindBody, /selectLeftView|leftViewKey/, 'a mode switch never changes or persists the rail view');
  assert.match(setKindBody, /applyLeftView\(\)/);
});

test('project operations stay under Projects and session navigation remains nested without session actions', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  const panel = html.match(/data-left-view="workspaces">([\s\S]*?)<\/section>/)?.[1] ?? '';
  assert.match(panel, /class="project-operations"[\s\S]*id="new-project"[\s\S]*id="open-project"[\s\S]*id="rename-project"[\s\S]*id="remove-project"/);
  assert.match(main, /className = work \? 'task-sessions' : 'project-sessions'/);
  assert.match(style, /\.project-sessions\{padding:[^}]*\}/);
  assert.doesNotMatch(main, /\['New Session',[\s\S]*renameProject\(project\)/);
});

test('Work task actions stay in Tasks while session controls stay in the workspace', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  const taskPanel = html.match(/data-left-view="workspaces">([\s\S]*?)<\/section>/)?.[1] ?? '';
  const workspace = html.match(/class="session-actions">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.match(taskPanel, /class="task-operations"[\s\S]*id="workspace-button"[\s\S]*id="rename-task"[\s\S]*id="delete-task"/);
  assert.match(workspace, /id="new-session"[\s\S]*id="rename-session"[\s\S]*id="delete-session"/);
  assert.match(main, /className = work \? 'task-sessions' : 'project-sessions'/);
  assert.match(main, /session\.taskId/);
  assert.match(style, /\.task-sessions\{padding:[^}]*\}/);
  assert.match(style, /data-left-view="workspaces"\] \.session-item\.selected[^}]*background:transparent/);
  assert.match(main, /session\.taskId === entry\.key/);
});

test('About displays the VERSION value without its BUILD metadata or an extra label', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(html, /<p class="workspace-name">Moderado Desktop<\/p><p class="path"><span id="about-version"><\/span><\/p>/);
  assert.match(main, /appVersion\.trim\(\)\.split\('\+'\)\[0\]/);
});

test('Code Explorer exposes manual file operations from its context menu', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const rust = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(html, /id="explorer-context-menu"[^>]*role="menu"/);
  assert.match(html, /data-explorer-action="new-file"/);
  assert.match(html, /data-explorer-action="new-folder"/);
  assert.match(html, /data-explorer-action="rename"/);
  assert.match(html, /data-explorer-action="delete"/);
  assert.match(main, /addEventListener\('contextmenu'/);
  for (const command of ['create_project_file', 'create_project_folder', 'rename_project_entry', 'delete_project_entry']) {
    assert.match(main, new RegExp(`invoke\\([^,]*'${command}'`));
    assert.match(rust, new RegExp(`fn ${command}\\(`));
  }
});

test('all five Auto-Approve options default on and MCP is marked as a placeholder', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['approve-read', 'approve-edit', 'approve-web', 'approve-command', 'approve-mcp']) {
    assert.match(html, new RegExp(`<input id="${id}" type="checkbox" checked`));
  }
  assert.match(html, /id="approve-mcp" type="checkbox" checked disabled/);
  assert.match(html, /MCP server support is a placeholder/);
});

test('Auto-Approve controls sit directly above the message composer', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  const composer = html.match(/<div class="composer-wrap">([\s\S]*?)<section class="page"/)?.[1] ?? '';
  assert.match(composer, /id="auto-approve-group"/);
  assert.ok(composer.indexOf('id="auto-approve-group"') < composer.indexOf('id="composer"'));
  assert.match(composer, /class="auto-approve-bar"/);
  assert.doesNotMatch(composer, /id="save-auto-approve"/);
  assert.match(style, /\.auto-approve-bar\{padding:0;border:0;border-radius:0;background:transparent\}/);
  assert.match(style, /\.message\{max-width:none\}/);
  assert.doesNotMatch(html.slice(0, html.indexOf('<main class="main">')), /id="auto-approve-group"/);
});

test('the composer offers a plus in both modes and a file menu in Code', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  assert.match(html, /id="attach-files" class="composer-attach"[^>]*aria-label="Attach files"[^>]*><svg/);
  assert.doesNotMatch(html, /id="attach-files"[^>]*\bhidden\b/, 'the plus is present in both modes');
  assert.match(html, /id="mention-menu"[^>]*role="listbox"[^>]*hidden/);
  assert.match(html, /id="mention-files" class="composer-attach composer-at"[^>]*aria-label="Reference a project file"/);
  // The @ button stays visible in Work and explains itself, rather than vanishing
  // and making the composer look like a different app in each mode.
  assert.match(main, /mentionButton\.disabled = selectingContext \|\| work \|\|/, 'the at button is disabled, not hidden, in Work');
  assert.doesNotMatch(main, /mentionButton\.toggleAttribute\('hidden'/);
  assert.match(main, /File references are available in Code sessions/);
  assert.match(main, /invoke<string\[\]>/);
  assert.match(main, /mentionQuery\(prompt\.value/);
  assert.match(style, /\.composer-stop svg\{width:18px;height:18px\}/);
});

test('composer footer pairs the model with the shortcut hint and always shows stop', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  const bottom = html.match(/<div class="composer-bottom">([\s\S]*?)<\/form>/)?.[1] ?? '';
  assert.match(bottom, /id="selected-model"/);
  assert.match(bottom, /class="composer-shortcuts"/);
  assert.ok(bottom.indexOf('id="selected-model"') < bottom.indexOf('class="composer-shortcuts"'), 'model leads the row');
  assert.ok(bottom.indexOf('id="send"') < bottom.indexOf('id="stop"'), 'stop sits right of send');
  assert.doesNotMatch(html, /id="stop"[^>]*\bhidden\b/);
  assert.match(style, /#send\.composer-send\{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0\}/);
  assert.match(style, /\.composer-stop\.running \.stop-square\{display:block\}/);
  assert.match(style, /\.composer-stop \.stop-square\{display:none;fill:#e2564a\}/);
});

test('token usage sits beside Auto-approve, outside the composer box', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  const composer = html.match(/<div class="composer-wrap">([\s\S]*?)<section class="page"/)?.[1] ?? '';
  const topbar = composer.match(/<div class="composer-topbar">([\s\S]*?)<form id="composer">/)?.[1] ?? '';
  assert.match(topbar, /id="auto-approve-group"/);
  assert.match(topbar, /id="model-usage"/);
  assert.ok(topbar.indexOf('id="auto-approve-group"') < topbar.indexOf('id="model-usage"'));
  const form = composer.match(/<form id="composer">([\s\S]*?)<\/form>/)?.[1] ?? '';
  assert.doesNotMatch(form, /id="model-usage"/);
  assert.match(style, /\.model-usage\{[^}]*font-size:11px/);
});

test('Work profile does not require a GitHub account', () => {
  assert.match(profileModeDescription('work'), /not required/i);
  assert.match(profileModeDescription('code'), /optional GitHub account/i);
});

test('Explorer root uses the project folder name on Windows and Unix paths', () => {
  assert.equal(projectNameFromWorkspace('C:\\Users\\me\\Documents\\my-project', 'Session label'), 'my-project');
  assert.equal(projectNameFromWorkspace('/home/me/code/my-project/', 'Session label'), 'my-project');
  assert.equal(projectNameFromWorkspace('', 'Session label'), 'Session label');
});

test('projects group Code sessions by workspace and exclude Work sessions', () => {
  const grouped = projectsForSessions([
    { id: 'w1', name: 'Work task', workspace: '/docs/work-session0', kind: 'work', updatedAt: 9 },
    { id: 'c1', name: 'First', workspace: 'C:\\code\\alpha', kind: 'code', updatedAt: 10 },
    { id: 'c2', name: 'Second', workspace: 'C:\\code\\alpha', kind: 'code', updatedAt: 30 },
    { id: 'c3', name: 'Third', workspace: '/home/me/beta', kind: 'code', updatedAt: 20 },
  ]);

  assert.deepEqual(grouped, [
    { workspace: 'C:\\code\\alpha', name: 'alpha', sessionCount: 2, latestSessionId: 'c2', updatedAt: 30 },
    { workspace: '/home/me/beta', name: 'beta', sessionCount: 1, latestSessionId: 'c3', updatedAt: 20 },
  ]);
});

test('sessionsForProject only returns Code sessions in the selected workspace', () => {
  const sessions = [
    { id: 'w1', workspace: '/repo', kind: 'work' },
    { id: 'c1', workspace: '/repo', kind: 'code' },
    { id: 'c2', workspace: '/other', kind: 'code' },
  ];

  assert.deepEqual(sessionsForProject(sessions, '/repo').map((session) => session.id), ['c1']);
  assert.deepEqual(sessionsForProject(sessions, '/unknown'), []);
  assert.deepEqual(sessionsForProject(sessions, ''), []);
});

test('write approval choice is only available to Code sessions', () => {
  assert.equal(scheduleWriteApprovalChoiceVisible('work'), false);
  assert.equal(scheduleWriteApprovalChoiceVisible('code'), true);
});
