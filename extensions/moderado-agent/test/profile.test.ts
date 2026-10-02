import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceRoot, configPath, mergeConfig, readConfig } from '../src/profile.js';
import { SessionStore, StoredSessionSchema, createSession } from '../src/sessions.js';

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
    const base = tempDir('moderado-link-');
    const real = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    expect(canonicalWorkspaceRoot(link)).toBe(canonicalWorkspaceRoot(real));
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