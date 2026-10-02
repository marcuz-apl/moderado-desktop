import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync as fsStatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deepMerge, detectConflicts, updateConfigCoordinated } from '../src/coordination.js';
import { credentialReference, MemoryCredentialStore, resolveCredential } from '../src/credentials.js';
import { canonicalWorkspaceRoot, configPath, discoverSkills, mergeConfig, readConfig } from '../src/profile.js';
import { SessionStore, StoredSessionSchema, createSession, saveSessionChecked } from '../src/sessions.js';

function home(): string {
  return mkdtempSync(join(tmpdir(), 'moderado-profile-'));
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeConfig(root: string, contents: string): void {
  mkdirSync(join(root, '.moderado'), { recursive: true });
  writeFileSync(join(root, '.moderado', 'config.json'), contents, 'utf8');
}

describe('canonicalWorkspaceRoot', () => {
  it('agrees on trailing separators', () => {
    const root = tempDir('moderado-ws-');
    const sep = process.platform === 'win32' ? '\\' : '/';
    expect(canonicalWorkspaceRoot(`${root}${sep}`)).toBe(canonicalWorkspaceRoot(root));
  });

  it('agrees on a Windows verbatim prefix', () => {
    if (process.platform !== 'win32') return;
    const root = canonicalWorkspaceRoot(tempDir('moderado-ws-'));
    expect(canonicalWorkspaceRoot(`\\\\?\\${root}`)).toBe(root);
  });

  it('agrees on drive-letter case', () => {
    if (process.platform !== 'win32') return;
    const root = tempDir('moderado-ws-');
    expect(canonicalWorkspaceRoot(root.toLowerCase())).toBe(root);
  });

  it('resolves a symlink to the same target', () => {
    if (process.platform === 'win32') return;
    const { symlinkSync } = require('node:fs') as typeof import('node:fs');
    const base = tempDir('moderado-link-');
    const real = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    expect(canonicalWorkspaceRoot(link)).toBe(canonicalWorkspaceRoot(real));
  });
});

import { describe, expect, it } from 'vitest';
import { FakeProviderAdapter, NvidiaAdapter, OpenAICompatibleAdapter } from '@moderado/providers';
import { resolveProvider } from '../src/host.js';
import { MemoryCredentialStore } from '../src/credentials.js';
import { readConfig } from '../src/profile.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Isolated profile home; never the developer's real `~/.moderado`. */
function homeWithConfig(contents: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'moderado-provider-'));
  mkdirSync(join(root, '.moderado'), { recursive: true });
  writeFileSync(join(root, '.moderado', 'config.json'), JSON.stringify(contents), 'utf8');
  return root;
}

const noEnv = {} as NodeJS.ProcessEnv;

describe('provider resolution', () => {
  it('falls back to the fake provider and explains why when nothing is configured', async () => {
    const home = homeWithConfig({});
    const { adapter, reason } = await resolveProvider(readConfig(home), new MemoryCredentialStore(), noEnv);
    expect(adapter).toBeInstanceOf(FakeProviderAdapter);
    // The fallback must be visible, not a silent pretend-run.
    expect(reason).toMatch(/No provider connection/i);
  });

  it('falls back to the fake provider when the profile is corrupt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'moderado-provider-bad-'));
    mkdirSync(join(root, '.moderado'), { recursive: true });
    writeFileSync(join(root, '.moderado', 'config.json'), '{ not json', 'utf8');
    const { adapter, reason } = await resolveProvider(readConfig(root), new MemoryCredentialStore(), noEnv);
    expect(adapter).toBeInstanceOf(FakeProviderAdapter);
    expect(reason).toBeTruthy();
  });

  it('builds a real OpenAI-compatible adapter when a key resolves', async () => {
    const home = homeWithConfig({
      activeConnectionId: 'my-provider',
      connections: {
        'my-provider': { id: 'my-provider', kind: 'openai-compatible', baseUrl: 'https://example.invalid/v1' },
      },
    });
    const { adapter, reason } = await resolveProvider(
      readConfig(home),
      new MemoryCredentialStore(),
      { MODERADO_MY_PROVIDER_API_KEY: 'sk-from-env' } as NodeJS.ProcessEnv,
    );
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(reason).toBeUndefined();
  });

  it('reads the key from the credential store when there is no environment value', async () => {
    const home = homeWithConfig({
      activeConnectionId: 'p1',
      connections: { p1: { id: 'p1', kind: 'openai-compatible', credentialReference: 'moderado/provider/p1' } },
    });
    const store = new MemoryCredentialStore();
    await store.set('moderado/provider/p1', 'secret-from-credman');
    const { adapter } = await resolveProvider(readConfig(home), store, noEnv);
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter);
  });

  it('uses the Nvidia adapter for an nvidia-nim connection', async () => {
    const home = homeWithConfig({
      activeConnectionId: 'nvidia-nim',
      connections: { 'nvidia-nim': { id: 'nvidia-nim', kind: 'nvidia-nim' } },
    });
    const { adapter } = await resolveProvider(
      readConfig(home),
      new MemoryCredentialStore(),
      { MODERADO_NVIDIA_NIM_API_KEY: 'k' } as NodeJS.ProcessEnv,
    );
    expect(adapter).toBeInstanceOf(NvidiaAdapter);
  });

  it('falls back and names the connection when no key can be resolved', async () => {
    const home = homeWithConfig({
      activeConnectionId: 'p1',
      connections: { p1: { id: 'p1', kind: 'openai-compatible' } },
    });
    const { adapter, reason } = await resolveProvider(readConfig(home), new MemoryCredentialStore(), noEnv);
    expect(adapter).toBeInstanceOf(FakeProviderAdapter);
    expect(reason).toContain('p1');
  });

  it('never leaks the resolved key into the resolution result', async () => {
    const home = homeWithConfig({
      activeConnectionId: 'p1',
      connections: { p1: { id: 'p1', kind: 'openai-compatible' } },
    });
    const { adapter, reason } = await resolveProvider(
      readConfig(home),
      new MemoryCredentialStore(),
      { MODERADO_P1_API_KEY: 'super-secret-value' } as NodeJS.ProcessEnv,
    );
    expect(JSON.stringify({ adapter: adapter.id, name: adapter.name, reason })).not.toContain('super-secret-value');
  });
});

describe('credential references match the pinned CLI', () => {
  it('produces the documented target shape', () => {
    expect(credentialReference('nvidia-nim')).toBe('moderado/provider/nvidia-nim');
    expect(credentialReference('openai-compatible')).toBe('moderado/provider/openai-compatible');
  });

  it('normalizes exactly as the CLI does', () => {
    // Lowercase, and each run of unsupported characters becomes one hyphen.
    expect(credentialReference('  My Provider!!ID  ')).toBe('moderado/provider/my-provider-id');
    expect(credentialReference('a...b')).toBe('moderado/provider/a-b');
    expect(credentialReference('UPPER_case-1')).toBe('moderado/provider/upper_case-1');
  });

  it('rejects an id that normalizes to nothing', () => {
    // Whitespace and punctuation collapse to a single hyphen, which is still a
    // valid target; only a completely empty id is an error.
    expect(() => credentialReference('')).toThrow();
    expect(() => credentialReference('   ')).toThrow();
    // `!!!` becomes `-`, matching the CLI's normalization exactly.
    expect(credentialReference('!!!')).toBe('moderado/provider/-');
  });

  it('resolves environment before credential, then legacy', async () => {
    const store = new MemoryCredentialStore();
    await store.set('moderado/provider/demo', 'from-store');

    expect(await resolveCredential('from-env', 'moderado/provider/demo', 'legacy', store)).toBe('from-env');
    expect(await resolveCredential(undefined, 'moderado/provider/demo', 'legacy', store)).toBe('from-store');
    expect(await resolveCredential('', 'moderado/provider/missing', 'legacy', store)).toBe('legacy');
    expect(await resolveCredential(undefined, undefined, undefined, store)).toBeUndefined();
  });
});

describe('readConfig', () => {
  it('reports a missing profile as missing', () => {
    expect(readConfig(home()).kind).toBe('missing');
  });

  it('reports malformed JSON as invalid rather than empty', () => {
    const root = home();
    writeConfig(root, '{ not json');
    expect(readConfig(root).kind).toBe('invalid');
  });

  it('reports a JSON array as invalid', () => {
    const root = home();
    writeConfig(root, '[]');
    expect(readConfig(root).kind).toBe('invalid');
  });

  it('reads a valid config', () => {
    const root = home();
    writeConfig(root, '{"defaultModel":"mock/free-tool-model"}');
    expect(readConfig(root).kind).toBe('ok');
  });
});

describe('mergeConfig', () => {
  it('preserves fields it does not understand', () => {
    const root = home();
    writeConfig(root, JSON.stringify({ futureCliField: { keep: true }, defaultModel: 'a' }));
    expect(mergeConfig({ defaultModel: 'b' }, root).written).toBe(true);
    const merged = JSON.parse(readFileSync(configPath(root), 'utf8'));
    expect(merged.futureCliField).toEqual({ keep: true });
    expect(merged.defaultModel).toBe('b');
  });

  it('refuses to overwrite a corrupt profile', () => {
    const root = home();
    writeConfig(root, '{ broken');
    expect(mergeConfig({ defaultModel: 'b' }, root).written).toBe(false);
    expect(readFileSync(configPath(root), 'utf8')).toBe('{ broken');
  });

  it('creates the profile when none exists', () => {
    const root = home();
    expect(mergeConfig({ defaultModel: 'x' }, root).written).toBe(true);
    expect(JSON.parse(readFileSync(configPath(root), 'utf8')).defaultModel).toBe('x');
describe('SessionStore', () => {
  it('round-trips a session through the shared profile', () => {
    const root = home();
    const workspace = tempDir('moderado-sess-');
    const store = new SessionStore(root);
    store.save(createSession(workspace, { modelId: 'mock/free-tool-model' }));

    const listed = store.listSessions(workspace);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].schemaVersion).toBe(1);
  });

  it('resolves the same directory for equivalent path spellings', () => {
    const root = home();
    const workspace = tempDir('moderado-sess-');
    const store = new SessionStore(root);
    store.save(createSession(workspace));
    const sep = process.platform === 'win32' ? '\\' : '/';
    expect(store.getDirectory(`${workspace}${sep}`)).toBe(store.getDirectory(workspace));
  });

  it('surfaces a corrupt session instead of silently skipping it', () => {
    const root = home();
    const workspace = tempDir('moderado-sess-');
    const store = new SessionStore(root);
    store.save(createSession(workspace));

    writeFileSync(join(store.getDirectory(workspace), 'broken.json'), '{ not json', 'utf8');
    const listed = store.listSessions(workspace);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.invalid).toHaveLength(1);
  });

  it('writes atomically, leaving no temporary files', () => {
    const root = home();
    const workspace = tempDir('moderado-sess-');
    const store = new SessionStore(root);
    store.save(createSession(workspace));
    expect(readdirSync(store.getDirectory(workspace)).every((f) => f.endsWith('.json'))).toBe(true);
  });

  it('validates against the CLI-compatible schema', () => {
    expect(() => StoredSessionSchema.parse(createSession(tempDir('moderado-sess-')))).not.toThrow();
  });

  it('returns nothing for a workspace with no sessions', () => {
    const store = new SessionStore(home());
    const listed = store.listSessions(tempDir('moderado-none-'));
    expect(listed.sessions).toHaveLength(0);
    expect(listed.invalid).toHaveLength(0);
  });

  it('reads a session written by another process at the same path', () => {
    const root = home();
    const workspace = tempDir('moderado-sess-');
    const writer = new SessionStore(root);
    const reader = new SessionStore(root);
    writer.save(createSession(workspace));
    expect(reader.loadLatestSession(workspace)).toBeDefined();
    expect(existsSync(writer.getDirectory(workspace))).toBe(true);
  });
});
  });
});
describe('config coordination', () => {
  it('writes through a lock and preserves another process keys', () => {
    const root = tempDir('moderado-cfg-');
    const file = join(root, '.moderado', 'config.json');
    // Simulate a CLI write that happened before Desktop started editing.
    mkdirSync(join(root, '.moderado'), { recursive: true });
    writeFileSync(file, JSON.stringify({ cliOnlyField: 'keep-me' }));

    const result = updateConfigCoordinated(file, { defaultModel: 'mock/free-tool-model' });
    expect(result.written).toBe(true);
    const merged = JSON.parse(readFileSync(file, 'utf8'));
    expect(merged.cliOnlyField).toBe('keep-me');
    expect(merged.defaultModel).toBe('mock/free-tool-model');
  });

  it('removes its lock file afterwards', () => {
    const root = tempDir('moderado-cfg-');
    const file = join(root, '.moderado', 'config.json');
    updateConfigCoordinated(file, { a: 1 });
    expect(existsSync(`${file}.moderado-lock`)).toBe(false);
  });

  it('refuses to write over a corrupt config', () => {
    const root = tempDir('moderado-cfg-');
    const file = join(root, '.moderado', 'config.json');
    mkdirSync(join(root, '.moderado'), { recursive: true });
    writeFileSync(file, '{ broken');
    const result = updateConfigCoordinated(file, { a: 1 });
    expect(result.written).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it('detects a field another process changed and refuses to clobber it', () => {
    const root = tempDir('moderado-cfg-');
    const file = join(root, '.moderado', 'config.json');
    mkdirSync(join(root, '.moderado'), { recursive: true });
    // Desktop believed defaultModel was 'a'; the CLI has since set it to 'b'.
    writeFileSync(file, JSON.stringify({ defaultModel: 'b' }));

    const result = updateConfigCoordinated(
      file,
      { defaultModel: 'desktop-choice' },
      { expected: { defaultModel: 'a' } },
    );
    expect(result.written).toBe(false);
    expect(result.conflict?.conflictingKeys).toContain('defaultModel');
    // The CLI's value must survive.
    expect(JSON.parse(readFileSync(file, 'utf8')).defaultModel).toBe('b');
  });

  it('merges nested objects so a sibling connection is not dropped', () => {
    const root = tempDir('moderado-cfg-');
    const file = join(root, '.moderado', 'config.json');
    mkdirSync(join(root, '.moderado'), { recursive: true });
    writeFileSync(file, JSON.stringify({ connections: { theirs: { id: 'theirs' } } }));

    updateConfigCoordinated(file, { connections: { mine: { id: 'mine' } } });
    const connections = JSON.parse(readFileSync(file, 'utf8')).connections;
    expect(connections.theirs).toEqual({ id: 'theirs' });
    expect(connections.mine).toEqual({ id: 'mine' });
  });

  it('deepMerge replaces arrays rather than concatenating', () => {
    expect(deepMerge({ list: [1, 2] }, { list: [3] })).toEqual({ list: [3] });
  });

  it('detectConflicts reports nothing when the value is unchanged', () => {
    expect(detectConflicts({ a: 1 }, { a: 2 }, { a: 1 })).toEqual([]);
    expect(detectConflicts({ a: 1 }, { a: 2 }, { a: 9 })).toEqual(['a']);
  });
});

describe('session conflict handling', () => {
  it('refuses to overwrite a session another process changed', async () => {
    const root = tempDir('moderado-home-');
    const workspace = tempDir('moderado-ws-');
    const store = new SessionStore(root);
    const session = createSession(workspace);
    const saved = store.save(session);

    // Another process rewrites the file after Desktop read it.
    await new Promise((r) => setTimeout(r, 5));
    store.save({
      ...saved,
      messages: [{ role: 'user', content: 'from the CLI' }],
    });

    const result = saveSessionChecked(
      store,
      { ...saved, messages: [{ role: 'user', content: 'from Desktop' }] },
      { knownUpdatedAt: saved.updatedAt },
    );
    expect(result.saved).toBe(false);
    // The other process's content must survive.
    expect(store.loadLatestSession(workspace)?.messages[0]?.content).toBe('from the CLI');
  });

  it('saves when nothing else changed the file', () => {
    const root = tempDir('moderado-home-');
    const workspace = tempDir('moderado-ws-');
    const store = new SessionStore(root);
    const saved = store.save(createSession(workspace));
    expect(saveSessionChecked(store, saved, { knownUpdatedAt: saved.updatedAt }).saved).toBe(true);
  });
});

/**
 * Round-trip compatibility against the pinned CLI.
 *
 * These tests write a profile and session using the *actual* CLI source from the
 * pinned revision, then read them back with Desktop, and the reverse. That is
 * the only way to prove the two editions agree; asserting against a hand-written
 * copy of the schema would only prove Desktop agrees with itself.
 *
 * The CLI is loaded from `vendor/moderado` plus the sibling CLI checkout, and the
 * test never writes to the real `~/.moderado`.
 */
const cliRoot = process.env.MODERADO_CLI_ROOT ?? 'D:\\projects\\moderado';

async function loadCliSessions(): Promise<typeof import('d:/../moderado/apps/cli/dist/sessions.js')> {
  const path = await import('node:path');
  const file = path.join(cliRoot, 'apps', 'cli', 'dist', 'sessions.js');
  const mod = (await import(/* @vite-ignore */ `file:///${file.replace(/\\/g, '/')}`)) as {
    SessionStore: new (home?: string) => {
      save(session: unknown): unknown;
      listSessions(workspaceRoot: string): unknown[];
      loadLatestSession(workspaceRoot: string): unknown;
    };
    StoredSessionSchema: { parse(value: unknown): unknown };
  };
  return mod as never;
}

const cliAvailable = existsSync(join(cliRoot, 'apps', 'cli', 'dist', 'sessions.js'));

describe.skipIf(!cliAvailable)('round-trip with the pinned CLI', () => {
  it('reads a session the CLI wrote', async () => {
    const cli = await loadCliSessions();
    const home = tempDir('moderado-home-');
    const workspace = tempDir('moderado-ws-');

    const cliStore = new cli.SessionStore(home);
    const record = {
      schemaVersion: 1,
      id: '11111111-2222-4333-8444-555555555555',
      workspaceRoot: workspace,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providerId: 'nvidia-nim',
      providerName: 'NVIDIA NIM',
      modelId: 'mock/free-tool-model',
      mode: 'Execute',
      messages: [{ role: 'user', content: 'written by the CLI' }],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, costKnown: false, available: false },
    };
    cliStore.save(record);

    // Desktop must find it in the same directory the CLI used.
    const desktop = new SessionStore(home);
    const found = desktop.listSessions(workspace);
    expect(found.sessions).toHaveLength(1);
    expect(found.sessions[0].messages[0]?.content).toBe('written by the CLI');
    expect(found.sessions[0].modelId).toBe('mock/free-tool-model');
  });

  it('writes a session the CLI can read back', async () => {
    const cli = await loadCliSessions();
    const home = tempDir('moderado-home-');
    const workspace = tempDir('moderado-ws-');

    const desktop = new SessionStore(home);
    const session = createSession(workspace, { modelId: 'mock/free-tool-model' });
    desktop.save({ ...session, messages: [{ role: 'user', content: 'written by Desktop' }] });

    const cliStore = new cli.SessionStore(home);
    const seen = cliStore.listSessions(workspace) as Array<{ messages: Array<{ content?: string }> }>;
    expect(seen).toHaveLength(1);
    expect(seen[0].messages[0]?.content).toBe('written by Desktop');
  });

  it('resolves the same session directory for the same workspace', async () => {
    const cli = await loadCliSessions();
    const home = tempDir('moderado-home-');
    const workspace = tempDir('moderado-ws-');

    const cliStore = new cli.SessionStore(home) as unknown as {
      getDirectory(workspaceRoot: string): string;
    };
    const desktop = new SessionStore(home);
    expect(desktop.getDirectory(workspace)).toBe(cliStore.getDirectory(workspace));
  });

  it('agrees on which fields are valid', async () => {
    const cli = await loadCliSessions();
    const workspace = tempDir('moderado-ws-');
    const good = createSession(workspace);
    expect(() => cli.StoredSessionSchema.parse(good)).not.toThrow();
    expect(() => StoredSessionSchema.parse(good)).not.toThrow();
    // A record missing the required usage block is invalid for both.
    const broken = { ...good } as Record<string, unknown>;
    delete broken.usage;
    expect(() => cli.StoredSessionSchema.parse(broken)).toThrow();
    expect(() => StoredSessionSchema.parse(broken)).toThrow();
  });
});

describe('skills', () => {
  it('discovers a valid skill from the shared tree', () => {
    const root = tempDir('moderado-home-');
    mkdirSync(join(root, '.moderado', 'skills', 'review'), { recursive: true });
    writeFileSync(join(root, '.moderado', 'skills', 'review', 'SKILL.md'), 'Review carefully.');
    const { skills, invalid } = discoverSkills(root);
    expect(skills.map((s) => s.name)).toEqual(['review']);
    expect(invalid).toEqual([]);
  });

  it('reports an empty skill instead of using it', () => {
    const root = tempDir('moderado-home-');
    mkdirSync(join(root, '.moderado', 'skills', 'blank'), { recursive: true });
    writeFileSync(join(root, '.moderado', 'skills', 'blank', 'SKILL.md'), '   ');
    mkdirSync(join(root, '.moderado', 'skills', 'no-file'), { recursive: true });
    const { skills, invalid } = discoverSkills(root);
    expect(skills).toEqual([]);
    expect(invalid).toHaveLength(2);
  });

  it('returns nothing when no skills exist', () => {
    expect(discoverSkills(tempDir('moderado-home-')).skills).toEqual([]);
  });
});