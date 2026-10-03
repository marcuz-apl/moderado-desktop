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
    const pending = { requestId: 'r', actionSummary: '<b>x</b>' } as unknown as ApprovalRequest;
    const snap = viewSnapshot(state({ pendingApproval: pending }), () => '<script>bad</script>');
    expect(snap.approval).not.toContain('<script>');
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });
});

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

  it('puts the gear in a right-aligned bar at the top', () => {
    // The bug: the gear used float:right, which a flex container ignores, so it
    // rendered at the top-LEFT. It must live in a bar that justifies to the end,
    // above the transcript.
    const html = chatHtml(state(), preview);
    expect(html).toMatch(/#panel-bar\s*\{[^}]*justify-content:\s*flex-end/);
    expect(html.indexOf('id="panel-bar"')).toBeLessThan(html.indexOf('id="scroll"'));
    expect(html).not.toMatch(/#open-settings\s*\{[^}]*float:/);
    expect(html.indexOf('id="open-settings"')).toBeLessThan(html.indexOf('id="scroll"'));
  });

  it('shows the brand welcome state only while the transcript is empty', () => {
    const fresh = chatHtml(state(), preview);
    expect(fresh).toContain('class="empty-state"');
    expect(fresh).toContain('What can I do for you?');
    const started = chatHtml(
      state({ transcript: [{ kind: 'user', label: 'You', text: 'hi' }] }),
      preview,
    );
    expect(started).not.toContain('class="empty-state"');
  });

  it('renders a RECENT list with cost badges when sessions exist', () => {
    const html = chatHtml(state({
      recents: [
        { id: 's1', title: 'Fix the login bug', updatedAt: 'Sep 25', costLabel: '$0.00' },
        { id: 's2', title: 'Second task', updatedAt: 'Sep 20', costLabel: null },
      ],
    }), preview);
    expect(html).toContain('RECENT');
    expect(html).toContain('View All');
    expect(html).toContain('Fix the login bug');
    expect(html).toContain('class="recent-cost">$0.00</span>');
    // No cost badge when the engine reported none: two sessions, one badge.
    expect(html.split('class="recent-cost"').length - 1).toBe(1);
  });

  it('escapes untrusted recent-session titles', () => {
    const html = chatHtml(state({
      recents: [{ id: 's1', title: '<img src=x onerror=alert(1)>', updatedAt: 'Sep 25', costLabel: null }],
    }), preview);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('renders the auto-approve bar collapsed and denies everything by default', () => {
    const html = chatHtml(state(), preview);
    expect(html).toContain('Auto-approve: nothing');
    expect(html).toContain('id="auto-approve"');
    // No category may be pre-enabled.
    expect(html).not.toContain(' checked>');
    expect(html).not.toContain(' checked ');
    expect(html).toContain('id="aa-toggle"');
  });

  it('expands into a two-column grid when opened', () => {
    const html = chatHtml(state({
      autoApprove: {
        expanded: true, readFiles: true, editFiles: false,
        executeCommands: false, fetchWeb: false, useMcp: false,
      },
    }), preview);
    expect(html).toContain('aa-grid');
    expect(html).toContain('Read files');
    expect(html).toContain('Edit files');
    expect(html).toContain('Execute commands');
    expect(html).toContain('Fetch web content');
    expect(html).toContain('Use MCP servers');
    expect(html).toContain('data-key="readFiles" checked');
    // The fail-closed policy is stated rather than implied.
    expect(html).toContain('still denies');
  });

  it('reports an auto-approve change to the host rather than deciding locally', () => {
    // The renderer must never conclude on its own that an action is approved.
    const html = chatHtml(state(), preview);
    expect(html).toContain("postMessage({ type: 'setAutoApprove'");
    expect(html).toContain("postMessage({ type: 'toggleAutoApprovePanel' })");
  });

  it('offers a Plan/Act toggle in the footer', () => {
    const html = chatHtml(state(), preview);
    expect(html).toContain('id="mode-plan"');
    expect(html).toContain('id="mode-act"');
    expect(html).toContain("postMessage({ type: 'setMode'");
  });

  it('uses a multi-line composer that sends on Enter', () => {
    const html = chatHtml(state(), preview);
    expect(html).toContain('<textarea id="prompt"');
    expect(html).toContain('Type your task here...');
    expect(html).toContain("event.key === 'Enter' && !event.shiftKey");
  });

  it('keeps the pane out of the document until it is opened', () => {
    const html = chatHtml(state(), preview);
    expect(html).not.toContain('id="settings-pane"');
  });

  it('shows the active connection compactly, without the bulky path block', () => {
    // The previous layout rendered every connection as a card under a full
    // profile-path heading, which dominated the pane.
    const pane = settingsPaneHtml(settings({
      profilePath: 'C:\\Users\\marcu\\.moderado\\config.json',
      activeConnectionId: 'agnes-ai',
      savedConnections: [
        { id: 'agnes-ai', displayName: 'Agnes AI', kind: 'openai-compatible', baseUrl: 'https://a/v1', hasCredential: true },
      ],
    }));
    // One short line, and the path only as a tooltip.
    expect(pane).toContain('class="active-line"');
    expect(pane).toContain('Using <strong>Agnes AI</strong>');
    expect(pane).not.toContain('<h3>From');
    expect(pane).not.toContain('class="saved-list"');
    // The path is still discoverable without occupying layout space.
    expect(pane).toContain('title="Shared profile: C:\\Users\\marcu\\.moderado\\config.json"');
  });

  it('reflects the selected provider key state, not the previous one', () => {
    // Picking a provider must show whether *that* provider already has a key.
    const pane = settingsPaneHtml(settings({
      preset: 'openrouter',
      providers: [
        { value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'd', requiresApiKey: true, hasCredential: true },
        { value: 'openrouter', label: 'OpenRouter', description: 'd', requiresApiKey: true, hasCredential: false },
      ],
    }));
    expect(pane).not.toContain('already stored for this provider');
    expect(pane).toContain('placeholder="Paste the key"');
  });

  it('marks the key as stored for the provider that has one', () => {
    const pane = settingsPaneHtml(settings({
      preset: 'nvidia-nim',
      providers: [
        { value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'd', requiresApiKey: true, hasCredential: true },
        { value: 'openrouter', label: 'OpenRouter', description: 'd', requiresApiKey: true, hasCredential: false },
      ],
    }));
    expect(pane).toContain('already stored for this provider');
    expect(pane).toContain('Stored — leave empty to keep');
  });

  it('badges free models and summarises the counts', () => {
    const pane = settingsPaneHtml(settings({
      preset: 'nvidia-nim',
      providers: [{ value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'd', requiresApiKey: true }],
      models: [
        { id: 'free-a', accessTier: 'free_trial', isFree: true },
        { id: 'paid-b', accessTier: 'paid', isFree: false },
      ],
      defaultModel: 'free-a',
    }));
    // Free models are cards with a FREE badge, as in the reference layout.
    expect(pane).toContain('class="model-card on" data-model="free-a"');
    expect(pane).toContain('>FREE<');
    expect(pane).toContain('1 free');
    expect(pane).toContain('2 listed');
  });

  it('shows only free models on the Free tab', () => {
    const pane = settingsPaneHtml(settings({
      preset: 'nvidia-nim', modelTab: 'free',
      providers: [{ value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'd', requiresApiKey: true }],
      models: [
        { id: 'free-a', accessTier: 'free_trial', isFree: true },
        { id: 'paid-b', accessTier: 'paid', isFree: false },
      ],
    }));
    expect(pane).toContain('data-model="free-a"');
    expect(pane).not.toContain('data-model="paid-b"');
  });

  it('offers the Recommended and Free tabs', () => {
    const pane = settingsPaneHtml(settings({ modelTab: 'free' }));
    expect(pane).toContain('data-tab="all"');
    expect(pane).toContain('data-tab="free"');
  });

  it('explains an empty model list', () => {
    const pane = settingsPaneHtml(settings({
      preset: 'nvidia-nim',
      providers: [{ value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'd', requiresApiKey: true }],
    }));
    expect(pane).toContain('No models loaded yet.');
  });

  it('has a left settings nav with the reference sections', () => {
    const pane = settingsPaneHtml(settings({ page: 'api' }));
    for (const label of ['API Configuration', 'Features', 'Terminal', 'General', 'About']) {
      expect(pane).toContain(label);
    }
    expect(pane).toContain('class="set-nav"');
    expect(pane).toContain('data-page="api"');
    expect(pane).toContain('>Done</button>');
  });

  it('renders provider, key, and model controls when opened', () => {
    const pane = settingsPaneHtml(settings({ preset: 'nvidia-nim', providers: [
      { value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'Free-first routing.', requiresApiKey: true },
    ] }));
    expect(pane).toContain('id="settings-provider"');
    expect(pane).toContain('id="settings-api-key"');
    expect(pane).toContain('id="settings-model"');
  });

  it('hides the base URL field for a known provider', () => {
    // The preset already knows its endpoint. Asking for it would invite a user
    // to break a working provider by editing a value that is not theirs.
    const pane = settingsPaneHtml(settings({ preset: 'openrouter', providers: [
      { value: 'openrouter', label: 'OpenRouter', description: 'Free tier.', requiresApiKey: true },
    ] }));
    expect(pane).not.toContain('id="settings-base-url"');
    expect(pane).not.toContain('id="settings-display-name"');
  });

  it('shows the base URL and name fields for a custom endpoint', () => {
    const pane = settingsPaneHtml(settings({ preset: 'openai-compatible', providers: [
      { value: 'openai-compatible', label: 'Other', description: 'Any endpoint.', requiresApiKey: true, custom: true },
    ] }));
    expect(pane).toContain('id="settings-base-url"');
    expect(pane).toContain('id="settings-display-name"');
  });

  it('omits the key field for a local runtime', () => {
    // Ollama and LM Studio authenticate with no key; asking for one implies a
    // requirement that does not exist.
    const pane = settingsPaneHtml(settings({ preset: 'ollama', providers: [
      { value: 'ollama', label: 'Ollama', description: 'Local.', requiresApiKey: false },
    ] }));
    expect(pane).not.toContain('id="settings-api-key"');
    expect(pane).toContain('needs no API key');
  });

  it('tags providers the same way the CLI does', () => {
    const pane = settingsPaneHtml(settings({ preset: 'ollama', providers: [
      { value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'd', requiresApiKey: true, tag: 'Free Models' },
      { value: 'ollama', label: 'Ollama', description: 'd', requiresApiKey: false, tag: 'Local' },
    ] }));
    expect(pane).toContain('NVIDIA NIM · Free Models');
    expect(pane).toContain('Ollama · Local');
  });

  it('masks the API key field', () => {
    // A visible key field would put a provider secret on screen and in shoulder
    // surfing. The value is write-only: it is sent out and never sent back.
    const pane = settingsPaneHtml(settings({ preset: 'nvidia-nim', providers: [
      { value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'd', requiresApiKey: true },
    ] }));
    expect(pane).toMatch(/id="settings-api-key"[^>]*type="password"/);
  });

  it('never echoes a stored API key back into the pane', () => {
    // The credential state is a hint, never the value: the secret stays in
    // Credential Manager and is resolved host-side.
    const pane = settingsPaneHtml(settings({
      preset: 'nvidia-nim',
      providers: [{ value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'd', requiresApiKey: true, hasCredential: true }],
    }));
    expect(pane).not.toContain('sk-live-secret');
    expect(pane).toContain('already stored for this provider');
    expect(pane).toMatch(/id="settings-api-key"[^>]*type="password"/);
  });

  it('marks the selected provider and model', () => {
    const pane = settingsPaneHtml(
      settings({
        preset: 'ollama',
        providers: [
          { value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'd', requiresApiKey: true },
          { value: 'ollama', label: 'Ollama', description: 'd', requiresApiKey: false },
        ],
        models: [
          { id: 'model-a', accessTier: 'free_trial', isFree: true },
          { id: 'model-b', accessTier: 'paid', isFree: false },
        ],
        defaultModel: 'model-b',
      }),
    );
    expect(pane).toContain('<option value="ollama" selected');
    expect(pane).toContain('<option value="model-b" selected');
  });

  it('labels each model with its engine access tier instead of hiding cost', () => {
    // The real AccessTier values are free_trial | paid | local | unknown. The
    // tier stays in the label so the free-first rule remains observable.
    const pane = settingsPaneHtml(
      settings({
        preset: 'nvidia-nim',
        models: [
          { id: 'model-a', accessTier: 'free_trial', isFree: true },
          { id: 'model-b', accessTier: 'paid', isFree: false },
          { id: 'model-c', accessTier: 'unknown', isFree: false },
        ],
      }),
    );
    expect(pane).toContain('model-a — free_trial');
    expect(pane).toContain('model-b — paid');
    expect(pane).toContain('model-c — unknown');
  });

  it('escapes untrusted provider names, base URLs, and model ids', () => {
    const pane = settingsPaneHtml(
      settings({
        preset: 'openai-compatible',
        providers: [{ value: 'custom:x', label: '<img src=x onerror=alert(1)>', description: 'd', requiresApiKey: true, custom: true }],
        baseUrl: '"><script>bad</script>',
        models: [{ id: '<script>bad</script>', accessTier: 'free_trial', isFree: true }],
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

  it('parses a submitted form into validated values', () => {
    const parsed = parseSettingsForm({
      preset: 'nvidia-nim',
      apiKey: 'sk-test',
      modelId: 'model-a',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.preset).toBe('nvidia-nim');
    expect(parsed.value?.modelId).toBe('model-a');
  });

  it('rejects a missing or malformed provider value', () => {
    expect(parseSettingsForm({ apiKey: 'k' }).ok).toBe(false);
    expect(parseSettingsForm({ preset: 'x y z' }).ok).toBe(false);
  });

  it('rejects a provider name that cannot become a credential target', () => {
    // The name is slugified into the connection id, which becomes the
    // Credential Manager target name.
    expect(parseSettingsForm({ preset: 'openai-compatible', displayName: '///' }).ok).toBe(false);
  });

  it('treats an empty API key as "leave the stored key alone"', () => {
    // The pane never receives the existing key, so an empty field must not be
    // read as a request to erase it.
    const parsed = parseSettingsForm({ preset: 'openrouter', apiKey: '   ' });
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.apiKey).toBeUndefined();
  });

  it('rejects a malformed message instead of guessing', () => {
    expect(parseSettingsForm(undefined).ok).toBe(false);
    expect(parseSettingsForm({ preset: 42 }).ok).toBe(false);
  });

  it('carries a snapshot that updates the open pane in place', () => {
    const snap = settingsSnapshot(settings({ open: true, preset: 'nvidia-nim', providers: [
      { value: 'nvidia-nim', label: 'NVIDIA NIM', description: 'd', requiresApiKey: true },
    ] }));
    expect(snap.settingsOpen).toBe(true);
    expect(snap.settings).toContain('id="settings-provider"');
    expect(settingsSnapshot(emptySettings()).settings).toBe('');
  });
});