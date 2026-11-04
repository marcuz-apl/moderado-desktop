import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the packaged executable carries the company copyright', async () => {
  const config = JSON.parse(await read('src-tauri/tauri.conf.json'));
  // Windows embeds this as LegalCopyright; macOS uses it as NSHumanReadableCopyright.
  assert.equal(config.bundle.copyright, 'Copyright (c) 2026 Alfazen Inc.');
});
