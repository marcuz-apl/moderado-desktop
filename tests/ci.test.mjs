import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the browser checks are version controlled instead of ignored', async () => {
  const ignore = await read('.gitignore');
  // A bare `.playwright-cli/` entry kept the whole suite out of the repository,
  // so nothing verified the renderer outside the machine that wrote it.
  assert.doesNotMatch(ignore, /^\.playwright-cli\/$/m);
  assert.match(ignore, /^\.playwright-cli\/\*\.png$/m);
});

test('every browser check resolves Playwright from the project, not a machine path', async () => {
  const directory = new URL('../.playwright-cli/', import.meta.url);
  const checks = (await readdir(directory)).filter((name) => /^check-.*\.mjs$/.test(name));
  assert.ok(checks.length >= 10, `expected the full set of checks, found ${checks.length}`);
  for (const name of checks) {
    const source = await read(`.playwright-cli/${name}`);
    assert.match(source, /from 'playwright-core'/, `${name} must import playwright-core`);
    assert.doesNotMatch(source, /npm-cache\/_npx|ms-playwright/, `${name} must not hardcode a browser path`);
  }
});

test('CI runs the browser checks against the built frontend', async () => {
  const workflow = await read('.github/workflows/ci.yml');
  assert.match(workflow, /npm run test:browser/);
  const { scripts } = JSON.parse(await read('package.json'));
  assert.equal(scripts['test:browser'], 'vite build && node .playwright-cli/run-static-checks.cjs');
  assert.ok(JSON.parse(await read('package.json')).devDependencies['playwright-core']);
});

test('the runner discovers every check when it is given none', async () => {
  const runner = await read('.playwright-cli/run-static-checks.cjs');
  // The default set has to come from the folder, or a new check would only run
  // on the machine that remembered to name it.
  assert.match(runner, /readdirSync\(__dirname\)/);
  assert.match(runner, /check-\.\*\\\.mjs/);
});

test('the stylesheet keeps one declaration per line', async () => {
  const lines = (await read('src/renderer/style.css')).split(/\r?\n/);
  // The file was once minified, with rules packed onto lines thousands of
  // characters long, so changing one property rewrote a line no reviewer could
  // read. Nothing enforces the shape of a stylesheet, so this does.
  const longest = lines.reduce((worst, line) => (line.length > worst ? line.length : worst), 0);
  assert.ok(longest <= 120, `longest stylesheet line is ${longest} characters`);
  const packed = lines.find((line) => (line.match(/;/g) ?? []).length > 1);
  assert.equal(packed, undefined, `declarations share a line: ${packed?.trim()}`);
});
