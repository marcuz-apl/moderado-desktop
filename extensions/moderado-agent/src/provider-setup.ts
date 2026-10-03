import {
  CONNECT_PROVIDER_PRESET_META,
  type ConnectProvidersConfig,
  type ProviderConnectionKind,
} from '@moderado/providers';

/**
 * Provider setup, matching the Moderado CLI's `/connect` behaviour.
 *
 * WHY THIS EXISTS. An earlier version of the settings pane invented its own
 * shape and wrote `kind: 'openai-compatible'` with an optional `baseUrl`. Both
 * are wrong against the pinned engine:
 *
 *  - The CLI's config reader (`parseConnections` in apps/cli/src/config.ts)
 *    requires `typeof baseUrl === 'string'` and silently *discards* any
 *    connection that fails, so a saved connection can vanish with no error.
 *  - The engine builds `NvidiaAdapter` only when `kind === 'nvidia-nim'`.
 *    Hardcoding one kind routes NVIDIA through the generic adapter and loses
 *    its `freeCatalog` free-tier declaration.
 *  - `freeModelPolicyFor()` resolves a preset by *connection id*, so the id
 *    must be the preset id or the free-first rule silently stops applying.
 *
 * The preset list comes from the engine's own `CONNECT_PROVIDER_PRESET_META`
 * rather than a copy, so Desktop cannot drift from the pinned provider set.
 */

export type ProviderChoiceValue = string;

export interface ProviderChoice {
  value: ProviderChoiceValue;
  label: string;
  description: string;
  tag?: string;
  displayName?: string;
  baseUrl?: string;
  defaultModel?: string;
  kind: ProviderConnectionKind;
  /** False for local runtimes, which authenticate with no key. */
  requiresApiKey: boolean;
}

export interface ProviderConnectionRecord {
  id: string;
  displayName: string;
  kind: ProviderConnectionKind;
  baseUrl: string;
  credentialReference?: string;
  apiKey?: string;
  defaultModel?: string;
}

export interface ConnectionInput {
  preset: ProviderChoiceValue;
  apiKey?: string;
  baseUrl?: string;
  displayName?: string;
  defaultModel?: string;
}

/** Mirrors the CLI's slug rule in provider_connect.ts `connectionId`. */
export function connectionIdFor(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
}

/**
 * The provider picker, in the engine's own preset order.
 *
 * `connectProviders` from the shared profile is honoured: `enabled` filters the
 * built-ins and `custom` appends user endpoints, so a CLI user sees the same
 * list in Desktop.
 */
export function buildProviderChoices(config?: ConnectProvidersConfig): ProviderChoice[] {
  const enabled = config?.enabled;
  const builtIns: ProviderChoice[] = CONNECT_PROVIDER_PRESET_META
    .filter((preset) => enabled === undefined || enabled.includes(preset.id))
    .map((preset) => ({
      value: preset.id,
      label: preset.label,
      description: preset.description,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      defaultModel: preset.defaultModel,
      requiresApiKey: preset.requiresApiKey,
      // Mirrors the CLI's tags so both surfaces describe a preset identically.
      tag: preset.freeCatalog ? 'Free Models' : preset.requiresApiKey ? undefined : 'Local',
    }));

  const custom: ProviderChoice[] = (config?.custom ?? []).map((provider) => ({
    value: `custom:${provider.id}`,
    label: provider.name,
    description: 'Connect this custom OpenAI-compatible endpoint.',
    tag: 'Custom',
    displayName: provider.name,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    kind: 'openai-compatible',
    requiresApiKey: true,
  }));

  // `CONNECT_PROVIDER_PRESET_IDS` includes 'openai-compatible', but the preset
  // *metadata* table deliberately has no entry for it: it is the generic
  // "bring your own endpoint" escape hatch rather than a known provider. The CLI
  // supplies it from its own list, so Desktop adds it here rather than leaving
  // a selectable id with nothing behind it.
  const generic: ProviderChoice = {
    value: 'openai-compatible',
    label: 'Other OpenAI-compatible provider',
    description: 'Connect any compatible endpoint with its base URL, key, and model ID.',
    kind: 'openai-compatible',
    requiresApiKey: true,
  };

  const withGeneric = enabled === undefined || enabled.includes('openai-compatible')
    ? [...builtIns, generic]
    : builtIns;

  return [...withGeneric, ...custom];
}

/** The preset behind a picker value, or undefined for a removed custom entry. */
function findChoice(value: string, config?: ConnectProvidersConfig): ProviderChoice | undefined {
  if (value.startsWith('custom:')) {
    const id = value.slice('custom:'.length);
    const provider = config?.custom?.find((item) => item.id === id);
    if (!provider) return undefined;
    return {
      value,
      label: provider.name,
      description: 'Connect this custom OpenAI-compatible endpoint.',
      displayName: provider.name,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      kind: 'openai-compatible',
      requiresApiKey: true,
    };
  }
  return buildProviderChoices(config).find((choice) => choice.value === value);
}

function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

// --- Listing models before a connection is saved -------------------------------

/**
 * The connection id a picker value maps to.
 *
 * It is the Credential Manager target and the key `freeModelPolicyFor` resolves
 * against, so it must match what `buildProviderConnection` would produce.
 */
export function presetConnectionId(preset: string): string {
  if (preset.startsWith('custom:')) return preset.slice('custom:'.length);
  if (preset === 'openai-compatible') return connectionIdFor('Other OpenAI-compatible provider');
  return preset;
}

export interface DiscoveryInput {
  preset: string;
  apiKey?: string;
  /** The endpoint already recorded in the profile, if any. */
  storedBaseUrl?: string;
  displayName?: string;
  defaultModel?: string;
}

/**
 * A connection good enough to *list* models, with no key requirement.
 *
 * Deliberately more lenient than `buildProviderConnection`: OpenRouter and other
 * providers serve their catalog without authentication, and the CLI lists the
 * free models as its first step of the connect flow. Requiring a key here would
 * show an empty list until the user had already saved a connection they cannot
 * yet verify.
 */
export function buildDiscoveryConnection(
  input: DiscoveryInput,
  config?: ConnectProvidersConfig,
): ProviderConnectionRecord {
  const choice = findChoice(input.preset, config);
  if (!choice) throw new Error('That provider is no longer available in the shared profile.');

  const apiKey = input.apiKey?.trim() || undefined;
  const baseUrl = (input.storedBaseUrl?.trim() || choice.baseUrl || '').replace(/\/+$/, '');

  if (choice.kind === 'nvidia-nim') {
    return {
      id: 'nvidia-nim',
      displayName: choice.label,
      kind: 'nvidia-nim',
      baseUrl: choice.baseUrl!,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  if (!baseUrl) throw new Error('A base URL is required before models can be listed.');

  const displayName = input.displayName?.trim() || choice.displayName || choice.label;
  return {
    id: presetConnectionId(choice.value),
    displayName,
    kind: 'openai-compatible',
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(input.defaultModel?.trim() || choice.defaultModel
      ? { defaultModel: (input.defaultModel?.trim() || choice.defaultModel) as string }
      : {}),
  };
}

/**
 * Free models first, stable within each group.
 *
 * The engine's rule is free-first, so the list the user picks from is ordered the
 * same way; otherwise the cheapest option sits below a wall of paid entries.
 */
export function sortFreeFirst<T extends { isFree: boolean }>(models: T[]): T[] {
  return [...models].sort((a, b) => Number(b.isFree) - Number(a.isFree));
}

/**
 * The model to preselect: an explicit choice if it survived, otherwise the first
 * free one, otherwise the first listed.
 */
export function pickDefaultModel<T extends { id: string }>(models: T[], current: string): string {
  if (current && models.some((model) => model.id === current)) return current;
  return models[0]?.id ?? '';
}

/**
 * Validates and normalizes one connection exactly as the CLI's `buildConnection`
 * does, so a connection saved here is readable by the CLI unchanged.
 */
export function buildProviderConnection(
  input: ConnectionInput,
  config?: ConnectProvidersConfig,
): ProviderConnectionRecord {
  const choice = findChoice(input.preset, config);
  if (!choice) throw new Error('That provider is no longer available in the shared profile.');

  const apiKey = input.apiKey?.trim();

  if (choice.requiresApiKey && !apiKey) {
    if (choice.kind === 'nvidia-nim') throw new Error('An NVIDIA API key is required.');
    throw new Error('An API key is required.');
  }

  if (choice.kind === 'nvidia-nim') {
    // Fixed id, fixed endpoint: the free-tier policy resolves on 'nvidia-nim'.
    return {
      id: 'nvidia-nim',
      displayName: choice.label,
      kind: 'nvidia-nim',
      baseUrl: choice.baseUrl!,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  const displayName = input.displayName?.trim() || choice.displayName || choice.label;
  const id = choice.value.startsWith('custom:')
    ? choice.value.slice('custom:'.length)
    : connectionIdFor(displayName);
  const defaultModel = input.defaultModel?.trim() || choice.defaultModel;
  const rawBaseUrl = input.baseUrl?.trim() || choice.baseUrl;

  if (!rawBaseUrl) throw new Error('A base URL is required.');
  // The CLI requires a default model for a plain OpenAI-compatible endpoint;
  // a preset may supply its own.
  if (!defaultModel) throw new Error('A default model is required for an OpenAI-compatible provider.');

  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error('Enter a valid provider base URL.');
  }
  // HTTPS only, except loopback. Anything else would send the key in cleartext.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('Provider base URLs must use HTTPS (HTTP is allowed only for localhost).');
  }

  return {
    id,
    displayName,
    kind: 'openai-compatible',
    baseUrl: url.toString().replace(/\/+$/, ''),
    ...(apiKey ? { apiKey } : {}),
    defaultModel,
  };
}