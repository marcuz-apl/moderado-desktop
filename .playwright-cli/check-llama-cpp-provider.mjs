// Real-browser check for the llama.cpp entry in Settings -> Provider.
// The mock mirrors the Rust catalog (checked against the source below), so the
// dropdown order, endpoint, key field, and download link are exercised for real.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const CATALOG = [
  { id: 'moderado', name: 'Moderado', defaultBaseUrl: 'https://modr.alfazen.org/v1', local: false, keyless: true, applyKeyUrl: 'https://modr.alfazen.org/account?mode=signin', applyKeyLabel: 'Get API key' },
  { id: 'nvidia_nim', name: 'Nvidia NIM', defaultBaseUrl: 'https://integrate.api.nvidia.com/v1', local: false, keyless: false, applyKeyUrl: 'https://build.nvidia.com/settings/api-keys', applyKeyLabel: 'Get API key' },
  { id: 'open_router', name: 'OpenRouter', defaultBaseUrl: 'https://openrouter.ai/api/v1', local: false, keyless: false, applyKeyUrl: 'https://openrouter.ai/settings/keys', applyKeyLabel: 'Get API key' },
  { id: 'llama_cpp', name: 'llama.cpp', defaultBaseUrl: 'http://127.0.0.1:9931/v1', local: true, keyless: false, applyKeyUrl: 'https://github.com/ggml-org/llama.cpp/releases', applyKeyLabel: 'Get llama.cpp' },
  { id: 'ollama', name: 'Ollama - Local', defaultBaseUrl: 'http://127.0.0.1:11434/v1', local: true, keyless: false, applyKeyUrl: 'https://ollama.com/download', applyKeyLabel: 'Get Ollama' },
  { id: 'lm_studio', name: 'LM Studio - Local', defaultBaseUrl: 'http://127.0.0.1:1234/v1', local: true, keyless: false, applyKeyUrl: 'https://lmstudio.ai/download', applyKeyLabel: 'Get LM Studio' },
  { id: 'open_ai_compatible', name: 'Other OpenAI Compatible Endpoints', defaultBaseUrl: '', local: false, keyless: false, applyKeyUrl: null, applyKeyLabel: '' },
];

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.addInitScript((presets) => {
  localStorage.removeItem('moderado-navigation');
  const settings = { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', planModel: 'planner', actModel: 'writer' };
  const policy = { readFiles: true, editFiles: true, fetchWebContent: true, executeCommand: true, useMcpServers: true };
  const record = (id, name, kind, workspace, updatedAt) => ({ id, name, kind, workspace, taskId: 'wt0', updatedAt, settings, autoApprove: { ...policy }, history: [] });
  const session = record('w1', 'Session 1', 'work', 'C:\\Documents\\Moderado-Desktop\\work-session0', 8);
  const state = {
    sessions: [session],
    workTasks: [{ id: 'wt0', name: 'Task Alpha', workspace: session.workspace, updatedAt: 8 }],
    projects: [], calls: [], callbacks: {}, listeners: {}, next: 0,
  };
  const emit = (event, payload) => { for (const id of state.listeners[event] ?? []) state.callbacks[id]({ event, id, payload }); };
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) { const id = ++state.next; state.callbacks[id] = callback; return id; },
    unregisterCallback(id) { delete state.callbacks[id]; },
    async invoke(cmd, args = {}) {
      state.calls.push({ cmd, args });
      if (cmd === 'plugin:event|listen') { (state.listeners[args.event] ??= []).push(args.handler); return args.handler; }
      if (cmd === 'provider_catalog') return presets;
      if (cmd === 'load_provider_settings') return settings;
      if (cmd === 'probe_local_providers') return [
        { id: 'llama_cpp', available: false },
        { id: 'ollama', available: true },
        { id: 'lm_studio', available: false },
      ];
      if (cmd === 'list_sessions') return state.sessions;
      if (cmd === 'list_work_tasks') return state.workTasks;
      if (cmd === 'list_projects') return state.projects;
      if (cmd === 'get_session') return state.sessions.find((item) => item.id === args.sessionId) ?? session;
      if (cmd === 'get_search_settings') return { enabled: false, endpoint: '' };
      if (cmd === 'load_mcp_config' || cmd === 'load_lsp_config') return { servers: [] };
      if (cmd === 'get_git_identity') return {};
      if (cmd === 'get_source_control') return { branch: 'main', changes: [], commits: [] };
      if (cmd === 'create_default_session' || cmd === 'create_work_session_for_task') return session;
      if (cmd === 'start_turn') return new Promise((resolve) => { emit('turn-event', { kind: 'done', session_id: args.sessionId }); resolve(); });
      return [];
    },
  };
}, CATALOG);

const provider = readFileSync(new URL('../src-tauri/src/provider.rs', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
const state = () => page.evaluate(() => ({
  options: [...document.querySelectorAll('#provider-select option')].map((option) => ({ value: option.value, label: option.textContent.trim() })),
  endpoint: document.querySelector('#endpoint').value,
  keyDisabled: document.querySelector('#api-key').disabled,
  keyPlaceholder: document.querySelector('#api-key').placeholder,
  applyText: document.querySelector('#apply-key-link').textContent.trim(),
  applyHref: document.querySelector('#apply-key-link').getAttribute('href'),
  applyVisible: document.querySelector('#apply-key-link').style.display !== 'none',
  gatewayHidden: document.querySelector('#gateway-mode').hasAttribute('hidden'),
  keylessHidden: document.querySelector('#keyless-hint').hidden,
  selected: document.querySelector('#provider-select').value,
}));

try {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://localhost:1420');
  await page.waitForSelector('#session-title');
  await page.waitForTimeout(1200);

  // The mock is only trustworthy if the shipped Rust catalog matches it.
  const ids = [...provider.slice(provider.indexOf('pub const PRESETS'), provider.indexOf('impl ProviderId')).matchAll(/id:\s*ProviderId::(\w+)/g)].map((match) => match[1]);
  const snake = (id) => id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (JSON.stringify(ids.map(snake)) !== JSON.stringify(CATALOG.map((preset) => preset.id))) {
    throw new Error(`Rust catalog ${ids.join(',')} does not match the mocked catalog`);
  }
  if (!provider.includes('default_base_url: "http://127.0.0.1:9931/v1"')) throw new Error('the Rust preset does not use port 9931');
  if (!provider.includes('name: "llama.cpp"')) throw new Error('the Rust preset is not named llama.cpp');
  if (!main.includes("'open_router' | 'llama_cpp' | 'ollama'")) throw new Error('the renderer ProviderId union is stale');
  console.log('PASS the Rust catalog and renderer type agree on the seven-provider order');

  await page.locator('.rail-tab[data-page-link="settings"]').click();
  await page.waitForSelector('#page-settings.active');
  const initial = await state();
  const labels = initial.options.map((option) => option.label);
  if (labels[2] !== 'OpenRouter' || labels[3] !== 'llama.cpp (offline)' || labels[4] !== 'Ollama - Local (available)') {
    throw new Error(`wrong provider order: ${labels.join(' | ')}`);
  }
  if (labels[5] !== 'LM Studio - Local (offline)' || labels[6] !== 'Other OpenAI Compatible Endpoints') {
    throw new Error(`the remaining providers moved: ${labels.join(' | ')}`);
  }
  if (initial.options[3].value !== 'llama_cpp') throw new Error('llama.cpp has the wrong option value');
  console.log('PASS llama.cpp is fourth in Settings, between OpenRouter and Ollama - Local');
  console.log('PASS the startup probe marks all three local runtimes available/offline');

  await page.selectOption('#provider-select', 'llama_cpp');
  await page.waitForTimeout(150);
  const local = await state();
  if (local.endpoint !== 'http://127.0.0.1:9931/v1') throw new Error(`llama.cpp endpoint is ${local.endpoint}`);
  if (!local.keyDisabled) throw new Error('a local runtime should disable the API key box');
  if (local.applyText !== 'Get llama.cpp' || local.applyHref !== 'https://github.com/ggml-org/llama.cpp/releases' || !local.applyVisible) {
    throw new Error(`llama.cpp link is ${local.applyText} -> ${local.applyHref}`);
  }
  if (!local.gatewayHidden || !local.keylessHidden) throw new Error('Gateway-only controls leaked into the local preset');
  console.log('PASS selecting llama.cpp fills port 9931, disables the key, and links to its releases');

  await page.selectOption('#provider-select', 'open_router');
  await page.waitForTimeout(150);
  const remote = await state();
  if (remote.endpoint !== 'https://openrouter.ai/api/v1' || remote.keyDisabled || remote.applyText !== 'Get API key') {
    throw new Error(`OpenRouter regressed: ${JSON.stringify(remote)}`);
  }
  await page.selectOption('#provider-select', 'llama_cpp');
  await page.waitForTimeout(150);
  const back = await state();
  if (back.endpoint !== 'http://127.0.0.1:9931/v1') throw new Error(`reselecting llama.cpp lost its endpoint: ${back.endpoint}`);
  console.log('PASS switching to a remote provider and back keeps the llama.cpp draft');

  await page.screenshot({ path: '.playwright-cli/provider-llama-cpp.png', fullPage: true });
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('RESULT: 5 LLAMA.CPP PROVIDER CHECKS PASSED');
} catch (error) {
  console.log('ERR', error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
