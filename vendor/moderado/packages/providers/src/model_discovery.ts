import {
  ModelInventoryEntry,
  ModelInventoryEntrySchema,
  ProviderError,
} from '@moderado/contracts';

export const SPIKE_PROVIDER_ENDPOINTS = {} as const;

/**
 * Fetch the OpenAI-compatible `/models` listing from any provider endpoint.
 * Mirrors `NvidiaAdapter.discoverModels` but without per-instance caching —
 * `/connect` calls it once per setup flow.
 */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string | undefined,
  optionsOrSignal?: AbortSignal | { signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<ModelInventoryEntry[]> {
  const signal = optionsOrSignal instanceof AbortSignal ? optionsOrSignal : optionsOrSignal?.signal;
  const doFetch = (!(optionsOrSignal instanceof AbortSignal) && optionsOrSignal?.fetchImpl) ? optionsOrSignal.fetchImpl : fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new Error('Discovery request was aborted');
    throw new ProviderError(
      `Network error while contacting ${url}: ${err instanceof Error ? err.message : String(err)}`,
      'ERR_NETWORK_ERROR'
    );
  }
  if (!response.ok) {
    throw new ProviderError(
      `Model discovery failed with status ${response.status} at ${url}`,
      'ERR_HTTP_ERROR',
      response.status
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new ProviderError(
      `Failed to parse models response: ${err instanceof Error ? err.message : String(err)}`,
      'ERR_MALFORMED_RESPONSE'
    );
  }
  const dataArray = Array.isArray(json) ? json : (json as { data?: unknown[] })?.data;
  if (!Array.isArray(dataArray)) {
    throw new ProviderError("Expected array in models response ('data' field)", 'ERR_MALFORMED_RESPONSE');
  }
  const results: ModelInventoryEntry[] = [];
  for (const item of dataArray) {
    const parsed = ModelInventoryEntrySchema.safeParse(item);
    if (parsed.success) results.push(parsed.data);
  }
  return results;
}

/** Require explicit zero input and output prices, with no other metered fees. */
export function isFreeModelEntry(entry: Pick<ModelInventoryEntry, 'pricing'>): boolean {
  const pricing = entry.pricing;
  return pricing?.prompt !== undefined && pricing.completion !== undefined
    && Object.values(pricing).every((price) => price.trim() !== '' && Number.isFinite(Number(price)) && Number(price) === 0);
}

export async function fetchProviderFreeModels(
  baseUrl: string,
  apiKey: string | undefined,
  optionsOrSignal?: AbortSignal | { signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<ModelInventoryEntry[]> {
  const models = await fetchProviderModels(baseUrl, apiKey, optionsOrSignal);
  return models.filter(isFreeModelEntry);
}


const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/**
 * OpenRouter publishes its full model catalog without authentication; free
 * variants (e.g. `deepseek/deepseek-r1:free`) advertise `pricing.prompt: "0"`.
 * `fetchImpl` is injectable so tests stay fully offline.
 */
export async function fetchOpenRouterFreeModels(
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<ModelInventoryEntry[]> {
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(OPENROUTER_MODELS_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw new Error('Discovery request was aborted');
    throw new ProviderError(
      `Network error while contacting ${OPENROUTER_MODELS_URL}: ${err instanceof Error ? err.message : String(err)}`,
      'ERR_NETWORK_ERROR'
    );
  }
  if (!response.ok) {
    throw new ProviderError(
      `OpenRouter model discovery failed with status ${response.status}`,
      'ERR_HTTP_ERROR',
      response.status
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new ProviderError(
      `Failed to parse OpenRouter models response: ${err instanceof Error ? err.message : String(err)}`,
      'ERR_MALFORMED_RESPONSE'
    );
  }
  const dataArray = Array.isArray(json) ? json : (json as { data?: unknown[] })?.data;
  if (!Array.isArray(dataArray)) {
    throw new ProviderError("Expected array in OpenRouter models response ('data' field)", 'ERR_MALFORMED_RESPONSE');
  }
  const free: ModelInventoryEntry[] = [];
  for (const item of dataArray) {
    const parsed = ModelInventoryEntrySchema.safeParse(item);
    if (parsed.success && isFreeModelEntry(parsed.data)) free.push(parsed.data);
  }
  return free;
}

/** Split a provider listing into free-first and paid buckets. */
export function partitionFreeModels(entries: ModelInventoryEntry[]): {
  free: ModelInventoryEntry[];
  paid: ModelInventoryEntry[];
} {
  const free: ModelInventoryEntry[] = [];
  const paid: ModelInventoryEntry[] = [];
  for (const entry of entries) {
    (isFreeModelEntry(entry) ? free : paid).push(entry);
  }
  return { free, paid };
}
