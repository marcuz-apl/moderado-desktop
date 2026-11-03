export type ToolAction =
  | 'files'
  | 'task-monitor'
  | 'terminal-panel'
  | 'vscode'
  | 'system-terminal'
  | 'settings'
  | 'docs';

export type ToolGroup = 'panels' | 'open-in' | 'app';
export type ToolContext = { kind: 'work' | 'code'; hasWorkspace: boolean };
export type ToolItem = { action: ToolAction; label: string; group: ToolGroup; checkbox: boolean };

export const TOOL_ITEMS: readonly ToolItem[] = [
  { action: 'files', label: 'File browser', group: 'panels', checkbox: false },
  { action: 'task-monitor', label: 'Task monitor', group: 'panels', checkbox: true },
  { action: 'terminal-panel', label: 'Terminal panel', group: 'panels', checkbox: true },
  { action: 'vscode', label: 'Open in VS Code', group: 'open-in', checkbox: false },
  { action: 'system-terminal', label: 'Open system terminal', group: 'open-in', checkbox: false },
  { action: 'settings', label: 'Settings', group: 'app', checkbox: false },
  { action: 'docs', label: 'Docs', group: 'app', checkbox: false },
];

/** A disabled item still renders; the reason becomes its tooltip. */
export function toolDisabledReason(action: ToolAction, context: ToolContext): string | null {
  if (action === 'terminal-panel' && context.kind !== 'code') {
    return 'Commands run in Code sessions only.';
  }
  if ((action === 'vscode' || action === 'system-terminal') && !context.hasWorkspace) {
    return 'Select a project or task folder first.';
  }
  return null;
}

/** Roving focus for the popover: Home/End, arrows, and wraparound. */
export function nextMenuIndex(
  current: number,
  count: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (current < 0 || current >= count) return key === 'ArrowDown' ? 0 : count - 1;
  return key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count;
}
