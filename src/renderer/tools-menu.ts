export type ToolAction = 'files' | 'terminal-panel' | 'vscode' | 'system-terminal';
export type ToolContext = { kind: 'work' | 'code'; hasWorkspace: boolean };
export type ToolItem = { action: ToolAction; label: string };

/** The Right Pane menu: the three things that are not rail destinations. */
export const TOOL_ITEMS: readonly ToolItem[] = [
  { action: 'files', label: 'File browser' },
  { action: 'system-terminal', label: 'Open system terminal' },
  { action: 'vscode', label: 'Open in VS Code' },
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
