import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type ConfigConflict = {
  kind: 'conflict';
  reason: string;
  conflictingKeys: string[];
};

export interface ConfigUpdateResult {
  written: boolean;
  conflict?: ConfigConflict;
  reason?: string;
  attempts: number;
}

function readRaw(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function parseConfig(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('config.json is not a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merges `patch` into the shared config under an exclusive lock.
 *
 * The CLI writes config.json with a direct read/merge/write, so two processes
 * can lose one another's changes even when each write is atomic. Desktop takes
 * a lock file, then *re-reads inside the lock* — that re-read is what makes the
 * update safe against a CLI write that landed while Desktop was waiting.
 *
 * Where Desktop believes it owns a field, `expected` lets it detect that someone
 * else changed it and refuse rather than silently overwrite.
 */
export function updateConfigCoordinated(
  configFile: string,
  patch: Record<string, unknown>,
  options: { timeoutMs?: number; expected?: Record<string, unknown>; now?: () => number } = {},
): ConfigUpdateResult {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const now = options.now ?? Date.now;
  const lockFile = `${configFile}.moderado-lock`;
  const started = now();
  const deadline = started + timeoutMs;

  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });

  let lockHandle: number | undefined;
  for (;;) {
    try {
      // `wx` fails if the lock already exists, so two writers cannot share one.
      lockHandle = fs.openSync(lockFile, 'wx', 0o600);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        return { written: false, reason: `Could not lock config.json: ${(error as Error).message}`, attempts: 1 };
      }
      if (now() >= deadline) {
        return {
          written: false,
          attempts: 1,
          conflict: {
            kind: 'conflict',
            reason:
              'Another process held the config lock for too long. Desktop did not write, so no change was lost.',
            conflictingKeys: Object.keys(patch),
          },
        };
      }
      // A lock older than the timeout belongs to a process that died.
      try {
        if (now() - fs.statSync(lockFile).mtimeMs > timeoutMs) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      sleepBriefly();
    }
  }

  try {
    const raw = readRaw(configFile);
    let base: Record<string, unknown>;
    try {
      base = parseConfig(raw);
    } catch (error) {
      return {
        written: false,
        reason: `Refusing to write: ${(error as Error).message}`,
        attempts: 1,
      };
    }

    const conflicting = detectConflicts(base, patch, options.expected);
    if (conflicting.length > 0) {
      return {
        written: false,
        attempts: 1,
        conflict: {
          kind: 'conflict',
          reason:
            'The shared config changed while Desktop was editing it. Desktop left it untouched so the other process keeps its value.',
          conflictingKeys: conflicting,
        },
      };
    }

    const temp = `${configFile}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(deepMerge(base, patch), null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, configFile);
    return { written: true, attempts: 1 };
  } finally {
    if (lockHandle !== undefined) {
      try {
        fs.closeSync(lockHandle);
      } catch {
        /* already closed */
      }
    }
    fs.rmSync(lockFile, { force: true });
  }
}

/** Keys Desktop would change whose current value is not what it expected. */
export function detectConflicts(
  current: Record<string, unknown>,
  desired: Record<string, unknown>,
  expected?: Record<string, unknown>,
): string[] {
  if (!expected) return [];
  const conflicts: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    if (!(key in desired)) continue;
    if (JSON.stringify(current[key]) !== JSON.stringify(want)) conflicts.push(key);
  }
  return conflicts;
}

/** One-level-deep merge so a sibling's added keys survive; arrays are replaced. */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = { ...existing, ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Short blocking sleep used only while polling for the lock. */
function sleepBriefly(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}