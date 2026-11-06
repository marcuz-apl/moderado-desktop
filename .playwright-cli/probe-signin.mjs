import { chromium } from 'playwright-core';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('moderado-account-email:prod', '[email protected]');
    window.__qa = { calls: [] };
    const settings = { providerId: 'moderado', baseUrl: 'https://modr.alfazen.org/v1', planModel: '', actModel: '' };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      async invoke(cmd, args = {}) {
        window.__qa.calls.push({ cmd, args });
        if (cmd === 'plugin:event|listen') return 1;
        if (cmd === 'provider_catalog') return [{ id: 'moderado', name: 'Moderado Gateway', defaultBaseUrl: 'https://modr.alfazen.org/v1', local: false, keyless: true, applyKeyUrl: null, applyKeyLabel: '' }];
        if (cmd === 'load_provider_settings') return settings;
        if (cmd === 'load_mcp_config') return { servers: [] };
        if (cmd === 'moderado_sign_in') return { email: '[email protected]' };
        if (cmd === 'moderado_sign_out' || cmd === 'save_provider_settings') return null;
        if (cmd === 'get_search_settings' || cmd === 'get_lsp_config' || cmd === 'get_git_identity') return {};
        return [];
      },
    };
  });
  await page.goto('http://127.0.0.1:1420');
  await page.waitForTimeout(1200);
  const state = () => page.evaluate(() => ({
    endpoint: document.querySelector('#endpoint').value,
    signinLabel: document.querySelector('#user-signin').textContent.trim(),
    signinHidden: document.querySelector('#user-signin').hasAttribute('hidden'),
    account: document.querySelector('#user-account-name').textContent.trim(),
  }));
  const initial = await state();
  await page.evaluate(() => {
    const field = document.querySelector('#endpoint');
    field.value = 'http://127.0.0.1:4788/v1';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const afterTyping = await state();
  await page.evaluate(() => document.querySelector('#user-signin').click());
  await page.waitForTimeout(300);
  const calls = await page.evaluate(() => window.__qa.calls.filter((c) => c.cmd.startsWith('moderado_')));
  console.log(JSON.stringify({ initial, afterTyping, calls, errors }, null, 2));
  await browser.close();
})();
