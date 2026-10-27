// Run with Vite on :1420, then:
// npx --package @playwright/cli playwright-cli open about:blank
// npx --package @playwright/cli playwright-cli run-code --filename scripts/check-navigation-ui.js
async (page) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.removeItem('moderado-navigation');
    const settings = { providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', planModel: 'planner', actModel: 'writer' };
    const policy = { readFiles: true, editFiles: true, fetchWebContent: true, executeCommand: true, useMcpServers: true };
    const record = (id, name, kind, workspace, updatedAt) => ({ id, name, kind, workspace, updatedAt, settings, autoApprove: { ...policy, ...(kind === 'work' ? { executeCommand: false, useMcpServers: false } : {}) }, history: [] });
    const state = {
      sessions: [record('c1', 'Code one', 'code', 'C:\\Code\\alpha', 10), record('c2', 'Code two', 'code', 'C:\\Code\\alpha', 9), record('w1', 'Work one', 'work', 'C:\\Documents\\Moderado-Desktop\\work-session0', 8), record('w2', 'Work two', 'work', 'C:\\Documents\\Moderado-Desktop\\work-session1', 7)],
      projects: [{ workspace: 'C:\\Code\\alpha', name: 'Alpha', updatedAt: 10 }, { workspace: 'C:\\Code\\empty', name: 'Empty', updatedAt: 6 }],
      calls: [], callbacks: {}, listeners: {}, next: 0, slow: false, slowCreate: false, finish: null,
    };
    const emit = (event, payload) => { for (const id of state.listeners[event] ?? []) state.callbacks[id]({ event, id, payload }); };
    window.confirm = () => true;
    window.prompt = (_label, value) => value;
    window.__navigationQA = { state, emit };
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) { const id = ++state.next; state.callbacks[id] = callback; return id; },
      unregisterCallback(id) { delete state.callbacks[id]; },
      async invoke(cmd, args = {}) {
        state.calls.push({ cmd, args });
        if (cmd === 'plugin:event|listen') { (state.listeners[args.event] ??= []).push(args.handler); return args.handler; }
        if (cmd === 'provider_catalog') return [{ id: 'ollama', name: 'Ollama', defaultBaseUrl: settings.baseUrl, editableUrl: false, local: true, applyKeyUrl: null, applyKeyLabel: '' }];
        if (cmd === 'load_provider_settings') return settings;
        if (cmd === 'list_sessions') return state.sessions;
        if (cmd === 'list_projects') return state.projects;
        if (cmd === 'get_session') { if (state.slow && args.sessionId === 'c1') await new Promise((resolve) => setTimeout(resolve, 250)); const found = state.sessions.find((s) => s.id === args.sessionId); if (!found) throw new Error('Unknown session'); return found; }
        if (['list_pending_approvals', 'list_checkpoints', 'list_schedules', 'probe_local_providers'].includes(cmd)) return [];
        if (cmd === 'get_search_settings') return { enabled: false, endpoint: '' };
        if (cmd === 'list_project_entries') return [{ name: args.projectWorkspace ? 'code.md' : 'report.md', path: args.projectWorkspace ? 'code.md' : 'report.md', isDir: false }];
        if (cmd === 'read_project_file') return 'Readable document';
        if (cmd === 'save_provider_settings' || cmd === 'save_auto_approve') return;
        if (cmd === 'create_default_session' || cmd === 'create_session_in_project') {
          if (state.slowCreate) await new Promise((resolve) => setTimeout(resolve, 250));
          const index = state.sessions.length;
          const next = record(`new-${index}`, cmd === 'create_default_session' ? `Task ${index}` : `Session ${index}`, cmd === 'create_default_session' ? 'work' : 'code', args.projectWorkspace ?? `C:\\Documents\\Moderado-Desktop\\work-session${index}`, 20 + index);
          state.sessions.unshift(next); return next;
        }
        if (cmd === 'delete_session') { state.sessions = state.sessions.filter((s) => s.id !== args.sessionId); return; }
        if (cmd === 'rename_session') { state.sessions.find((s) => s.id === args.sessionId).name = args.name; return; }
        if (cmd === 'rename_project') { state.projects.find((p) => p.workspace === args.projectWorkspace).name = args.name; return; }
        if (cmd === 'remove_project') { state.projects = state.projects.filter((p) => p.workspace !== args.projectWorkspace); return; }
        if (cmd === 'open_project') { const next = { workspace: 'C:\\Code\\alpha', name: 'Alpha', updatedAt: 30 }; if (!state.projects.some((p) => p.workspace === next.workspace)) state.projects.push(next); return next; }
        if (cmd === 'create_project') { const next = { workspace: `C:\\Code\\${args.name}`, name: args.name, updatedAt: 30 }; state.projects.push(next); return next; }
        if (cmd === 'start_turn') { emit('turn-event', { kind: 'text', session_id: args.sessionId, value: 'Working on the task' }); return new Promise((resolve) => { state.finish = () => { emit('turn-event', { kind: 'done', session_id: args.sessionId }); resolve(); }; }); }
        if (cmd === 'get_source_control') return { branch: 'main', changes: [], commits: [] };
        if (cmd === 'plugin:dialog|open') return ['C:\\Source\\notes.md'];
        if (cmd === 'add_attachments') return [{ id: 'a1', sessionId: args.sessionId, name: 'notes.md', kind: 'text', bytes: 12 }];
        throw new Error(`Unexpected bridge command: ${cmd}`);
      },
    };
  });
  const check = async (condition, message) => { if (!(await condition())) throw new Error(message); };
  const title = (text) => check(async () => (await page.locator('#session-title').textContent()) === text, `Expected active conversation: ${text}`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:1420');
  await page.locator('#session-title').filter({ hasText: 'Work one' }).waitFor();
  await title('Work one');
  await page.locator('#prompt').fill('Unsent Work draft');
  await page.locator('#kind-code').click();
  await page.locator('#session-title').filter({ hasText: 'Code one' }).waitFor();
  await page.getByRole('button', { name: 'Code two', exact: true }).click();
  await page.locator('#session-title').filter({ hasText: 'Code two' }).waitFor();
  await page.locator('#prompt').fill('Unsent Code draft');
  await page.locator('#kind-work').click();
  await page.locator('#session-title').filter({ hasText: 'Work one' }).waitFor();
  await check(async () => await page.locator('#prompt').inputValue() === 'Unsent Work draft', 'Work draft lost');
  await page.evaluate(() => { window.__navigationQA.state.slowCreate = true; });
  await page.locator('#workspace-button').click();
  await page.getByRole('button', { name: 'Work two', exact: true }).click();
  await title('Work two');
  await page.locator('#prompt').fill('Draft in the selected task');
  await page.waitForTimeout(300);
  await title('Work two');
  await check(async () => await page.locator('#prompt').inputValue() === 'Draft in the selected task', 'Session creation overwrote the selected task draft');
  const createdTask = page.getByRole('button', { name: 'Task 4', exact: true });
  await createdTask.waitFor();
  await createdTask.click();
  await title('Task 4');
  await check(async () => await page.locator('#prompt').inputValue() === '', 'A draft from another task leaked into the newly created task');
  await page.locator('[data-panel="workspace"]').click();
  await page.getByRole('treeitem', { name: 'report.md', exact: true }).waitFor();
  await page.locator('#kind-code').click();
  await page.locator('#session-title').filter({ hasText: 'Code two' }).waitFor();
  await check(async () => await page.locator('#prompt').inputValue() === 'Unsent Code draft', 'Code draft lost');
  await page.getByRole('button', { name: 'Empty', exact: true }).click();
  await title('New Session');
  await check(async () => !(await page.locator('#send').isDisabled()), 'Empty registered project must allow sending');
  await page.locator('[data-panel="workspace"]').click();
  await page.getByRole('treeitem', { name: 'code.md', exact: true }).waitFor();
  await page.locator('[data-panel="projects"]').click();
  await page.locator('.project-group').filter({ has: page.getByRole('button', { name: 'Empty', exact: true }) }).getByRole('button', { name: 'New Session', exact: true }).click();
  await page.locator('#session-title').filter({ hasText: 'Session 5' }).waitFor();
  await page.locator('#delete-session').click();
  await title('New Session');
  await check(async () => await page.getByRole('button', { name: 'Empty', exact: true }).count() === 1, 'Deleting last session removed project');
  await page.getByRole('button', { name: 'Alpha', exact: true }).click();
  await page.evaluate(() => { window.__navigationQA.state.slow = true; });
  await page.getByRole('button', { name: 'Code one', exact: true }).click();
  await page.locator('#kind-work').click();
  await page.locator('#session-title').filter({ hasText: 'Task 4' }).waitFor();
  await page.waitForTimeout(350);
  await title('Task 4');
  await page.locator('#prompt').fill('Write a report');
  await page.locator('#send').click();
  await page.locator('#stop').waitFor({ state: 'visible' });
  await page.locator('#kind-code').click();
  await page.locator('#session-title').filter({ hasText: 'Code two' }).waitFor();
  await page.locator('#prompt').fill('Keep this new Code draft');
  await page.evaluate(() => window.__navigationQA.state.finish());
  await check(async () => await page.locator('#prompt').inputValue() === 'Keep this new Code draft', 'Background completion overwrote draft');
  await page.locator('.project-group').filter({ has: page.getByRole('button', { name: 'Alpha', exact: true }) }).getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Alpha', exact: true }).waitFor({ state: 'detached' });
  await page.locator('#open-project').click();
  await page.getByRole('button', { name: 'Alpha', exact: true }).waitFor();
  await check(async () => (await page.evaluate(() => window.__navigationQA.state.sessions)).some((s) => s.id === 'c1'), 'Project removal deleted sessions');
  await page.locator('#new-project').click();
  await page.locator('#project-name').fill('NewCodebase');
  await page.getByRole('button', { name: 'Choose parent folder' }).click();
  await page.getByRole('button', { name: 'NewCodebase', exact: true }).waitFor();
  await title('New Session');
  await page.screenshot({ path: '.playwright-cli/redesign-code.png', fullPage: true });
  await page.locator('#kind-work').click();
  await page.locator('#session-title').filter({ hasText: 'Task 4' }).waitFor();
  await page.screenshot({ path: '.playwright-cli/redesign-work.png', fullPage: true });
  if (errors.length) throw new Error(errors.join('\n'));
  await check(async () => !(await page.locator('#new-project').isDisabled()) && !(await page.locator('#open-project').isDisabled()), 'Project controls stayed disabled after async creation');
  return 'Passed mode/draft restoration, delayed session creation without stealing navigation, Work/empty-project Explorer, nested sessions, session deletion, stale async selection, background completion, project removal/reopen, and separate New/Open project flows.';
}
