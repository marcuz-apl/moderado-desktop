import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type TurnEvent = { kind: 'text' | 'tool' | 'error' | 'done'; value?: string };
type ApprovalEvent = { id: number; path: string; before: string; after: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const transcript = $<HTMLElement>('transcript');
const status = $<HTMLElement>('status');
const prompt = $<HTMLTextAreaElement>('prompt');
const send = $<HTMLButtonElement>('send');
const dialog = $<HTMLDialogElement>('approval-dialog');
let workspace = '';
let mode: 'plan' | 'act' = 'plan';
let assistantText: HTMLElement | null = null;
let busy = false;
let pendingApproval: number | null = null;

function setStatus(message: string): void { status.textContent = message; }

function addMessage(role: string, content = ''): HTMLElement {
  $('empty-state')?.remove();
  const card = document.createElement('article');
  card.className = `message ${role.toLowerCase()}`;
  const label = document.createElement('span');
  label.className = 'message-role';
  label.textContent = role;
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = content;
  card.append(label, body);
  transcript.append(card);
  transcript.scrollTop = transcript.scrollHeight;
  return body;
}

function setMode(next: 'plan' | 'act'): void {
  mode = next;
  for (const value of ['plan', 'act'] as const) {
    const button = $<HTMLButtonElement>(`${value}-mode`);
    const selected = value === next;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  setStatus(next === 'plan' ? 'Plan mode: read only.' : 'Act mode: writes require approval.');
}

$('plan-mode').addEventListener('click', () => setMode('plan'));
$('act-mode').addEventListener('click', () => setMode('act'));

$('workspace-button').addEventListener('click', async () => {
  if (busy) return;
  try {
    workspace = await invoke<string>('choose_workspace');
    $('workspace-name').textContent = workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace;
    $('workspace-path').textContent = workspace;
    transcript.replaceChildren();
    setStatus('Workspace ready.');
    prompt.focus();
  } catch (error) {
    if (String(error) !== 'No workspace selected') setStatus(String(error));
  }
});

void listen<TurnEvent>('turn-event', ({ payload }) => {
  if (payload.kind === 'text') {
    if (!assistantText) assistantText = addMessage('Agent');
    assistantText.textContent += payload.value ?? '';
    transcript.scrollTop = transcript.scrollHeight;
  } else if (payload.kind === 'tool') {
    addMessage('Tool', payload.value ?? '');
    assistantText = null;
  } else if (payload.kind === 'error') {
    addMessage('Error', payload.value ?? 'Unknown error');
    setStatus('Turn failed.');
  } else {
    setStatus('Ready.');
  }
});

void listen<ApprovalEvent>('approval-request', ({ payload }) => {
  pendingApproval = payload.id;
  $('approval-path').textContent = payload.path;
  $('before').textContent = payload.before || '(new file)';
  $('after').textContent = payload.after || '(empty file)';
  dialog.showModal();
  setStatus('Waiting for your approval.');
});

async function answerApproval(accepted: boolean): Promise<void> {
  const id = pendingApproval;
  if (id === null) return;
  pendingApproval = null;
  dialog.close();
  try {
    await invoke('respond_approval', { id, accepted });
    setStatus(accepted ? 'Write approved.' : 'Write rejected.');
  } catch (error) { setStatus(String(error)); }
}

$('approve').addEventListener('click', () => { void answerApproval(true); });
$('reject').addEventListener('click', () => { void answerApproval(false); });
dialog.addEventListener('cancel', (event) => { event.preventDefault(); void answerApproval(false); });

prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $<HTMLFormElement>('composer').requestSubmit();
  }
});

$<HTMLFormElement>('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  if (!workspace) { setStatus('Choose a workspace first.'); return; }
  const text = prompt.value.trim();
  const baseUrl = $<HTMLInputElement>('endpoint').value.trim();
  const model = $<HTMLInputElement>('model').value.trim();
  const apiKey = $<HTMLInputElement>('api-key').value;
  if (!text || !baseUrl || !model) { setStatus('Enter an endpoint, model, and task.'); return; }
  busy = true;
  send.disabled = true;
  $('workspace-button').setAttribute('disabled', '');
  addMessage('You', text);
  prompt.value = '';
  assistantText = null;
  setStatus('Agent is working…');
  try {
    if (apiKey) {
      await invoke('save_provider_key', { baseUrl, apiKey });
      $<HTMLInputElement>('api-key').value = '';
    }
    await invoke('start_turn', { baseUrl, model, mode, prompt: text });
  } catch (error) {
    setStatus(String(error));
  } finally {
    busy = false;
    send.disabled = false;
    $('workspace-button').removeAttribute('disabled');
    prompt.focus();
  }
});
