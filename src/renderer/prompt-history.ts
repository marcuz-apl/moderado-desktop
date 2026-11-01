export type RecallState = { index: number | null; stash: string };

export const EMPTY_RECALL: RecallState = { index: null, stash: '' };

/**
 * Only take over the arrow keys at the first and last line of the box, so
 * moving through multi-line text keeps working normally.
 */
export function canRecall(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: -1 | 1,
): boolean {
  if (selectionStart !== selectionEnd) return false;
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  return direction < 0 ? !before.includes('\n') : !after.includes('\n');
}

/**
 * Steps through the sent-prompt history. Going up from the live draft stashes
 * it, and coming back down past the newest entry restores that draft.
 */
export function recall(
  history: readonly string[],
  state: RecallState,
  direction: -1 | 1,
  currentText: string,
): { text: string; state: RecallState } | null {
  if (!history.length) return null;
  let index = state.index;
  let stash = state.stash;
  if (index === null) {
    if (direction > 0) return null;
    stash = currentText;
    index = history.length;
  }
  const next = index + direction;
  if (next < 0) return null;
  if (next >= history.length) return { text: stash, state: { ...EMPTY_RECALL } };
  return { text: history[next] ?? '', state: { index: next, stash } };
}
