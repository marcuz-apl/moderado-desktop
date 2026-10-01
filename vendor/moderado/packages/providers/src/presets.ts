import type { ModelClassification, ModelInventoryEntry } from '@moderado/contracts';
import { isFreeModelEntry } from './model_discovery.js';

export const CONNECT_PROVIDER_PRESET_IDS = [
  'nvidia-nim', 'openrouter', 'agnes-ai', 'orcarouter', 'ollama', 'lm-studio', 'openai-compatible',
] as const;

export type ConnectProviderPresetId = typeof CONNECT_PROVIDER_PRESET_IDS[number];

export interface CustomConnectProvider {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel?: string;
}

export interface ConnectProvidersConfig {
  /** Omit to show all built-ins; an empty list hides every built-in. */
  enabled?: ConnectProviderPresetId[];
  custom?: CustomConnectProvider[];
}

export type ProviderConnectionKind = 'nvidia-nim' | 'openai-compatible';

/**
 * Pure metadata for the built-in provider presets. Lives here (not in the TUI
 * layer) so the host runtime can answer `provider.list` without importing any
 * presentation code.
 */
export interface ProviderPresetMeta {
  id: ConnectProviderPresetId;
  label: string;
  description: string;
  kind: ProviderConnectionKind;
  baseUrl: string;
  defaultModel?: string;
  /** Local-only runtimes (Ollama, LM Studio) never require a key. */
  requiresApiKey: boolean;
  /**
   * Exact model ids this preset guarantees cost nothing, for aliases the
   * provider's own catalog cannot prove. Matched by exact equality only — a
   * substring or id-shape match would free an entire aggregator catalog.
   */
  freeModelAliases?: readonly string[];
  /**
   * Trailing id markers this preset guarantees cost nothing. OrcaRouter names
   * its no-cost routing endpoints `.../free` and publishes no `pricing` at all,
   * so the endpoint name is the only signal available.
   *
   * The marker is matched at the **end** of the id and only where it starts a
   * segment, so `orcarouter/free` is free while `orcarouter/notfree` and
   * `orcarouter/free-router` are not. The declaration is resolved by connection
   * id, so granting it to another provider is an explicit act rather than an
   * accident of a shared substring.
   */
  freeIdSuffixes?: readonly string[];
  /**
   * True when the provider's entire hosted catalog costs nothing.
   *
   * NVIDIA NIM advertises no `pricing` on any of its catalog entries, yet the
   * hosted catalog runs on build.nvidia.com trial credits. That is a property
   * of the *provider*, not of any one model id, so it is declared once here
   * instead of being re-guessed from model names at every call site. It is
   * resolved strictly by connection id, so it can never free an aggregator's
   * metered catalog.
   */
  freeCatalog?: boolean;
}

/** How much of a provider's catalog is declared cost-free, for the free-model predicate. */
export interface ProviderFreePolicy {
  freeModelAliases?: readonly string[];
  freeIdSuffixes?: readonly string[];
  freeCatalog?: boolean;
}

/**
 * The free-tier declaration for a connection id, or `undefined` when the id has
 * no preset. An undeclared provider contributes no free evidence at all.
 */
export function freeModelPolicyFor(connectionId: string | undefined): ProviderFreePolicy | undefined {
  const preset = connectionId ? findProviderPreset(connectionId) : undefined;
  if (!preset) return undefined;
  return {
    freeModelAliases: preset.freeModelAliases,
    freeIdSuffixes: preset.freeIdSuffixes,
    freeCatalog: preset.freeCatalog,
  };
}

export const CONNECT_PROVIDER_PRESET_META: ProviderPresetMeta[] = [
  {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    description: 'Free-first routing across Nemotron, LLaMA, DeepSeek and Kimi.',
    kind: 'nvidia-nim',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    // Every hosted NIM endpoint runs on build.nvidia.com trial credits and the
    // catalog advertises no `pricing`, so without this the free list is empty
    // for the default provider.
    freeCatalog: true,
    requiresApiKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'One key for Qwen, DeepSeek, Mistral and free-tier models.',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
  },
  {
    id: 'agnes-ai',
    label: 'Agnes AI',
    description: 'Agnes Flash and Code endpoints.',
    kind: 'openai-compatible',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    // Every Agnes AI endpoint is free, and the catalog advertises no `pricing`
    // to prove it per model. Declared once as a property of the provider so the
    // whole catalog lands in the free bucket in every surface, instead of a
    // hardcoded model list in one of them.
    freeCatalog: true,
    requiresApiKey: true,
  },
  {
    id: 'orcarouter',
    label: 'OrcaRouter',
    description: 'Adaptive model routing.',
    kind: 'openai-compatible',
    baseUrl: 'https://api.orcarouter.ai/v1',
    defaultModel: 'orcarouter/free',
    // The catalog advertises no pricing, so a free endpoint is identified by its
    // name: every routing endpoint OrcaRouter serves for nothing ends in `free`.
    // Declared as a trailing marker rather than a free-for-all substring, so the
    // rest of the catalog stays metered.
    freeIdSuffixes: ['free'],
    requiresApiKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Models served locally by Ollama.',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresApiKey: false,
  },
  {
    id: 'lm-studio',
    label: 'LM Studio',
    description: 'Models served by the LM Studio local server.',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    requiresApiKey: false,
  },
];

/** True for loopback endpoints, which authenticate without an API key. */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function findProviderPreset(id: string): ProviderPresetMeta | undefined {
  return CONNECT_PROVIDER_PRESET_META.find((preset) => preset.id === id);
}

/**
 * Whether a model id ends with a provider-declared free marker, as its own
 * trailing segment.
 *
 * The two guards are the whole point. Anchoring at the end means `free` in the
 * middle of an id (`orcarouter/free-router-4`) never matches, and the segment
 * boundary means a metered id that merely ends in the same letters
 * (`orcarouter/notfree`) never matches either. An unanchored substring test is
 * what marked a whole aggregator catalog free.
 */
function endsWithFreeMarker(modelId: string, marker: string): boolean {
  if (!marker) return false;
  if (!modelId.toLowerCase().endsWith(marker.toLowerCase())) return false;
  // `charAt` past the start returns '', which is not alphanumeric, so an id that
  // is nothing but the marker still matches.
  return !/[a-z0-9]/i.test(modelId.charAt(modelId.length - marker.length - 1));
}

/**
 * Whether a provider preset *declares* this model id cost-free by name — either
 * as an exact alias or by a trailing free marker.
 *
 * This is the evidence a catalog cannot supply: OrcaRouter publishes no
 * `pricing` field whatsoever, yet its free routing endpoints are named for it.
 * It is scoped to the declaring provider (resolved by connection id through
 * `freeModelPolicyFor`), so no other provider inherits the rule.
 */
export function isDeclaredFreeModelId(modelId: string, policy?: ProviderFreePolicy): boolean {
  if (policy?.freeModelAliases?.includes(modelId)) return true;
  return (policy?.freeIdSuffixes ?? []).some((marker) => endsWithFreeMarker(modelId, marker));
}

/** Explicit zero prices or curated/preset declarations qualify; paid prices win. */
export function isFreeModelOption(
  entry: Pick<ModelInventoryEntry, 'id' | 'pricing'>,
  classification: ModelClassification,
  policy?: ProviderFreePolicy,
): boolean {
  // A reported nonzero price outranks any blanket preset declaration.
  if (entry.pricing && Object.values(entry.pricing).some(price => price.trim() === '' || !Number.isFinite(Number(price)) || Number(price) !== 0)) return false;
  if (isFreeModelEntry(entry)) return true;
  const curated = classification.source !== 'heuristic';
  if (curated && classification.accessTier !== 'free_trial' && classification.accessTier !== 'local') return false;
  if (policy?.freeCatalog) return true;
  if (isDeclaredFreeModelId(entry.id, policy)) return true;
  if (!curated) return false;
  return classification.accessTier === 'free_trial' || classification.accessTier === 'local';
}
