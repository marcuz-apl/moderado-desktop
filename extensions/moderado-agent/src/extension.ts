import * as vscode from 'vscode';
import { AgentEvent, ApprovalRequest } from '@moderado/contracts';
import { AgentHost } from './host.js';
import { RawDecision } from './approval.js';
import { configPath, mergeConfig } from './profile.js';
import { updateConfigCoordinated } from './coordination.js';

/**
 * Extension entry point.
 *
 * The renderer boundary is deliberately thin: the webview may post a prompt or
 * an approval answer and nothing else. It never receives provider credentials
 * and cannot grant its own tool permissions.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Moderado');
  context.subscriptions.push(output);

  const config = () => vscode.workspace.getConfiguration('moderado');
  const pendingApprovals = new Map<string, (raw: RawDecision | undefined) => void>();
  const view: ChatViewState & { planMode: boolean } = { transcript: [], running: false, pendingApproval: null, planMode: false };
  let panel: vscode.WebviewPanel | undefined;

  // Prefer the real editor workspace root so a session directory matches what the
  // CLI would derive for the same folder.
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const host = new AgentHost({
    workspaceRoot,
    nonInteractive: false,
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
    if (panel) {
      view.pendingApproval = request;
      render();
      const answer = await new Promise<RawDecision | undefined>((resolve) => {
        pendingApprovals.set(request.requestId, (raw) => {
          pendingApprovals.delete(request.requestId);
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

  function openChatPanel(): vscode.WebviewPanel {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Active);
      return panel;
    }
    const created = vscode.window.createWebviewPanel('moderado.chat', 'Moderado', vscode.ViewColumn.Active, {
      enableScripts: true,
      // The webview loads only inline content and never fetches remote sources.
      localResourceRoots: [],
    });
    panel = created;
    created.onDidDispose(() => {
      panel = undefined;
      // Closing the view must deny anything still awaiting a decision.
      host.cancel('The Moderado view was closed.');
    });
    created.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'prompt' && typeof message.text === 'string') {
        void runPrompt(message.text);
        return;
      }
      if (message.type === 'cancel') {
        host.cancel();
        return;
      }
      if (message.type === 'approval' && typeof message.requestId === 'string') {
        const settle = pendingApprovals.get(message.requestId);
        if (!settle) return;
        // The id is echoed back so the coordinator can match it; a message that
        // names a different request cannot authorize this one.
        settle({ requestId: message.requestId, status: message.status === 'approved' ? 'approved' : 'denied' });
      }
    });
    render();
    return created;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('moderado.openChat', async () => {
      openChatPanel();
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

      const result = updateConfigCoordinated(configPath(), {
        connections: {
          [id.trim()]: {
            id: id.trim(),
            displayName: displayName.trim(),
            kind: 'openai-compatible',
            baseUrl: baseUrl.trim(),
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

  // A restored panel must not resolve approvals for a request that no longer
  // exists, so a serializer only re-attaches a message listener.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('moderado.chat', {
      async deserializeWebviewPanel(restored) {
        panel = restored;
        restored.onDidDispose(() => {
          panel = undefined;
          host.cancel('The Moderado view was closed.');
        });
        restored.webview.onDidReceiveMessage((message) => {
          if (!message || typeof message !== 'object') return;
          if (message.type === 'prompt' && typeof message.text === 'string') {
            void runPrompt(message.text);
            return;
          }
          if (message.type === 'cancel') {
            host.cancel();
            return;
          }
          if (message.type === 'approval' && typeof message.requestId === 'string') {
            const settle = pendingApprovals.get(message.requestId);
            if (!settle) return;
            settle({
              requestId: message.requestId,
              status: message.status === 'approved' ? 'approved' : 'denied',
            });
          }
        });
        render();
      },
    }),
  );

  /** Renders the current chat state into an open panel, if there is one. */
  function render(): void {
    if (!panel) return;
    panel.webview.html = chatHtml(view);
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

interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool' | 'error';
  label: string;
  text: string;
}

interface ChatViewState {
  transcript: TranscriptEntry[];
  running: boolean;
  pendingApproval: ApprovalRequest | null;
}

/**
 * Minimal, dependency-free chat webview.
 *
 * The renderer is treated as untrusted: it receives already-validated events and
 * sends only a prompt, a cancel, or an approval answer keyed by request id. It is
 * never given a credential and can never grant its own tool permission.
 */
function chatHtml(state: ChatViewState): string {
  const escape = (value: unknown) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const rows = state.transcript
    .map((entry) => `<li class="${escape(entry.kind)}"><span class="who">${escape(entry.label)}</span><pre>${escape(entry.text)}</pre></li>`)
    .join('');

  const approval = state.pendingApproval
    ? `<section class="approval" role="alertdialog" aria-label="Approval required">
         <h2>Approval required</h2>
         <p>${escape(state.pendingApproval.actionSummary)}</p>
         <pre>${escape(previewText(state.pendingApproval))}</pre>
         <button id="allow" type="button">Allow</button>
         <button id="deny" type="button">Deny</button>
       </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>Moderado</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0.75rem; }
  ul { list-style: none; padding: 0; }
  li { border-left: 3px solid var(--vscode-panel-border); margin: 0.4rem 0; padding-left: 0.6rem; }
  li.error { border-color: var(--vscode-errorForeground); }
  li.tool { border-color: var(--vscode-charts-blue); }
  .who { font-size: 0.75rem; text-transform: uppercase; opacity: 0.7; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0.2rem 0 0; font-family: inherit; }
  .approval { border: 1px solid var(--vscode-focusBorder); padding: 0.75rem; margin-top: 1rem; }
  .approval h2 { font-size: 1rem; margin: 0 0 0.4rem; }
  form { display: flex; gap: 0.4rem; margin-top: 0.75rem; }
  input[type="text"] { flex: 1; padding: 0.4rem; color: inherit; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  button { padding: 0.4rem 0.8rem; }
</style>
</head>
<body>
<ul id="transcript">${rows}</ul>
${approval}
<form id="composer">
  <label class="sr-only" for="prompt">Ask Moderado</label>
  <input id="prompt" type="text" placeholder="Ask Moderado" autocomplete="off" ${state.running ? 'disabled' : ''} />
  <button type="submit" ${state.running ? 'disabled' : ''}>Send</button>
  <button type="button" id="cancel" ${state.running ? '' : 'disabled'}>Cancel</button>
</form>
<script>
  const vscode = acquireVsCodeApi();
  let pendingId = ${JSON.stringify(state.pendingApproval?.requestId ?? null)};
  document.getElementById('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('prompt');
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'prompt', text });
    input.value = '';
  });
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  const allow = document.getElementById('allow');
  const deny = document.getElementById('deny');
  if (allow) allow.addEventListener('click', () => vscode.postMessage({ type: 'approval', requestId: pendingId, status: 'approved' }));
  if (deny) deny.addEventListener('click', () => vscode.postMessage({ type: 'approval', requestId: pendingId, status: 'denied' }));
</script>
</body>
</html>`;
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
}

export function deactivate(): void {
  // Host disposal is registered as a subscription in activate().
}