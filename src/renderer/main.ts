import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { lineDiff } from './diff';
import { canSend, selectedModelLabel, sessionForSubmit, shouldAutoScroll } from './composer';

export type ProviderId = 'moderado' | 'nvidia_nim' | 'open_router' | 'ollama' | 'lm_studio' | 'other_openai_compatible';
type ProviderPreset = { id: ProviderId; name: string; defaultBaseUrl: string; editableUrl: boolean; local: boolean };
type ProviderSettings = { providerId: ProviderId; baseUrl: string; planModel: string; actModel: string };
type LocalProviderStatus = { id: ProviderId; available: boolean };
type HistoryMessage = { role: string; content?: string };
type SessionSummary = { id: string; name: string; workspace: string; settings: ProviderSettings; updatedAt: number };
type SessionRecord = SessionSummary & { history: HistoryMessage[] };
type DisplayMessage = { role: string; content: string };
type TurnEvent = { kind: 'text' | 'tool' | 'error' | 'done' | 'cancelled'; session_id: string; value?: string };
type ApprovalEvent = { sessionId: string; id: number; path: string; before: string; after: string };
type ApprovalExpired = { sessionId: string; id: number };
type Checkpoint = { id: string; sessionId: string; gitRef: string; path: string; createdAt: number };
type CheckpointPreview = { checkpointId: string; currentTree: string; changes: { path: string; before: string; after: string }[] };
type Schedule = { id: string; sessionId: string; prompt: string; mode: 'plan' | 'act'; approvalPolicy: 'prompt' | 'auto_write'; nextRunAt: number; intervalSeconds: number | null; enabled: boolean; inFlight: boolean; lastRunAt: number | null; lastError: string | null };
type SearchSettings = { enabled: boolean; endpoint: string };
type ScheduleStarted = { sessionId: string; scheduleId: string; prompt: string };
type ScheduleRun = { sessionId: string; scheduleId: string; error: string | null };
type ProjectEntry = { name: string; path: string; isDir: boolean };
type CommitSummary = { hash: string; subject: string; author: string; timestamp: number };
type SourceControlSnapshot = { branch: string; changes: string[]; commits: CommitSummary[] };
type SidebarPanel = 'sessions' | 'workspace' | 'checkpoints' | 'schedules' | 'source-control' | 'profile' | 'settings';
type GatewayMode = 'prod' | 'dev';

const GATEWAY_URLS: Record<GatewayMode, string> = {
  prod: 'https://modr.alfazen.org/v1',
  dev: 'http://127.0.0.1:4788/v1',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const transcript = $<HTMLElement>('transcript');
const status = $<HTMLElement>('status');
const prompt = $<HTMLTextAreaElement>('prompt');
const selectedModel = $('selected-model');
const send = $<HTMLButtonElement>('send');
const stop = $<HTMLButtonElement>('stop');
const providerSelect = $<HTMLSelectElement>('provider-select');
const endpoint = $<HTMLInputElement>('endpoint');
const keyField = $<HTMLInputElement>('api-key');
const approvalDialog = $<HTMLDialogElement>('approval-dialog');
const restoreDialog = $<HTMLDialogElement>('restore-dialog');
const scheduleDialog = $<HTMLDialogElement>('schedule-dialog');
const importDialog = $<HTMLDialogElement>('import-dialog');
const emptyState = $('empty-state').cloneNode(true);

let providers: ProviderPreset[] = [];
let initialized = false;
let creatingSession = false;
let activeProvider: ProviderId = 'moderado';
let gatewayMode: GatewayMode = 'prod';
let activeSessionId: string | null = null;
let scheduleSessionId: string | null = null;
let importSessionId: string | null = null;
let mode: 'plan' | 'act' = 'plan';
let currentApproval: ApprovalEvent | null = null;
let pendingRestore: { sessionId: string; preview: CheckpointPreview } | null = null;
let approvalBefore = '';
let activePanel: SidebarPanel | null = 'sessions';
const projectEntries = new Map<string, ProjectEntry[]>();
const expandedFolders = new Set<string>();
let summaries: SessionSummary[] = [];
const sessions = new Map<string, SessionRecord>();
const views = new Map<string, DisplayMessage[]>();
const running = new Set<string>();
const scheduledPending = new Map<string, number>();
const approvalQueue: ApprovalEvent[] = [];
const modeBySession = new Map<string, 'plan' | 'act'>();
const providerDrafts = new Map<ProviderId, Omit<ProviderSettings, 'providerId'>>();
const conversationBindings = new Map<string, string>();
const btwHistory = new Map<string, Array<{ question: string; answer: string }>>();

function setStatus(message: string): void { status.textContent = message; }
function activeSession(): SessionRecord | null { return activeSessionId ? sessions.get(activeSessionId) ?? null : null; }
function binding(settings: ProviderSettings): string { return `${settings.providerId}\n${settings.baseUrl.trim()}`; }

function currentSettings(): ProviderSettings {
  return {
    providerId: activeProvider,
    baseUrl: endpoint.value.trim(),
    planModel: $<HTMLSelectElement>('plan-model').value.trim(),
    actModel: $<HTMLSelectElement>('act-model').value.trim(),
  };
}

function updateSelectedModel(): void {
  const settings = currentSettings();
  selectedModel.textContent = selectedModelLabel(mode, settings);
  selectedModel.title = mode === 'plan' ? settings.planModel : settings.actModel;
}

function setModelOptions(models: string[], planValue: string, actValue: string): void {
  for (const [id, selected] of [['plan-model', planValue], ['act-model', actValue]] as const) {
    const select = $<HTMLSelectElement>(id);
    const options = [new Option('Choose a model', '')];
    for (const model of models) options.push(new Option(model, model));
    if (selected && !models.includes(selected)) options.push(new Option(selected, selected));
    select.replaceChildren(...options);
    select.value = selected;
  }
  updateSelectedModel();
}

function setGatewayMode(next: GatewayMode, persistDraft = true): void {
  const changed = gatewayMode !== next;
  gatewayMode = next;
  endpoint.value = GATEWAY_URLS[next];
  document.querySelectorAll<HTMLButtonElement>('[data-gateway-mode]').forEach((button) => {
    const selected = button.dataset.gatewayMode === next;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  if (changed && activeProvider === 'moderado') {
    setModelOptions([], $<HTMLSelectElement>('plan-model').value, $<HTMLSelectElement>('act-model').value);
  }
  if (persistDraft && activeProvider === 'moderado') {
    providerDrafts.set('moderado', {
      baseUrl: endpoint.value,
      planModel: $<HTMLSelectElement>('plan-model').value,
      actModel: $<HTMLSelectElement>('act-model').value,
    });
  }
}

function selectProvider(id: ProviderId): void {
  if (providers.length === 0) return;
  if (initialized) providerDrafts.set(activeProvider, currentSettings());
  const preset = providers.find((item) => item.id === id);
  if (!preset) return;
  activeProvider = id;
  providerSelect.value = id;
  const draft = providerDrafts.get(id);
  const isModerado = id === 'moderado';
  if (isModerado) {
    setGatewayMode(draft?.baseUrl === GATEWAY_URLS.dev ? 'dev' : 'prod', false);
  } else {
    endpoint.value = draft?.baseUrl ?? preset.defaultBaseUrl;
  }
  endpoint.readOnly = isModerado || !preset.editableUrl;
  $('gateway-mode').toggleAttribute('hidden', !isModerado);
  endpoint.placeholder = id === 'moderado' ? 'https://your-gateway.example/v1' : 'https://your-endpoint.example/v1';
  setModelOptions([], draft?.planModel ?? '', draft?.actModel ?? '');
  keyField.value = '';
  keyField.disabled = preset.local;
  if (activeSession()) setStatus(`${preset.name} selected. Changing provider starts a new conversation on the next task.`);
}

function applySessionSettings(settings: ProviderSettings): void {
  selectProvider(settings.providerId);
  if (settings.providerId === 'moderado') {
    setGatewayMode(settings.baseUrl === GATEWAY_URLS.dev ? 'dev' : 'prod', false);
  } else {
    endpoint.value = settings.baseUrl;
  }
  setModelOptions([], settings.planModel, settings.actModel);
}

async function saveEnteredKey(settings: ProviderSettings): Promise<void> {
  if (!keyField.value) return;
  await invoke('save_provider_key', { providerId: settings.providerId, baseUrl: settings.baseUrl, apiKey: keyField.value });
  keyField.value = '';
}

function historyToView(history: HistoryMessage[]): DisplayMessage[] {
  return history.flatMap((message) => {
    if (message.role === 'user') return [{ role: 'You', content: message.content ?? '' }];
    if (message.role === 'tool') return [{ role: 'Tool', content: message.content ?? '' }];
    if (message.role === 'system') return [{ role: 'System', content: message.content ?? '' }];
    if (message.role === 'assistant' && message.content) return [{ role: 'Agent', content: message.content }];
    return [];
  });
}

function messageElement(role: string, content: string): HTMLElement {
  const card = document.createElement('article');
  card.className = `message ${role.toLowerCase()}`;
  const label = document.createElement('span');
  label.className = 'message-role';
  label.textContent = role;
  const body = document.createElement('div');
  body.className = 'message-body';
  body.textContent = content;
  card.append(label, body);
  return card;
}

function renderTranscript(): void {
  const messages = activeSessionId ? views.get(activeSessionId) ?? [] : [];
  transcript.replaceChildren(...(messages.length ? messages.map((item) => messageElement(item.role, item.content)) : [emptyState.cloneNode(true)]));
  transcript.scrollTop = transcript.scrollHeight;
}

function addDisplay(sessionId: string, role: string, content: string, append = false): void {
  const messages = views.get(sessionId) ?? [];
  const last = messages.at(-1);
  if (append && last?.role === role) last.content += content;
  else messages.push({ role, content });
  views.set(sessionId, messages);
  if (sessionId !== activeSessionId) return;
  const stickToBottom = role === 'You' || shouldAutoScroll(transcript.scrollTop, transcript.scrollHeight, transcript.clientHeight);
  if (append && last?.role === role) {
    const body = transcript.lastElementChild?.querySelector('.message-body');
    if (body) body.textContent = last.content;
    else renderTranscript();
  } else {
    $('empty-state')?.remove();
    transcript.append(messageElement(role, content));
  }
  if (stickToBottom) transcript.scrollTop = transcript.scrollHeight;
}

function renderSessions(): void {
  const list = $('session-list');
  list.replaceChildren(...summaries.map((session) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `session-item${session.id === activeSessionId ? ' selected' : ''}`;
    button.textContent = `${running.has(session.id) ? '● ' : ''}${session.name}`;
    button.title = session.workspace;
    button.addEventListener('click', () => { void selectSession(session.id); });
    return button;
  }));
}

async function refreshSummaries(): Promise<void> {
  summaries = await invoke<SessionSummary[]>('list_sessions');
  renderSessions();
}

async function refreshSession(id: string, replaceView = false): Promise<SessionRecord> {
  const record = await invoke<SessionRecord>('get_session', { sessionId: id });
  sessions.set(id, record);
  if (replaceView || !views.has(id)) views.set(id, historyToView(record.history));
  conversationBindings.set(id, binding(record.settings));
  if (id === activeSessionId && replaceView) renderTranscript();
  return record;
}

async function selectSession(id: string): Promise<void> {
  const record = await refreshSession(id);
  activeSessionId = id;
  applySessionSettings(record.settings);
  mode = modeBySession.get(id) ?? 'plan';
  setMode(mode);
  $('workspace-name').textContent = record.name;
  $('workspace-path').textContent = record.workspace;
  $('session-title').textContent = record.name;
  $('profile-session').textContent = record.name;
  $('profile-provider').textContent = `${providers.find((item) => item.id === record.settings.providerId)?.name ?? record.settings.providerId} · ${record.settings.planModel || 'No plan model'}`;
  $('project-root-name').textContent = record.workspace;
  renderSessions();
  renderTranscript();
  updateControls();
  await refreshCheckpoints();
  await refreshSchedules();
  projectEntries.clear();
  expandedFolders.clear();
  if (activePanel === 'workspace') await refreshProjectTree();
  if (activePanel === 'source-control') await refreshSourceControl();
  const searchSettings = await invoke<SearchSettings>('get_search_settings', { sessionId: id });
  if (id !== activeSessionId) return;
  $<HTMLInputElement>('search-enabled').checked = searchSettings.enabled;
  $<HTMLInputElement>('search-endpoint').value = searchSettings.endpoint;
  $<HTMLInputElement>('search-key').value = '';
  setStatus(running.has(id) ? 'Agent is working…' : 'Session ready.');
}

function updateControls(): void {
  const busy = activeSessionId ? running.has(activeSessionId) : false;
  send.disabled = !canSend(initialized, busy || creatingSession);
  stop.hidden = !busy;
  stop.disabled = !busy;
  providerSelect.disabled = busy;
  endpoint.disabled = busy;
  keyField.disabled = busy || (providers.find((item) => item.id === activeProvider)?.local ?? false);
  $<HTMLSelectElement>('plan-model').disabled = busy;
  $<HTMLSelectElement>('act-model').disabled = busy;
  $<HTMLButtonElement>('load-models').disabled = busy;
  $<HTMLButtonElement>('save-provider-settings').disabled = busy;
  $<HTMLButtonElement>('plan-mode').disabled = busy;
  $<HTMLButtonElement>('act-mode').disabled = busy;
  $<HTMLButtonElement>('rename-session').disabled = !activeSessionId || busy;
  $<HTMLButtonElement>('delete-session').disabled = !activeSessionId || busy;
  $<HTMLButtonElement>('workspace-button').disabled = !initialized || creatingSession;
  $<HTMLButtonElement>('new-schedule').disabled = !activeSessionId;
  $<HTMLButtonElement>('import-transcript').disabled = !activeSessionId;
  $<HTMLButtonElement>('save-search').disabled = !activeSessionId || busy;
  $<HTMLInputElement>('search-enabled').disabled = !activeSessionId || busy;
  $<HTMLInputElement>('search-endpoint').disabled = !activeSessionId || busy;
  $<HTMLInputElement>('search-key').disabled = !activeSessionId || busy;
}

function setMode(next: 'plan' | 'act'): void {
  mode = next;
  if (activeSessionId) modeBySession.set(activeSessionId, next);
  for (const value of ['plan', 'act'] as const) {
    const button = $<HTMLButtonElement>(`${value}-mode`);
    button.classList.toggle('selected', value === next);
    button.setAttribute('aria-pressed', String(value === next));
  }
  updateSelectedModel();
}

async function refreshCheckpoints(): Promise<void> {
  const list = $('checkpoint-list');
  const id = activeSessionId;
  if (!id) { list.textContent = 'Select a session.'; return; }
  try {
    const checkpoints = await invoke<Checkpoint[]>('list_checkpoints', { sessionId: id });
    if (id !== activeSessionId) return;
    if (!checkpoints.length) { list.textContent = 'No checkpoints yet.'; return; }
    list.replaceChildren(...checkpoints.map((checkpoint) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'checkpoint-item';
      button.textContent = `${checkpoint.path} · ${new Date(checkpoint.createdAt * 1000).toLocaleString()}`;
      button.addEventListener('click', () => { void previewCheckpoint(id, checkpoint.id); });
      return button;
    }));
  } catch (error) { if (id === activeSessionId) setStatus(String(error)); }
}

async function refreshSchedules(): Promise<void> {
  const list = $('schedule-list');
  const id = activeSessionId;
  if (!id) { list.textContent = 'Select a session.'; return; }
  try {
    const schedules = await invoke<Schedule[]>('list_schedules', { sessionId: id });
    if (id !== activeSessionId) return;
    if (!schedules.length) { list.textContent = 'No scheduled tasks.'; return; }
    list.replaceChildren(...schedules.map((schedule) => {
      const item = document.createElement('div');
      item.className = 'schedule-item';
      const name = document.createElement('strong');
      name.textContent = schedule.prompt;
      name.title = schedule.prompt;
      const timing = document.createElement('span');
      timing.textContent = `${schedule.inFlight ? 'Running' : schedule.enabled ? 'Next' : schedule.lastError ? 'Paused' : 'Completed'}: ${new Date(schedule.nextRunAt * 1000).toLocaleString()}${schedule.intervalSeconds ? ` · every ${schedule.intervalSeconds / 60} min` : ''}`;
      const policy = document.createElement('span');
      policy.textContent = `${schedule.mode === 'act' ? 'Act' : 'Plan'} · ${schedule.approvalPolicy === 'auto_write' ? 'auto-approve writes' : 'ask before writes'}`;
      item.append(name, timing, policy);
      if (schedule.lastError) {
        const error = document.createElement('span');
        error.className = 'schedule-error';
        error.textContent = schedule.lastError;
        item.append(error);
      }
      if (!schedule.enabled && schedule.lastError) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry now';
        retry.addEventListener('click', async () => {
          try { await invoke('retry_schedule', { sessionId: id, scheduleId: schedule.id }); await refreshSchedules(); }
          catch (error) { setStatus(String(error)); }
        });
        item.append(retry);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete schedule';
      remove.addEventListener('click', async () => {
        try { await invoke('delete_schedule', { sessionId: id, scheduleId: schedule.id }); await refreshSchedules(); }
        catch (error) { setStatus(String(error)); }
      });
      item.append(remove);
      return item;
    }));
  } catch (error) { if (id === activeSessionId) setStatus(String(error)); }
}

let collapseTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCollapse(): void {
  if (collapseTimer) clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => { activePanel = null; document.querySelector<HTMLElement>('.app')?.classList.add('sidebar-collapsed'); document.querySelectorAll<HTMLButtonElement>('.activity-button').forEach((b) => { b.classList.remove('selected'); b.setAttribute('aria-pressed', 'false'); }); document.querySelectorAll<HTMLElement>('.sidebar-panel').forEach((s) => s.classList.remove('active')); }, 30000);
}
function switchPanel(panel: SidebarPanel): void {
  activePanel = panel;
  document.querySelector<HTMLElement>('.app')?.classList.remove('sidebar-collapsed');
  document.querySelectorAll<HTMLButtonElement>('.activity-button').forEach((button) => {
    const selected = button.dataset.panel === activePanel;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll<HTMLElement>('.sidebar-panel').forEach((section) => {
    section.classList.toggle('active', section.dataset.panelContent === panel);
  });
  if (activePanel === 'workspace') void refreshProjectTree();
  if (activePanel === 'source-control') void refreshSourceControl();
  scheduleCollapse();
}

async function loadProjectFolder(path: string): Promise<ProjectEntry[]> {
  const id = activeSessionId;
  if (!id) return [];
  const entries = await invoke<ProjectEntry[]>('list_project_entries', { sessionId: id, path });
  if (id !== activeSessionId) return [];
  projectEntries.set(path, entries);
  return entries;
}

async function refreshProjectTree(): Promise<void> {
  const tree = $('project-tree');
  const id = activeSessionId;
  projectEntries.clear();
  expandedFolders.clear();
  if (!id) { tree.textContent = 'Select a session to browse its workspace.'; return; }
  tree.textContent = 'Loading project files…';
  $('project-root-name').textContent = sessions.get(id)?.workspace ?? '';
  try {
    await loadProjectFolder('.');
    if (id === activeSessionId) renderProjectTree();
  } catch (error) { if (id === activeSessionId) tree.textContent = `Could not load project files: ${String(error)}`; }
}

function renderProjectTree(): void {
  const tree = $('project-tree');
  const fragment = document.createDocumentFragment();
  const append = (entries: ProjectEntry[], depth: number): void => {
    for (const entry of entries) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `tree-row${entry.isDir ? ' tree-folder' : ' tree-file'}`;
      row.style.paddingLeft = `${12 + depth * 14}px`;
      row.setAttribute('role', 'treeitem');
      if (entry.isDir) {
        const open = expandedFolders.has(entry.path);
        row.setAttribute('aria-expanded', String(open));
        row.textContent = `${open ? '▾' : '▸'}  ${entry.name}`;
        row.addEventListener('click', async () => {
          if (expandedFolders.has(entry.path)) expandedFolders.delete(entry.path);
          else {
            expandedFolders.add(entry.path);
            if (!projectEntries.has(entry.path)) {
              try { await loadProjectFolder(entry.path); }
              catch (error) { setStatus(`Could not read ${entry.path}: ${String(error)}`); expandedFolders.delete(entry.path); }
            }
          }
          renderProjectTree();
        });
      } else {
        row.textContent = `   ${entry.name}`;
        row.addEventListener('click', () => { void previewProjectFile(entry); });
      }
      fragment.append(row);
      if (entry.isDir && expandedFolders.has(entry.path)) append(projectEntries.get(entry.path) ?? [], depth + 1);
    }
  };
  const rootEntries = projectEntries.get('.');
  if (!rootEntries?.length) { tree.textContent = 'This folder is empty.'; return; }
  append(rootEntries, 0);
  tree.replaceChildren(fragment);
}

async function previewProjectFile(entry: ProjectEntry): Promise<void> {
  const id = activeSessionId;
  if (!id) return;
  const dialog = $<HTMLDialogElement>('file-preview-dialog');
  $('file-preview-title').textContent = entry.name;
  $('file-preview-path').textContent = entry.path;
  $('file-preview-content').textContent = 'Loading…';
  dialog.showModal();
  try {
    const contents = await invoke<string>('read_project_file', { sessionId: id, path: entry.path });
    if (id === activeSessionId) $('file-preview-content').textContent = contents;
  } catch (error) { $('file-preview-content').textContent = `Could not preview file: ${String(error)}`; }
}

async function refreshSourceControl(): Promise<void> {
  const id = activeSessionId;
  const branch = $('source-branch');
  const message = $('source-control-message');
  const changes = $('source-changes');
  const history = $('commit-history');
  changes.replaceChildren();
  history.replaceChildren();
  if (!id) { branch.textContent = 'Select a session'; message.textContent = 'Open a workspace to inspect Git.'; return; }
  branch.textContent = 'Loading…';
  message.textContent = 'Reading local Git status…';
  try {
    const snapshot = await invoke<SourceControlSnapshot>('get_source_control', { sessionId: id });
    if (id !== activeSessionId) return;
    branch.textContent = snapshot.branch;
    message.textContent = snapshot.changes.length ? `${snapshot.changes.length} changed file${snapshot.changes.length === 1 ? '' : 's'}` : 'Working tree clean';
    changes.replaceChildren(...snapshot.changes.map((path) => {
      const row = document.createElement('div');
      row.className = 'source-change';
      row.textContent = path;
      row.title = path;
      return row;
    }));
    if (!snapshot.commits.length) history.textContent = 'No commits yet.';
    else history.replaceChildren(...snapshot.commits.map((commit) => {
      const row = document.createElement('article');
      row.className = 'commit-item';
      const subject = document.createElement('strong');
      subject.textContent = commit.subject || '(no subject)';
      const meta = document.createElement('span');
      meta.textContent = `${commit.hash} · ${commit.author} · ${new Date(commit.timestamp * 1000).toLocaleDateString()}`;
      row.append(subject, meta);
      return row;
    }));
  } catch (error) {
    if (id !== activeSessionId) return;
    branch.textContent = 'Unavailable';
    message.textContent = String(error);
  }
}

async function previewCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
  try {
    const preview = await invoke<CheckpointPreview>('preview_checkpoint', { sessionId, checkpointId });
    pendingRestore = { sessionId, preview };
    $('restore-description').textContent = `${preview.changes.length} file changes will be restored in ${sessions.get(sessionId)?.name ?? 'this session'}.`;
    const container = $('restore-changes');
    container.replaceChildren(...preview.changes.map((change) => {
      const section = document.createElement('section');
      const title = document.createElement('h3');
      title.textContent = change.path;
      const diff = document.createElement('pre');
      diff.replaceChildren(...lineDiff(change.before, change.after).map(({ kind, text }) => {
        const line = document.createElement('span');
        line.className = `diff-${kind}`;
        line.textContent = `${kind === 'added' ? '+' : kind === 'removed' ? '-' : ' '} ${text}\n`;
        return line;
      }));
      section.append(title, diff);
      return section;
    }));
    $<HTMLButtonElement>('confirm-restore').disabled = preview.changes.length === 0;
    restoreDialog.showModal();
  } catch (error) { setStatus(String(error)); }
}

function showChanges(before: string, after: string): void {
  $('change-summary').replaceChildren(...lineDiff(before, after).map(({ kind, text }) => {
    const line = document.createElement('span');
    line.className = `diff-${kind}`;
    line.textContent = `${kind === 'added' ? '+' : kind === 'removed' ? '-' : ' '} ${text}\n`;
    return line;
  }));
}

function enqueueApproval(request: ApprovalEvent): void {
  if (currentApproval?.sessionId === request.sessionId && currentApproval.id === request.id) return;
  if (approvalQueue.some((item) => item.sessionId === request.sessionId && item.id === request.id)) return;
  approvalQueue.push(request);
  showNextApproval();
}

function showNextApproval(): void {
  if (currentApproval || approvalDialog.open) return;
  const next = approvalQueue.shift();
  if (!next) return;
  currentApproval = next;
  approvalBefore = next.before;
  $('approval-session').textContent = sessions.get(next.sessionId)?.name ?? next.sessionId;
  $('approval-path').textContent = next.path;
  $('before').textContent = next.before || '(new file)';
  const editor = $<HTMLTextAreaElement>('after');
  editor.value = next.after;
  editor.readOnly = true;
  showChanges(next.before, next.after);
  approvalDialog.showModal();
  void invoke('activate_approval', { sessionId: next.sessionId, id: next.id }).catch((error) => {
    if (currentApproval?.sessionId === next.sessionId && currentApproval.id === next.id) {
      currentApproval = null;
      approvalDialog.close();
      setStatus(String(error));
      showNextApproval();
    }
  });
  setStatus('Waiting for your approval.');
}

async function answerApproval(accepted: boolean): Promise<void> {
  const current = currentApproval;
  if (!current) return;
  currentApproval = null;
  approvalDialog.close();
  try {
    await invoke('respond_approval', { sessionId: current.sessionId, id: current.id, content: accepted ? $<HTMLTextAreaElement>('after').value : null });
    setStatus(accepted ? 'Write approved.' : 'Write rejected.');
  } catch (error) { setStatus(String(error)); }
  showNextApproval();
}

async function initialize(): Promise<void> {
  try {
    await Promise.all([turnListenerReady, approvalListenerReady, approvalExpiryReady, checkpointListenerReady, scheduleStartedReady, scheduleRunReady, schedulerErrorReady]);
    for (const pending of await invoke<ApprovalEvent[]>('list_pending_approvals')) enqueueApproval(pending);
    providers = await invoke<ProviderPreset[]>('provider_catalog');
    providerSelect.replaceChildren(...providers.map((provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.name;
      return option;
    }));
    let saved: ProviderSettings | null = null;
    try { saved = await invoke<ProviderSettings | null>('load_provider_settings'); }
    catch (error) { setStatus(`Saved provider settings could not be loaded: ${String(error)}. Using defaults.`); }
    if (saved) providerDrafts.set(saved.providerId, { baseUrl: saved.baseUrl, planModel: saved.planModel, actModel: saved.actModel });
    selectProvider(saved?.providerId ?? 'moderado');
    initialized = true;
    await refreshSummaries();
    const first = summaries[0];
    if (first) await selectSession(first.id);
    else updateControls();
    const local = await invoke<LocalProviderStatus[]>('probe_local_providers');
    for (const item of local) {
      const preset = providers.find((provider) => provider.id === item.id);
      const option = Array.from(providerSelect.options).find((candidate) => candidate.value === item.id);
      if (preset && option) option.textContent = `${preset.name} (${item.available ? 'available' : 'offline'})`;
    }
  } catch (error) { setStatus(`Session setup failed: ${String(error)}`); }
}

providerSelect.addEventListener('change', () => selectProvider(providerSelect.value as ProviderId));
$<HTMLSelectElement>('plan-model').addEventListener('change', updateSelectedModel);
$<HTMLSelectElement>('act-model').addEventListener('change', updateSelectedModel);
document.querySelectorAll<HTMLButtonElement>('[data-gateway-mode]').forEach((button) => {
  button.addEventListener('click', () => setGatewayMode(button.dataset.gatewayMode as GatewayMode));
});
document.querySelectorAll<HTMLButtonElement>('.activity-button').forEach((button) => {
  button.addEventListener('click', () => switchPanel(button.dataset.panel as SidebarPanel));
});
$<HTMLButtonElement>('refresh-project').addEventListener('click', () => { void refreshProjectTree(); });
$<HTMLButtonElement>('refresh-source-control').addEventListener('click', () => { void refreshSourceControl(); });
$<HTMLButtonElement>('close-file-preview').addEventListener('click', () => $<HTMLDialogElement>('file-preview-dialog').close());
$('plan-mode').addEventListener('click', () => setMode('plan'));
$('act-mode').addEventListener('click', () => setMode('act'));
$('close-btw').addEventListener('click', () => $<HTMLDialogElement>('btw-dialog').close());
stop.addEventListener('click', async () => {
  const id = activeSessionId;
  if (!id || !running.has(id)) return;
  stop.disabled = true;
  setStatus('Stopping task…');
  try { await invoke('stop_turn', { sessionId: id }); }
  catch (error) { setStatus(String(error)); stop.disabled = false; }
});

$('load-models').addEventListener('click', async () => {
  const settings = currentSettings();
  if (!initialized || !settings.baseUrl) { setStatus('Select a provider and enter its URL first.'); return; }
  const button = $<HTMLButtonElement>('load-models');
  button.disabled = true;
  setStatus('Loading models…');
  try {
    await saveEnteredKey(settings);
    const models = await invoke<string[]>('discover_models', { providerId: settings.providerId, baseUrl: settings.baseUrl });
    if (settings.providerId === activeProvider && settings.baseUrl === endpoint.value.trim()) {
      const first = models[0];
      const planModel = $<HTMLSelectElement>('plan-model').value || first || '';
      const actModel = $<HTMLSelectElement>('act-model').value || first || '';
      setModelOptions(models, planModel, actModel);
    }
    setStatus(models.length ? `${models.length} models available.` : 'The endpoint returned no models.');
  } catch (error) { setStatus(String(error)); }
  finally { button.disabled = activeSessionId ? running.has(activeSessionId) : false; }
});

$<HTMLButtonElement>('save-provider-settings').addEventListener('click', async () => {
  const settings = currentSettings();
  if (!initialized) { setStatus('Settings are still loading.'); return; }
  const button = $<HTMLButtonElement>('save-provider-settings');
  button.disabled = true;
  try {
    await saveEnteredKey(settings);
    await invoke('save_provider_settings', { sessionId: activeSessionId, settings });
    providerDrafts.set(settings.providerId, { baseUrl: settings.baseUrl, planModel: settings.planModel, actModel: settings.actModel });
    if (activeSessionId) {
      const record = sessions.get(activeSessionId);
      if (record) record.settings = settings;
      conversationBindings.set(activeSessionId, binding(settings));
      await refreshSummaries();
    }
    setStatus('Settings saved on this device.');
  } catch (error) { setStatus(String(error)); }
  finally { button.disabled = activeSessionId ? running.has(activeSessionId) : false; }
});

async function createSession(settings: ProviderSettings): Promise<string> {
  if (!initialized) throw new Error('Session setup is still loading.');
  if (creatingSession) throw new Error('Workspace picker is already open.');
  creatingSession = true;
  updateControls();
  try {
    const record = await invoke<SessionRecord>('create_session', { settings });
    sessions.set(record.id, record);
    views.set(record.id, []);
    await refreshSummaries();
    await selectSession(record.id);
    prompt.focus();
    return record.id;
  } finally {
    creatingSession = false;
    updateControls();
  }
}

$('workspace-button').addEventListener('click', async () => {
  try { await createSession(currentSettings()); }
  catch (error) { if (String(error) !== 'No workspace selected') setStatus(String(error)); }
});

function localDateTime(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

$('new-schedule').addEventListener('click', () => {
  if (!activeSessionId) return;
  scheduleSessionId = activeSessionId;
  $<HTMLTextAreaElement>('schedule-prompt').value = '';
  $<HTMLInputElement>('schedule-time').value = localDateTime(new Date(Date.now() + 5 * 60_000));
  $<HTMLInputElement>('schedule-repeat').value = '';
  $<HTMLSelectElement>('schedule-mode').value = mode;
  $<HTMLSelectElement>('schedule-policy').value = 'prompt';
  scheduleDialog.showModal();
});
$('cancel-schedule').addEventListener('click', () => scheduleDialog.close());
$<HTMLFormElement>('schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const sessionId = scheduleSessionId;
  if (!sessionId) return;
  const time = new Date($<HTMLInputElement>('schedule-time').value).getTime();
  const repeat = $<HTMLInputElement>('schedule-repeat').value.trim();
  const intervalSeconds = repeat ? Number(repeat) * 60 : null;
  const selectedMode = $<HTMLSelectElement>('schedule-mode').value as 'plan' | 'act';
  const approvalPolicy = $<HTMLSelectElement>('schedule-policy').value as 'prompt' | 'auto_write';
  if (!Number.isFinite(time) || time <= Date.now()) { setStatus('Choose a future run time.'); return; }
  if (repeat && (!Number.isInteger(intervalSeconds) || intervalSeconds === null || intervalSeconds < 60 || intervalSeconds > 2_592_000)) { setStatus('Repeat interval must be 1 to 43,200 minutes.'); return; }
  if (selectedMode === 'plan' && approvalPolicy === 'auto_write') { setStatus('Auto-approve writes requires Act mode.'); return; }
  try {
    await invoke<Schedule>('create_schedule', { sessionId, prompt: $<HTMLTextAreaElement>('schedule-prompt').value, mode: selectedMode, approvalPolicy, nextRunAt: Math.floor(time / 1000), intervalSeconds });
    scheduleDialog.close();
    if (sessionId === activeSessionId) await refreshSchedules();
    setStatus('Task scheduled. It will run while the app is open.');
  } catch (error) { setStatus(String(error)); }
});

$('import-transcript').addEventListener('click', () => {
  const session = activeSession();
  if (!session) return;
  importSessionId = session.id;
  $<HTMLInputElement>('import-name').value = `${session.name} import`;
  importDialog.showModal();
});
$('cancel-import').addEventListener('click', () => importDialog.close());
$('save-search').addEventListener('click', async () => {
  const sessionId = activeSessionId;
  if (!sessionId) return;
  const endpoint = $<HTMLInputElement>('search-endpoint').value.trim();
  const apiKey = $<HTMLInputElement>('search-key').value;
  const settings: SearchSettings = { enabled: $<HTMLInputElement>('search-enabled').checked, endpoint };
  try {
    if (apiKey) {
      if (!endpoint) throw new Error('Enter a search endpoint before saving its API key.');
      await invoke('save_search_key', { endpoint, apiKey });
      $<HTMLInputElement>('search-key').value = '';
    }
    await invoke('save_search_settings', { sessionId, settings });
    setStatus(endpoint && settings.enabled ? 'Web search is available for this session.' : 'Search settings saved.');
  } catch (error) { setStatus(String(error)); }
});
$<HTMLFormElement>('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const sourceSessionId = importSessionId;
  if (!sourceSessionId) return;
  try {
    const record = await invoke<SessionRecord>('import_transcript', { sourceSessionId, name: $<HTMLInputElement>('import-name').value, format: $<HTMLSelectElement>('import-format').value });
    importDialog.close();
    await refreshSummaries();
    await selectSession(record.id);
    setStatus(`Imported ${record.history.length} text messages.`);
  } catch (error) { if (String(error) !== 'No transcript selected') setStatus(String(error)); }
});

$('rename-session').addEventListener('click', async () => {
  const session = activeSession();
  if (!session || running.has(session.id)) return;
  const name = window.prompt('Session name', session.name);
  if (name === null) return;
  try {
    await invoke('rename_session', { sessionId: session.id, name });
    session.name = name.trim();
    $('session-title').textContent = session.name;
    $('workspace-name').textContent = session.name;
    await refreshSummaries();
  } catch (error) { setStatus(String(error)); }
});

$('delete-session').addEventListener('click', async () => {
  const session = activeSession();
  if (!session || running.has(session.id) || !window.confirm(`Delete session “${session.name}”? Workspace files will remain.`)) return;
  try {
    await invoke('delete_session', { sessionId: session.id });
    sessions.delete(session.id);
    views.delete(session.id);
    conversationBindings.delete(session.id);
    activeSessionId = null;
    await refreshSummaries();
    const first = summaries[0];
    if (first) await selectSession(first.id);
    else {
      $('session-title').textContent = 'Workspace conversation';
      $('workspace-name').textContent = 'No session selected';
      $('workspace-path').textContent = 'Agent files stay in this folder.';
      $('profile-session').textContent = 'No session selected';
      $('profile-provider').textContent = 'Not configured';
      $('project-root-name').textContent = 'No workspace selected';
      renderTranscript();
      await refreshCheckpoints();
      await refreshSchedules();
      if (activePanel === 'workspace') await refreshProjectTree();
      if (activePanel === 'source-control') await refreshSourceControl();
      updateControls();
      setStatus('Create a session to begin.');
    }
  } catch (error) { setStatus(String(error)); }
});

$('selected-model').addEventListener('click', () => switchPanel('settings'));
$('selected-model').style.cursor = 'pointer';
const sidebar = document.querySelector<HTMLElement>('.sidebar');
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
sidebar?.addEventListener('mouseleave', () => { leaveTimer = setTimeout(() => { activePanel = null; document.querySelector<HTMLElement>('.app')?.classList.add('sidebar-collapsed'); document.querySelectorAll<HTMLButtonElement>('.activity-button').forEach((b) => { b.classList.remove('selected'); b.setAttribute('aria-pressed', 'false'); }); document.querySelectorAll<HTMLElement>('.sidebar-panel').forEach((s) => s.classList.remove('active')); }, 10000); });
sidebar?.addEventListener('mouseenter', () => { if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; } });
document.querySelectorAll<HTMLElement>('.panel-heading').forEach((heading) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '×';
  btn.className = 'text-button';
  btn.style.marginLeft = 'auto';
  btn.addEventListener('click', () => { activePanel = null; document.querySelector<HTMLElement>('.app')?.classList.add('sidebar-collapsed'); document.querySelectorAll<HTMLButtonElement>('.activity-button').forEach((b) => { b.classList.remove('selected'); b.setAttribute('aria-pressed', 'false'); }); document.querySelectorAll<HTMLElement>('.sidebar-panel').forEach((s) => s.classList.remove('active')); });
  heading.append(btn);
});
const turnListenerReady = listen<TurnEvent>('turn-event', ({ payload }) => {
  const id = payload.session_id;
  if (payload.kind === 'text') addDisplay(id, 'Agent', payload.value ?? '', true);
  else if (payload.kind === 'tool') addDisplay(id, 'Tool', payload.value ?? '');
  else if (payload.kind === 'error') {
    if (!scheduledPending.has(id)) running.delete(id);
    if (id === activeSessionId) setStatus(payload.value ?? 'Turn failed.');
  } else {
    if (payload.kind === 'cancelled') {
      for (let index = approvalQueue.length - 1; index >= 0; index--) {
        if (approvalQueue[index]?.sessionId === id) approvalQueue.splice(index, 1);
      }
      if (currentApproval?.sessionId === id) {
        currentApproval = null;
        approvalDialog.close();
      }
    }
    if (!scheduledPending.has(id)) running.delete(id);
    if (id === activeSessionId) setStatus(payload.kind === 'cancelled' ? 'Task stopped.' : 'Ready.');
    void refreshSession(id, true).then(async () => {
      await refreshSummaries();
      if (id === activeSessionId && activePanel === 'workspace') await refreshProjectTree();
      if (id === activeSessionId && activePanel === 'source-control') await refreshSourceControl();
    }).catch((error) => setStatus(String(error)));
  }
  renderSessions();
  updateControls();
});

const approvalListenerReady = listen<ApprovalEvent>('approval-request', ({ payload }) => {
  enqueueApproval(payload);
});

const approvalExpiryReady = listen<ApprovalExpired>('approval-expired', ({ payload }) => {
  const queued = approvalQueue.findIndex((item) => item.sessionId === payload.sessionId && item.id === payload.id);
  if (queued >= 0) approvalQueue.splice(queued, 1);
  if (currentApproval?.sessionId === payload.sessionId && currentApproval.id === payload.id) {
    currentApproval = null;
    approvalDialog.close();
    setStatus('Approval expired. The file was not changed.');
    showNextApproval();
  }
});

const checkpointListenerReady = listen<Checkpoint>('checkpoint-created', ({ payload }) => {
  if (payload.sessionId === activeSessionId) void refreshCheckpoints();
});

const scheduleStartedReady = listen<ScheduleStarted>('schedule-started', ({ payload }) => {
  scheduledPending.set(payload.sessionId, (scheduledPending.get(payload.sessionId) ?? 0) + 1);
  running.add(payload.sessionId);
  addDisplay(payload.sessionId, 'You', `[Scheduled] ${payload.prompt}`);
  if (payload.sessionId === activeSessionId) setStatus('Scheduled task is running…');
  renderSessions();
  updateControls();
});

const scheduleRunReady = listen<ScheduleRun>('schedule-run', ({ payload }) => {
  const remaining = (scheduledPending.get(payload.sessionId) ?? 1) - 1;
  if (remaining > 0) scheduledPending.set(payload.sessionId, remaining);
  else { scheduledPending.delete(payload.sessionId); running.delete(payload.sessionId); }
  if (payload.sessionId === activeSessionId) {
    setStatus(payload.error ? `Scheduled task failed: ${payload.error}` : 'Scheduled task completed.');
    void refreshSchedules();
  }
  renderSessions();
  updateControls();
});

const schedulerErrorReady = listen<string>('scheduler-error', ({ payload }) => setStatus(`Scheduler error: ${payload}`));

$('approve').addEventListener('click', () => { void answerApproval(true); });
$('reject').addEventListener('click', () => { void answerApproval(false); });
$('edit-approval').addEventListener('click', () => {
  const editor = $<HTMLTextAreaElement>('after');
  editor.readOnly = false;
  editor.focus();
});
$<HTMLTextAreaElement>('after').addEventListener('input', (event) => showChanges(approvalBefore, (event.target as HTMLTextAreaElement).value));
approvalDialog.addEventListener('cancel', (event) => { event.preventDefault(); void answerApproval(false); });

$('cancel-restore').addEventListener('click', () => { pendingRestore = null; restoreDialog.close(); });
restoreDialog.addEventListener('cancel', () => { pendingRestore = null; });
$('confirm-restore').addEventListener('click', async () => {
  const pending = pendingRestore;
  if (!pending) return;
  const button = $<HTMLButtonElement>('confirm-restore');
  button.disabled = true;
  try {
    await invoke<number>('restore_checkpoint', { sessionId: pending.sessionId, checkpointId: pending.preview.checkpointId, expectedTree: pending.preview.currentTree });
    restoreDialog.close();
    pendingRestore = null;
    await refreshSession(pending.sessionId, true);
    if (activeSessionId && activeSessionId !== pending.sessionId && sessions.get(activeSessionId)?.workspace === sessions.get(pending.sessionId)?.workspace) {
      await refreshSession(activeSessionId, true);
    }
    await refreshCheckpoints();
    setStatus('Checkpoint restored.');
  } catch (error) { setStatus(String(error)); }
  finally { button.disabled = false; }
});

prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $<HTMLFormElement>('composer').requestSubmit();
  }
});

$<HTMLFormElement>('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!initialized || creatingSession || (activeSessionId && running.has(activeSessionId))) return;
  const text = prompt.value.trim();
  const btw = /^\/btw(?:\s|$)/i.test(text);
  if (!text) return;
  if (btw && text.replace(/^\/btw\s*/i, '').trim() === '') {
    const history = activeSessionId ? btwHistory.get(activeSessionId) ?? [] : [];
    const content = history.length
      ? history.slice(-5).reverse().map((item) => `Q: ${item.question}\nA: ${item.answer}`).join('\n\n---\n\n')
      : 'Ask a quick side question with /btw <question>. Side questions are not added to session history.';
    $('btw-content').textContent = content;
    $<HTMLDialogElement>('btw-dialog').showModal();
    prompt.value = '';
    return;
  }
  const settings = currentSettings();
  const turnMode = mode;
  const model = turnMode === 'plan' ? settings.planModel : settings.actModel;
  const sideQuestion = btw ? text.replace(/^\/btw\s*/i, '').trim() : '';
  if (!text || !settings.baseUrl || (btw ? !settings.planModel : !model)) { setStatus('Enter an endpoint, choose a model, and enter a task.'); return; }
  let id: string;
  try { id = await sessionForSubmit(activeSessionId, () => createSession(settings)); }
  catch (error) { setStatus(String(error) === 'No workspace selected' ? 'Choose a workspace to send your message.' : String(error)); return; }
  running.add(id);
  updateControls();
  renderSessions();
  try {
    await Promise.all([turnListenerReady, approvalListenerReady, approvalExpiryReady, checkpointListenerReady, scheduleStartedReady, scheduleRunReady, schedulerErrorReady]);
    await saveEnteredKey(settings);
    await invoke('save_provider_settings', { sessionId: id, settings });
    if (btw) {
      setStatus('Thinking about your side question…');
      const answer = await invoke<string>('ask_btw', { sessionId: id, settings, model: settings.planModel, question: sideQuestion });
      const history = btwHistory.get(id) ?? [];
      history.push({ question: sideQuestion, answer });
      btwHistory.set(id, history);
      $('btw-content').textContent = `Q: ${sideQuestion}\n\n${answer}\n\n(Not saved to session history)`;
      $<HTMLDialogElement>('btw-dialog').showModal();
      if (id === activeSessionId) setStatus('Ready.');
      return;
    }
    const previous = conversationBindings.get(id);
    if (previous && previous !== binding(settings)) {
      views.set(id, []);
      if (id === activeSessionId) renderTranscript();
      addDisplay(id, 'System', 'New conversation started for the selected provider and URL.');
    }
    conversationBindings.set(id, binding(settings));
    addDisplay(id, 'You', text);
    prompt.value = '';
    if (id === activeSessionId) setStatus('Agent is working…');
    await invoke('start_turn', { sessionId: id, settings, mode: turnMode, prompt: text });
  } catch (error) {
    const detail = String(error);
    if (!detail.includes('stopped by user')) addDisplay(id, 'Error', detail);
    if (id === activeSessionId) setStatus(detail.includes('stopped by user') ? 'Side question stopped.' : detail);
  } finally {
    if (!scheduledPending.has(id)) running.delete(id);
    renderSessions();
    updateControls();
    if (id === activeSessionId) prompt.focus();
  }
});

void initialize();
