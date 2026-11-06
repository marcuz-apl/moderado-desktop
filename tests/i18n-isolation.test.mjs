import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('translation records use weak keys so a rebuilt transcript can be collected', async () => {
  const source = await read('src/renderer/i18n/index.ts');
  // renderTranscript replaces every node; strong keys would retain them all.
  assert.match(source, /new WeakMap<Text, string>\(\)/);
  assert.match(source, /new WeakMap<Element, Map<string, string>>\(\)/);
});

test('names the user typed are never translated', async () => {
  const source = await read('src/renderer/i18n/index.ts');
  const userContent = source.slice(source.indexOf('const USER_CONTENT'), source.indexOf('const KEEP'));
  for (const id of ['#library-list', '#session-title', '#project-root-name', '#workspace-context']) {
    assert.ok(userContent.includes(id), `${id} must stay out of the translation pass`);
  }
});

test('the copy around those names is translated at render time instead', async () => {
  const main = await read('src/renderer/main.ts');
  assert.match(main, /function refreshDraftTitle/);
  assert.match(main, /\$\('project-root-name'\)\.textContent = named \?\? derived/);
  // The Git pane placeholders were missing from every pack, so they stayed
  // English in the other eight languages.
  for (const language of ['fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'de', 'ru']) {
    const pack = await read(`src/renderer/i18n/${language}.ts`);
    assert.match(pack, /'No repository':/, `${language} is missing No repository`);
    assert.match(pack, /'Select a project':/, `${language} is missing Select a project`);
  }
});
