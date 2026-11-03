export type MonitorActivity = {
  role: string;
  toolId?: string;
  toolName?: string;
  content: string;
  createdAt?: number;
};

export type MonitorUpdate = {
  id: string;
  at: number;
  kind: 'tool' | 'error' | 'checkpoint';
  label: string;
  detail: string;
};

export type MonitorArtifact = {
  path: string;
  action: 'created' | 'updated' | 'changed';
  at: number;
};

export type MonitorCheckpoint = { id: string; path: string; createdAt: number };
export type MonitorSchedule = {
  id: string;
  prompt: string;
  inFlight: boolean;
  enabled: boolean;
  nextRunAt: number;
  intervalSeconds: number | null;
  lastError: string | null;
};
export type MonitorRun = {
  label: string;
  startedAt: number;
  scheduled: boolean;
  scheduleId?: string;
};
export type MonitorProcess = {
  id: string;
  label: string;
  state: 'running' | 'scheduled';
  detail: string;
  startedAt?: number;
};

const TOOL_TITLES: Record<string, string> = {
  list_files: 'Browsed files',
  read_file: 'Read a file',
  search_files: 'Searched files',
  write_file: 'Created a file',
  edit_file: 'Edited a file',
  execute_command: 'Ran a command',
  web_search: 'Searched the web',
  git_diff: 'Showed the Git diff',
  find_references: 'Found references',
  get_definition: 'Found a definition',
};

export function toolTitle(name?: string): string {
  return name ? TOOL_TITLES[name] ?? name.replaceAll('_', ' ') : 'Tool activity';
}

export function shortText(value: string, limit = 120): string {
  const line = value.split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export function elapsedLabel(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function toolDetail(name: string, content: string): string {
  if (name === 'write_file' || name === 'edit_file') return shortText(content);
  if (name === 'execute_command') {
    try {
      const parsed = JSON.parse(content) as { exitCode?: unknown };
      return typeof parsed.exitCode === 'number' ? `Exit ${parsed.exitCode}` : 'Completed';
    } catch {
      return '';
    }
  }
  return '';
}

export function updatesFromActivity(
  activities: readonly MonitorActivity[],
  now: number,
): MonitorUpdate[] {
  return activities
    .flatMap((activity, index) => {
      if (activity.role !== 'Activity' || !activity.toolName) return [];
      const failed = activity.content.startsWith('Error:');
      return [{
        id: `tool:${activity.toolId ?? index}`,
        at: activity.createdAt ?? now,
        kind: failed ? 'error' as const : 'tool' as const,
        label: toolTitle(activity.toolName),
        detail: failed ? shortText(activity.content) : toolDetail(activity.toolName, activity.content),
      }];
    })
    .sort((left, right) => right.at - left.at);
}

export function checkpointUpdates(checkpoints: readonly MonitorCheckpoint[]): MonitorUpdate[] {
  return checkpoints
    .map((checkpoint) => ({
      id: `checkpoint:${checkpoint.id}`,
      at: checkpoint.createdAt * 1000,
      kind: 'checkpoint' as const,
      label: 'Checkpoint',
      detail: checkpoint.path,
    }))
    .sort((left, right) => right.at - left.at);
}

export function mergeUpdates(groups: readonly MonitorUpdate[][], limit = 100): MonitorUpdate[] {
  const seen = new Set<string>();
  const merged: MonitorUpdate[] = [];
  for (const group of groups) {
    for (const update of group) {
      if (seen.has(update.id)) continue;
      seen.add(update.id);
      merged.push(update);
    }
  }
  return merged.sort((left, right) => right.at - left.at).slice(0, limit);
}

export function artifactsFromTool(name: string, content: string, at: number): MonitorArtifact[] {
  if (content.startsWith('Error:')) return [];
  if (name === 'write_file' || name === 'edit_file') {
    const prefix = name === 'write_file' ? 'Wrote ' : 'Edited ';
    if (!content.startsWith(prefix)) return [];
    const path = content.slice(prefix.length).replace(/ with user-edited content$/, '').trim();
    return path ? [{ path, action: name === 'write_file' ? 'created' : 'updated', at }] : [];
  }
  if (name === 'execute_command') {
    try {
      const parsed = JSON.parse(content) as { changedFiles?: unknown };
      if (!Array.isArray(parsed.changedFiles)) return [];
      return parsed.changedFiles
        .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
        .map((path) => ({ path, action: 'changed' as const, at }));
    } catch {
      return [];
    }
  }
  return [];
}

export function artifactsFromActivity(
  activities: readonly MonitorActivity[],
  now: number,
): MonitorArtifact[] {
  const byPath = new Map<string, MonitorArtifact>();
  for (const activity of activities) {
    if (activity.role !== 'Activity' || !activity.toolName) continue;
    const at = activity.createdAt ?? now;
    for (const artifact of artifactsFromTool(activity.toolName, activity.content, at)) {
      const previous = byPath.get(artifact.path);
      if (!previous || previous.at <= artifact.at) byPath.set(artifact.path, artifact);
    }
  }
  return [...byPath.values()].sort((left, right) => right.at - left.at);
}

export function backgroundRows(
  run: MonitorRun | undefined,
  schedules: readonly MonitorSchedule[],
  now: number,
): MonitorProcess[] {
  const rows: MonitorProcess[] = [];
  if (run) {
    rows.push({
      id: 'active-run',
      label: run.label,
      state: 'running',
      detail: `${run.scheduled ? 'Scheduled' : 'Active'} · ${elapsedLabel(run.startedAt, now)}`,
      startedAt: run.startedAt,
    });
  }
  for (const schedule of schedules) {
    if (run?.scheduled && run.scheduleId === schedule.id) continue;
    const minutes = Math.max(0, Math.round((schedule.nextRunAt * 1000 - now) / 60_000));
    const detail = schedule.inFlight
      ? 'Running now'
      : schedule.enabled
        ? minutes < 1 ? 'Next in <1m' : `Next in ${minutes}m`
        : schedule.lastError
          ? `Paused: ${shortText(schedule.lastError, 60)}`
          : 'Completed';
    rows.push({
      id: `schedule:${schedule.id}`,
      label: `Scheduled: ${shortText(schedule.prompt, 60)}`,
      state: schedule.inFlight ? 'running' : 'scheduled',
      detail,
    });
  }
  return rows.sort((left, right) => {
    if (left.state === right.state) return 0;
    return left.state === 'running' ? -1 : 1;
  });
}
