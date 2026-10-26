export type SessionKind = 'work' | 'code';
export type SidebarPanel = 'mode' | 'tasks' | 'projects' | 'sessions' | 'workspace' | 'checkpoints' | 'schedules' | 'source-control' | 'profile' | 'settings';

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

export function defaultPanelForKind(_kind: SessionKind): SidebarPanel {
  return 'mode';
}

export function panelAvailableForKind(panel: SidebarPanel, kind: SessionKind): boolean {
  if (panel === 'mode') return true;
  if (kind === 'work') return !['projects', 'sessions', 'workspace', 'checkpoints', 'source-control'].includes(panel);
  return panel !== 'tasks';
}

export function newActionLabel(panel: 'tasks' | 'projects' | 'sessions'): string {
  if (panel === 'tasks') return 'New Task';
  return panel === 'projects' ? 'New Project' : 'New Session';
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
