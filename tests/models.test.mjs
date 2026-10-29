import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultModelId, explainProviderError, isKeylessModel, keylessModelCount, modelOptionLabel } from '../src/renderer/models.ts';

const catalog = [
  { id: 'stealth/one:free', name: 'Stealth One', access: 'free', section: 'default', capabilities: ['tools'] },
  { id: 'other/free', name: 'Other Free', access: 'free', section: 'other', capabilities: ['text'] },
  { id: 'paid/model', name: 'Paid Model', access: 'paid', section: 'other' },
  { id: 'plain-model', name: '' },
];

test('the pinned stealth default is labelled as no-key', () => {
  assert.equal(modelOptionLabel(catalog[0]), 'Stealth One — free, no key');
  assert.equal(isKeylessModel(catalog[0]), true);
  assert.equal(isKeylessModel(catalog[1]), false);
});

test('free-but-key-required and paid models are labelled distinctly', () => {
  assert.equal(modelOptionLabel(catalog[1]), 'Other Free — free, key required');
  assert.equal(modelOptionLabel(catalog[2]), 'Paid Model — paid');
  assert.equal(modelOptionLabel(catalog[3]), 'plain-model');
});

test('a stealth default is preselected, else the first model, else nothing', () => {
  assert.equal(defaultModelId(catalog), 'stealth/one:free');
  assert.equal(defaultModelId([catalog[1]]), 'other/free');
  assert.equal(defaultModelId([]), '');
});

test('the keyless count only counts pinned defaults', () => {
  assert.equal(keylessModelCount(catalog), 1);
  assert.equal(keylessModelCount([]), 0);
});

test('a 401 from a keyless provider explains the free stealth models', () => {
  const hint = explainProviderError('Provider returned HTTP 401', { name: 'Moderado', keyless: true });
  assert.match(hint, /free stealth models work without one/);
  assert.equal(
    explainProviderError('Provider returned HTTP 500', { name: 'Moderado', keyless: true }),
    'Provider returned HTTP 500',
  );
  assert.equal(
    explainProviderError('Provider returned HTTP 401', { name: 'Nvidia NIM', keyless: false }),
    'Provider returned HTTP 401',
  );
});
