import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMcpArgs, parseMcpEnv, parseMcpTools } from '../src/renderer/mcp-config.ts';

test('args parse as a JSON array', () => {
  assert.deepEqual(parseMcpArgs(''), []);
  assert.deepEqual(parseMcpArgs('["-y","pkg"]'), ['-y', 'pkg']);
  assert.deepEqual(parseMcpArgs('[1, true]'), ['1', 'true']);
  assert.throws(() => parseMcpArgs('{"a":1}'), /JSON array/);
});

test('env parses as a JSON object of strings', () => {
  assert.deepEqual(parseMcpEnv(''), {});
  assert.deepEqual(parseMcpEnv('{"TOKEN":"x"}'), { TOKEN: 'x' });
  assert.deepEqual(parseMcpEnv('{"PORT":8080}'), { PORT: '8080' });
  assert.throws(() => parseMcpEnv('["x"]'), /JSON object/);
});

test('tools split on commas and blank means every tool', () => {
  assert.equal(parseMcpTools(''), null);
  assert.equal(parseMcpTools('   '), null);
  assert.deepEqual(parseMcpTools('echo, fail'), ['echo', 'fail']);
  assert.deepEqual(parseMcpTools(' echo ,, fail '), ['echo', 'fail']);
});
