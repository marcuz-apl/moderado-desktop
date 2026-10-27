import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionForMode } from '../src/renderer/sessions-view.ts';

const sessions = [
  { id: 'code-a', kind: 'code', workspace: '/a' },
  { id: 'work-new', kind: 'work', workspace: '/tasks/2' },
  { id: 'work-old', kind: 'work', workspace: '/tasks/1' },
  { id: 'code-b', kind: 'code', workspace: '/b' },
];

test('mode restoration never returns another mode and honors the remembered conversation', () => {
  assert.equal(sessionForMode(sessions, 'work', 'code-a')?.id, 'work-new');
  assert.equal(sessionForMode(sessions, 'work', 'work-old')?.id, 'work-old');
  assert.equal(sessionForMode(sessions, 'code', 'work-new')?.id, 'code-a');
});

test('a selected project with no conversations remains an empty project draft', () => {
  assert.equal(sessionForMode(sessions, 'code', 'code-b', '/a')?.id, 'code-a');
  assert.equal(sessionForMode(sessions, 'code', 'code-a', '/empty'), undefined);
  assert.equal(sessionForMode([], 'work', 'work-old'), undefined);
});
