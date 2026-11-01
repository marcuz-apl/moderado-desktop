import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpointField, isSearchConfigured, needsKey, requiresEndpoint, searchStatus, toSearchProvider, validateSearchInput } from '../src/renderer/search-config.ts';

test('unknown providers fall back to the custom endpoint', () => {
  assert.equal(toSearchProvider('brave'), 'brave');
  assert.equal(toSearchProvider('searxng'), 'searxng');
  assert.equal(toSearchProvider('duckduckgo'), 'custom');
  assert.equal(toSearchProvider(undefined), 'custom');
});

test('hosted providers need a key, custom and SearXNG need a URL', () => {
  for (const provider of ['brave', 'tavily', 'serper']) {
    assert.equal(needsKey(provider), true, provider);
    assert.equal(requiresEndpoint(provider), false, provider);
  }
  for (const provider of ['custom', 'searxng']) {
    assert.equal(needsKey(provider), false, provider);
    assert.equal(requiresEndpoint(provider), true, provider);
  }
});

test('configured matches what the agent can actually call', () => {
  assert.equal(isSearchConfigured('brave', '', true), true);
  assert.equal(isSearchConfigured('brave', '', false), false);
  assert.equal(isSearchConfigured('custom', 'https://search.example/api', false), true);
  assert.equal(isSearchConfigured('custom', '   ', false), false);
  assert.equal(isSearchConfigured('searxng', 'https://searx.example.com', false), true);
});

test('invalid input is rejected before it reaches the backend', () => {
  assert.match(validateSearchInput('custom', '', ''), /endpoint/);
  assert.match(validateSearchInput('searxng', '', ''), /SearXNG URL/);
  assert.match(validateSearchInput('brave', '', ''), /API key/);
  assert.equal(validateSearchInput('brave', '', 'key'), null);
  assert.equal(validateSearchInput('custom', 'https://search.example/api', ''), null);
});

test('status explains what is still missing', () => {
  assert.match(searchStatus('brave', '', true), /available/);
  assert.match(searchStatus('brave', '', false), /API key/);
  assert.match(searchStatus('custom', '', false), /endpoint/);
});

test('endpoint hints follow the provider', () => {
  assert.equal(endpointField('brave').label, 'Endpoint (optional)');
  assert.equal(endpointField('searxng').label, 'SearXNG URL');
  assert.match(endpointField('custom').placeholder, /^https:\/\//);
});
