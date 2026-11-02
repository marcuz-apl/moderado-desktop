/** The `@` reference the caret sits in, if any. */
export function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

/** Replaces the half-typed reference with a finished one and reports the caret. */
export function applyMention(
  value: string,
  start: number,
  end: number,
  path: string,
): { text: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const inserted = `@${path} `;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

/** Ranks file-name matches ahead of path-only matches so the menu stays useful. */
export function filterFiles(files: readonly string[], query: string, limit = 8): string[] {
  const needle = query.toLowerCase();
  if (!needle) return files.slice(0, limit);
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    let score = -1;
    if (name.startsWith(needle)) score = 0;
    else if (name.includes(needle)) score = 1;
    else if (lower.includes(needle)) score = 2;
    if (score >= 0) scored.push({ path, score });
  }
  scored.sort((left, right) => left.score - right.score
    || left.path.length - right.path.length
    || left.path.localeCompare(right.path));
  return scored.slice(0, limit).map((item) => item.path);
}
