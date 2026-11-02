import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_SESSION_KIND, defaultPanel, needsWorkspacePicker, newSessionLabel, nextSessionKind, parseSessionKind, parseWorkspaceView, profileModeDescription, projectNameFromWorkspace, projectsForSessions, scheduleWriteApprovalChoiceVisible, sessionsForProject, visibleSessions } from '../src/renderer/sessions-view.ts';

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

test('new session action names the selected session kind', () => {
  assert.equal(newSessionLabel('work'), '+ New Work session');
  assert.equal(newSessionLabel('code'), '+ New Code session');
});

test('no panel is mode-specific any more', () => {
  // The rail is the same in both modes; only panel contents differ. Git, the last
  // mode-dependent panel, is now a tab inside Workspace.
  assert.equal(defaultPanel(), 'library');
  assert.equal(parseSessionKind('code'), 'code');
  assert.equal(parseSessionKind('work'), 'work');
  assert.equal(parseSessionKind(null), 'work');
  assert.equal(parseSessionKind('unexpected'), 'work');
  assert.equal(parseWorkspaceView('changes'), 'changes');
  assert.equal(parseWorkspaceView('checkpoints'), 'checkpoints');
  assert.equal(parseWorkspaceView(null), 'explorer');
  assert.equal(parseWorkspaceView('source-control'), 'explorer', 'retired names fall back');
});

test('top bar contains the Work/Code switch and Explorer owns the folder icon', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(html, /class="kind-segment"[\s\S]*id="kind-work"[\s\S]*id="kind-code"/);
  assert.match(html, /class="kind-stack"><div class="kind-segment"[\s\S]*<p class="eyebrow">AGENT SESSION<\/p><h1 id="session-title"/);
  assert.match(html, /class="session-actions">[\s\S]*id="new-session"/);
  assert.doesNotMatch(html, /data-panel="mode"|data-panel-content="mode"/);
  assert.match(main, /radio\.type = 'radio'/);
  assert.match(html, /data-panel="workspace"[^>]*aria-label="Workspace"[^>]*>[\s\S]*?#icon-folder/);
  assert.match(html, /data-panel="library"[^>]*>[\s\S]*?#icon-projects/);
  assert.match(html, /<span>⌘<\/span><\/div>/);
  assert.doesNotMatch(html, /empty-symbol[^<]*<img/);
});

test('both modes share one activity rail', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const rail = [...html.matchAll(/class="activity-button" data-panel="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rail, ['library', 'workspace', 'schedules', 'profile'], 'four panels, identical in both modes');
  assert.doesNotMatch(html, /data-panel="explorer"|data-panel="checkpoints"|data-panel="source-control"/);
  const pages = [...html.matchAll(/class="activity-button" data-page="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(pages, ['docs', 'settings'], 'the manual sits above settings, which stays at the bottom');
  assert.doesNotMatch(html, /data-panel="tasks"|data-panel="projects"/);
  assert.doesNotMatch(html, /data-panel-content="settings"/, 'settings no longer lives in the sidebar');
  assert.match(html, /data-panel-content="library"><header class="panel-heading"><h2 id="library-title">/);
});

test('Workspace holds the file, change and checkpoint views as tabs', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const panel = html.slice(html.indexOf('data-panel-content="workspace"'), html.indexOf('data-panel-content="schedules"'));
  const tabs = [...panel.matchAll(/class="panel-tab[^"]*" type="button" role="tab" data-view="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['explorer', 'changes', 'checkpoints']);
  const views = [...panel.matchAll(/data-workspace-view="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(views, ['explorer', 'changes', 'checkpoints']);
  // The ids the renderer drives must survive the merge.
  for (const id of ['project-tree', 'project-root-name', 'source-branch', 'source-control-message',
    'source-changes', 'commit-history', 'checkpoint-list', 'refresh-project', 'refresh-source-control']) {
    assert.match(panel, new RegExp(`id="${id}"`), id);
  }
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /const viewingExplorer = \(\): boolean => activePanel === 'workspace' && workspaceView === 'explorer'/);
  assert.match(main, /localStorage\.getItem\(lastKindKey\)/, 'the mode is remembered across launches');
  assert.match(main, /localStorage\.setItem\(workspaceViewKey, view\)/, 'the tab is remembered');
});

test('project operations stay under Projects and session navigation remains nested without session actions', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  const panel = html.match(/data-panel-content="library">([\s\S]*?)<\/section>/)?.[1] ?? '';
  assert.match(panel, /class="project-operations"[\s\S]*id="new-project"[\s\S]*id="open-project"[\s\S]*id="rename-project"[\s\S]*id="remove-project"[\s\S]*id="project-list"/);
  assert.match(main, /className = 'project-sessions'/);
  assert.match(style, /\.project-sessions\{padding:[^}]*\}/);
  assert.doesNotMatch(main, /\['New Session',[\s\S]*renameProject\(project\)/);
});

test('Work task actions stay in Tasks while session controls stay in the workspace', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  const taskPanel = html.match(/data-panel-content="library">([\s\S]*?)<\/section>/)?.[1] ?? '';
  const workspace = html.match(/class="session-actions">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.match(taskPanel, /class="task-operations"[\s\S]*id="workspace-button"[\s\S]*id="rename-task"[\s\S]*id="delete-task"[\s\S]*id="task-list"/);
  assert.match(workspace, /id="new-session"[\s\S]*id="rename-session"[\s\S]*id="delete-session"/);
  assert.match(main, /className = 'task-sessions'/);
  assert.match(main, /session\.taskId/);
  assert.match(style, /\.task-sessions\{padding:[^}]*\}/);
  assert.match(style, /data-panel-content="library"\] \.session-item\.selected[^}]*background:transparent/);
  assert.match(main, /session\.taskId === task\.id/);
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
