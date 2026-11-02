import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCommandLine } from '../src/renderer/terminal.ts';

test('splits a program and its arguments', () => {
  assert.deepEqual(parseCommandLine('cargo test --quiet'), { program: 'cargo', args: ['test', '--quiet'] });
  assert.deepEqual(parseCommandLine('  git   status  '), { program: 'git', args: ['status'] });
  assert.deepEqual(parseCommandLine('ls'), { program: 'ls', args: [] });
});

test('keeps quoted words together and strips the quotes', () => {
  assert.deepEqual(parseCommandLine('git commit -m "two words"'), { program: 'git', args: ['commit', '-m', 'two words'] });
  assert.deepEqual(parseCommandLine("echo 'a b'"), { program: 'echo', args: ['a b'] });
  assert.deepEqual(parseCommandLine('echo ""'), { program: 'echo', args: [''] });
});

test('empty input runs nothing', () => {
  assert.equal(parseCommandLine(''), null);
  assert.equal(parseCommandLine('   '), null);
});

test('no shell features are interpreted', () => {
  // A pipe is just another argument: the program runs directly, so it must not
  // look like the app supports shell syntax.
  assert.deepEqual(parseCommandLine('ls | grep x'), { program: 'ls', args: ['|', 'grep', 'x'] });
  assert.deepEqual(parseCommandLine('echo $HOME'), { program: 'echo', args: ['$HOME'] });
});
