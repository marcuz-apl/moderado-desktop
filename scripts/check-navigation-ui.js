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
        if (cmd === 'provider_catalog') return [{ id: 'ollama', name: 'Ollama', defaultBaseUrl: settings.baseUrl, editableUrl: false, local: true, applyKeyUrl: null, applyKeyLabel: '' }];
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
  await title('Session 1');
  await check(async () => await page.locator('.task-heading input[type="radio"]:checked').count() === 1 && await page.locator('.task-sessions input[type="radio"]:checked').count() === 1, 'Work Task and session selection must use separate radios');
  await check(async () => {
    const listLeft = await page.locator('#task-list').evaluate((element) => element.getBoundingClientRect().left);
    const taskLeft = await page.locator('.task-heading .session-item').first().evaluate((element) => element.getBoundingClientRect().left);
    const sessionLeft = await page.locator('.task-sessions .session-item').first().evaluate((element) => element.getBoundingClientRect().left);
    return taskLeft - listLeft <= 20 && sessionLeft - taskLeft >= 20;
  }, 'Work Tasks should align with the Tasks list edge and sessions should be indented beneath them');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await check(async () => /^v?\d+\.\d+\.\d+$/.test((await page.locator('#about-version').textContent()).trim()) && (await page.locator('.about-group .path').textContent()).trim() === (await page.locator('#about-version').textContent()).trim(), 'About should display only the VERSION value without build metadata');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await check(async () => await page.locator('.task-sessions').evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft) >= 30), 'Work sessions should be indented under the Task');
  await check(async () => await page.locator('.task-sessions .session-item.selected').evaluate((element) => getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(element).borderColor === 'rgba(0, 0, 0, 0)'), 'Work session rows should use the radio indicator instead of a box');
  await check(async () => await page.locator('#save-auto-approve').count() === 0, 'Auto-approve should not show a Save button');
  const alignedWidths = await page.evaluate(() => {
    const transcript = document.querySelector('#transcript').getBoundingClientRect();
    const transcriptStyle = getComputedStyle(document.querySelector('#transcript'));
    const composer = document.querySelector('#composer').getBoundingClientRect();
    return Math.abs(transcript.left + parseFloat(transcriptStyle.paddingLeft) - composer.left) < 1
      && Math.abs(transcript.right - parseFloat(transcriptStyle.paddingRight) - composer.right) < 1;
  });
  await check(async () => alignedWidths, 'Conversation content and message composer widths should align');
  await page.locator('#approve-read').uncheck();
  await page.waitForFunction(() => window.__navigationQA.state.calls.some((call) => call.cmd === 'save_auto_approve' && call.args.sessionId === 'w1' && call.args.policy.readFiles === false));
  await check(async () => await page.evaluate(() => window.__navigationQA.state.sessions.find((s) => s.id === 'w1').autoApprove.readFiles === false), 'Auto-approve checkbox did not save immediately');
  await page.locator('#approve-read').check();
  await page.waitForFunction(() => window.__navigationQA.state.calls.filter((call) => call.cmd === 'save_auto_approve' && call.args.sessionId === 'w1').length >= 2);
  await page.locator('#prompt').fill('Unsent Work draft');
  await page.locator('#kind-code').click();
  await page.locator('#session-title').filter({ hasText: 'Code one' }).waitFor();
  await page.getByRole('button', { name: 'Code two', exact: true }).click();
  await page.locator('#session-title').filter({ hasText: 'Code two' }).waitFor();
  await page.locator('#prompt').fill('Unsent Code draft');
  await page.locator('#kind-work').click();
  await title('Session 1');
  await check(async () => await page.locator('#prompt').inputValue() === 'Unsent Work draft', 'Work draft lost');
  await page.evaluate(() => { window.__navigationQA.state.slowCreate = true; });
  await page.locator('#workspace-button').click();
  const createdTask = page.getByRole('button', { name: 'Task 2', exact: true });
  await createdTask.waitFor();
  await title('New Session');
  await check(async () => !(await page.locator('#rename-task').isDisabled()) && !(await page.locator('#delete-task').isDisabled()), 'Task operations must be in the Tasks panel');
  await page.evaluate(() => { window.__navigationQA.state.promptAnswer = 'Research task'; });
  await page.locator('#rename-task').click();
  await page.getByRole('button', { name: 'Research task', exact: true }).waitFor();
  await page.locator('#prompt').fill('Draft in the selected task');
  await page.locator('#new-session').click();
  await page.getByRole('button', { name: 'Task Alpha', exact: true }).click();
  await title('Session 1');
  await page.waitForTimeout(300);
  await title('Session 1');
  await page.getByRole('button', { name: 'Research task', exact: true }).click();
  await title('Session 1');
  await check(async () => await page.locator('#prompt').inputValue() === 'Draft in the selected task', 'Session creation overwrote the selected task draft');
  await page.getByRole('button', { name: 'Task Beta', exact: true }).click();
  await page.locator('#delete-task').click();
  await page.getByRole('button', { name: 'Task Beta', exact: true }).waitFor({ state: 'detached' });
  await check(async () => !(await page.evaluate(() => window.__navigationQA.state.sessions.some((session) => session.id === 'w3'))), 'Deleting a Task should remove its child sessions');
  await page.getByRole('button', { name: 'Research task', exact: true }).click();
  await page.locator('[data-panel="workspace"]').click();
  await page.getByRole('treeitem', { name: 'report.md', exact: true }).waitFor();
  await page.locator('#kind-code').click();
  await page.locator('#session-title').filter({ hasText: 'Code two' }).waitFor();
  await check(async () => await page.locator('#prompt').inputValue() === 'Unsent Code draft', 'Code draft lost');
  await page.getByRole('button', { name: 'Empty', exact: true }).click();
  await title('New Session');
  await check(async () => !(await page.locator('#send').isDisabled()), 'Empty registered project must allow sending');
  await check(async () => !(await page.locator('#rename-project').isDisabled()) && !(await page.locator('#remove-project').isDisabled()), 'Project operations must target the selected project');
  await page.locator('[data-panel="workspace"]').click();
  await page.getByRole('treeitem', { name: 'code.md', exact: true }).waitFor();
  await page.locator('[data-panel="projects"]').click();
  await check(async () => await page.getByRole('button', { name: 'New Session', exact: true }).count() === 1, 'Session creation should be available in the main workspace only');
  await page.locator('#new-session').click();
  await title('Session 1');
  await page.locator('#delete-session').click();
  await title('New Session');
  await check(async () => await page.getByRole('button', { name: 'Empty', exact: true }).count() === 1, 'Deleting last session removed project');
  await page.getByRole('button', { name: 'Alpha', exact: true }).click();
  await page.evaluate(() => { window.__navigationQA.state.promptAnswer = 'Alpha renamed'; });
  await page.locator('#rename-project').click();
  await page.getByRole('button', { name: 'Alpha renamed', exact: true }).waitFor();
  await check(async () => (await page.evaluate(() => window.__navigationQA.state.calls)).some((call) => call.cmd === 'rename_project' && call.args.name === 'Alpha renamed'), 'Project Rename should affect the selected project');
  await page.evaluate(() => { window.__navigationQA.state.slow = true; });
  await page.getByRole('button', { name: 'Code one', exact: true }).click();
  await page.locator('#kind-work').click();
  await title('Session 1');
  await page.waitForTimeout(350);
  await title('Session 1');
  await page.locator('#prompt').fill('Write a report');
  await page.locator('#send').click();
  await page.locator('#stop').waitFor({ state: 'visible' });
  await page.evaluate(() => window.__navigationQA.emit('turn-event', { kind: 'tool_started', session_id: 'new-5', tool_id: 'qa-read', name: 'read_file' }));
  await page.locator('.activity-entry').waitFor();
  await check(async () => await page.locator('.activity-entry .activity-status').textContent() === 'Working', 'Running tools should appear as active timeline steps');
  await page.evaluate(() => window.__navigationQA.emit('turn-event', { kind: 'tool', session_id: 'new-5', tool_id: 'qa-read', name: 'read_file', value: '{"path":"report.md"}' }));
  await check(async () => await page.locator('.activity-entry .activity-status').textContent() === 'Completed', 'Completed tools should update their timeline step');
  await check(async () => await page.locator('.message.turn-summary').count() === 0, 'Turn summary should wait until the turn finishes');
  await page.locator('#kind-code').click();
  await page.locator('#session-title').filter({ hasText: 'Code two' }).waitFor();
  await page.locator('#prompt').fill('Keep this new Code draft');
  await page.evaluate(() => window.__navigationQA.state.finish());
  await check(async () => await page.locator('#prompt').inputValue() === 'Keep this new Code draft', 'Background completion overwrote draft');
  await page.locator('#kind-work').click();
  await page.getByRole('button', { name: 'Research task', exact: true }).click();
  await page.locator('.message.turn-summary').waitFor();
  await check(async () => await page.locator('.activity-entry time').count() === 1, 'The completed activity timeline should retain its timestamp');
  await check(async () => (await page.locator('.message.turn-summary .message-role').textContent()) === 'Turn summary', 'Finished turns should show a distinct summary');
  await check(async () => (await page.locator('.message.turn-summary li').count()) === 3 && (await page.locator('.message.turn-summary code').textContent()) === 'report.md', 'Turn summary Markdown formatting was not rendered');
  await check(async () => await page.locator('.message.turn-summary img').count() === 0 && (await page.locator('.message.turn-summary .message-body').textContent()).includes('<img src=x onerror=alert(1)>'), 'Raw HTML in model Markdown must remain inert text');
  await page.locator('#kind-code').click();
  await page.getByRole('button', { name: 'Code two', exact: true }).click();
  await page.locator('#remove-project').click();
  await page.getByRole('button', { name: 'Alpha renamed', exact: true }).waitFor({ state: 'detached' });
  await page.locator('#open-project').click();
  await page.getByRole('button', { name: 'Alpha renamed', exact: true }).waitFor();
  await check(async () => (await page.evaluate(() => window.__navigationQA.state.sessions)).some((s) => s.id === 'c1'), 'Project removal deleted sessions');
  await check(async () => await page.getByRole('button', { name: 'Alpha renamed', exact: true }).count() === 1, 'Reopening a project did not preserve its display name');
  await page.locator('[data-panel="workspace"]').click();
  await page.locator('.tree-row[data-path="src"]').waitFor();
  await page.locator('.tree-row[data-path="src"]').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'New File' }).click();
  await page.locator('#project-entry-name').fill('manual.txt');
  await page.locator('#save-project-entry').click();
  await page.locator('.tree-row[data-path="src/manual.txt"]').waitFor();
  await page.locator('.tree-row[data-path="src/manual.txt"]').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Rename' }).click();
  await page.locator('#project-entry-name').fill('notes.md');
  await page.locator('#save-project-entry').click();
  await page.locator('.tree-row[data-path="src/notes.md"]').waitFor();
  await page.locator('.tree-row[data-path="src/notes.md"]').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();
  await page.locator('.tree-row[data-path="src/notes.md"]').waitFor({ state: 'detached' });
  await page.locator('#project-tree').evaluate((element) => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 500 })));
  await page.getByRole('menu').getByRole('menuitem', { name: 'New Folder' }).click();
  await page.locator('#project-entry-name').fill('manual-folder');
  await page.locator('#save-project-entry').click();
  await page.locator('.tree-row[data-path="manual-folder"]').waitFor();
  await page.locator('.tree-row[data-path="manual-folder"]').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();
  await page.locator('.tree-row[data-path="manual-folder"]').waitFor({ state: 'detached' });
  await page.locator('#new-project').click();
  await page.locator('#project-name').fill('NewCodebase');
  await page.getByRole('button', { name: 'Choose parent folder' }).click();
  await page.getByRole('button', { name: 'NewCodebase', exact: true }).waitFor();
  await title('New Session');
  await page.screenshot({ path: '.playwright-cli/redesign-code.png', fullPage: true });
  await page.locator('#kind-work').click();
  await title('Session 1');
  await page.screenshot({ path: '.playwright-cli/redesign-work.png', fullPage: true });
  if (errors.length) throw new Error(errors.join('\n'));
  await check(async () => !(await page.locator('#new-project').isDisabled()) && !(await page.locator('#open-project').isDisabled()), 'Project controls stayed disabled after async creation');
  return 'Passed Work Task/session nesting and radio selection, task/session action placement, task rename, mode/draft restoration, auto-saved approvals, aligned conversation/composer widths, project-only actions, activity timeline, Markdown turn summary, safe rendering, stale async selection, background completion, project removal/reopen, and separate New/Open project flows.';
}
