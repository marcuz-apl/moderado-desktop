import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { folderContextLabel, sessionLabel, sessionStamp } from '../src/renderer/sessions-view.ts';

const stamp = new Date(2020, 9, 29, 10, 23, 54).getTime() / 1000;

test('session stamps read as a local YY-MM-DD HH:MM:SS clock time', () => {
  assert.equal(sessionStamp(stamp), '20-10-29 10:23:54');
  const early = new Date(2024, 0, 2, 3, 4, 5).getTime() / 1000;
  assert.equal(sessionStamp(early), '24-01-02 03:04:05');
});

test('automatic session names read as their creation stamp', () => {
  assert.equal(sessionLabel({ name: 'Session 1', createdAt: stamp }), '20-10-29 10:23:54');
  assert.equal(sessionLabel({ name: 'Session 12', createdAt: stamp }), '20-10-29 10:23:54');
  assert.equal(sessionLabel({ name: 'New Session', createdAt: stamp }), '20-10-29 10:23:54');
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
  assert.equal(folderContextLabel('work', null), 'Select a task to start a session.');
});

test('the Workspaces rows and the topbar headline show the session stamp', async () => {
  const main = await readFile(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.match(main, /radio\.setAttribute\('aria-label', `Select \$\{sessionLabel\(session\)\}`\)/);
  assert.match(main, /button\.textContent = `\$\{running\.has\(session\.id\) \? '● ' : ''\}\$\{sessionLabel\(session\)\}`/);
  assert.match(main, /\$\('session-title'\)\.textContent = sessionLabel\(record\)/);
});

test('the topbar keeps the AGENT SESSION eyebrow above the stamp', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<p class="eyebrow">AGENT SESSION<\/p><h1 id="session-title">/);
});
