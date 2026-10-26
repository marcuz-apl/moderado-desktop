export type SessionKind = 'work' | 'code';

/** The session list shows one kind at a time; the switch decides which. */
export function visibleSessions<T extends { kind: SessionKind }>(
  sessions: T[],
  kind: SessionKind,
): T[] {
  return sessions.filter((session) => session.kind === kind);
}

/** Work sessions have no project folder, so they never open a folder picker. */
export function needsWorkspacePicker(kind: SessionKind): boolean {
  return kind === 'code';
}
