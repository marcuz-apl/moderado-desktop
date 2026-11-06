import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Shift + wheel and Shift + middle click are wired to the transcript scale', async () => {
  const main = await read('src/renderer/main.ts');
  assert.match(main, /document\.addEventListener\('wheel', \(event: WheelEvent\) => \{[\s\S]*?if \(!event\.shiftKey\) return;[\s\S]*?event\.target\.closest\('\.main'\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?stepContextScale\(contextScale, delta < 0 \? 1 : -1\)[\s\S]*?\}, \{ passive: false \}\)/);
  assert.match(main, /event\.button !== 1 \|\| !event\.shiftKey/, 'the middle button reset also requires Shift');
  assert.match(main, /setContextScale\(DEFAULT_CONTEXT_SCALE\)/);
  assert.match(main, /const delta = event\.deltaY \|\| event\.deltaX/, 'trackpads that scroll on X work too');
});

test('the gesture scales only the conversation and multiplies the Settings preset', async () => {
  const main = await read('src/renderer/main.ts');
  assert.match(main, /const scale = Number\(\(textScaleFor\(textSize\) \* contextScale\)\.toFixed\(3\)\)/);
  assert.match(main, /transcript\.style\.setProperty\('--text-scale', String\(scale\)\)/);
  assert.match(main, /root\.dataset\.textSize = textSize;[\s\S]*?applyContextScale\(\)/, 'a Settings change recomputes the combined scale');
  assert.match(main, /localStorage\.setItem\(contextScaleKey, String\(contextScale\)\)/);
  assert.match(main, /const contextScaleKey = 'moderado-context-scale'/);
  assert.match(main, /setStatus\(`\$\{t\('Context text size'\)\}: \$\{Math\.round\(contextScale \* 100\)\}%`\)/);
});

test('the Settings hint, manual and language packs document the gesture', async () => {
  const [html, manual] = await Promise.all([read('index.html'), read('docs/manual.md')]);
  assert.match(html, /<p class="hint">Shift \+ wheel over the conversation changes the context text size; Shift \+ middle click resets it\.<\/p>/);
  assert.match(manual, /`Shift` \+ mouse wheel \| Enlarge or shrink the conversation text on the fly/);
  assert.match(manual, /`Shift` \+ middle click \| Reset the conversation text to 100%/);
  for (const language of ['fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'de', 'ru']) {
    const pack = await read(`src/renderer/i18n/${language}.ts`);
    assert.match(pack, /'Context text size': '[^']+'/);
    assert.match(pack, /'Shift \+ wheel over the conversation changes the context text size; Shift \+ middle click resets it\.': '[^']+'/);
  }
});
