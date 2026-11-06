import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  localStorage.removeItem('moderado-navigation'); localStorage.setItem('moderado-theme', 'dark');
  const settings = { providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', planModel: 'planner', actModel: 'writer' };
  const policy = { readFiles: true, editFiles: true, fetchWebContent: true, executeCommand: true, useMcpServers: true };
  const record = (id, name, kind, workspace, updatedAt, taskId = null) => ({ id, name, kind, workspace, taskId, updatedAt, settings, autoApprove: { ...policy, ...(kind === 'work' ? { executeCommand: false, useMcpServers: false } : {}) }, history: [] });
  const state = {
    sessions: [record('c1', 'Code one', 'code', 'C:\\Code\\alpha', 10), record('c2', 'Code two', 'code', 'C:\\Code\\alpha', 9), record('w1', 'Session 1', 'work', 'C:\\Documents\\Moderado-Desktop\\work-session0', 8, 'wt0')],
    workTasks: [{ id: 'wt0', name: 'Task Alpha', workspace: 'C:\\Documents\\Moderado-Desktop\\work-session0', updatedAt: 8 }],
    projects: [{ workspace: 'C:\\Code\\alpha', name: 'Alpha', updatedAt: 10 }],
    projectEntries: [{ workspace: 'C:\\Code\\alpha', name: 'src', path: 'src', isDir: true }, { workspace: 'C:\\Code\\alpha', name: 'code.md', path: 'code.md', isDir: false }],
    calls: [], callbacks: {}, listeners: {}, next: 0, finish: null, copied: null,
  };
  const emit = (event, payload) => { for (const id of state.listeners[event] ?? []) state.callbacks[id]({ event, id, payload }); };
  window.confirm = () => true;
  window.prompt = (_label, value) => value;
  window.__navigationQA = { state, emit };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { state.copied = text; } } });
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
      if (cmd === 'get_session') return state.sessions.find((s) => s.id === args.sessionId) ?? state.sessions[0];
      if (['list_pending_approvals', 'list_checkpoints', 'list_schedules', 'probe_local_providers'].includes(cmd)) return [];
      if (cmd === 'get_search_settings') return { enabled: false, endpoint: '' };
      if (cmd === 'list_project_entries') return [{ name: 'report.md', path: 'report.md', isDir: false }];
      if (cmd === 'read_project_file') return 'Readable document';
      if (cmd === 'save_auto_approve') return;
      if (cmd === 'save_provider_settings') return;
      if (cmd === 'create_default_session' || cmd === 'create_work_session_for_task' || cmd === 'create_session_in_project') {
        const next = record(`new-${state.sessions.length}`, 'Session 1', 'work', 'C:\\Documents\\Moderado-Desktop\\work-session0', 30, 'wt0');
        state.sessions.unshift(next); return next;
      }
      if (cmd === 'start_turn') {
        emit('turn-event', { kind: 'text', session_id: args.sessionId, value: 'Working on the task' });
        return new Promise((resolve) => { state.finish = () => { const active = state.sessions.find((s) => s.id === args.sessionId) ?? state.sessions[0]; active.history = [{ role: 'user', content: args.prompt }, { role: 'assistant', content: '## Turn summary\n\n- Updated the task notes in `report.md`.\n- Preserved the existing project files.' }]; emit('turn-event', { kind: 'done', session_id: args.sessionId }); resolve(); }; });
      }
      if (cmd === 'steer_turn') return;
      if (cmd === 'get_source_control') return { branch: 'main', changes: [], commits: [] };
      if (cmd === 'plugin:dialog|open') return ['C:\\Source\\notes.md'];
      if (cmd === 'add_attachments') return [];
      throw new Error(`Unexpected bridge command: ${cmd}`);
    },
  };
});

try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://localhost:1420');
  await page.waitForSelector('#session-title');
  await page.waitForFunction(() => document.querySelector('#send') && !document.querySelector('#send').disabled);

  const glyph = await page.evaluate(() => {
    const svg = document.querySelector('.composer-stop svg');
    const button = document.querySelector('.composer-stop');
    return {
      glyph: getComputedStyle(svg).width,
      frame: getComputedStyle(button).width,
      triangle: document.querySelector('.stop-play path').getAttribute('d'),
      square: document.querySelector('.stop-square rect').getAttribute('width'),
    };
  });
  if (glyph.glyph !== '22px') throw new Error(`Idle/Stop glyph is ${glyph.glyph}, expected 22px`);
  if (glyph.frame !== '34px') throw new Error(`Idle/Stop button frame changed to ${glyph.frame}`);
  if (!glyph.triangle.startsWith('M3.2 1.9') || glyph.square !== '7.6') throw new Error('the inner shapes did not grow');
  console.log('PASS the Idle/Stop glyph is bigger inside the unchanged 34px button');

  await page.fill('#prompt', 'Measure me');
  await page.press('#prompt', 'Enter');
  await page.waitForSelector('.message.you .message-actions');

  const sent = await page.evaluate(() => {
    const card = document.querySelector('.message.you');
    const body = card.querySelector('.message-body').getBoundingClientRect();
    const actions = card.querySelector('.message-actions');
    return {
      buttons: [...actions.querySelectorAll('.message-action')].map((button) => button.dataset.action),
      below: actions.getBoundingClientRect().top >= body.bottom - 1,
      size: getComputedStyle(actions.querySelector('svg')).width,
    };
  });
  if (sent.buttons.join(',') !== 'copy,rerun') throw new Error(`sent question has [${sent.buttons}]`);
  if (!sent.below) throw new Error('sent-question actions are not below the box');
  if (sent.size !== '13px') throw new Error(`action icon is ${sent.size}, expected 13px`);
  console.log('PASS the sent-question box has small copy + re-run icons beneath it');

  await page.locator('.message.you .message-action-copy').first().click();
  const copiedPrompt = await page.evaluate(() => window.__navigationQA.state.copied);
  if (copiedPrompt !== 'Measure me') throw new Error(`copy produced ${JSON.stringify(copiedPrompt)}`);
  const copyTitle = await page.locator('.message.you .message-action-copy').first().getAttribute('title');
  if (copyTitle !== 'Copied') throw new Error(`copy feedback title is ${copyTitle}`);
  console.log('PASS copying a sent question writes the exact prompt and flashes Copied');

  await page.evaluate(() => window.__navigationQA.state.finish?.());
  await page.waitForSelector('.message.turn-summary .message-actions');
  const summaryButtons = await page.evaluate(() => [...document.querySelectorAll('.turn-summary .message-action')].map((button) => button.dataset.action));
  if (summaryButtons.join(',') !== 'copy') throw new Error(`turn summary has [${summaryButtons}]`);
  await page.locator('.turn-summary .message-action-copy').click();
  const copiedSummary = await page.evaluate(() => window.__navigationQA.state.copied);
  if (!copiedSummary.includes('Updated the task notes')) throw new Error(`summary copy produced ${JSON.stringify(copiedSummary)}`);
  console.log('PASS the turn summary has one working copy icon beneath it');

  await page.fill('#prompt', 'Unsent draft');
  await page.locator('.message.you .message-action-rerun').first().click();
  await page.waitForFunction(() => window.__navigationQA.state.calls.filter((call) => call.cmd === 'start_turn').length === 2);
  const rerun = await page.evaluate(() => ({
    prompts: window.__navigationQA.state.calls.filter((call) => call.cmd === 'start_turn').map((call) => call.args.prompt),
    draft: document.querySelector('#prompt').value,
  }));
  if (rerun.prompts.join('|') !== 'Measure me|Measure me') throw new Error(`re-run sent ${JSON.stringify(rerun.prompts)}`);
  if (rerun.draft !== 'Unsent draft') throw new Error(`re-run wiped the composer draft: ${JSON.stringify(rerun.draft)}`);
  console.log('PASS re-run resubmits the original prompt without discarding the draft');

  await page.screenshot({ path: '.playwright-cli/message-actions.png' });
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('\nRESULT: 5 MESSAGE-ACTION CHECKS PASSED');
} catch (error) {
  console.log('ERR', error.message);
  process.exitCode = 1;
} finally { await browser.close(); }
