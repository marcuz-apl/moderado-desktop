import type { ApprovalRequest } from '@moderado/contracts';

/**
 * The chat webview, as pure string building.
 *
 * Deliberately separate from extension.ts so it carries no `vscode` import and
 * can be tested directly.
 *
 * The document is written once. Later state changes are pushed to the webview as
 * `update` messages and applied to the live DOM. Reassigning `webview.html` on
 * every event rebuilds the document, which discards whatever the user is typing
 * and steals keyboard focus, which made the composer unusable during streaming.
 */

export interface TranscriptEntry {
  kind: 'user' | 'assistant' | 'tool' | 'error';
  label: string;
  text: string;
}

export interface ChatViewState {
  transcript: TranscriptEntry[];
  running: boolean;
  pendingApproval: ApprovalRequest | null;
}

/** The parts of the view the webview updates in place. */
export interface ViewSnapshot {
  rows: string;
  approval: string;
  running: boolean;
  pendingId: string | null;
}

/** Escapes untrusted transcript, model, or provider text before it becomes HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A fresh per-render nonce, which is what a VS Code webview CSP expects. */
export function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return text;
}

/** Builds the approval prompt. Empty when nothing is awaiting a decision. */
export function approvalHtml(
  pending: ApprovalRequest | null,
  preview: (r: ApprovalRequest) => string,
): string {
  if (!pending) return '';
  return `<section class="approval" role="alertdialog" aria-label="Approval required">
            <h2>Approval required</h2>
            <p>${escapeHtml(pending.actionSummary)}</p>
            <pre>${escapeHtml(preview(pending))}</pre>
            <button id="allow" type="button">Allow</button>
            <button id="deny" type="button">Deny</button>
          </section>`;
}

export function chatHtml(state: ChatViewState, preview: (r: ApprovalRequest) => string): string {
  const snapshot = viewSnapshot(state, preview);
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
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
<ul id="transcript">${snapshot.rows}</ul>
<div id="approval-host">${snapshot.approval}</div>
<form id="composer">
  <label class="sr-only" for="prompt">Ask Moderado</label>
  <input id="prompt" type="text" placeholder="Ask Moderado" autocomplete="off" ${snapshot.running ? 'disabled' : ''} />
  <button type="submit" id="send" ${snapshot.running ? 'disabled' : ''}>Send</button>
  <button type="button" id="cancel" ${snapshot.running ? '' : 'disabled'}>Cancel</button>
</form>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const input = document.getElementById('prompt');
  const send = document.getElementById('send');
  const cancel = document.getElementById('cancel');
  const transcript = document.getElementById('transcript');
  const approvalHost = document.getElementById('approval-host');

  function bindApproval(pendingId) {
    const allow = document.getElementById('allow');
    const deny = document.getElementById('deny');
    if (allow) allow.addEventListener('click', () => vscode.postMessage({ type: 'approval', requestId: pendingId, status: 'approved' }));
    if (deny) deny.addEventListener('click', () => vscode.postMessage({ type: 'approval', requestId: pendingId, status: 'denied' }));
  }

  document.getElementById('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'prompt', text });
    input.value = '';
  });
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  bindApproval(${JSON.stringify(snapshot.pendingId)});

  // Updates are applied to the live DOM. Rebuilding the document here would
  // discard whatever the user is currently typing and steal focus.
  window.addEventListener('message', (event) => {
    const update = event.data;
    if (!update || update.type !== 'update') return;
    transcript.innerHTML = update.rows;
    approvalHost.innerHTML = update.approval;
    input.disabled = update.running;
    send.disabled = update.running;
    cancel.disabled = !update.running;
    if (update.pendingId) bindApproval(update.pendingId);
  });
</script>
</body>
</html>`;
}
export function viewSnapshot(
  state: ChatViewState,
  preview: (r: ApprovalRequest) => string,
): ViewSnapshot {
  const rows = state.transcript
    .map(
      (entry) =>
        `<li class="${escapeHtml(entry.kind)}"><span class="who">${escapeHtml(entry.label)}</span><pre>${escapeHtml(entry.text)}</pre></li>`,
    )
    .join('');
  return {
    rows,
    approval: approvalHtml(state.pendingApproval, preview),
    running: state.running,
    pendingId: state.pendingApproval?.requestId ?? null,
  };
}