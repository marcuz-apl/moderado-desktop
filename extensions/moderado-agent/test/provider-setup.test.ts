import { describe, expect, it } from 'vitest';
import {
  buildProviderChoices,
  buildProviderConnection,
  connectionIdFor,
} from '../src/provider-setup.js';

// These encode the CLI's rules, taken from apps/cli/src/ui/provider_connect.ts
// (buildConnection) and apps/cli/src/config.ts (parseConnections) at the pinned
// revision. The point of each comment is *why* a rule exists, because several
// of them silently discard a connection rather than erroring.

describe('provider setup parity with the CLI', () => {
  it('always writes a baseUrl, because the CLI drops a connection without one', () => {
    // apps/cli/src/config.ts parseConnections requires typeof baseUrl === 'string'
    // and `continue`s past the entry otherwise. A connection saved without a
    // baseUrl is silently discarded on the CLI's next read, so the field can
    // never be optional here.
    const built = buildProviderConnection({
      preset: 'openrouter',
      apiKey: 'sk-test',
      defaultModel: 'some/free-model',
      baseUrl: '',
    });
    expect(built.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('takes kind from the preset, so NVIDIA gets the NVIDIA adapter', () => {
    // The engine builds NvidiaAdapter only for kind === 'nvidia-nim'. Writing
    // 'openai-compatible' for every preset would route NVIDIA through the
    // generic adapter and lose its freeCatalog free-tier declaration.
    const nvidia = buildProviderConnection({ preset: 'nvidia-nim', apiKey: 'sk-test' });
    expect(nvidia.kind).toBe('nvidia-nim');
    expect(nvidia.id).toBe('nvidia-nim');
    expect(nvidia.baseUrl).toBe('https://integrate.api.nvidia.com/v1');

    const openrouter = buildProviderConnection({
      preset: 'openrouter', apiKey: 'sk-test', defaultModel: 'some/free-model',
    });
    expect(openrouter.kind).toBe('openai-compatible');
    expect(openrouter.id).toBe('openrouter');
    expect(openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('uses the preset id as the connection id so free policy resolves', () => {
    // freeModelPolicyFor(connectionId) looks the preset up by connection id. An
    // ad-hoc id silently disables the free-first rule for that provider.
    expect(buildProviderConnection({ preset: 'agnes-ai', apiKey: 'k', defaultModel: 'm' }).id).toBe('agnes-ai');
    expect(buildProviderConnection({ preset: 'ollama', defaultModel: 'llama3' }).id).toBe('ollama');
  });

  it("applies the preset's default model so the user need not choose one", () => {
    expect(buildProviderConnection({ preset: 'orcarouter', apiKey: 'k' }).defaultModel)
      .toBe('orcarouter/free');
  });

  it('does not require a key for local runtimes', () => {
    expect(buildProviderConnection({ preset: 'ollama', defaultModel: 'llama3' }).baseUrl)
      .toBe('http://127.0.0.1:11434/v1');
    expect(buildProviderConnection({ preset: 'lm-studio', defaultModel: 'x' }).baseUrl)
      .toBe('http://127.0.0.1:1234/v1');
  });

  it('refuses to build a keyed provider without a key', () => {
    expect(() => buildProviderConnection({ preset: 'openrouter', apiKey: '', defaultModel: 'm' }))
      .toThrow(/API key/i);
    expect(() => buildProviderConnection({ preset: 'nvidia-nim', apiKey: '   ' }))
      .toThrow(/NVIDIA API key/i);
  });

  it('rejects cleartext http to a remote host but allows loopback', () => {
    // The CLI permits http only for localhost. Allowing it generally would send
    // the provider key in cleartext.
    expect(() => buildProviderConnection({
      preset: 'openai-compatible', apiKey: 'k', defaultModel: 'm',
      baseUrl: 'http://evil.example.com/v1', displayName: 'X',
    })).toThrow(/HTTPS/i);
    expect(buildProviderConnection({
      preset: 'openai-compatible', apiKey: 'k', defaultModel: 'm',
      baseUrl: 'http://localhost:1234/v1', displayName: 'Local',
    }).baseUrl).toBe('http://localhost:1234/v1');
  });

  it('strips trailing slashes from the base URL', () => {
    expect(buildProviderConnection({
      preset: 'openai-compatible', apiKey: 'k', defaultModel: 'm', baseUrl: 'https://api.example.com/v1///', displayName: 'X',
    }).baseUrl).toBe('https://api.example.com/v1');
  });

  it('requires a default model for a custom OpenAI-compatible provider', () => {
    expect(() => buildProviderConnection({
      preset: 'openai-compatible', apiKey: 'k', baseUrl: 'https://api.example.com/v1', displayName: 'X',
    })).toThrow(/default model/i);
  });

  it('slugifies a display name into the connection id like the CLI', () => {
    expect(connectionIdFor('OpenRouter')).toBe('openrouter');
    expect(connectionIdFor('My Provider!')).toBe('my-provider');
    expect(connectionIdFor('///')).toBe('provider');
  });

  it('offers every built-in preset, with a tag and description', () => {
    const choices = buildProviderChoices();
    const values = choices.map((c) => c.value);
    for (const id of ['nvidia-nim', 'openrouter', 'agnes-ai', 'orcarouter', 'ollama', 'lm-studio', 'openai-compatible']) {
      expect(values).toContain(id);
    }
    expect(choices.every((c) => c.label && c.description)).toBe(true);
  });

  it('produces a connection the CLI reader will not discard', () => {
    // Mirrors apps/cli/src/config.ts `parseConnections`, which silently skips any
    // entry failing these checks. Desktop writes the entry, so anything that
    // fails here is a connection that vanishes when the user opens the CLI.
    const cliAccepts = (c: Record<string, unknown>) =>
      typeof c.id === 'string' &&
      typeof c.displayName === 'string' &&
      typeof c.baseUrl === 'string' &&
      (c.kind === 'nvidia-nim' || c.kind === 'openai-compatible');

    const cases = [
      buildProviderConnection({ preset: 'nvidia-nim', apiKey: 'k' }),
      buildProviderConnection({ preset: 'openrouter', apiKey: 'k', defaultModel: 'm' }),
      buildProviderConnection({ preset: 'agnes-ai', apiKey: 'k', defaultModel: 'm' }),
      buildProviderConnection({ preset: 'orcarouter', apiKey: 'k' }),
      buildProviderConnection({ preset: 'ollama', defaultModel: 'llama3' }),
      buildProviderConnection({ preset: 'lm-studio', defaultModel: 'x' }),
      buildProviderConnection({
        preset: 'openai-compatible', apiKey: 'k', defaultModel: 'm',
        baseUrl: 'https://api.example.com/v1', displayName: 'My Gateway',
      }),
    ];

    for (const connection of cases) {
      expect(cliAccepts(connection as unknown as Record<string, unknown>)).toBe(true);
    }
  });

  it('flags which presets need a key', () => {
    const byId = new Map(buildProviderChoices().map((c) => [c.value, c]));
    expect(byId.get('nvidia-nim')?.requiresApiKey).toBe(true);
    expect(byId.get('ollama')?.requiresApiKey).toBe(false);
    expect(byId.get('lm-studio')?.requiresApiKey).toBe(false);
  });

  it('honours connectProviders.enabled and .custom from the shared profile', () => {
    const choices = buildProviderChoices({
      enabled: ['ollama'],
      custom: [{ id: 'my-gw', name: 'My Gateway', baseUrl: 'https://gw.example.com/v1' }],
    });
    const values = choices.map((c) => c.value);
    expect(values).toEqual(['ollama', 'custom:my-gw']);
  });

  it('builds a connection from a custom profile entry', () => {
    // A `custom:` value only resolves against the profile's `connectProviders`,
    // so the caller must pass the same config the picker was built from.
    const config = {
      custom: [{ id: 'my-gw', name: 'My Gateway', baseUrl: 'https://gw.example.com/v1' }],
    };
    const built = buildProviderConnection({
      preset: 'custom:my-gw', apiKey: 'k', defaultModel: 'm', baseUrl: 'https://gw.example.com/v1', displayName: 'My Gateway',
    }, config);
    expect(built.id).toBe('my-gw');
    expect(built.baseUrl).toBe('https://gw.example.com/v1');
  });

  it('refuses a custom provider that is no longer in the profile', () => {
    expect(() => buildProviderConnection({
      preset: 'custom:removed', apiKey: 'k', defaultModel: 'm', displayName: 'Gone',
    }, { custom: [] })).toThrow(/no longer available/i);
  });
});