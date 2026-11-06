import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readStylesheet } from './style.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the Idle/Stop glyph grows without changing the button frame', async () => {
  const [html, css] = await Promise.all([read('index.html'), readStylesheet()]);
  const button = html.match(/<button id="stop"[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(button, /class="stop-play"[\s\S]*?d="M3\.2 1\.9 10 6 3\.2 10\.1Z"/, 'the idle triangle fills more of its viewBox');
  assert.match(button, /class="stop-square"[\s\S]*?width="7\.6" height="7\.6"/, 'the stop square fills more of its viewBox');
  assert.match(css, /\.composer-stop svg\{width:22px;height:22px\}/, 'the glyph draws at 22px');
  assert.match(css, /\.composer-stop\{[^}]*width:34px;height:34px/, 'the 34px button is unchanged');
});

test('turn summaries get a copy action and sent questions get copy plus re-run', async () => {
  const [main, css] = await Promise.all([read('src/renderer/main.ts'), readStylesheet()]);
  assert.match(main, /if \(message\.role === 'Turn summary' \|\| message\.role === 'You'\) card\.append\(messageActions\(message\)\)/);
  assert.match(main, /if \(message\.role === 'You'\) \{[\s\S]*?messageActionButton\('rerun'\)/);
  assert.match(main, /button\.dataset\.noI18n = ''/, 'action labels stay out of conversation translation');
  assert.match(main, /button\.title = t\(action === 'copy' \? 'Copy' : 'Re-run'\)/);
  assert.match(main, /refreshMessageActionLabels\(\)/, 'labels follow a language switch');
  assert.match(css, /\.message-actions\{display:flex;align-items:center;gap:4px;margin:6px 0 0 18px\}/);
  assert.match(css, /\.message-action svg\{width:13px;height:13px\}/);
  assert.match(css, /:root\[data-theme="light"\] \.message-action\{/, 'light theme has its own contrast');
});

test('copy and re-run keep the original prompt and the current draft', async () => {
  const main = await read('src/renderer/main.ts');
  assert.match(main, /await navigator\.clipboard\.writeText\(text\); copied = true/);
  assert.match(main, /document\.execCommand\('copy'\)/, 'a fallback exists when the clipboard API is denied');
  assert.match(main, /button\.title = t\('Copied'\)/, 'the button confirms a successful copy');
  assert.match(main, /type DisplayMessage = \{[^}]*prompt\?: string; attachments\?: AttachmentRecord\[\]/);
  assert.match(main, /if \(sentView\) \{ sentView\.prompt = text; sentView\.attachments = sent; \}/);
  assert.match(main, /await submitTurn\(text, attachments, false, true\)/, 're-run keeps the composer draft');
  assert.match(main, /if \(!fromQueue && !preserveDraft\)/);
  assert.match(main, /enqueueTurn\(id, text, attachments\);[\s\S]*?Re-run queued for the next turn\./, 'a busy session queues the re-run');
});

test('all language packs localize the three action labels', async () => {
  const packs = ['fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'de', 'ru'];
  for (const language of packs) {
    const source = await read(`src/renderer/i18n/${language}.ts`);
    for (const phrase of ['Copy', 'Re-run', 'Copied']) {
      assert.match(source, new RegExp(`'${phrase}': '[^']+'`), `${language}.ts translates ${phrase}`);
    }
  }
});

test('the in-app manual explains the two message action rows', async () => {
  const manual = await read('docs/manual.md');
  assert.match(manual, /\*\*sent question\*\* are two small buttons: \*\*Copy\*\*[\s\S]*?\*\*Re-run\*\*/);
  assert.match(manual, /\*\*Turn summary\*\* cards have a \*\*Copy\*\* button too/);
});
