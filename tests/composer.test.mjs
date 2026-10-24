import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canSend, selectedModelLabel, sessionForSubmit, shouldAutoScroll } from '../src/renderer/composer.ts';

test('first message can be submitted after initialization without an existing session', async () => {
  assert.equal(canSend(true, false), true);
  let created = 0;
  const id = await sessionForSubmit(null, async () => {
    created += 1;
    return 'new-session';
  });
  assert.equal(id, 'new-session');
  assert.equal(created, 1);
});

test('later messages reuse the active session', async () => {
  const id = await sessionForSubmit('existing-session', async () => {
    throw new Error('Workspace picker must not reopen');
  });
  assert.equal(id, 'existing-session');
  assert.equal(canSend(true, true), false);
});

test('model label follows the active mode and shows when no model is selected', () => {
  const settings = { planModel: 'planner', actModel: 'coder' };
  assert.equal(selectedModelLabel('plan', settings), 'Plan model: planner');
  assert.equal(selectedModelLabel('act', settings), 'Act model: coder');
  assert.equal(selectedModelLabel('act', { ...settings, actModel: '' }), 'Act model: None selected');
});

test('incoming messages keep the viewport still when reading older chat', () => {
  assert.equal(shouldAutoScroll(700, 1000, 300), true);
  assert.equal(shouldAutoScroll(300, 1000, 300), false);
});
