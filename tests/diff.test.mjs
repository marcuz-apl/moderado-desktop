import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineDiff } from '../src/renderer/diff.ts';

test('line diff shows unchanged context and the removed and added lines', () => {
  assert.deepEqual(lineDiff('alpha\nold\nomega', 'alpha\nnew\nomega'), [
    { kind: 'context', text: 'alpha' },
    { kind: 'removed', text: 'old' },
    { kind: 'added', text: 'new' },
    { kind: 'context', text: 'omega' },
  ]);
});
