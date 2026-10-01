import { z } from 'zod';
import { IToolDefinition, ToolExecutionContext, ToolResult, WebSearchParams, WebSearchParamsSchema } from '@moderado/contracts';

/** Hosted MCP search services. No credential is required; an API key only raises provider limits. */
export const EXA_SEARCH_URL = 'https://mcp.exa.ai/mcp';
export const PARALLEL_SEARCH_URL = 'https://search.parallel.ai/mcp';
export const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;
export const MAX_SEARCH_OUTPUT_CHARS = 8_000;
const MAX_SOURCES = 10;
const MCP_ACCEPT = 'application/json, text/event-stream';

export type WebSearchProviderName = 'exa' | 'parallel' | 'custom';

export interface WebSearchTarget {
  provider: WebSearchProviderName;
  url: string;
  tool: string;
}

export interface WebSearchToolOptions {
  /** Explicit HTTPS (or localhost) endpoint returning `{ results: [{ title, url, snippet? }] }`. */
  endpoint?: string;
  /** Pin the search provider instead of the default Exa-then-Parallel order. */
  provider?: WebSearchProviderName;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const McpSearchResponseSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  }),
});

const CustomSearchResponseSchema = z.object({
  results: z.array(z.object({ title: z.string().optional(), url: z.string().optional(), snippet: z.string().optional() })),
});

export function isAllowedSearchEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function parseProvider(value: string | undefined): WebSearchProviderName | undefined {
  const text = value?.trim().toLowerCase();
  return text === 'exa' || text === 'parallel' || text === 'custom' ? text : undefined;
}

/**
 * Order the search sites deterministically: an explicit endpoint wins, then Exa (best current-events
 * context in live probes), then Parallel. A pinned provider moves to the front and keeps the rest as fallback.
 */
export function resolveWebSearchTargets(options: WebSearchToolOptions = {}, env: NodeJS.ProcessEnv = process.env): WebSearchTarget[] {
  const customEndpoint = (options.endpoint ?? env.MODERADO_WEB_SEARCH_ENDPOINT)?.trim();
  const exaKey = env.EXA_API_KEY?.trim();
  const targets: WebSearchTarget[] = [];
  if (customEndpoint && isAllowedSearchEndpoint(customEndpoint)) targets.push({ provider: 'custom', url: customEndpoint, tool: '' });
  targets.push({ provider: 'exa', url: exaKey ? `${EXA_SEARCH_URL}?exaApiKey=${encodeURIComponent(exaKey)}` : EXA_SEARCH_URL, tool: 'web_search_exa' });
  targets.push({ provider: 'parallel', url: PARALLEL_SEARCH_URL, tool: 'web_search' });
  const pinned = options.provider ?? parseProvider(env.MODERADO_WEB_SEARCH_PROVIDER);
  if (!pinned) return targets;
  const direct = targets.filter((target) => target.provider === pinned);
  return direct.length ? [...direct, ...targets.filter((target) => target.provider !== pinned)] : targets;
}

function readMcpText(payload: string): string | undefined {
  if (!payload.startsWith('{')) return undefined;
  try {
    const parsed = McpSearchResponseSchema.safeParse(JSON.parse(payload));
    if (!parsed.success || parsed.data.result.isError) return undefined;
    return parsed.data.result.content?.find((item) => item.text)?.text;
  } catch {
    return undefined;
  }
}

/** Accept both a direct JSON-RPC body and a server-sent-events stream. */
export function parseMcpSearchText(body: string): string | undefined {
  const direct = readMcpText(body.trim());
  if (direct) return direct;
  for (const line of body.split('\n')) {
    const text = line.startsWith('data:') ? readMcpText(line.slice(5).trim()) : undefined;
    if (text) return text;
  }
  return undefined;
}

export function extractSearchSources(text: string, limit = MAX_SOURCES): Array<{ title: string; url: string }> {
  const sources: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  let title = '';
  const add = (url: string, label: string): void => {
    if (seen.has(url) || sources.length >= limit) return;
    seen.add(url);
    sources.push({ title: label || url, url });
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Title:')) { title = trimmed.slice(6).trim(); continue; }
    if (trimmed.startsWith('URL:')) {
      const url = trimmed.slice(4).trim();
      if (/^https?:\/\//.test(url)) add(url, title);
      title = '';
    }
  }
  if (!sources.length) for (const match of text.matchAll(/https?:\/\/[^\s"'`<>)\]}]+/g)) add(match[0], '');
  return sources;
}

export function boundSearchOutput(text: string, maxChars = MAX_SEARCH_OUTPUT_CHARS): { output: string; truncated: boolean } {
  if (text.length <= maxChars) return { output: text, truncated: false };
  return { output: `${text.slice(0, maxChars)}\n\n[search context truncated at ${maxChars} characters]`, truncated: true };
}

async function fetchMcpSearch(target: WebSearchTarget, params: WebSearchParams, signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const args = target.provider === 'parallel'
    ? { objective: params.objective ?? params.query, search_queries: [params.query] }
    : { query: params.query, objective: params.objective ?? params.query, numResults: params.maxResults };
  const response = await fetchImpl(target.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: target.tool, arguments: args } }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = parseMcpSearchText(await response.text());
  if (!text) throw new Error('unreadable search response');
  return text;
}

async function fetchCustomSearch(endpoint: string, params: WebSearchParams, signal: AbortSignal, fetchImpl: typeof fetch): Promise<string> {
  const url = new URL(endpoint);
  url.searchParams.set('q', params.query);
  url.searchParams.set('limit', String(params.maxResults));
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = CustomSearchResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!payload.success) throw new Error('unreadable search response');
  return payload.data.results
    .filter((item) => typeof item.title === 'string' && typeof item.url === 'string')
    .slice(0, params.maxResults)
    .map((item) => `Title: ${item.title}\nURL: ${item.url}${typeof item.snippet === 'string' && item.snippet.length > 0 ? `\n${item.snippet}` : ''}`)
    .join('\n\n');
}

function searchSignal(context: ToolExecutionContext, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
}

/** Build a search tool bound to operator configuration so the model only supplies the query. */
export function createWebSearchTool(options: WebSearchToolOptions = {}): IToolDefinition<WebSearchParams> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  return {
    name: 'web_search',
    description: `Search the web for current information. Use it immediately for anything that changes over time, such as weather, news, prices, scores, schedules, and releases, instead of running curl or asking the user to look it up. The returned pages are raw excerpts: answer the user with the facts and values only, and never list source URLs, site names, or page titles unless the user explicitly asks for them. The current year is ${new Date().getFullYear()}.`,
    requiresApproval: false,
    parametersSchema: WebSearchParamsSchema,
    async execute(params: WebSearchParams, context: ToolExecutionContext): Promise<ToolResult> {
      const explicitEndpoint = params.endpoint?.trim();
      if (explicitEndpoint && !isAllowedSearchEndpoint(explicitEndpoint)) return { toolName: 'web_search', status: 'error', output: 'Search endpoint must use HTTPS or localhost.' };
      const fetchImpl = options.fetchImpl ?? fetch;
      const failures: string[] = [];
      for (const target of resolveWebSearchTargets({ ...options, endpoint: explicitEndpoint ?? options.endpoint })) {
        const signal = searchSignal(context, timeoutMs);
        try {
          const text = target.provider === 'custom' ? await fetchCustomSearch(target.url, params, signal, fetchImpl) : await fetchMcpSearch(target, params, signal, fetchImpl);
          if (!text.trim()) { failures.push(`${target.provider}: no results`); continue; }
          const bounded = boundSearchOutput(text);
          return {
            toolName: 'web_search',
            status: 'success',
            output: bounded.output,
            ...(bounded.truncated ? { truncated: true } : {}),
            metadata: { provider: target.provider, sources: extractSearchSources(bounded.output) },
          };
        } catch (error) {
          const timedOut = signal.aborted && !context.abortSignal?.aborted;
          failures.push(`${target.provider}: ${timedOut ? `timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { toolName: 'web_search', status: 'error', output: `Web search failed (${failures.join('; ')}).` };
    },
  };
}

/** Default registration used when the CLI does not supply operator configuration. */
export const WebSearchTool = createWebSearchTool();
