import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  localStorage.removeItem('moderado-navigation'); localStorage.setItem('moderado-theme', 'dark');
  const settings = { providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', planModel: 'planner', actModel: 'writer' };
  const policy = { readFiles: true, editFiles: true, fetchWebContent: true, executeCommand: true, useMcpServers: true };
  const record = (id, name, kind, workspace, updatedAt, taskId = null) => ({ id, name, kind, workspace, taskId, updatedAt, settings, autoApprove: { ...policy }, history: [] });
  const state = {
    sessions: [record('w1', 'Session 1', 'work', 'C:\\Documents\\Moderado-Desktop\\work-session0', 8, 'wt0')],
    workTasks: [{ id: 'wt0', name: 'Task Alpha', workspace: 'C:\\Documents\\Moderado-Desktop\\work-session0', updatedAt: 8 }],
    projects: [], projectEntries: [], calls: [], callbacks: {}, listeners: {}, next: 0,
  };
  window.__navigationQA = { state };
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
      if (cmd === 'load_mcp_config') return { servers: [] };
      if (cmd === 'list_project_entries') return [];
      if (cmd === 'get_source_control') return { branch: 'main', changes: [], commits: [] };
      return;
    },
  };
});

const scaleOf = () => page.evaluate(() => {
  const transcript = document.querySelector('.transcript');
  return {
    inline: transcript.style.getPropertyValue('--text-scale'),
    computed: getComputedStyle(transcript).getPropertyValue('--text-scale').trim(),
    heading: getComputedStyle(document.querySelector('.empty-state h2')).fontSize,
    status: document.querySelector('#status').textContent,
  };
});
const wheel = async (deltaY, shift) => {
  await page.locator('.transcript').hover();
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.wheel(0, deltaY);
  if (shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(40);
};

try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://localhost:1420');
  await page.waitForSelector('#session-title');
  await page.waitForSelector('.empty-state h2');

  const start = await scaleOf();
  if (start.inline !== '1' || start.heading !== '29px') throw new Error(`baseline scale is ${JSON.stringify(start)}`);
  console.log('PASS the conversation starts at 100% (29px empty-state heading)');

  await wheel(-100, true);
  const grown = await scaleOf();
  if (grown.inline !== '1.05' || grown.computed !== '1.05') throw new Error(`Shift + wheel up produced ${JSON.stringify(grown)}`);
  if (grown.heading !== '30.45px') throw new Error(`conversation text did not grow: ${grown.heading}`);
  if (!grown.status.includes('105%')) throw new Error(`status readout is ${JSON.stringify(grown.status)}`);
  console.log('PASS Shift + wheel up grows the context text to 105% (30.45px) with a status readout');

  await wheel(100, false);
  const plain = await scaleOf();
  if (plain.inline !== '1.05') throw new Error(`a plain wheel changed the scale to ${plain.inline}`);
  await wheel(100, true);
  await wheel(100, true);
  const shrunk = await scaleOf();
  if (shrunk.inline !== '0.95') throw new Error(`two Shift + wheel downs produced ${shrunk.inline}`);
  console.log('PASS plain scrolling is untouched and Shift + wheel down shrinks the text');

  const box = await page.locator('.transcript').boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'middle' });
  await page.keyboard.up('Shift');
  await page.waitForTimeout(40);
  const reset = await scaleOf();
  if (reset.inline !== '1') throw new Error(`Shift + middle click left the scale at ${reset.inline}`);
  console.log('PASS Shift + middle click resets the context text to 100%');

  await wheel(-100, true);
  await wheel(-100, true);
  if ((await scaleOf()).inline !== '1.1') throw new Error('could not reach 110%');
  await page.reload();
  await page.waitForSelector('.empty-state h2');
  const restored = await scaleOf();
  if (restored.inline !== '1.1') throw new Error(`reload lost the scale: ${restored.inline}`);
  console.log('PASS the live scale persists across a restart');

  await page.locator('.rail-tab[data-page-link="settings"]').click();
  await page.selectOption('#text-size', 'large');
  const combined = await page.evaluate(() => document.querySelector('.transcript').style.getPropertyValue('--text-scale'));
  if (combined !== '1.265') throw new Error(`Settings Large + 110% should be 1.265, got ${combined}`);
  console.log('PASS the Settings Text size preset multiplies the live scale (1.15 x 1.10 = 1.265)');

  await page.screenshot({ path: '.playwright-cli/context-scale.png' });
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('\nRESULT: 6 CONTEXT-SCALE CHECKS PASSED');
} catch (error) {
  console.log('ERR', error.message);
  process.exitCode = 1;
} finally { await browser.close(); }
