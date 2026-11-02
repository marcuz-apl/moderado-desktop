import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMention, filterFiles, mentionQuery } from '../src/renderer/mention.ts';

test('the at-token is only recognised at a word boundary', () => {
  assert.deepEqual(mentionQuery('@src', 4), { start: 0, query: 'src' });
  assert.deepEqual(mentionQuery('look at @src/ma', 15), { start: 8, query: 'src/ma' });
  assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
  assert.equal(mentionQuery('mail me at a@b.com', 18), null, 'an email is not a reference');
  assert.equal(mentionQuery('no token here', 13), null);
  assert.deepEqual(mentionQuery('@src/main.rs and more', 12), { start: 0, query: 'src/main.rs' }, 'stops at the whitespace after');
});

test('accepting a reference replaces the token and places the caret after it', () => {
  assert.deepEqual(applyMention('@src', 0, 4, 'src/main.rs'), { text: '@src/main.rs ', caret: 13 });
  assert.deepEqual(applyMention('see @ma please', 4, 7, 'src/main.rs'), { text: 'see @src/main.rs  please', caret: 17 });
  assert.deepEqual(applyMention('', 0, 0, 'README.md'), { text: '@README.md ', caret: 11 });
});

test('matches rank by file name before path, then by shorter path', () => {
  const files = ['docs/main-guide.md', 'src/main.rs', 'src/domain/main.ts', 'README.md'];
  assert.deepEqual(filterFiles(files, 'main'), ['src/main.rs', 'docs/main-guide.md', 'src/domain/main.ts']);
  assert.deepEqual(filterFiles(files, 'read'), ['README.md']);
  assert.deepEqual(filterFiles(files, ''), ['docs/main-guide.md', 'src/main.rs', 'src/domain/main.ts', 'README.md']);
  assert.deepEqual(filterFiles(files, 'nope'), []);
});

test('the menu is capped', () => {
  const files = Array.from({ length: 20 }, (_, index) => `file${index}.txt`);
  assert.equal(filterFiles(files, '', 8).length, 8);
});
