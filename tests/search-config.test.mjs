import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endpointField, isKeyless, isSearchConfigured, needsKey, requiresEndpoint, searchStatus, toSearchProvider, validateSearchInput } from '../src/renderer/search-config.ts';

test('automatic search is the default and needs nothing', () => {
  assert.equal(toSearchProvider(undefined), 'automatic');
  assert.equal(toSearchProvider('duckduckgo'), 'automatic');
  assert.equal(toSearchProvider('automatic'), 'automatic');
  assert.equal(isKeyless('automatic'), true);
  assert.equal(isSearchConfigured('automatic', '', false), true);
  assert.equal(validateSearchInput('automatic', '', '', true), null);
  assert.match(searchStatus('automatic', '', false), /no setup needed/);
});

test('unknown providers fall back to the default', () => {
  assert.equal(toSearchProvider('brave'), 'brave');
  assert.equal(toSearchProvider('searxng'), 'searxng');
  assert.equal(toSearchProvider('nonsense'), 'automatic');
});

test('hosted providers need a key, custom and SearXNG need a URL', () => {
  for (const provider of ['brave', 'tavily', 'serper']) {
    assert.equal(needsKey(provider), true, provider);
    assert.equal(requiresEndpoint(provider), false, provider);
  }
  for (const provider of ['custom', 'searxng', 'automatic']) {
    assert.equal(needsKey(provider), false, provider);
  }
  assert.equal(requiresEndpoint('custom'), true);
  assert.equal(requiresEndpoint('searxng'), true);
  assert.equal(requiresEndpoint('automatic'), false);
});

test('configured matches what the agent can actually call', () => {
  assert.equal(isSearchConfigured('brave', '', true), true);
  assert.equal(isSearchConfigured('brave', '', false), false);
  assert.equal(isSearchConfigured('custom', 'https://search.example/api', false), true);
  assert.equal(isSearchConfigured('custom', '   ', false), false);
  assert.equal(isSearchConfigured('searxng', 'https://searx.example.com', false), true);
});

test('invalid input is rejected before it reaches the backend', () => {
  assert.match(validateSearchInput('custom', '', '', true), /endpoint/);
  assert.match(validateSearchInput('searxng', '', '', true), /SearXNG URL/);
  assert.match(validateSearchInput('brave', '', '', true), /API key/);
  assert.equal(validateSearchInput('brave', '', 'key', true), null);
  assert.equal(validateSearchInput('custom', 'https://search.example/api', '', true), null);
});

test('search can be turned off without configuring it', () => {
  assert.equal(validateSearchInput('custom', '', '', false), null);
  assert.equal(validateSearchInput('brave', '', '', false), null);
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
