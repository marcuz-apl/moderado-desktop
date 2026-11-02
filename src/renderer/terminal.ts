/** One command line, split the way a shell would split words but without a shell. */
export type ParsedCommand = { program: string; args: string[] };

/**
 * Split a command line into a program and its arguments. Quotes group words and
 * are removed; there is no variable expansion, no pipes, no globbing — the app
 * runs the program directly, so anything else would silently do nothing.
 */
export function parseCommandLine(line: string): ParsedCommand | null {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of line) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/.test(character)) {
      if (started || current) { words.push(current); current = ''; started = false; }
      continue;
    }
    current += character;
    started = true;
  }
  if (current || started) words.push(current);
  const [program, ...args] = words;
  return program ? { program, args } : null;
}
