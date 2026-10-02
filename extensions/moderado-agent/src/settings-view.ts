import { escapeHtml } from './html.js';

/**
 * The in-panel Moderado settings pane, as pure string building.
 *
 * Same split as chat-view.ts: no `vscode` import, so this is directly testable.
 *
 * SECURITY BOUNDARY. This pane collects a provider API key, so it is written to
 * be hostile to its own contents:
 *
 *  - The stored key is never sent into the pane. The field is a write-only
 *    masked input; an empty field means "leave the stored key alone" and can
 *    never erase one. Reading it back would put a live secret on screen.
 *  - The key leaves through a single `saveSettings` message and goes straight to
 *    the extension host, which writes it to Credential Manager. It is never put
 *    in `config.json`, an editor setting, or an event.
 *  - Everything rendered here (provider names, base URLs, model ids, profile
 *    errors) is untrusted data from the shared profile and is escaped.
 */

export interface SettingsConnection {
  id: string;
  displayName: string;
}

export interface SettingsModel {
  id: string;
  /** Engine `AccessTier`: free_trial | paid | local | unknown. */
  accessTier: string;
  isFree: boolean;
}

/** A picker entry; mirrors the engine's preset metadata plus CLI tags. */
export interface SettingsProviderChoice {
  value: string;
  label: string;
  description: string;
  tag?: string;
  baseUrl?: string;
  defaultModel?: string;
  requiresApiKey: boolean;
  /** True for the generic "other endpoint" entry, which needs the extra fields. */
  custom?: boolean;
}

export interface SettingsState {
  open: boolean;
  /** The engine-driven provider picker, in the CLI's order. */
  providers: SettingsProviderChoice[];
  /** Currently selected picker value. */
  preset: string;
  connections: SettingsConnection[];
  activeConnectionId: string;
  baseUrl: string;
  displayName: string;
  /** True when a Credential Manager entry exists. The key itself is never here. */
  apiKeyStored: boolean;
  models: SettingsModel[];
  defaultModel: string;
  /** Set when the profile could not be read; blocks saving rather than defaulting. */
  profileError?: string;
  /** Transient feedback line, e.g. "Saved." or a failure reason. */
  status?: string;
}

export function emptySettings(): SettingsState {
  return {
    open: false,
    providers: [],
    preset: '',
    connections: [],
    activeConnectionId: '',
    baseUrl: '',
    displayName: '',
    apiKeyStored: false,
    models: [],
    defaultModel: '',
  };
}

/** The parts of the pane the webview updates in place. */
export interface SettingsSnapshot {
  settingsOpen: boolean;
  settings: string;
  /** Delivered separately so a status change does not rewrite the form. */
  settingsStatus: string;
}

/** One `<option>` per provider preset, in the engine's order. */
function providerOptions(state: SettingsState): string {
  return state.providers
    .map(
      (choice) =>
        `<option value="${escapeHtml(choice.value)}"${choice.value === state.preset ? ' selected' : ''}>${escapeHtml(choice.tag ? `${choice.label} · ${choice.tag}` : choice.label)}</option>`,
    )
    .join('');
}

/** The selected preset, if it is known. */
function selectedChoice(state: SettingsState): SettingsProviderChoice | undefined {
  return state.providers.find((choice) => choice.value === state.preset);
}

/**
 * One `<option>` per model, labelled with its cost tier.
 *
 * The tier stays visible in the label rather than being filtered away, so the
 * free-first rule and the paid/unknown opt-in stay observable in the UI.
 */
function modelOptions(state: SettingsState): string {
  return state.models
    .map(
      (model) =>
        `<option value="${escapeHtml(model.id)}"${model.id === state.defaultModel ? ' selected' : ''}>${escapeHtml(`${model.id} — ${model.accessTier}`)}</option>`,
    )
    .join('');
}

/**
 * The connection form.
 *
 * The preset supplies the endpoint, the connection kind, and (for OrcaRouter) a
 * default model, so a known provider needs only a key. The base URL, name, and
 * model fields appear only for the generic "other endpoint" entry, which is what
 * the CLI does: asking for a base URL the preset already knows would invite a
 * user to break a working provider.
 */
export function settingsPaneHtml(state: SettingsState): string {
  // A corrupt profile must stop the user here. Rendering an empty form would
  // invite saving defaults over data that was never successfully read.
  const blocked = Boolean(state.profileError);
  const disabled = blocked ? ' disabled' : '';

  const choice = selectedChoice(state);
  const generic = choice?.custom === true;
  const needsKey = choice?.requiresApiKey ?? true;

  const problem = blocked
    ? `<p class="problem" role="alert">${escapeHtml(state.profileError as string)} Fix or move that file before changing settings; Desktop did not read it and will not overwrite it.</p>`
    : '';

  const saved = state.connections.length
    ? `<p class="note">Active connection: <strong>${escapeHtml(state.activeConnectionId || 'none')}</strong></p>`
    : '<p class="note">No provider connected yet.</p>';

  // The key is write-only: an empty field keeps whatever is stored, so the saved
  // key is never rendered back into the pane.
  const keyField = !needsKey
    ? '<p class="note">This local runtime needs no API key.</p>'
    : `<label for="settings-api-key">API key</label>
    <input id="settings-api-key" type="password" autocomplete="off" spellcheck="false"
           placeholder="${state.apiKeyStored ? 'Stored — leave empty to keep' : 'Paste the key'}"${disabled} />
    ${state.apiKeyStored ? '<p class="note">A key is already stored in Windows Credential Manager. Leave the field empty to keep it.</p>' : ''}`;

  // Only the generic endpoint has no preset-supplied values to fall back on.
  const extra = generic
    ? `<label for="settings-display-name">Provider name</label>
    <input id="settings-display-name" type="text" spellcheck="false"
           placeholder="OpenRouter" value="${escapeHtml(state.displayName)}"${disabled} />
    <label for="settings-base-url">Base URL</label>
    <input id="settings-base-url" type="text" spellcheck="false"
           placeholder="https://api.example.com/v1" value="${escapeHtml(state.baseUrl)}"${disabled} />
    <p class="note">HTTPS only. HTTP is accepted for localhost endpoints.</p>`
    : '';

  const modelField = `<label for="settings-model">Default model</label>
    <select id="settings-model"${disabled}>${modelOptions(state)}</select>
    ${state.models.length ? '' : '<p class="note">No models discovered yet. Save the connection first, then reload models.</p>'}
    <p class="note">Free models are preferred. Paid and unknown-cost models stay listed but are only used when allowed.</p>`;

  const presetNote = choice ? `<p class="note">${escapeHtml(choice.description)}</p>` : '';

  return `<section id="settings-pane" class="settings" aria-label="Moderado settings">
    <header>
      <h2>Connect a provider</h2>
      <button id="close-settings" type="button" aria-label="Close settings">Close</button>
    </header>
    ${problem}
    ${saved}
    <label for="settings-provider">Provider</label>
    <select id="settings-provider"${disabled}>${providerOptions(state)}</select>
    ${presetNote}
    ${extra}
    ${keyField}
    ${modelField}
    <div class="row">
      <button id="settings-save" type="button"${disabled}>Save and connect</button>
      <button id="settings-refresh" type="button"${disabled}>Reload models</button>
    </div>
    <p id="settings-status" class="status" role="status">${escapeHtml(state.status ?? '')}</p>
  </section>`;
}

export function settingsSnapshot(state: SettingsState): SettingsSnapshot {
  return {
    settingsOpen: state.open,
    settings: state.open ? settingsPaneHtml(state) : '',
    settingsStatus: state.status ?? '',
  };
}

export interface SettingsFormValues {
  /** The picker value: a preset id, `openai-compatible`, or `custom:<id>`. */
  preset: string;
  displayName: string;
  baseUrl: string;
  /** Undefined means "leave the stored key alone", never "clear it". */
  apiKey?: string;
  modelId?: string;
}

export type ParsedSettings =
  | { ok: true; value: SettingsFormValues }
  | { ok: false; error: string };

/**
 * Validates a submitted form at the boundary.
 *
 * This deliberately checks only shape. The connection's endpoint, kind, id, and
 * default model come from the preset and are resolved by `buildProviderConnection`
 * (provider-setup.ts), which is where the CLI's rules live, so there is one
 * implementation of them rather than two that can disagree.
 */
export function parseSettingsForm(message: unknown): ParsedSettings {
  if (!message || typeof message !== 'object') return { ok: false, error: 'Malformed settings message.' };
  const raw = message as Record<string, unknown>;

  const preset = typeof raw.preset === 'string' ? raw.preset.trim() : '';
  if (!preset) return { ok: false, error: 'Choose a provider.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(preset)) {
    return { ok: false, error: 'That provider value is not recognised.' };
  }

  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  if (raw.displayName !== undefined && raw.displayName !== null && typeof raw.displayName !== 'string') {
    return { ok: false, error: 'Malformed provider name.' };
  }
  // The name becomes the connection id via a slug, and that slug is the
  // Credential Manager target name, so it must stay in the CLI's safe charset.
  if (displayName && !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(displayName)) {
    return { ok: false, error: 'That provider name contains characters that cannot be stored safely.' };
  }

  let baseUrl = '';
  if (typeof raw.baseUrl === 'string') {
    baseUrl = raw.baseUrl.trim();
  } else if (raw.baseUrl !== undefined && raw.baseUrl !== null) {
    return { ok: false, error: 'Malformed base URL.' };
  }

  let apiKey: string | undefined;
  if (typeof raw.apiKey === 'string') {
    const trimmed = raw.apiKey.trim();
    // Whitespace is not a request to erase the stored key.
    if (trimmed) apiKey = trimmed;
  } else if (raw.apiKey !== undefined && raw.apiKey !== null) {
    return { ok: false, error: 'Malformed API key.' };
  }

  let modelId: string | undefined;
  if (typeof raw.modelId === 'string') {
    const trimmed = raw.modelId.trim();
    if (trimmed) modelId = trimmed;
  } else if (raw.modelId !== undefined && raw.modelId !== null) {
    return { ok: false, error: 'Malformed model id.' };
  }

  return { ok: true, value: { preset, displayName, baseUrl, apiKey, modelId } };
}