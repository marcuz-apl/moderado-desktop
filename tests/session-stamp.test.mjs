import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { folderContextLabel, sessionLabel, sessionStamp } from '../src/renderer/sessions-view.ts';

const stamp = new Date(2020, 9, 29, 10, 23, 54).getTime() / 1000;

test('session stamps read as a local YYYY-MM-DD HH:MM:SS clock time', () => {
  assert.equal(sessionStamp(stamp), '2020-10-29 10:23:54');
  const early = new Date(2024, 0, 2, 3, 4, 5).getTime() / 1000;
  assert.equal(sessionStamp(early), '2024-01-02 03:04:05');
});

test('automatic session names read as their creation stamp', () => {
  assert.equal(sessionLabel({ name: 'Session 1', createdAt: stamp }), '2020-10-29 10:23:54');
  assert.equal(sessionLabel({ name: 'Session 12', createdAt: stamp }), '2020-10-29 10:23:54');
  assert.equal(sessionLabel({ name: 'New Session', createdAt: stamp }), '2020-10-29 10:23:54');
});

test('a session created with its stamp keeps that stamp as its name', () => {
  assert.equal(
    sessionLabel({ name: '2026-11-04 07:16:23', createdAt: stamp }),
    '2026-11-04 07:16:23',
  );
});

test('a renamed session keeps the name the user typed', () => {
  assert.equal(sessionLabel({ name: 'Fix the login bug', createdAt: stamp }), 'Fix the login bug');
});

test('a session without a creation stamp falls back to its name', () => {
  assert.equal(sessionLabel({ name: 'Session 1' }), 'Session 1');
});

test('the topbar context names the project or task instead of the full path', () => {
  assert.equal(folderContextLabel('code', 'C:\\code\\alpha', 'Alpha app'), 'Alpha app');
  assert.equal(folderContextLabel('code', 'C:\\code\\alpha'), 'alpha');
  assert.equal(folderContextLabel('work', '/docs/Task 7', undefined, 'Research'), 'Research');
  assert.equal(folderContextLabel('work', '/docs/Task 7'), 'Task 7');
  assert.equal(folderContextLabel('code', null), 'Create or open a project folder.');
  assert.equal(folderContextLabel('work', null), 'Select a task to start.');
});

test('the Library rows and the topbar headline show the session stamp', async () => {
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /radio\.setAttribute\('aria-label', `Select \$\{sessionLabel\(session\)\}`\)/);
  assert.match(main, /button\.textContent = `\$\{running\.has\(session\.id\) \? '● ' : ''\}\$\{sessionLabel\(session\)\}`/);
  assert.match(main, /\$\('session-title'\)\.textContent = sessionLabel\(record\)/);
});

test('a new Code session sends its creation stamp as the session name', async () => {
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(
    main,
    /invoke<SessionRecord>\('create_session_in_project', \{ projectWorkspace: workspace, settings, name: sessionStamp\(Date\.now\(\) \/ 1000\) \}\)/,
  );
});

test('the topbar markup keeps the label attached to the session title', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<p id="session-eyebrow" class="eyebrow">AGENT SESSION<\/p><h1 id="session-title">/);
});

test('the topbar lays the label and the stamp out on one row', async () => {
  const css = await readFile(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.topbar \.topbar-title\{display:flex;align-items:baseline;gap:10px/);
  assert.match(css, /\.topbar \.topbar-title \.eyebrow\{[^}]*font-size:12px/);
  assert.match(css, /\.topbar \.topbar-title \.eyebrow::after\{content:":"\}/);
  assert.match(css, /\.topbar \.topbar-title h1\{[^}]*font-size:13px/);
});
