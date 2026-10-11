export type DiffLine = { kind: 'context' | 'removed' | 'added'; text: string };

export function lineDiff(before: string, after: string): DiffLine[] {
  const oldLines = before ? before.split('\n') : [];
  const newLines = after ? after.split('\n') : [];
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  return [
    ...oldLines.slice(0, prefix).map((text): DiffLine => ({ kind: 'context', text })),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((text): DiffLine => ({ kind: 'removed', text })),
    ...newLines.slice(prefix, newLines.length - suffix).map((text): DiffLine => ({ kind: 'added', text })),
    ...newLines.slice(newLines.length - suffix).map((text): DiffLine => ({ kind: 'context', text })),
  ];
}
