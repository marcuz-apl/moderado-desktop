import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.removeItem('moderado-navigation');
    const settings = { providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', planModel: 'planner', actModel: 'writer' };
    const policy = { readFiles: true, editFiles: true, fetchWebContent: true, executeCommand: true, useMcpServers: true };
    const record = (id, name, kind, workspace, updatedAt, taskId = null) => ({ id, name, kind, workspace, taskId, updatedAt, settings, autoApprove: { ...policy, ...(kind === 'work' ? { executeCommand: false, useMcpServers: false } : {}) }, history: [] });
    const state = {
      sessions: [record('c1', 'Code one', 'code', 'C:\\Code\\alpha', 10), record('c2', 'Code two', 'code', 'C:\\Code\\alpha', 9), record('w1', 'Session 1', 'work', 'C:\\Documents\\Moderado-Desktop\\work-session0', 8, 'wt0'), record('w2', 'Session 2', 'work', 'C:\\Documents\\Moderado-Desktop\\work-session0', 7, 'wt0'), record('w3', 'Session 1', 'work', 'C:\\Documents\\Moderado-Desktop\\work-session1', 6, 'wt1')],
      workTasks: [{ id: 'wt0', name: 'Task Alpha', workspace: 'C:\\Documents\\Moderado-Desktop\\work-session0', updatedAt: 8 }, { id: 'wt1', name: 'Task Beta', workspace: 'C:\\Documents\\Moderado-Desktop\\work-session1', updatedAt: 6 }],
      projects: [{ workspace: 'C:\\Code\\alpha', name: 'Alpha', updatedAt: 10 }, { workspace: 'C:\\Code\\empty', name: 'Empty', updatedAt: 6 }],
      projectEntries: [{ workspace: 'C:\\Code\\alpha', name: 'src', path: 'src', isDir: true }, { workspace: 'C:\\Code\\alpha', name: 'code.md', path: 'code.md', isDir: false }, { workspace: 'C:\\Code\\alpha', name: 'main.rs', path: 'src/main.rs', isDir: false }],
      calls: [], callbacks: {}, listeners: {}, next: 0, slow: false, slowCreate: false, finish: null, projectName: 'Alpha', promptAnswer: null,
    };
    const emit = (event, payload) => { for (const id of state.listeners[event] ?? []) state.callbacks[id]({ event, id, payload }); };
    window.confirm = () => true;
    window.prompt = (_label, value) => state.promptAnswer ?? value;
    window.__navigationQA = { state, emit };
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) { const id = ++state.next; state.callbacks[id] = callback; return id; },
      unregisterCallback(id) { delete state.callbacks[id]; },
      async invoke(cmd, args = {}) {
        state.calls.push({ cmd, args });
        if (cmd === 'plugin:event|listen') { (state.listeners[args.event] ??= []).push(args.handler); return args.handler; }
        if (cmd === 'provider_catalog') return [{ id: 'ollama', name: 'Ollama', defaultBaseUrl: settings.baseUrl, local: true, applyKeyUrl: null, applyKeyLabel: '' }];
        if (cmd === 'load_provider_settings') return settings;
        if (cmd === 'list_sessions') return state.sessions;
        if (cmd === 'list_work_tasks') return state.workTasks;
        if (cmd === 'list_projects') return state.projects;
        if (cmd === 'get_session') { if (state.slow && args.sessionId === 'c1') await new Promise((resolve) => setTimeout(resolve, 250)); const found = state.sessions.find((s) => s.id === args.sessionId); if (!found) throw new Error('Unknown session'); return found; }
        if (['list_pending_approvals', 'list_checkpoints', 'list_schedules', 'probe_local_providers'].includes(cmd)) return [];
        if (cmd === 'get_search_settings') return { enabled: false, endpoint: '' };
        if (cmd === 'list_project_entries') {
          if (!args.projectWorkspace) return [{ name: 'report.md', path: 'report.md', isDir: false }];
          return state.projectEntries.filter((entry) => entry.workspace === args.projectWorkspace && (entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '.') === args.path);
        }
        if (cmd === 'read_project_file') return 'Readable document';
        if (cmd === 'create_project_file' || cmd === 'create_project_folder') {
          const path = args.parentPath === '.' ? args.name : `${args.parentPath}/${args.name}`;
          if (state.projectEntries.some((entry) => entry.workspace === args.projectWorkspace && entry.path === path)) throw new Error('Already exists');
          state.projectEntries.push({ workspace: args.projectWorkspace, name: args.name, path, isDir: cmd === 'create_project_folder' }); return;
        }
        if (cmd === 'rename_project_entry') {
          const item = state.projectEntries.find((entry) => entry.workspace === args.projectWorkspace && entry.path === args.path);
          if (!item) throw new Error('Missing entry');
          const nextPath = item.path.includes('/') ? `${item.path.slice(0, item.path.lastIndexOf('/') + 1)}${args.newName}` : args.newName;
          const prefix = `${item.path}/`;
          for (const entry of state.projectEntries.filter((candidate) => candidate.workspace === item.workspace && (candidate.path === item.path || candidate.path.startsWith(prefix)))) entry.path = `${nextPath}${entry.path.slice(item.path.length)}`;
          item.name = args.newName; return;
        }
        if (cmd === 'delete_project_entry') { state.projectEntries = state.projectEntries.filter((entry) => entry.workspace !== args.projectWorkspace || (entry.path !== args.path && !entry.path.startsWith(`${args.path}/`))); return; }
        if (cmd === 'save_auto_approve') { state.sessions.find((s) => s.id === args.sessionId).autoApprove = { ...args.policy }; return; }
        if (cmd === 'save_provider_settings') return;
        if (cmd === 'create_work_task') {
          const index = state.workTasks.length;
          const task = { id: `wt${index}`, name: `Task ${index}`, workspace: `C:\\Documents\\Moderado-Desktop\\work-session${index}`, updatedAt: 20 + index };
          state.workTasks.push(task); return task;
        }
        if (cmd === 'create_work_session_for_task') {
          if (state.slowCreate) await new Promise((resolve) => setTimeout(resolve, 250));
          const task = state.workTasks.find((item) => item.id === args.taskId);
          const number = state.sessions.filter((item) => item.taskId === task.id).length + 1;
          const next = record(`new-${state.sessions.length}`, `Session ${number}`, 'work', task.workspace, 20 + state.sessions.length, task.id);
          state.sessions.unshift(next); return next;
        }
        if (cmd === 'create_default_session') {
          if (state.slowCreate) await new Promise((resolve) => setTimeout(resolve, 250));
          const task = { id: `wt${state.workTasks.length}`, name: `Task ${state.workTasks.length}`, workspace: `C:\\Documents\\Moderado-Desktop\\work-session${state.workTasks.length}`, updatedAt: 30 };
          state.workTasks.push(task);
          const next = record(`new-${state.sessions.length}`, 'Session 1', 'work', task.workspace, 30, task.id);
          state.sessions.unshift(next); return next;
        }
        if (cmd === 'create_session_in_project') {
          const index = state.sessions.filter((session) => session.kind === 'code' && session.workspace === args.projectWorkspace).length + 1;
          const next = record(`code-new-${state.sessions.length}`, `Session ${index}`, 'code', args.projectWorkspace, 20 + state.sessions.length);
          state.sessions.unshift(next); return next;
        }
        if (cmd === 'delete_session') { state.sessions = state.sessions.filter((s) => s.id !== args.sessionId); return; }
        if (cmd === 'rename_session') { state.sessions.find((s) => s.id === args.sessionId).name = args.name; return; }
        if (cmd === 'rename_project') { state.projects.find((p) => p.workspace === args.projectWorkspace).name = args.name; state.projectName = args.name; return; }
        if (cmd === 'remove_project') { state.projects = state.projects.filter((p) => p.workspace !== args.projectWorkspace); return; }
        if (cmd === 'rename_work_task') { state.workTasks.find((task) => task.id === args.taskId).name = args.name; return; }
        if (cmd === 'delete_work_task') { const removed = state.sessions.filter((s) => s.taskId === args.taskId).map((s) => s.id); state.sessions = state.sessions.filter((s) => s.taskId !== args.taskId); state.workTasks = state.workTasks.filter((task) => task.id !== args.taskId); return removed; }
        if (cmd === 'open_project') { const next = { workspace: 'C:\\Code\\alpha', name: state.projectName, updatedAt: 30 }; if (!state.projects.some((p) => p.workspace === next.workspace)) state.projects.push(next); return next; }
        if (cmd === 'create_project') { const next = { workspace: `C:\\Code\\${args.name}`, name: args.name, updatedAt: 30 }; state.projects.push(next); return next; }
        if (cmd === 'start_turn') { emit('turn-event', { kind: 'text', session_id: args.sessionId, value: 'Working on the task' }); return new Promise((resolve) => { state.finish = () => { const active = state.sessions.find((s) => s.id === args.sessionId); active.history = [{ role: 'user', content: args.prompt }, { role: 'assistant', content: null, tool_calls: [{ id: 'qa-read', function: { name: 'read_file' } }] }, { role: 'tool', tool_call_id: 'qa-read', content: '{"path":"report.md"}' }, { role: 'assistant', content: '## Turn summary\n\n- Updated the task notes in `report.md`.\n- Preserved the existing project files.\n- Literal safe text: <img src=x onerror=alert(1)>' }]; emit('turn-event', { kind: 'done', session_id: args.sessionId }); resolve(); }; }); }
        if (cmd === 'steer_turn') return;
        if (cmd === 'get_source_control') return { branch: 'main', changes: [], commits: [] };
        if (cmd === 'plugin:dialog|open') return ['C:\\Source\\notes.md'];
        if (cmd === 'add_attachments') return [{ id: 'a1', sessionId: args.sessionId, name: 'notes.md', kind: 'text', bytes: 12 }];
        throw new Error(`Unexpected bridge command: ${cmd}`);
      },
    };
  });

const GIT = '.rail-tabs .rail-tab[data-rail="git"]';

try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://localhost:1420');
  await page.waitForSelector('#session-title');
  await page.waitForTimeout(1500);

  const railState = () => page.evaluate((selector) => {
    const git = document.querySelector(selector);
    return {
      hidden: git.hidden,
      display: getComputedStyle(git).display,
      others: ['library', 'files', 'schedules'].map((name) => ({
        name,
        hidden: document.querySelector(`.rail-tabs .rail-tab[data-rail="${name}"]`).hidden,
      })),
      kind: document.querySelector('#kind-work').getAttribute('aria-pressed'),
      activeView: document.querySelector('[data-left-view].active')?.dataset.leftView,
    };
  }, GIT);
  const setMode = async (kind) => {
    await page.click(`#kind-${kind}`);
    await page.waitForFunction((wanted) => document.querySelector(`#kind-${wanted}`).getAttribute('aria-pressed') === 'true', kind);
    await page.waitForTimeout(300);
  };

  await setMode('work');
  let state = await railState();
  if (!state.hidden || state.display !== 'none') throw new Error(`Work still shows the Git icon: ${JSON.stringify(state)}`);
  if (state.others.some((item) => item.hidden)) throw new Error(`Work hid another rail icon: ${JSON.stringify(state.others)}`);
  console.log('PASS Work mode hides the Git icon, other rail icons stay visible');
  // Selecting a session changes the kind through selectSession(), which calls
  // applyKindUi but NOT applyLeftView — the second place that must toggle it.
  const clickSession = async (label, expandLabel) => {
    let row = page.locator('.session-item', { hasText: label });
    if (!(await row.count())) {
      await page.click(`.project-expander[aria-label="${expandLabel}"]`);
      row = page.locator('.session-item', { hasText: label });
    }
    await row.first().click();
    await page.waitForTimeout(350);
  };
  await clickSession('Code one', 'Expand Alpha');
  state = await railState();
  if (state.kind !== 'false') throw new Error('selecting a Code session did not switch to Code mode');
  if (state.hidden || state.display === 'none') throw new Error('selecting a Code session did not bring the Git icon back');
  console.log('PASS selecting a Code session from the Work Library reveals the Git icon');
  await clickSession('Session 1', 'Expand Task Alpha');
  state = await railState();
  if (!state.hidden || state.display !== 'none') throw new Error('selecting a Work session did not hide the Git icon');
  console.log('PASS selecting a Work session hides the Git icon again');

  await setMode('code');
  state = await railState();
  if (state.hidden || state.display === 'none') throw new Error(`Code mode hides the Git icon: ${JSON.stringify(state)}`);
  console.log('PASS Code mode shows the Git icon');

  // Opening the Git pane in Code, then returning to Work, must fall back to
  // the Library and hide the icon again without leaving a dead view behind.
  await page.click(GIT);
  await page.waitForFunction(() => document.querySelector('[data-left-view="git"]').classList.contains('active'));
  await setMode('work');
  state = await railState();
  if (!state.hidden || state.display !== 'none') throw new Error('Git icon came back after leaving Code from the Git pane');
  if (state.activeView !== 'library') throw new Error(`Work left the ${state.activeView} pane active`);
  console.log('PASS switching from the Git pane back to Work hides the icon and restores the Library');

  await setMode('code');
  state = await railState();
  if (state.hidden || state.display === 'none') throw new Error('the icon did not return on the second Code switch');
  console.log('RESULT: 5 GIT-RAIL CHECKS PASSED');
} catch (e) {
  console.log('ERR', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
