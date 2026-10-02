import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Canonical workspace root resolution.
 *
 * The CLI hashes the workspace root string directly to choose a session
 * directory, so two spellings of one folder would silently resolve to different
 * sessions. Desktop receives its root from the editor, which is not guaranteed
 * to match the spelling the CLI recorded, so it is normalized first.
 *
 * This produces the canonical form Desktop *stores*. It does not claim to
 * reproduce the CLI's hash for every existing session: any change of spelling
 * rule changes the hash, which is exactly the compatibility question Milestone 3
 * must settle against a pinned CLI release.
 */
export function canonicalWorkspaceRoot(input: string): string {
  let resolved = path.resolve(input.trim());
  // Strip a Windows verbatim/UNC namespace so `\\?\C:\p` and `C:\p` agree.
  if (/^\\\\\?\\/.test(resolved)) resolved = resolved.slice(4);
  resolved = path.normalize(resolved);
  // Resolve to the real location so a symlink or junction cannot fork the hash.
  try {
    const real = fs.realpathSync.native(resolved);
    if (real) resolved = real;
  } catch {
    // A path that does not exist yet still needs a stable form.
  }
  resolved = path.normalize(resolved);
  // Windows drive letters are case-insensitive; case differences must not fork.
  if (process.platform === 'win32') {
    resolved = resolved.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
  }
  // A trailing separator would otherwise change the hash.
  while (resolved.length > 1 && (resolved.endsWith(path.sep) || resolved.endsWith('/'))) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

/** Shared Moderado home, matching the CLI's `path.join(home, '.moderado')`. */
export function moderadoHome(customHome?: string): string {
  return path.join(customHome || os.homedir(), '.moderado');
}

export function configPath(customHome?: string): string {
  return path.join(moderadoHome(customHome), 'config.json');
}

export type ConfigState =
  | { kind: 'missing' }
  | { kind: 'invalid'; error: string }
  | { kind: 'ok'; config: Record<string, unknown> };

/**
 * Reads the shared config and, crucially, distinguishes *missing* from
 * *invalid*.
 *
 * The CLI loader returns an empty config on a parse error, which would let
 * Desktop mistake a corrupt profile for an empty one and overwrite it. A corrupt
 * profile must stop the caller, never be replaced with defaults.
 */
export function readConfig(customHome?: string): ConfigState {
  const file = configPath(customHome);
  if (!fs.existsSync(file)) return { kind: 'missing' };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { kind: 'invalid', error: `Unreadable config.json: ${(error as Error).message}` };
  }
  if (!raw.trim()) return { kind: 'invalid', error: 'config.json is empty.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'invalid', error: `config.json is not valid JSON: ${(error as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'invalid', error: 'config.json is not a JSON object.' };
  }
  return { kind: 'ok', config: parsed as Record<string, unknown> };
}

export interface ConfigWriteResult {
  written: boolean;
  reason?: string;
}

/**
 * Merges Desktop-owned changes into the shared config without discarding fields
 * Desktop does not understand.
 *
 * Unknown keys are preserved by merging onto the parsed document rather than
 * rebuilding it from a known-shape object. The write is atomic (temp + rename)
 * and refuses to run against an invalid profile.
 */
export function mergeConfig(
  patch: Record<string, unknown>,
  customHome?: string,
): ConfigWriteResult {
  const state = readConfig(customHome);
  if (state.kind === 'invalid') {
    return { written: false, reason: `Refusing to write: ${state.error}` };
  }
  const base = state.kind === 'ok' ? state.config : {};
  const merged = { ...base, ...patch };

  const dir = moderadoHome(customHome);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = configPath(customHome);
  const temp = `${target}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* best effort */
    }
    return { written: false, reason: `Write failed: ${(error as Error).message}` };
  }
  return { written: true };
}

/** Lists the shared profile entries without reading or trusting their contents. */
export function profileLayout(customHome?: string) {
  const root = moderadoHome(customHome);
  return {
    root,
    config: path.join(root, 'config.json'),
    sessions: path.join(root, 'sessions'),
    skills: path.join(root, 'skills'),
    desktop: path.join(root, 'desktop'),
  };
}