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
  accessTier: string;
  isFree: boolean;
}

export interface SettingsState {
  open: boolean;
  connections: SettingsConnection[];
  activeConnectionId: string;
  baseUrl: string;
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
    connections: [],
    activeConnectionId: '',
    baseUrl: '',
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

/** One `<option>` per provider, with the active one preselected. */
function providerOptions(state: SettingsState): string {
  return state.connections
    .map(
      (connection) =>
        `<option value="${escapeHtml(connection.id)}"${connection.id === state.activeConnectionId ? ' selected' : ''}>${escapeHtml(connection.displayName)}</option>`,
    )
    .join('');
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

export function settingsPaneHtml(state: SettingsState): string {
  // A corrupt profile must stop the user here. Rendering an empty form would
  // invite saving defaults over data that was never successfully read.
  const blocked = Boolean(state.profileError);
  const disabled = blocked ? ' disabled' : '';

  const problem = blocked
    ? `<p class="problem" role="alert">${escapeHtml(state.profileError as string)} Fix or move that file before changing settings; Desktop did not read it and will not overwrite it.</p>`
    : '';

  const storedNote = state.apiKeyStored
    ? '<p class="note">A key is already stored in Windows Credential Manager. Leave the field empty to keep it.</p>'
    : '';

  const noProviders = state.connections.length
    ? ''
    : '<p class="note">No provider connections yet. Add one below to get started.</p>';

  return `<section id="settings-pane" class="settings" aria-label="Moderado settings">
    <header>
      <h2>Moderado settings</h2>
      <button id="close-settings" type="button" aria-label="Close settings">Close</button>
    </header>
    ${problem}
    <label for="settings-provider">Provider</label>
    <select id="settings-provider"${disabled}>${providerOptions(state)}</select>
    ${noProviders}
    <label for="settings-connection-id">Connection id</label>
    <input id="settings-connection-id" type="text" spellcheck="false"
           placeholder="${escapeHtml(state.activeConnectionId || 'openai-compatible')}"${disabled} />
    <p class="note">Leave empty to keep the selected provider. This id becomes the Credential Manager target name.</p>
    <label for="settings-base-url">Base URL</label>
    <input id="settings-base-url" type="text" spellcheck="false"
           placeholder="https://integrate.api.nvidia.com/v1"
           value="${escapeHtml(state.baseUrl)}"${disabled} />
    <label for="settings-api-key">API key</label>
    <input id="settings-api-key" type="password" autocomplete="off" spellcheck="false"
           placeholder="${state.apiKeyStored ? 'Stored — leave empty to keep' : 'Paste the key'}"${disabled} />
    ${storedNote}
    <label for="settings-model">Model</label>
    <select id="settings-model"${disabled}>${modelOptions(state)}</select>
    <p class="note">Free models are preferred. Paid and unknown-cost models stay visible but are only used when allowed.</p>
    <div class="row">
      <button id="settings-save" type="button"${disabled}>Save</button>
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
  connectionId: string;
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
 * The base URL is the address the provider key gets sent to, so only http/https
 * is accepted; a `javascript:` or otherwise shaped value must never reach the
 * profile. The connection id is rejected when it could not become a credential
 * target, because that normalization happens later and would fail only after the
 * profile was already written.
 */
export function parseSettingsForm(message: unknown): ParsedSettings {
  if (!message || typeof message !== 'object') return { ok: false, error: 'Malformed settings message.' };
  const raw = message as Record<string, unknown>;

  const connectionId = typeof raw.connectionId === 'string' ? raw.connectionId.trim() : '';
  if (!connectionId) return { ok: false, error: 'Choose or name a provider connection.' };
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(connectionId)) {
    return { ok: false, error: 'That connection id contains characters that cannot be stored safely.' };
  }

  let baseUrl = '';
  if (typeof raw.baseUrl === 'string') {
    baseUrl = raw.baseUrl.trim();
    if (baseUrl) {
      let parsed: URL;
      try {
        parsed = new URL(baseUrl);
      } catch {
        return { ok: false, error: 'That base URL is not a valid URL.' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'The base URL must use http or https.' };
      }
    }
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

  return { ok: true, value: { connectionId, baseUrl, apiKey, modelId } };
}