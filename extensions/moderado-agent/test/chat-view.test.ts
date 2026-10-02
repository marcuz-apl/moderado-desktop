import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@moderado/contracts';
import { chatHtml, escapeHtml, viewSnapshot, ChatViewState } from '../src/chat-view.js';
import {
  settingsPaneHtml,
  settingsSnapshot,
  parseSettingsForm,
  SettingsState,
  emptySettings,
} from '../src/settings-view.js';

const preview = () => 'preview';

function state(over: Partial<ChatViewState> = {}): ChatViewState {
  return { transcript: [], running: false, pendingApproval: null, ...over };
}

describe('chat view', () => {
  it('renders a composer input so there is somewhere to type', () => {
    const html = chatHtml(state(), preview);
    expect(html).toContain('id="prompt"');
    expect(html).toContain('id="composer"');
    expect(html).toContain('id="send"');
  });

  it('keeps the input out of the document only once', () => {
    // The regression: the panel used to be re-rendered per streamed token by
    // reassigning webview.html, which rebuilt the document, discarded the
    // composer's contents, and stole focus. Updates must be a separate message.
    const html = chatHtml(state(), preview);
    const occurrences = html.split('id="prompt"').length - 1;
    expect(occurrences).toBe(1);
  });

  it('applies later state as an in-place update, not a new document', () => {
    const html = chatHtml(state(), preview);
    // The update path must mutate the existing DOM nodes only.
    expect(html).toContain("update.type !== 'update'");
    expect(html).toContain('transcript.innerHTML = update.rows');
    expect(html).toContain('input.disabled = update.running');
  });

  it('authorises scripts with a per-render nonce', () => {
    const html = chatHtml(state(), preview);
    const csp = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(html);
    expect(csp).not.toBeNull();
    expect(csp?.[1]?.length).toBeGreaterThanOrEqual(16);
    // The script tag must carry the same nonce the policy advertises.
    expect(html).toContain(`<script nonce="${csp?.[1]}">`);
    // 'unsafe-inline' would let any injected inline script run.
    expect(html).not.toContain("script-src 'unsafe-inline'");
  });

  it('escapes untrusted transcript text', () => {
    const html = chatHtml(
      state({ transcript: [{ kind: 'assistant', label: 'x', text: '<img src=x onerror=alert(1)>' }] }),
      preview,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('produces a snapshot whose approval block is empty when nothing is pending', () => {
    const snap = viewSnapshot(state(), preview);
    expect(snap.approval).toBe('');
    expect(snap.pendingId).toBeNull();
    expect(snap.running).toBe(false);
  });

  it('carries the pending request id so only that request can be answered', () => {
    const pending = { requestId: 'req-1', actionSummary: 'write a file' } as unknown as ApprovalRequest;
    const snap = viewSnapshot(state({ pendingApproval: pending }), preview);
    expect(snap.pendingId).toBe('req-1');
    expect(snap.approval).toContain('Allow');
    expect(snap.approval).toContain('Deny');
    // The sidebar is too narrow for a full diff, so it must offer to open one.
    expect(snap.approval).toContain('id="full-diff"');
  });

  it('offers the full-change action only for a pending approval', () => {
    const html = chatHtml(state(), preview);
    expect(html).not.toContain('id="full-diff"');
    expect(html).toContain('id="prompt"');
  });

  it('keeps the composer pinned below a scrollable transcript', () => {
    const html = chatHtml(state(), preview);
    expect(html).toContain('id="scroll"');
    expect(html.indexOf('id="scroll"')).toBeLessThan(html.indexOf('id="composer"'));
  });

  it('escapes approval previews, which contain file paths and diffs', () => {
describe('moderado settings pane', () => {
  function settings(over: Partial<SettingsState> = {}): SettingsState {
    return { ...emptySettings(), ...over };
  }

  it('offers a gear control that opens the pane', () => {
    // The entry point is the gear in the chat header; without it the pane is
    // unreachable from the panel.
    const html = chatHtml(state(), preview);
    expect(html).toContain('id="open-settings"');
    expect(html).toContain("postMessage({ type: 'openSettings' })");
  });

  it('keeps the pane out of the document until it is opened', () => {
    const html = chatHtml(state(), preview);
    expect(html).not.toContain('id="settings-pane"');
  });

  it('renders provider, API key, and model controls when opened', () => {
    const pane = settingsPaneHtml(settings());
    expect(pane).toContain('id="settings-provider"');
    expect(pane).toContain('id="settings-base-url"');
    expect(pane).toContain('id="settings-api-key"');
    expect(pane).toContain('id="settings-model"');
  });

  it('masks the API key field', () => {
    // A visible key field would put a provider secret on screen and in shoulder
    // surfing. The value is write-only: it is sent out and never sent back.
    const pane = settingsPaneHtml(settings());
    expect(pane).toMatch(/id="settings-api-key"[^>]*type="password"/);
  });

  it('never echoes a stored API key back into the pane', () => {
    const pane = settingsPaneHtml(settings({ apiKeyStored: true, apiKey: 'sk-live-secret' }));
    expect(pane).not.toContain('sk-live-secret');
    expect(pane).toContain('A key is already stored');
  });

  it('marks the active provider and model as selected', () => {
    const pane = settingsPaneHtml(
      settings({
        connections: [
          { id: 'nvidia', displayName: 'NVIDIA NIM' },
          { id: 'local', displayName: 'Ollama' },
        ],
        activeConnectionId: 'local',
        models: [
          { id: 'model-a', accessTier: 'free', isFree: true },
          { id: 'model-b', accessTier: 'paid', isFree: false },
        ],
        defaultModel: 'model-b',
      }),
    );
    expect(pane).toContain('<option value="local" selected');
    expect(pane).toContain('<option value="model-b" selected');
  });

  it('labels paid and unknown models instead of hiding the cost', () => {
    const pane = settingsPaneHtml(
      settings({
        models: [
          { id: 'model-a', accessTier: 'free', isFree: true },
          { id: 'model-b', accessTier: 'paid', isFree: false },
          { id: 'model-c', accessTier: 'unknown', isFree: false },
        ],
      }),
    );
    expect(pane).toContain('model-b — paid');
    expect(pane).toContain('model-c — unknown');
    expect(pane).toContain('model-a — free');
  });

  it('escapes untrusted provider names, base URLs, and model ids', () => {
    const pane = settingsPaneHtml(
      settings({
        connections: [{ id: 'x', displayName: '<img src=x onerror=alert(1)>' }],
        baseUrl: '"><script>bad</script>',
        models: [{ id: '<script>bad</script>', accessTier: 'free', isFree: true }],
      }),
    );
    expect(pane).not.toContain('<img src=x');
    expect(pane).not.toContain('<script>bad</script>');
    expect(pane).toContain('&lt;script&gt;');
  });

  it('reports a corrupt profile instead of showing empty defaults', () => {
    // Silently rendering an empty form would invite overwriting a corrupt
    // config.json with fresh defaults.
    const pane = settingsPaneHtml(settings({ profileError: 'config.json is not valid JSON' }));
    expect(pane).toContain('config.json is not valid JSON');
    expect(pane).toContain('disabled');
  });

  it('parses a submitted form into a validated patch', () => {
    const parsed = parseSettingsForm({
      connectionId: 'nvidia',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'sk-test',
      modelId: 'model-a',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.connectionId).toBe('nvidia');
    expect(parsed.value?.modelId).toBe('model-a');
  });

  it('rejects a non-https base URL rather than storing it', () => {
    // A base URL is where the key gets sent, so a plaintext or script-shaped
    // value must not reach the profile.
    const parsed = parseSettingsForm({ connectionId: 'x', baseUrl: 'javascript:alert(1)' });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeTruthy();
  });

  it('rejects a connection id that cannot become a credential target', () => {
    const parsed = parseSettingsForm({ connectionId: '///', baseUrl: '' });
    expect(parsed.ok).toBe(false);
  });

  it('treats an empty API key as "leave the stored key alone"', () => {
    // The pane never receives the existing key, so an empty field must not be
    // read as a request to erase it.
    const parsed = parseSettingsForm({ connectionId: 'x', baseUrl: '', apiKey: '   ' });
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.apiKey).toBeUndefined();
  });

  it('rejects a malformed message instead of guessing', () => {
    expect(parseSettingsForm(undefined).ok).toBe(false);
    expect(parseSettingsForm({ connectionId: 42 }).ok).toBe(false);
  });

  it('carries a snapshot that updates the open pane in place', () => {
    const snap = settingsSnapshot(settings({ open: true }));
    expect(snap.settingsOpen).toBe(true);
    expect(snap.settings).toContain('id="settings-provider"');
    expect(settingsSnapshot(emptySettings()).settings).toBe('');
  });
});
    const pending = { requestId: 'r', actionSummary: '<b>x</b>' } as unknown as ApprovalRequest;
    const snap = viewSnapshot(state({ pendingApproval: pending }), () => '<script>bad</script>');
    expect(snap.approval).not.toContain('<script>');
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });
});