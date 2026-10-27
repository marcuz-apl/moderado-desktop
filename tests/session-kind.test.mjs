import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_SESSION_KIND, defaultPanelForKind, needsWorkspacePicker, newActionLabel, newSessionLabel, nextSessionKind, panelAvailableForKind, profileModeDescription, projectNameFromWorkspace, projectsForSessions, scheduleWriteApprovalChoiceVisible, sessionsForProject, visibleSessions } from '../src/renderer/sessions-view.ts';

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

test('sidebar defaults and available panels follow the selected mode', () => {
  assert.equal(defaultPanelForKind('work'), 'tasks');
  assert.equal(defaultPanelForKind('code'), 'projects');
  assert.equal(panelAvailableForKind('tasks', 'work'), true);
  assert.equal(panelAvailableForKind('projects', 'work'), false);
  assert.equal(panelAvailableForKind('sessions', 'work'), false);
  assert.equal(panelAvailableForKind('workspace', 'work'), true);
  assert.equal(panelAvailableForKind('checkpoints', 'work'), true);
  assert.equal(panelAvailableForKind('tasks', 'work'), true);
  assert.equal(panelAvailableForKind('tasks', 'code'), false);
  assert.equal(panelAvailableForKind('projects', 'code'), true);
  assert.equal(panelAvailableForKind('sessions', 'code'), false);
  assert.equal(panelAvailableForKind('workspace', 'code'), true);
  assert.equal(panelAvailableForKind('projects', 'code'), true);
  assert.equal(panelAvailableForKind('schedules', 'work'), true);
});

test('new action captions match the selected sidebar panel', () => {
  assert.equal(newActionLabel('tasks'), 'New Task');
  assert.equal(newActionLabel('projects'), 'New Project');
  assert.equal(newActionLabel('sessions'), 'New Session');
});

test('top bar contains the Work/Code switch and Explorer owns the folder icon', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(html, /class="kind-segment"[\s\S]*id="kind-work"[\s\S]*id="kind-code"/);
  assert.match(html, /class="kind-stack"><div class="kind-segment"[\s\S]*<p class="eyebrow">AGENT SESSION<\/p><h1 id="session-title"/);
  assert.match(html, /class="session-actions">[\s\S]*id="new-session"/);
  assert.doesNotMatch(html, /data-panel="mode"|data-panel-content="mode"/);
  assert.match(main, /radio\.type = 'radio'/);
  assert.match(html, /data-panel="workspace"[^>]*aria-label="Explorer"[^>]*>[\s\S]*?#icon-folder/);
  assert.match(html, /data-panel="projects"[^>]*>[\s\S]*?#icon-projects/);
  assert.match(html, /<span>⌘<\/span><\/div>/);
  assert.doesNotMatch(html, /empty-symbol[^<]*<img/);
});

test('project operations stay under Projects and session navigation remains nested without session actions', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  const panel = html.match(/data-panel-content="projects">([\s\S]*?)<\/section>/)?.[1] ?? '';
  assert.match(panel, /<h2>Projects<\/h2>[\s\S]*class="project-operations"[\s\S]*id="new-project"[\s\S]*id="open-project"[\s\S]*id="rename-project"[\s\S]*id="remove-project"[\s\S]*id="project-list"/);
  assert.match(main, /className = 'project-sessions'/);
  assert.match(style, /\.project-sessions\{padding:[^}]*\}/);
  assert.doesNotMatch(main, /\['New Session',[\s\S]*renameProject\(project\)/);
});

test('Work task actions stay in Tasks while session controls stay in the workspace', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  const taskPanel = html.match(/data-panel-content="tasks">([\s\S]*?)<\/section>/)?.[1] ?? '';
  const workspace = html.match(/class="session-actions">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.match(taskPanel, /<h2>Tasks<\/h2>[\s\S]*class="task-operations"[\s\S]*id="workspace-button"[\s\S]*id="rename-task"[\s\S]*id="delete-task"[\s\S]*id="task-list"/);
  assert.match(workspace, /id="new-session"[\s\S]*id="rename-session"[\s\S]*id="delete-session"/);
  assert.match(main, /className = 'task-sessions'/);
  assert.match(main, /session\.taskId/);
  assert.match(style, /\.task-sessions\{padding:[^}]*\}/);
  assert.match(style, /data-panel-content="tasks"\] \.session-item\.selected[^}]*background:transparent/);
  assert.match(main, /session\.taskId === task\.id/);
});

test('About displays the VERSION value without its BUILD metadata or an extra label', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(html, /<p class="workspace-name">Moderado Desktop<\/p><p class="path"><span id="about-version"><\/span><\/p>/);
  assert.match(main, /appVersion\.trim\(\)\.split\('\+'\)\[0\]/);
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
  const composer = html.match(/<div class="composer-wrap">([\s\S]*?)<\/div>\s*<\/main>/)?.[1] ?? '';
  assert.match(composer, /id="auto-approve-group"/);
  assert.ok(composer.indexOf('id="auto-approve-group"') < composer.indexOf('id="composer"'));
  assert.match(composer, /class="auto-approve-bar"/);
  assert.doesNotMatch(composer, /id="save-auto-approve"/);
  assert.match(style, /\.auto-approve-bar\{padding:0;border:0;border-radius:0;background:transparent\}/);
  assert.match(style, /\.message\{max-width:none\}/);
  assert.doesNotMatch(html.slice(0, html.indexOf('<main class="main">')), /id="auto-approve-group"/);
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
