import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ChatMessageSchema, ChatMessage, ChatUsage } from '@moderado/contracts';
import { canonicalWorkspaceRoot, moderadoHome } from './profile.js';

/**
 * Mirrors the CLI's `StoredSessionSchema` exactly. Desktop must be able to read
 * what the CLI wrote and vice versa, so this shape is a compatibility contract,
 * not a local convenience.
 */
const UsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimated: z.boolean().optional(),
  costUsd: z.number().nonnegative().optional(),
  costKnown: z.boolean(),
  available: z.boolean().default(false),
});

export const StoredSessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  workspaceRoot: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  providerId: z.string().optional(),
  providerName: z.string().optional(),
  modelId: z.string().optional(),
  mode: z.enum(['Plan', 'Execute']),
  messages: z.array(ChatMessageSchema),
  usage: UsageSchema,
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

export function createSession(
  workspaceRoot: string,
  details: Partial<Pick<StoredSession, 'providerId' | 'providerName' | 'modelId' | 'mode'>> = {},
): StoredSession {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    workspaceRoot: canonicalWorkspaceRoot(workspaceRoot),
    createdAt: now,
    updatedAt: now,
    providerId: details.providerId,
    providerName: details.providerName,
    modelId: details.modelId,
    mode: details.mode ?? 'Execute',
    messages: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costKnown: false, available: false },
  };
}

export type SessionLoad =
  | { kind: 'ok'; session: StoredSession }
  | { kind: 'invalid'; file: string; error: string };

/**
 * Session storage under the shared `~/.moderado/sessions/` tree.
 *
 * Writes are atomic (temp + rename). Unlike the CLI's `listSessions`, a corrupt
 * record is surfaced rather than silently skipped, so a broken session cannot be
 * mistaken for an empty history.
 */
export class SessionStore {
  constructor(private readonly home?: string) {}

  getDirectory(workspaceRoot: string): string {
    const canonical = canonicalWorkspaceRoot(workspaceRoot);
    return path.join(
      moderadoHome(this.home),
      'sessions',
      crypto.createHash('sha256').update(canonical).digest('hex'),
    );
  }

  getSessionPath(session: StoredSession): string {
    return path.join(this.getDirectory(session.workspaceRoot), `${session.id}.json`);
  }

  save(session: StoredSession): StoredSession {
    const checked = StoredSessionSchema.parse({
      ...session,
      workspaceRoot: canonicalWorkspaceRoot(session.workspaceRoot),
      updatedAt: new Date().toISOString(),
    });
    const dir = this.getDirectory(checked.workspaceRoot);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = this.getSessionPath(checked);
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(checked, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    return checked;
  }

  /** Returns every session plus any records that failed validation. */
  listSessions(workspaceRoot: string): { sessions: StoredSession[]; invalid: SessionLoad[] } {
    const dir = this.getDirectory(workspaceRoot);
    const invalid: SessionLoad[] = [];
    if (!fs.existsSync(dir)) return { sessions: [], invalid };

    const sessions: StoredSession[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(dir, entry);
      try {
        sessions.push(StoredSessionSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))));
      } catch (error) {
        // Surfaced, not swallowed: a corrupt session must be visible.
        invalid.push({ kind: 'invalid', file, error: (error as Error).message });
      }
    }
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions, invalid };
  }

  loadLatestSession(workspaceRoot: string): StoredSession | undefined {
    return this.listSessions(workspaceRoot).sessions[0];
  }

  /** Accumulates usage across turns, keeping the CLI's estimate semantics. */
  static applyUsage(previous: StoredSession['usage'], usage: ChatUsage, estimated: boolean): StoredSession['usage'] {
    return {
      promptTokens: previous.promptTokens + (usage.promptTokens ?? 0),
      completionTokens: previous.completionTokens + (usage.completionTokens ?? 0),
      totalTokens: previous.totalTokens + (usage.totalTokens ?? 0),
      estimated: estimated || previous.estimated,
      costKnown: previous.costKnown,
      available: previous.available,
    };
  }
}

/** Narrows a conversation for storage, matching the CLI's history compaction. */
export function conversationOf(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role !== 'system');
}

export type SessionSaveResult =
  | { saved: true; session: StoredSession }
  | { saved: false; conflict: { reason: string; existing: StoredSession | null } };

/**
 * Saves a session, refusing to clobber a concurrent edit.
 *
 * Atomic rename prevents a partial file, but two active processes editing one
 * session ID would still silently overwrite each other's conversation. Desktop
 * therefore compares the `updatedAt` it last saw against what is on disk now,
 * and if the file moved underneath it, reports a conflict instead of writing.
 *
 * The comparison is on the recorded timestamp rather than the filesystem mtime
 * because mtime granularity is too coarse to be reliable here, and a
 * same-millisecond write by the other process would otherwise be missed.
 */
export function saveSessionChecked(
  store: SessionStore,
  session: StoredSession,
  options: { knownUpdatedAt?: string } = {},
): SessionSaveResult {
  const target = store.getSessionPath(session);
  const onDisk = safeParse(target);

  if (options.knownUpdatedAt !== undefined && onDisk && onDisk.updatedAt !== options.knownUpdatedAt) {
    return {
      saved: false,
      conflict: {
        reason:
          'This session was changed by another process since Desktop last read it. Desktop did not overwrite it.',
        existing: onDisk,
      },
    };
  }

  const saved = store.save(session);
  return { saved: true, session: saved };
}

/** Parses a session file, or null when it is absent or does not validate. */
function safeParse(file: string): StoredSession | null {
  try {
    return StoredSessionSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** The stamp to pass to `saveSessionChecked` after reading or writing a session. */
export function sessionStamp(session: StoredSession): string {
  return session.updatedAt;
}