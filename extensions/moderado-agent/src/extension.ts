import * as vscode from 'vscode';
import { AgentEvent, ApprovalRequest } from '@moderado/contracts';
import { AgentHost, RunOutcome } from './host.js';
import { RawDecision } from './approval.js';
import { configPath, readConfig } from './profile.js';
import { updateConfigCoordinated } from './coordination.js';
import {
  WindowsCredentialStore,
  credentialManagerAvailable,
  credentialReference,
} from './credentials.js';
import { ChatViewState, TranscriptEntry, chatHtml, viewSnapshot } from './chat-view.js';
import {
  SettingsState,
  emptySettings,
  parseSettingsForm,
} from './settings-view.js';
import {
  ProviderConnectionRecord,
  buildProviderChoices,
  buildProviderConnection,
} from './provider-setup.js';
import type { ConnectProviderPresetId, ConnectProvidersConfig } from '@moderado/providers';

export interface ModeradoApi {
  /** Starts one bounded agent turn. Any mutation still requires human approval. */
  startRun(task: string, options?: { planMode?: boolean }): Promise<RunOutcome>;
  listSessions(): ReturnType<AgentHost['listSessions']>;
  cancel(reason?: string): void;
}

/**
 * The webview view id. Must match `contributes.views.moderado[].id` in
 * package.json; VS Code resolves `<id>.focus` against it.
 */
const chatViewProviderId = 'moderado.chatView';

/**
 * Extension entry point.
 *
 * The renderer boundary is deliberately thin: the webview may post a prompt or
 * an approval answer and nothing else. It never receives provider credentials
 * and cannot grant its own tool permissions.
 */
export function activate(context: vscode.ExtensionContext): ModeradoApi {
  const output = vscode.window.createOutputChannel('Moderado');
  context.subscriptions.push(output);

  const config = () => vscode.workspace.getConfiguration('moderado');
  const pendingApprovals = new Map<string, (raw: RawDecision | undefined) => void>();
  /**
   * The request behind each id, kept so a sidebar "show full diff" action can
   * open the complete proposed change. Deny-by-default: this only ever feeds a
   * read-only preview and can never authorize anything on its own.
   */
  const pendingApprovalRequests = new Map<string, ApprovalRequest>();
  const settings: SettingsState = emptySettings();
  const view: ChatViewState & { planMode: boolean } = {
    transcript: [],
    running: false,
    pendingApproval: null,
    planMode: false,
    settings,
  };
  let chatView: vscode.WebviewView | undefined;
  // True once the webview document has been written; see render().
  let documentRendered = false;

  // Prefer the real editor workspace root so a session directory matches what the
  // CLI would derive for the same folder.
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const host = new AgentHost({
    workspaceRoot,
    nonInteractive: false,
    // On Windows the key comes from Credential Manager; elsewhere the in-memory
    // default keeps Desktop usable without a keychain.
    credentialStore: credentialManagerAvailable()
      ? new WindowsCredentialStore()
      : undefined,
    approvalTimeoutMs: config().get<number>('approvalTimeoutSeconds', 120) * 1000,
    allowPaid: config().get<boolean>('allowPaidModels', false),
    allowUnknown: config().get<boolean>('allowUnknownModels', false),
    onEvent: (event: AgentEvent) => {
      output.appendLine(`[${event.type}] ${JSON.stringify(event, redactKey)}`);
      if (event.type === 'approval_request') {
        view.pendingApproval = event.request;
        render();
      }
      if (event.type === 'error') append({ kind: 'error', label: 'Error', text: event.message });
      if (event.type === 'assistant_delta') appendDelta(event.delta);
    },
    promptForApproval: (request, signal) => askHuman(request, signal),
  });

  context.subscriptions.push({ dispose: () => host.dispose() });

  /** Coalesces streamed assistant text into a single transcript entry. */
  let streaming: { text: string } | null = null;
  function appendDelta(delta: string): void {
    if (!streaming) {
      streaming = { text: '' };
      view.transcript.push({ kind: 'assistant', label: 'Moderado', text: '' });
      if (view.transcript.length > 200) view.transcript.shift();
    }
    streaming.text += delta;
    const entry = view.transcript[view.transcript.length - 1];
    entry.text = streaming.text;
    render();
  }
  function endStreaming(): void {
    streaming = null;
  }

  /**
   * Asks through a modal dialog when no chat view is open, and through the
   * webview's own allow/deny buttons when one is. Both are keyboard reachable;
   * dismissal or a closed view denies.
   */
  async function askHuman(request: ApprovalRequest, signal: AbortSignal): Promise<RawDecision | undefined> {
    if (chatView) {
      view.pendingApproval = request;
      pendingApprovalRequests.set(request.requestId, request);
      render();
      const answer = await new Promise<RawDecision | undefined>((resolve) => {
        pendingApprovals.set(request.requestId, (raw) => {
          pendingApprovals.delete(request.requestId);
          pendingApprovalRequests.delete(request.requestId);
          view.pendingApproval = null;
          endStreaming();
          render();
          resolve(raw);
        });
        signal.addEventListener('abort', () => {
          if (!pendingApprovals.delete(request.requestId)) return;
          view.pendingApproval = null;
          resolve(undefined);
        }, { once: true });
      });
      return answer;
    }

    const label = `Allow ${request.toolName}: ${request.actionSummary}`;
    const detailParts = [
      request.exactPayload.targetFile ? `Target: ${request.exactPayload.targetFile}` : undefined,
      request.exactPayload.command?.length ? `Command: ${request.exactPayload.command.join(' ')}` : undefined,
      request.exactPayload.cwd ? `Working directory: ${request.exactPayload.cwd}` : undefined,
    ].filter(Boolean) as string[];

    const choice = await Promise.race([
      vscode.window.showInformationMessage(label, { modal: true, detail: detailParts.join('\n') }, 'Allow', 'Deny'),
      new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true })),
    ]);

    // The view was closed or dismissed without choosing.
    if (choice !== 'Allow') return { requestId: request.requestId, status: 'denied', reason: 'Deny' };
    return { requestId: request.requestId, status: 'approved' };
  }

  /**
 * Opens the full proposed change as a read-only editor tab.
 *
 * The sidebar is too narrow for a diff, but the human must still be able to read
 * the whole thing before deciding. The tab is read-only: the approval decision is
 * made in the sidebar, never in the preview.
 */
async function openDiffTab(requestId: string): Promise<void> {
  const request = pendingApprovalRequests.get(requestId);
  if (!request) return;
  const body = request.exactPayload.diffPreview || request.exactPayload.contentPreview;
  if (!body) return;
  const document = await vscode.workspace.openTextDocument({
    language: 'diff',
    content: body,
  });
  await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.One,
  });
}

/** A connection as it appears in the profile, with only display-safe fields. */
  function connectionsFromConfig(config: Record<string, unknown>): {
    id: string;
    displayName: string;
  }[] {
    const connections = (config.connections ?? {}) as Record<string, Record<string, unknown>>;
    return Object.entries(connections)
      .filter(([id, value]) => id.trim() && value && typeof value === 'object')
      .map(([id, value]) => ({
        id,
        displayName: typeof value.displayName === 'string' && value.displayName.trim()
          ? value.displayName.trim()
          : id,
      }));
  }

  /**
   * Rebuilds the pane from the shared profile.
   *
   * A corrupt profile blocks the pane instead of rendering empty defaults: the
   * CLI loader would return an empty config here, and saving over that would
   * destroy data that was never successfully read.
   */
  async function loadSettingsState(status?: string): Promise<void> {
    const state = readConfig();
    settings.open = true;
    settings.profileError = undefined;
    settings.models = [];
    if (status) settings.status = status;

    // The picker is built from the engine's own preset metadata, so Desktop
    // offers the same providers the CLI does and cannot drift from the pin.
    const connectConfig = readConnectProviders(state);
    settings.providers = buildProviderChoices(connectConfig).map((choice) => ({
      value: choice.value,
      label: choice.label,
      description: choice.description,
      tag: choice.tag,
      baseUrl: choice.baseUrl,
      defaultModel: choice.defaultModel,
      requiresApiKey: choice.requiresApiKey,
      custom: choice.value === 'openai-compatible' || choice.value.startsWith('custom:'),
    }));

    if (state.kind === 'invalid') {
      settings.connections = [];
      settings.activeConnectionId = '';
      settings.baseUrl = '';
      settings.displayName = '';
      settings.apiKeyStored = false;
      settings.defaultModel = '';
      settings.preset = settings.providers[0]?.value ?? '';
      settings.profileError = state.error;
      render();
      return;
    }

    const config = state.kind === 'ok' ? state.config : {};
    settings.connections = connectionsFromConfig(config);
    settings.activeConnectionId =
      typeof config.activeConnectionId === 'string' ? config.activeConnectionId : '';
    settings.defaultModel = typeof config.defaultModel === 'string' ? config.defaultModel : '';

    // Preselect the provider that is already connected, so reopening the pane
    // shows the current state rather than resetting the user to the first entry.
    settings.preset = settings.activeConnectionId ||
      settings.providers[0]?.value ||
      '';

    const record = (config.connections ?? {}) as Record<string, Record<string, unknown>>;
    const activeRecord = record[settings.activeConnectionId];
    settings.displayName =
      typeof activeRecord?.displayName === 'string' ? activeRecord.displayName : '';
    settings.baseUrl = typeof activeRecord?.baseUrl === 'string' ? activeRecord.baseUrl : '';

    // Only the *presence* of a credential reaches the renderer. The key itself
    // must never be read back, so it is never loaded here.
    settings.apiKeyStored = Boolean(
      activeRecord?.credentialReference || activeRecord?.apiKey,
    );

    // Model discovery needs a working provider; without one it fails, and that
    // failure is shown rather than leaving an empty, unexplained list.
    try {
      const models = await host.discoverModels();
      settings.models = models.map((m) => ({
        id: m.id,
        accessTier: m.accessTier,
        isFree: m.isFree,
      }));
      settings.status = status ?? `${models.length} model(s) available.`;
    } catch (error) {
      settings.status = `Could not list models: ${(error as Error).message}`;
    }
    render();
  }

  /** Reads `connectProviders` defensively; the CLI ignores anything malformed. */
  function readConnectProviders(state: ReturnType<typeof readConfig>): ConnectProvidersConfig | undefined {
    if (state.kind !== 'ok') return undefined;
    const raw = state.config.connectProviders;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    const custom = Array.isArray(record.custom)
      ? record.custom.filter(
        (item): item is { id: string; name: string; baseUrl: string; defaultModel?: string } =>
          !!item && typeof item === 'object' &&
          typeof (item as Record<string, unknown>).id === 'string' &&
          typeof (item as Record<string, unknown>).name === 'string' &&
          typeof (item as Record<string, unknown>).baseUrl === 'string',
      )
      : undefined;
    const enabled = Array.isArray(record.enabled)
      ? (record.enabled.filter((id) => typeof id === 'string') as ConnectProviderPresetId[])
      : undefined;
    return { ...(enabled ? { enabled } : {}), ...(custom ? { custom } : {}) };
  }

  async function openSettingsPane(): Promise<void> {
    await loadSettingsState();
  }

  /**
 * Applies a submitted settings form.
 *
 * The connection is built by `buildProviderConnection`, which carries the CLI's
 * rule set. That guarantees the stored entry has the id, kind, and baseUrl the
 * CLI's reader requires — an entry missing any of those is silently dropped on
 * the CLI's next read, which is exactly the failure this replaces.
 *
 * The API key is written to Windows Credential Manager first and only the
 * *reference* goes into config.json. If the credential write fails, nothing is
 * written to the profile at all, so the two can never disagree.
 */
  async function saveSettings(message: unknown): Promise<void> {
    const parsed = parseSettingsForm(message);
    if (!parsed.ok) {
      settings.status = parsed.error;
      render();
      return;
    }
    const { preset, displayName, baseUrl, apiKey, modelId } = parsed.value;

    let connection: ProviderConnectionRecord;
    try {
      connection = buildProviderConnection(
        { preset, apiKey, baseUrl, displayName, defaultModel: modelId },
        readConnectProviders(readConfig()),
      );
    } catch (error) {
      // These are the CLI's own validation messages, surfaced verbatim so both
      // applications explain a rejected connection the same way.
      settings.status = (error as Error).message;
      render();
      return;
    }

    let credentialRef: string | undefined;
    if (apiKey) {
      if (!credentialManagerAvailable()) {
        settings.status = 'This platform has no Credential Manager. Set the provider environment variable instead.';
        render();
        return;
      }
      try {
        credentialRef = credentialReference(connection.id);
        await new WindowsCredentialStore().set(credentialRef, apiKey);
      } catch {
        // Deliberately vague: the error must not carry the key or the target.
        settings.status = 'Could not store the API key in Windows Credential Manager. Nothing was written to config.json.';
        render();
        return;
      }
    }

    const patch: Record<string, unknown> = {
      connections: {
        [connection.id]: {
          ...connection,
          // A plaintext key is never persisted; the reference replaces it.
          apiKey: undefined,
          ...(credentialRef ? { credentialReference: credentialRef } : {}),
        },
      },
      activeConnectionId: connection.id,
      ...(connection.defaultModel ? { defaultModel: connection.defaultModel } : {}),
    };

    const result = updateConfigCoordinated(configPath(), patch);
    if (!result.written) {
      settings.status = result.conflict?.reason ?? result.reason ?? 'Could not save the settings.';
      render();
      return;
    }
    settings.status = 'Saved.';
    // Reread so the pane reflects exactly what is on disk, including whether a
    // credential now exists, rather than what this call intended to write.
    await loadSettingsState('Saved.');
  }

  /** Handles every message the chat webview can send. */
  function handleWebviewMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;
    if (msg.type === 'openSettings') {
      void openSettingsPane();
      return;
    }
    if (msg.type === 'closeSettings') {
      settings.open = false;
      render();
      return;
    }
    if (msg.type === 'refreshModels') {
      void loadSettingsState('Loading models…');
      return;
    }
    if (msg.type === 'selectPreset' && typeof msg.preset === 'string') {
      // The preset decides which fields apply, so the host re-renders the pane.
      settings.preset = msg.preset;
      settings.status = '';
      render();
      return;
    }
    if (msg.type === 'saveSettings') {
      void saveSettings(msg);
      return;
    }
    if (msg.type === 'prompt' && typeof msg.text === 'string') {
      void runPrompt(msg.text);
      return;
    }
    if (msg.type === 'cancel') {
      host.cancel();
      return;
    }
    if (msg.type === 'preview' && typeof msg.requestId === 'string') {
      // A full diff is too wide for the sidebar, so it opens as a normal editor
      // tab. The sidebar keeps the summary and the decision.
      openDiffTab(msg.requestId);
      return;
    }
    if (msg.type === 'approval' && typeof msg.requestId === 'string') {
      const settle = pendingApprovals.get(msg.requestId);
      if (!settle) return;
      // The id is echoed back so the coordinator can match it; a message that
      // names a different request cannot authorize this one.
      settle({ requestId: msg.requestId, status: msg.status === 'approved' ? 'approved' : 'denied' });
    }
  }

  /**
   * The chat lives in the activity bar sidebar, not a floating editor tab.
   *
   * `retainContextWhenHidden` matters: without it the webview is destroyed when
   * the user switches away, discarding the transcript and anything typed but
   * not yet sent.
   */
  const chatViewProvider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      chatView = webviewView;
      webviewView.webview.options = {
        enableScripts: true,
        // The webview loads only inline content and never fetches remote sources.
        localResourceRoots: [],
      };
      webviewView.webview.html = chatHtml(view, previewText);
      documentRendered = true;
      webviewView.webview.onDidReceiveMessage(handleWebviewMessage);
      webviewView.onDidDispose(() => {
        chatView = undefined;
        documentRendered = false;
        // Losing the view must deny anything still awaiting a decision.
        host.cancel('The Moderado view was closed.');
      });
      render();
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(chatViewProviderId, chatViewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('moderado.openChat', async () => {
      // The agent is meant to be always available; this only reveals it when the
      // sidebar is collapsed or showing another view.
      await vscode.commands.executeCommand(`${chatViewProviderId}.focus`);
    }),
    vscode.commands.registerCommand('moderado.cancelRun', () => {
      host.cancel();
      view.running = false;
      render();
      vscode.window.showInformationMessage('Moderado run cancelled.');
    }),
    vscode.commands.registerCommand('moderado.togglePlanMode', async () => {
      view.planMode = !view.planMode;
      render();
      vscode.window.showInformationMessage(
        view.planMode
          ? 'Plan mode on: file writes and commands stay blocked.'
          : 'Plan mode off.',
      );
    }),
    vscode.commands.registerCommand('moderado.openSettings', async () => {
      await openSettingsPane();
    }),
    vscode.commands.registerCommand('moderado.selectModel', async () => {
      const models = await host.discoverModels();
      // Paid and unknown-cost models stay labelled so the free-first rule is visible.
      const picked = await vscode.window.showQuickPick(
        models.map((m) => `${m.id} — ${m.accessTier}${m.isFree ? ' (free)' : ''}`),
        { placeHolder: 'Select a model. Free-first routing applies unless paid/unknown is allowed.' },
      );
      if (!picked) return;
      const modelId = picked.split(' — ')[0];
      // Coordinated write: the shared config may have changed in the CLI.
      const result = updateConfigCoordinated(configPath(), { defaultModel: modelId });
      if (result.written) {
        vscode.window.showInformationMessage(`Default model set to ${modelId}.`);
        return;
      }
      if (result.conflict) {
        vscode.window.showWarningMessage(result.conflict.reason);
        return;
      }
      vscode.window.showErrorMessage(result.reason ?? 'Could not save the choice.');
    }),
    vscode.commands.registerCommand('moderado.configureProvider', async () => {
      // Provider secrets are never typed into an editor setting or sent to a
      // renderer; only the non-secret connection fields are collected here.
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Provider base URL (leave empty to skip)',
        placeHolder: 'https://integrate.api.nvidia.com/v1',
      });
      if (baseUrl === undefined) return;
      const id = await vscode.window.showInputBox({ prompt: 'Connection id', value: 'openai-compatible' });
      if (!id?.trim()) return;
      const displayName = await vscode.window.showInputBox({ prompt: 'Display name', value: id.trim() });
      if (!displayName?.trim()) return;

      // The key is written straight to Credential Manager and only the
      // *reference* is stored in config.json. It is never echoed, never put in
      // an editor setting, and never sent to the renderer.
      const apiKey = await vscode.window.showInputBox({
        prompt: 'API key (stored in Windows Credential Manager, never in config.json)',
        password: true,
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) return;

      let credentialRef: string | undefined;
      if (apiKey.trim()) {
        if (!credentialManagerAvailable()) {
          vscode.window.showWarningMessage(
            'This platform has no Credential Manager. Set the provider environment variable instead.',
          );
          return;
        }
        try {
          credentialRef = credentialReference(id.trim());
          await new WindowsCredentialStore().set(credentialRef, apiKey.trim());
        } catch {
          vscode.window.showErrorMessage(
            'Could not store the API key in Windows Credential Manager. Nothing was written to config.json.',
          );
          return;
        }
      }

      const result = updateConfigCoordinated(configPath(), {
        connections: {
          [id.trim()]: {
            id: id.trim(),
            displayName: displayName.trim(),
            kind: 'openai-compatible',
            baseUrl: baseUrl.trim(),
            ...(credentialRef ? { credentialReference: credentialRef } : {}),
          },
        },
        activeConnectionId: id.trim(),
      });
      if (result.written) {
        vscode.window.showInformationMessage(`Saved connection '${displayName.trim()}'.`);
        return;
      }
      if (result.conflict) {
        vscode.window.showWarningMessage(result.conflict.reason);
        return;
      }
      vscode.window.showErrorMessage(result.reason ?? 'Could not save the connection.');
    }),
    vscode.commands.registerCommand('moderado.showSessions', async () => {
      const { sessions, invalid } = host.listSessions();
      if (invalid.length) {
        vscode.window.showWarningMessage(
          `${invalid.length} session file(s) in this workspace could not be read and were left untouched.`,
        );
      }
      if (!sessions.length) {
        vscode.window.showInformationMessage('No recorded sessions for this workspace yet.');
        return;
      }
      await vscode.window.showQuickPick(
        sessions.map((s) => `${s.updatedAt} · ${s.mode} · ${s.modelId ?? 'no model'} · ${s.messages.length} message(s)`),
        { placeHolder: 'Recorded sessions for this workspace' },
      );
    }),
  );

  /** Renders the current chat state into the open sidebar view, if there is one. */
  function render(): void {
    if (!chatView) return;
    // The document is written once. Later updates are pushed into the live DOM,
    // because reassigning `webview.html` destroys and rebuilds the whole webview:
    // doing that per streamed token wiped the composer and stole focus, so the
    // user could not type at all while a reply was arriving.
    if (!documentRendered) {
      chatView.webview.html = chatHtml(view, previewText);
      documentRendered = true;
      return;
    }
    void chatView.webview.postMessage({ type: 'update', ...viewSnapshot(view, previewText) });
  }

  function append(entry: TranscriptEntry): void {
    view.transcript.push(entry);
    // Keep the transcript bounded so a long session cannot grow without limit.
    if (view.transcript.length > 200) view.transcript.shift();
    render();
  }

  async function runPrompt(text: string): Promise<void> {
    append({ kind: 'user', label: 'You', text });
    view.running = true;
    render();
    try {
      const result = await host.startRun({ task: text, planMode: view.planMode });
      if (result.finalMessage) append({ kind: 'assistant', label: 'Moderado', text: result.finalMessage });
      append({ kind: 'tool', label: 'Session', text: `${result.status} · ${result.model} · ${result.totalSteps} step(s) · session ${result.sessionId}` });
    } catch (error) {
      append({ kind: 'error', label: 'Error', text: (error as Error).message });
    } finally {
      view.running = false;
      view.pendingApproval = null;
      render();
    }
  }

  // A narrow extension API. It exists so the host can be driven by an automated
  // check (including the live provider smoke probe) without going through the
  // webview. It deliberately exposes no credentials and no tool permissions: a
  // caller can start a run, list sessions, or cancel, nothing more.
  return {
    startRun: (task: string, options?: { planMode?: boolean }) =>
      host.startRun({ task, planMode: options?.planMode }),
    listSessions: () => host.listSessions(),
    cancel: (reason?: string) => host.cancel(reason),
  };
}

function previewText(request: ApprovalRequest): string {
  const parts: string[] = [];
  if (request.exactPayload.targetFile) parts.push(`Target: ${request.exactPayload.targetFile}`);
  if (request.exactPayload.cwd) parts.push(`Working directory: ${request.exactPayload.cwd}`);
  if (request.exactPayload.command?.length) parts.push(`Command: ${request.exactPayload.command.join(' ')}`);
  const body = request.exactPayload.diffPreview || request.exactPayload.contentPreview;
  if (body) parts.push(body);
  return parts.join('\n\n');
}
const SECRET_KEYS = new Set(['apiKey', 'credential', 'authorization', 'token', 'api_key']);

function redactKey(key: string, value: unknown): unknown {
  return SECRET_KEYS.has(key) ? '[redacted]' : value;
}

export function deactivate(): void {
  // Host disposal is registered as a subscription in activate().
}
