import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SESSION_KIND, needsWorkspacePicker, newSessionLabel, nextSessionKind, profileModeDescription, projectNameFromWorkspace, scheduleWriteApprovalChoiceVisible, visibleSessions } from '../src/renderer/sessions-view.ts';

const sessions = [
  { id: 'a', kind: 'work' },
  { id: 'b', kind: 'code' },
  { id: 'c', kind: 'work' },
];

test('the session list shows one kind at a time', () => {
  assert.deepEqual(visibleSessions(sessions, 'work').map((s) => s.id), ['a', 'c']);
  assert.deepEqual(visibleSessions(sessions, 'code').map((s) => s.id), ['b']);
  assert.deepEqual(visibleSessions([], 'work'), []);
});

test('only Code sessions ask for a project folder', () => {
  assert.equal(needsWorkspacePicker('code'), true);
  assert.equal(needsWorkspacePicker('work'), false);
});

test('Work is the default session kind and the selector toggles both ways', () => {
  assert.equal(DEFAULT_SESSION_KIND, 'work');
  assert.equal(nextSessionKind('work'), 'code');
  assert.equal(nextSessionKind('code'), 'work');
});

test('new session action names the selected session kind', () => {
  assert.equal(newSessionLabel('work'), '+ New Work session');
  assert.equal(newSessionLabel('code'), '+ New Code session');
});

test('Work profile does not require a GitHub account', () => {
  assert.match(profileModeDescription('work'), /not required/i);
  assert.match(profileModeDescription('code'), /optional GitHub account/i);
});

test('Explorer root uses the project folder name on Windows and Unix paths', () => {
  assert.equal(projectNameFromWorkspace('C:\\Users\\me\\Documents\\my-project', 'Session label'), 'my-project');
  assert.equal(projectNameFromWorkspace('/home/me/code/my-project/', 'Session label'), 'my-project');
  assert.equal(projectNameFromWorkspace('', 'Session label'), 'Session label');
});

test('write approval choice is only available to Code sessions', () => {
  assert.equal(scheduleWriteApprovalChoiceVisible('work'), false);
  assert.equal(scheduleWriteApprovalChoiceVisible('code'), true);
});
