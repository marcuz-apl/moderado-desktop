import { describe, expect, it } from 'vitest';
import { discoverModelOptions } from '../src/model-discovery.js';

describe('model discovery for the settings pane', () => {
  it('reports a definite result instead of leaving the placeholder', () => {
    // The regression: the pane re-assigned its in-flight placeholder text after a
    // successful load, so the UI stayed on "Loading models…" forever.
    return discoverModelOptions(async () => [
      { id: 'a', accessTier: 'free_trial', toolSupport: 'supported', isFree: true },
      { id: 'b', accessTier: 'paid', toolSupport: 'supported', isFree: false },
    ], 1000).then((result) => {
      expect(result.models.map((m) => m.id)).toEqual(['a', 'b']);
      expect(result.status).not.toMatch(/loading/i);
      expect(result.status).toMatch(/2/);
    });
  });

  it('carries the engine access tier through for cost labelling', () => {
    return discoverModelOptions(async () => [
      { id: 'a', accessTier: 'free_trial', toolSupport: 'unknown', isFree: true },
      { id: 'b', accessTier: 'unknown', toolSupport: 'unknown', isFree: false },
    ], 1000).then((result) => {
      expect(result.models.map((m) => m.accessTier)).toEqual(['free_trial', 'unknown']);
    });
  });

  it('explains a failure instead of hanging on the placeholder', () => {
    return discoverModelOptions(async () => { throw new Error('401 unauthorized'); }, 1000)
      .then((result) => {
        expect(result.models).toEqual([]);
        expect(result.status).toMatch(/401 unauthorized/);
      });
  });

  it('gives up after the timeout so the pane cannot wedge', () => {
    // A provider that accepts the connection and then never answers must not
    // leave the panel spinning forever.
    const never = () => new Promise<never>(() => { /* never settles */ });
    return discoverModelOptions(never, 20).then((result) => {
      expect(result.models).toEqual([]);
      expect(result.status).toMatch(/timed out/i);
    });
  });

  it('never echoes a credential in a failure message', () => {
    return discoverModelOptions(async () => { throw new Error('failed for sk-live-secret'); }, 1000)
      .then((result) => {
        expect(result.status).not.toContain('sk-live-secret');
      });
  });
});