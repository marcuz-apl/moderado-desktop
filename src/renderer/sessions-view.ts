export type SessionKind = 'work' | 'code';
/** One rail for both modes. `library` lists tasks in Work and projects in Code. */
export type SidebarPanel = 'library' | 'explorer' | 'checkpoints' | 'schedules' | 'source-control' | 'profile';
/** Full-width views that replace the conversation instead of opening a panel. */
export type AppPage = 'settings' | 'docs';

export type ProjectSessionLike = {
  id: string;
  name: string;
  workspace: string;
  kind: SessionKind;
  updatedAt: number;
};

export type ProjectSummary = {
  workspace: string;
  name: string;
  sessionCount: number;
  latestSessionId: string;
  updatedAt: number;
};

export const DEFAULT_SESSION_KIND: SessionKind = 'work';

/// Both modes open on the same panel; only its contents change.
export function defaultPanel(): SidebarPanel {
  return 'library';
}

/// Git is the one capability that only exists in Code, so it is the only panel
/// that differs between modes.
export function panelAvailableForKind(panel: SidebarPanel, kind: SessionKind): boolean {
  return panel !== 'source-control' || kind === 'code';
}

export function sessionForMode<T extends { id: string; kind: SessionKind; workspace: string }>(
  sessions: T[], kind: SessionKind, rememberedId?: string, projectWorkspace?: string | null,
): T | undefined {
  const candidates = sessions.filter((session) => session.kind === kind
    && (kind !== 'code' || !projectWorkspace || session.workspace === projectWorkspace));
  return candidates.find((session) => session.id === rememberedId) ?? candidates[0];
}

export function nextSessionKind(kind: SessionKind): SessionKind {
  return kind === 'work' ? 'code' : 'work';
}

export function newSessionLabel(kind: SessionKind): string {
  return kind === 'work' ? '+ New Work session' : '+ New Code session';
}

export function profileModeDescription(kind: SessionKind): string {
  return kind === 'work'
    ? 'Work profile is local to this device. A GitHub account is not required.'
    : 'Connect an optional GitHub account for Code mode.';
}

export function projectNameFromWorkspace(workspace: string, fallback: string): string {
  const name = workspace.split(/[\\/]/).filter(Boolean).at(-1);
  return name || fallback;
}

export function projectsForSessions<T extends ProjectSessionLike>(sessions: T[]): ProjectSummary[] {
  const projects = new Map<string, ProjectSummary>();
  for (const session of sessions) {
    if (session.kind !== 'code' || !session.workspace) continue;
    const project = projects.get(session.workspace);
    if (!project) {
      projects.set(session.workspace, {
        workspace: session.workspace,
        name: projectNameFromWorkspace(session.workspace, session.name),
        sessionCount: 1,
        latestSessionId: session.id,
        updatedAt: session.updatedAt,
      });
      continue;
    }
    project.sessionCount += 1;
    if (session.updatedAt > project.updatedAt
      || (session.updatedAt === project.updatedAt && session.id > project.latestSessionId)) {
      project.latestSessionId = session.id;
      project.updatedAt = session.updatedAt;
    }
  }
  return [...projects.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

export function sessionsForProject<T extends ProjectSessionLike>(sessions: T[], workspace: string): T[] {
  if (!workspace) return [];
  return sessions.filter((session) => session.kind === 'code' && session.workspace === workspace);
}


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

export function scheduleWriteApprovalChoiceVisible(kind: SessionKind): boolean {
  return kind === 'code';
}
