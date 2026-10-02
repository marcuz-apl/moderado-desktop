import type { ApprovalRequest } from '@moderado/contracts';
import { escapeHtml } from './html.js';
import { settingsPaneHtml, SettingsState, emptySettings } from './settings-view.js';

export { escapeHtml } from './html.js';

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
  /** The in-panel settings pane; see settings-view.ts. */
  settings?: SettingsState;
}

/** The parts of the view the webview updates in place. */
export interface ViewSnapshot {
  rows: string;
  approval: string;
  running: boolean;
  pendingId: string | null;
  settingsOpen: boolean;
  settings: string;
  settingsStatus: string;
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
            <button id="full-diff" type="button">Show full change</button>
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
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0.75rem; display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  /* The transcript takes the remaining space so the composer stays pinned to the
     bottom of the sidebar rather than sitting mid-panel. */
  #scroll { flex: 1; overflow-y: auto; min-height: 0; }
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
  /* The gear opens the in-panel settings pane; it is a plain text glyph so it
     inherits the active theme and needs no icon font. */
  #open-settings { float: right; padding: 0.2rem 0.5rem; line-height: 1; background: none; border: none; color: var(--vscode-foreground); cursor: pointer; font-size: 1.1rem; }
  #open-settings:hover { color: var(--vscode-textLink-foreground); }
  #settings-host:not(:empty) { border-top: 1px solid var(--vscode-panel-border); padding-top: 0.5rem; }
  .settings label { display: block; margin: 0.6rem 0 0.2rem; font-size: 0.8rem; opacity: 0.85; }
  .settings input, .settings select { width: 100%; box-sizing: border-box; padding: 0.35rem; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
  .settings header { display: flex; align-items: center; justify-content: space-between; }
  .settings h2 { font-size: 1rem; margin: 0; }
  .settings .note { font-size: 0.75rem; opacity: 0.75; margin: 0.3rem 0 0; }
  .settings .problem { color: var(--vscode-errorForeground); font-size: 0.8rem; }
  .settings .row { display: flex; gap: 0.4rem; margin-top: 0.8rem; }
  .settings .status { font-size: 0.8rem; min-height: 1.2em; margin: 0.4rem 0 0; }
</style>
</head>
<body>
<button id="open-settings" type="button" title="Moderado settings" aria-label="Moderado settings">&#9881;</button>
<div id="settings-host">${snapshot.settings}</div>
<div id="scroll">
  <ul id="transcript">${snapshot.rows}</ul>
</div>
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
  const scroll = document.getElementById('scroll');

  function bindApproval(pendingId) {
    const allow = document.getElementById('allow');
    const deny = document.getElementById('deny');
    const full = document.getElementById('full-diff');
    if (allow) allow.addEventListener('click', () => vscode.postMessage({ type: 'approval', requestId: pendingId, status: 'approved' }));
    if (deny) deny.addEventListener('click', () => vscode.postMessage({ type: 'approval', requestId: pendingId, status: 'denied' }));
    if (full) full.addEventListener('click', () => vscode.postMessage({ type: 'preview', requestId: pendingId }));
  }

  // The settings pane collects a provider key, so it is a separate host element
  // that is only written when the host actually sends a pane. The key is read
  // from the DOM only at the moment of saving and is never stored in the
  // webview, echoed back, or sent anywhere except the one save message.
  const settingsHost = document.getElementById('settings-host');
  let settingsOpen = ${JSON.stringify(snapshot.settingsOpen)};
  if (settingsOpen) bindSettings();
  const status = () => document.getElementById('settings-status');

  function say(text) {
    const node = status();
    if (node) node.textContent = text;
  }

  // A picked provider supplies the connection id. When the user is adding a new
  // connection the id comes from the text field instead, so both paths end up
  // as one validated id on the host side.
  function readSettings() {
    const provider = document.getElementById('settings-provider');
    const connectionId = document.getElementById('settings-connection-id');
    const baseUrl = document.getElementById('settings-base-url');
    const apiKey = document.getElementById('settings-api-key');
    const model = document.getElementById('settings-model');
    const typed = connectionId ? connectionId.value.trim() : '';
    return {
      connectionId: typed || (provider ? provider.value : ''),
      baseUrl: baseUrl ? baseUrl.value : '',
      apiKey: apiKey ? apiKey.value : '',
      modelId: model ? model.value : '',
    };
  }

  function bindSettings() {
    const close = document.getElementById('close-settings');
    const save = document.getElementById('settings-save');
    const refresh = document.getElementById('settings-refresh');
    if (close) close.addEventListener('click', () => vscode.postMessage({ type: 'closeSettings' }));
    if (save) save.addEventListener('click', () => {
      say('Saving…');
      vscode.postMessage({ type: 'saveSettings', ...readSettings() });
    });
    if (refresh) refresh.addEventListener('click', () => {
      say('Loading models…');
      vscode.postMessage({ type: 'refreshModels' });
    });
  }

  document.getElementById('open-settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

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
    // The pane is replaced only when the host sends one. Rewriting it on every
    // streamed token would discard a half-typed API key mid-entry.
    if (update.settingsOpen !== undefined && update.settingsOpen !== settingsOpen) {
      settingsOpen = update.settingsOpen;
      settingsHost.innerHTML = update.settings || '';
      if (settingsOpen) bindSettings();
    } else if (update.settingsStatus) {
      say(update.settingsStatus);
    }
    scroll.scrollTop = scroll.scrollHeight;
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
  const settings = state.settings ?? emptySettings();
  return {
    rows,
    approval: approvalHtml(state.pendingApproval, preview),
    running: state.running,
    pendingId: state.pendingApproval?.requestId ?? null,
    settingsOpen: settings.open,
    // Empty unless open, so the pane never reaches the document unasked.
    settings: settings.open ? settingsPaneHtml(settings) : '',
    settingsStatus: settings.status ?? '',
  };
}