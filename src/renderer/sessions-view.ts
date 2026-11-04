export type SessionKind = 'work' | 'code';
/** The rail destinations that own the Left Pane. */
export type LeftView = 'library' | 'files' | 'git' | 'schedules' | 'user';
export const LEFT_VIEWS: readonly LeftView[] = ['library', 'files', 'git', 'schedules', 'user'];
/** Tabs inside the Git destination. */
export type GitView = 'changes' | 'checkpoints';
export const GIT_VIEWS: readonly GitView[] = ['changes', 'checkpoints'];
/** Full-width views that replace the conversation. */
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
export const DEFAULT_LEFT_VIEW: LeftView = 'library';

/// Unknown or retired stored views open the default one; `workspaces` is the
/// pre-rename name of the Library view and keeps opening it.
export function parseLeftView(value: string | null): LeftView {
  if (value === 'workspaces') return 'library';
  return value === 'library' || value === 'files' || value === 'git' || value === 'schedules' || value === 'user'
    ? value
    : DEFAULT_LEFT_VIEW;
}

export function parseGitView(value: string | null): GitView {
  return value === 'checkpoints' ? value : 'changes';
}


/// The rail remembers the mode you were last in, the way WorkBuddy does.
export function parseSessionKind(value: string | null): SessionKind {
  return value === 'code' ? 'code' : 'work';
}

/// Startup opens the stored mode only while it still has a session; otherwise
/// Work is the default, so an empty Code toggle never becomes the next launch.
export function startupSessionKind(stored: SessionKind, hasStoredSessions: boolean): SessionKind {
  return stored === 'code' && !hasStoredSessions ? DEFAULT_SESSION_KIND : stored;
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

export function projectNameFromWorkspace(workspace: string, fallback: string): string {
  const name = workspace.split(/[\\/]/).filter(Boolean).at(-1);
  return name || fallback;
}

/// Rust canonicalizes folders, which on Windows yields verbatim paths such as
/// `\\?\E:\work`. They are valid but noisy on screen, so strip the prefix where
/// a path is shown; stored and command paths keep the canonical form.
export function displayPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  if (path.startsWith('\\\\?\\')) return path.slice(4);
  return path;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Session identity stamps use the local clock so they match the device. */
export function sessionStamp(at: number): string {
  const date = new Date(at * 1000);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Names the shell generates are replaced by the creation stamp. */
const AUTO_SESSION_NAME = /^(Session \d+|New Session)$/;

/** A user-typed name wins; automatic names read as the creation stamp. */
export function sessionLabel(session: { name: string; createdAt?: number }): string {
  if (!session.createdAt) return session.name;
  return AUTO_SESSION_NAME.test(session.name) ? sessionStamp(session.createdAt) : session.name;
}

/** The topbar names the project or task; the full path stays in its tooltip. */
export function folderContextLabel(
  kind: SessionKind,
  folder: string | null,
  projectName?: string,
  taskName?: string,
): string {
  if (kind === 'work') {
    return taskName ?? (folder ? projectNameFromWorkspace(folder, 'Task folder') : 'Select a task to start.');
  }
  return projectName ?? (folder ? projectNameFromWorkspace(folder, 'Project folder') : 'Create or open a project folder.');
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
