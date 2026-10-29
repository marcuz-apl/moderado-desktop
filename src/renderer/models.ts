/** A model advertised by a provider, as returned by `discover_models`. */
export type ModelInfo = {
  id: string;
  name: string;
  access?: string | null;
  capabilities?: string[];
  section?: string | null;
};

/** The Gateway's pinned stealth defaults, the only routes it serves keyless. */
export function isKeylessModel(model: Pick<ModelInfo, 'section'>): boolean {
  return model.section === 'default';
}

/**
 * Human label for a model option. The Gateway tags its catalog with `access`
 * and `section`, so the free stealth defaults are distinguishable from free
 * routes that still need a key and from paid routes. Other providers return
 * only an id, which passes through unchanged.
 */
export function modelOptionLabel(model: Pick<ModelInfo, 'id' | 'name' | 'access' | 'section'>): string {
  const name = model.name || model.id;
  if (model.section === 'default') return `${name} — free, no key`;
  if (model.access === 'free') return `${name} — free, key required`;
  if (model.access === 'paid') return `${name} — paid`;
  return name;
}

/** Preselect a keyless stealth default when one exists, else the first model. */
export function defaultModelId(models: ModelInfo[]): string {
  const preferred = models.find((model) => model.section === 'default') ?? models[0];
  return preferred?.id ?? '';
}

/** Count the models that work without an API key. */
export function keylessModelCount(models: ModelInfo[]): number {
  return models.filter((model) => model.section === 'default').length;
}

/**
 * Turn a bare provider error into something actionable. A 401 from a
 * keyless-capable provider means the chosen model needs a key while the free
 * stealth defaults do not.
 */
export function explainProviderError(
  detail: string,
  preset: { name: string; keyless: boolean } | undefined,
): string {
  if (/HTTP 401/.test(detail) && preset?.keyless) {
    return `${detail} — this model needs a ${preset.name} API key; the free stealth models work without one.`;
  }
  return detail;
}
