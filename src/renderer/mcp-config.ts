/** Parse the form's "Args (JSON)" field into an argv array. */
export function parseMcpArgs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) throw new Error('Args must be a JSON array');
  return parsed.map((item) => String(item));
}

/** Parse the form's "Env (JSON)" field into a string map. */
export function parseMcpEnv(text: string): Record<string, string> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Env must be a JSON object');
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
}

/** Parse the form's "Tools" field. Blank means every advertised tool. */
export function parseMcpTools(text: string): string[] | null {
  const tools = text.split(',').map((tool) => tool.trim()).filter(Boolean);
  return tools.length ? tools : null;
}
