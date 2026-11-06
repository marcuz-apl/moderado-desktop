import { chromium } from 'playwright-core';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const settings = { providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', planModel: '', actModel: '' };
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      async invoke(cmd) {
        if (cmd === 'plugin:event|listen') return 1;
        if (cmd === 'provider_catalog') return [{ id: 'ollama', name: 'Ollama', defaultBaseUrl: 'http://localhost:11434/v1', local: true, keyless: false, applyKeyUrl: null, applyKeyLabel: '' }];
        if (cmd === 'load_provider_settings') return settings;
        if (cmd === 'load_mcp_config') return { servers: [] };
        if (cmd === 'get_search_settings' || cmd === 'get_lsp_config' || cmd === 'get_git_identity') return {};
        return [];
      },
    };
  });
  await page.goto('http://127.0.0.1:1420');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.waitForTimeout(400);
  const probe = () => {
    const btn = document.querySelector('#add-mcp-server');
    const card = document.querySelector('.mcp-card');
    const list = document.querySelector('#mcp-servers');
    const r = btn.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return {
      text: btn.textContent.trim(),
      disabled: btn.disabled,
      hidden: btn.hasAttribute('hidden'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      card: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) },
      insideCard: r.top >= c.top && r.bottom <= c.bottom,
      rows: list.querySelectorAll('.mcp-server-row').length,
      listParentIsCard: list.parentElement === card,
    };
  };
  const before = await page.evaluate(probe);
  await page.locator('#add-mcp-server').click();
  await page.locator('#add-mcp-server').click();
  await page.waitForTimeout(200);
  const after = await page.evaluate(probe);
  const overflow = await page.evaluate(() => {
    const card = document.querySelector('.mcp-card').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#mcp-servers .mcp-server-row')].map((r) => { const b = r.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), inside: b.bottom <= card.bottom }; });
    return { cardBottom: Math.round(card.bottom), rows };
  });
  await page.screenshot({ path: '.playwright-cli/mcp-card.png', fullPage: true });
  console.log(JSON.stringify({ before, after, overflow, errors }, null, 2));
  await browser.close();
})();
