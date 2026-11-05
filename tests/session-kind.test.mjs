import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DEFAULT_LEFT_VIEW, DEFAULT_SESSION_KIND, displayPath, GIT_VIEWS, LEFT_VIEWS, needsWorkspacePicker, newSessionLabel, nextSessionKind, parseGitView, parseLeftView, parseSessionKind, projectNameFromWorkspace, projectsForSessions, scheduleWriteApprovalChoiceVisible, sessionsForProject, startupSessionKind, visibleSessions } from '../src/renderer/sessions-view.ts';

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

test('startup opens Work unless the stored mode still has a session', async () => {
  assert.equal(startupSessionKind('work', false), 'work');
  assert.equal(startupSessionKind('work', true), 'work');
  assert.equal(startupSessionKind('code', false), 'work', 'an empty Code toggle never becomes the next launch');
  assert.equal(startupSessionKind('code', true), 'code', 'previous Code work resumes');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /const codeSessions = summaries\.filter\(\(session\) => session\.kind === 'code' && validProjects\.has\(session\.workspace\)\)/);
  assert.match(main, /activeKind = startupSessionKind\(storedKind, codeSessions\.length > 0\)/);
  assert.match(main, /codeSessions\.some\(\(session\) => session\.workspace === selectedProjectWorkspace\)/, 'a project without sessions does not win the restore');
});

test('Auto-approve stays visible but disabled before a session starts', async () => {
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /\$\('auto-approve-group'\)\.toggleAttribute\('hidden'/, 'the footer never collapses to a blank row');
  assert.match(main, /approvals\.removeAttribute\('hidden'\)/);
  assert.match(main, /approvals\.title = activeSessionId \? '' : work \? 'Start with the next task\.' : 'Start with the next session\.'/);
  assert.ok(main.includes("for (const id of ['approve-read', 'approve-edit', 'approve-web', 'approve-command']) $<HTMLInputElement>(id).disabled = !activeSessionId || selectingContext;"), 'the checkboxes are disabled without a session');
});

test('the workspace topbar always speaks in sessions', async () => {
  const [html, main] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /<p id="session-eyebrow" class="eyebrow">AGENT SESSION<\/p>/);
  assert.match(main, /\$\('session-eyebrow'\)\.textContent = 'AGENT SESSION'/);
  assert.match(main, /\$\('new-session'\)\.textContent = 'New Session'/);
  assert.doesNotMatch(main, /AGENT TASKLIST/, 'the topbar never switches to task vocabulary');
});

test('the Library creates numbered tasks and the topbar starts their sessions', async () => {
  const [main, rust] = await Promise.all([
    readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/sessions.rs', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /\$\('workspace-button'\)\.addEventListener\('click', \(\) => \{ void createWorkTask\(\); \}\)/, 'the Library owns task creation');
  assert.match(main, /const task = await invoke<WorkTaskRecord>\('create_work_task'\)/);
  assert.match(main, /async function newWorkSession\(taskId: string\)[\s\S]*createSession\(currentSettings\(\), 'work', null, taskId\)/, 'the topbar starts a session in the selected task');
  assert.match(main, /if \(activeKind === 'work'\) \{ if \(selectedWorkTaskId\) void newWorkSession\(selectedWorkTaskId\); \}/);
  assert.match(main, /activeKind === 'work' \? !selectedWorkTaskId : !selectedProjectWorkspace/, 'a Work session needs a selected task');
  assert.match(main, /Delete task .* and its sessions from Moderado\?/, 'deleting a task announces its sessions');
  assert.ok(rust.includes('create_numbered_workspace(documents, "work-task-", 1, 2)'), 'task folders start at 01');
  assert.ok(rust.includes('format!("{prefix}{number:0digits$}")'), 'the counter is zero-padded to two digits');
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
  assert.equal(DEFAULT_LEFT_VIEW, 'library');
  assert.deepEqual(LEFT_VIEWS, ['library', 'files', 'git', 'schedules', 'user']);
  assert.equal(parseLeftView('library'), 'library');
  assert.equal(parseLeftView('files'), 'files');
  assert.equal(parseLeftView('git'), 'git');
  assert.equal(parseLeftView('schedules'), 'schedules');
  assert.equal(parseLeftView('user'), 'user');
  assert.equal(parseLeftView('workspaces'), 'library', 'the pre-rename value keeps opening Library');
  assert.equal(parseLeftView('source-control'), 'library', 'retired names fall back');
  assert.equal(parseLeftView(null), 'library');
  assert.deepEqual(GIT_VIEWS, ['changes', 'checkpoints']);
  assert.equal(parseGitView('checkpoints'), 'checkpoints');
  assert.equal(parseGitView('explorer'), 'changes', 'retired names fall back');
  assert.equal(parseGitView(null), 'changes');
});

test('the merged shell header holds Work/Code and the topbar does not', async () => {
  const [html, main, style] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /class="left-shell">[\s\S]*class="shell-head">[\s\S]*class="kind-segment"[\s\S]*id="kind-work"[\s\S]*id="kind-code"/);
  assert.match(html, /class="brand"><span class="brand-word">Moderado Desktop<\/span><\/div>/, 'the OS icon is the only brand mark');
  assert.doesNotMatch(html, /class="brand-mark"/);
  assert.doesNotMatch(style, /\.brand-mark\{/);
  assert.match(style, /\.shell-head \.kind-segment\{flex:none;margin-left:auto\}/, 'the slider hugs its labels');
  assert.match(style, /\.shell-head \.kind-segment button\{flex:none;width:52px/, 'both halves stay equal and compact');
  const topbar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>', html.indexOf('<header class="topbar">')));
  assert.doesNotMatch(topbar, /id="kind-work"|id="kind-code"|class="kind-segment"|id="sidebar-toggle"/);
  assert.match(html, /class="rail-tabs"[^>]*role="tablist"[^>]*aria-orientation="vertical"[\s\S]*data-rail="library"[\s\S]*data-rail="files"[\s\S]*data-rail="git"[\s\S]*data-rail="schedules"[\s\S]*<\/nav>/);
  const railPages = html.slice(html.indexOf('class="rail-pages"'), html.indexOf('</aside>'));
  assert.match(railPages, /data-rail="user"[^>]*aria-pressed="false"[\s\S]*data-page-link="docs"[\s\S]*data-page-link="settings"/, 'User sits directly above Docs even though it opens a pane view');
  assert.doesNotMatch(railPages, /data-page-link="profile"/, 'User is a pane view, not a full page');
  assert.match(html, /class="session-actions">[\s\S]*id="new-session"/);
  assert.doesNotMatch(html, /empty-symbol[^<]*<img/);
  assert.match(main, /radio\.type = 'radio'/);
  // The design doc claims the rail's keyboard roving is covered by frontend checks.
  const railTabs = html.slice(html.indexOf('class="rail-tabs"'), html.indexOf('class="rail-pages"'));
  assert.doesNotMatch(railTabs, /data-rail="user"/, 'the pane view left the top group');
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
  assert.deepEqual(views, ['library', 'files', 'git', 'schedules', 'user']);
  assert.doesNotMatch(html, /data-panel-content=/);
  assert.match(html, /class="left-shell">[\s\S]*id="sidebar-toggle"/, 'the Left Pane collapses from the merged header');
  assert.doesNotMatch(html, /class="activity-bar"|class="activity-button"/);
  assert.match(html, /<aside class="sidebar" id="sidebar" role="tabpanel" aria-label="Left pane">/);
});

test('Git is Code-only, so Work disables its rail entry and pane', async () => {
  const [main, style, theme] = await Promise.all([
    readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/theme.css', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /const gitAvailable = \(\): boolean => activeKind === 'code';/, 'only Code owns a repository');
  assert.match(main, /if \(kind === 'work' && activeLeftView === 'git'\) activeLeftView = 'library';/, 'the view settles before any refresh reads it');
  assert.match(main, /if \(!enabled && activeLeftView === 'git'\) activeLeftView = 'library';/, 'Work falls back to the Library');
  assert.match(main, /gitRail\.setAttribute\('aria-disabled', String\(!enabled\)\)/, 'the rail entry announces its state');
  assert.match(main, /gitRail\.title = enabled \? 'Git' : 'Git is available in Code mode'/, 'hovering explains how to reach it');
  assert.match(main, /button\.dataset\.rail === 'git' && !gitAvailable\(\)/, 'a disabled entry explains itself instead of switching');
  assert.match(main, /Git is available in Code mode\.'\); return;/, 'the click names the mode');
  assert.match(main, /\.filter\(\(button\) => button\.getAttribute\('aria-disabled'\) !== 'true'\)/, 'arrow keys skip the disabled entry');
  assert.match(style, /\.rail-tab\[aria-disabled="true"\],\.rail-tab\[aria-disabled="true"\]:hover\{background:transparent/, 'it never looks hovered');
  assert.match(theme, /:root\[data-theme="light"\] \.rail-tab\[aria-disabled="true"\]/, 'the light rail carries the same state');
});

test('Library lists tasks and projects in one badged list', async () => {
  const [html, main, style] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8'),
  ]);
  const panel = html.match(/data-left-view="library">([\s\S]*?)<\/section>/)?.[1] ?? '';
  assert.match(panel, /<h2 id="library-title">Library<\/h2>/);
  assert.match(html, /data-rail="library" aria-label="Library" title="Library"/, 'the rail label avoids the central workspace name');
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
  assert.match(files, /id="project-tree"[^>]*><p class="hint">Select a task or project to browse its files\.<\/p>/, 'the idle Files text uses the shared hint size');
  assert.match(main, /tree\.replaceChildren\(hintText\('This folder is empty\.'\)\)/, 'an empty folder reads at the same size as the idle text');
  assert.match(main, /function hintText\(text: string\): HTMLParagraphElement \{[\s\S]*className = 'hint'/, 'one helper owns hint paragraphs');
  assert.match(files, /id="project-path"[^>]*hidden/, 'the location line sits above the tree and starts hidden');
  assert.match(main, /pathLine\.textContent = folder \? displayPath\(folder\) : ''/);
  assert.match(main, /pathLine\.toggleAttribute\('hidden', !folder\)/);
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
  const panel = html.match(/data-left-view="library">([\s\S]*?)<\/section>/)?.[1] ?? '';
  assert.match(panel, /class="project-operations"[\s\S]*id="new-project"[^>]*>New Project<[\s\S]*id="open-project"[\s\S]*id="rename-project"[\s\S]*id="delete-project"[^>]*>Delete</);
  assert.match(main, /className = work \? 'task-sessions' : 'project-sessions'/);
  assert.match(style, /\.project-sessions\{padding:[^}]*\}/);
  assert.match(main, /invoke<string\[\]>\('delete_project'/, 'the Library deletes the project and its sessions');
  assert.match(main, /Delete project .* Its sessions and histories are removed from Moderado; the project folder and files remain\./);
  assert.doesNotMatch(main, /remove_project|remove-project/, 'no project-level remove path remains');
  assert.doesNotMatch(main, /\['New Session',[\s\S]*renameProject\(project\)/);
});

test('Work task actions stay in Tasks while session controls stay in the workspace', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  const taskPanel = html.match(/data-left-view="library">([\s\S]*?)<\/section>/)?.[1] ?? '';
  const workspace = html.match(/class="session-actions">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.match(taskPanel, /class="task-operations"[\s\S]*id="workspace-button"[\s\S]*id="rename-task"[\s\S]*id="delete-task"/);
  assert.match(workspace, /id="new-session"[\s\S]*id="rename-session"[\s\S]*id="delete-session"/);
  assert.match(main, /className = work \? 'task-sessions' : 'project-sessions'/);
  assert.match(main, /session\.taskId/);
  assert.match(style, /\.task-sessions\{padding:[^}]*\}/);
  assert.match(style, /data-left-view="library"\] \.session-item\.selected[^}]*background:transparent/);
  assert.match(main, /session\.taskId === entry\.key/);
});

test('Library rows sit tight against their task/project name and at half the former inter-row spacing', async () => {
  const style = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  assert.match(style, /\.task-sessions\{padding:0 0 3px 34px\}/);
  assert.match(style, /\.project-sessions\{padding:0 0 3px 23px\}/);
  assert.match(style, /\.task-heading:has\(\+ \.task-sessions\)>\.session-item,\.project-heading:has\(\+ \.project-sessions\)>\.session-item\{padding-bottom:4px\}/);
  assert.match(style, /\.task-group\{padding:2px 0;border:0\}/);
  assert.match(style, /\.project-group\{padding:2px 0;border-bottom:1px solid #2a4258\}/);
  assert.match(style, /#library-list\{gap:2px\}/);
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

test('all five Auto-Approve options default on and MCP is usable in Code mode', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['approve-read', 'approve-edit', 'approve-web', 'approve-command', 'approve-mcp']) {
    assert.match(html, new RegExp(`<input id="${id}" type="checkbox" checked`));
  }
  assert.match(html, /id="approve-mcp" type="checkbox" checked \/>/, 'the option is enabled; MCP tools are supported');
  assert.doesNotMatch(html, /MCP server support is a placeholder/);
  assert.match(html, /MCP tools from servers configured in Settings/);
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
  assert.match(style, /\.model-usage\{[^}]*font-size:calc\(11px\*var\(--text-scale\)\)/);
});

test('Explorer root uses the project folder name on Windows and Unix paths', () => {
  assert.equal(projectNameFromWorkspace('C:\\Users\\me\\Documents\\my-project', 'Session label'), 'my-project');
  assert.equal(projectNameFromWorkspace('/home/me/code/my-project/', 'Session label'), 'my-project');
  assert.equal(projectNameFromWorkspace('', 'Session label'), 'Session label');
});

test('the location line drops the Windows verbatim prefix but keeps normal paths', async () => {
  assert.equal(displayPath('\\\\?\\E:\\projects\\moderado'), 'E:\\projects\\moderado');
  assert.equal(displayPath('\\\\?\\UNC\\server\\share\\repo'), '\\\\server\\share\\repo');
  assert.equal(displayPath('E:\\projects\\moderado'), 'E:\\projects\\moderado');
  assert.equal(displayPath('/home/me/code'), '/home/me/code');
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /pathLine\.textContent = folder \? displayPath\(folder\) : ''/, 'the Files panel line uses the display form');
  assert.match(main, /button\.title = displayPath\(session\.workspace\)/, 'tooltips use it too');
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
