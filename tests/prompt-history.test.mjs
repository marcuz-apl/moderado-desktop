import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_RECALL, canRecall, recall } from '../src/renderer/prompt-history.ts';

test('arrows are only taken over on the first and last line', () => {
  assert.equal(canRecall('', 0, 0, -1), true);
  assert.equal(canRecall('', 0, 0, 1), true);
  assert.equal(canRecall('hello', 5, 5, -1), true);
  assert.equal(canRecall('hello', 2, 2, -1), true);
  assert.equal(canRecall('one\ntwo', 7, 7, -1), false, 'caret on the second line moves the caret');
  assert.equal(canRecall('one\ntwo', 3, 3, 1), false, 'there is a line below the caret');
  assert.equal(canRecall('one\ntwo', 7, 7, 1), true, 'last line can step forward');
  assert.equal(canRecall('hello', 1, 3, -1), false, 'a selection is left alone');
});

test('up walks back through history and down walks forward', () => {
  const history = ['first', 'second', 'third'];
  const up = recall(history, EMPTY_RECALL, -1, 'draft text');
  assert.equal(up?.text, 'third');
  assert.equal(up?.state.index, 2);
  const older = recall(history, up.state, -1, 'third');
  assert.equal(older?.text, 'second');
  const oldest = recall(history, older.state, -1, 'second');
  assert.equal(oldest?.text, 'first');
  assert.equal(oldest?.state.index, 0);
  assert.equal(recall(history, oldest.state, -1, 'first'), null, 'stops at the oldest entry');
  const back = recall(history, oldest.state, 1, 'first');
  assert.equal(back?.text, 'second');
});

test('coming down past the newest entry restores the draft', () => {
  const history = ['only'];
  const recalled = recall(history, EMPTY_RECALL, -1, 'my unsent draft');
  assert.equal(recalled?.text, 'only');
  const restored = recall(history, recalled.state, 1, 'only');
  assert.equal(restored?.text, 'my unsent draft');
  assert.deepEqual(restored?.state, EMPTY_RECALL);
});

test('an empty history or a downward press at the draft changes nothing', () => {
  assert.equal(recall([], EMPTY_RECALL, -1, 'draft'), null);
  assert.equal(recall([], EMPTY_RECALL, 1, 'draft'), null);
  assert.equal(recall(['a'], EMPTY_RECALL, 1, 'draft'), null);
});
