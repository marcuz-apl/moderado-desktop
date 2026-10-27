import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { lineDiff } from './diff';
import { canSend, selectedModelLabel, sessionForSubmit, shouldAutoScroll } from './composer';
import { oppositeTheme, parseThemePreference, resolveTheme, type ThemePreference } from './theme';
import appVersion from '../../VERSION?raw';
import { DEFAULT_SESSION_KIND, defaultPanelForKind, newActionLabel, panelAvailableForKind, profileModeDescription, projectNameFromWorkspace, sessionForMode, scheduleWriteApprovalChoiceVisible, sessionsForProject, visibleSessions, type SessionKind, type SidebarPanel } from './sessions-view';

export type ProviderId = 'moderado' | 'nvidia_nim' | 'open_router' | 'ollama' | 'lm_studio' | 'other_openai_compatible';
type ProviderPreset = { id: ProviderId; name: string; defaultBaseUrl: string; editableUrl: boolean; local: boolean; applyKeyUrl: string | null; applyKeyLabel: string };
type ProviderSettings = { providerId: ProviderId; baseUrl: string; planModel: string; actModel: string };
type AutoApprovePolicy = { readFiles: boolean; editFiles: boolean; fetchWebContent: boolean; executeCommand: boolean; useMcpServers: boolean };
type ModelUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; rateTps: number | null; contextTokens: number | null };
type LocalProviderStatus = { id: ProviderId; available: boolean };
type AttachmentRecord = { id: string; sessionId: string; name: string; kind: 'text' | 'image'; bytes: number };
type HistoryMessage = { role: string; content?: string | Array<{ type?: string; text?: string; name?: string }> };
type SessionSummary = { id: string; name: string; workspace: string; kind: SessionKind; settings: ProviderSettings; autoApprove: AutoApprovePolicy; updatedAt: number };
type SessionRecord = SessionSummary & { history: HistoryMessage[] };
type DisplayMessage = { role: string; content: string };
type TurnEvent = { kind: 'text' | 'tool' | 'usage' | 'error' | 'done' | 'cancelled'; session_id: string; value?: string; usage?: ModelUsage };
type ApprovalEvent = { sessionId: string; id: number; category: 'read_files' | 'edit_files' | 'fetch_web_content' | 'execute_command' | 'use_mcp_servers'; title: string; detail: string; hasPreview: boolean; path: string; before: string; after: string };
type ApprovalExpired = { sessionId: string; id: number };
type Checkpoint = { id: string; sessionId: string; gitRef: string; path: string; createdAt: number };
type CheckpointPreview = { checkpointId: string; currentTree: string; changes: { path: string; before: string; after: string }[] };
type Schedule = { id: string; sessionId: string; prompt: string; mode: 'plan' | 'act'; approvalPolicy: 'prompt' | 'auto_write'; nextRunAt: number; intervalSeconds: number | null; enabled: boolean; inFlight: boolean; lastRunAt: number | null; lastError: string | null };
type SearchSettings = { enabled: boolean; endpoint: string };
type ScheduleStarted = { sessionId: string; scheduleId: string; prompt: string };
type ScheduleRun = { sessionId: string; scheduleId: string; error: string | null };
type ProjectRecord = { workspace: string; name: string; updatedAt: number };
type ProjectEntry = { name: string; path: string; isDir: boolean };
type CommitSummary = { hash: string; subject: string; author: string; timestamp: number };
type SourceControlSnapshot = { branch: string; changes: string[]; commits: CommitSummary[] };
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
const keyApplyLink = $<HTMLAnchorElement>('apply-key-link');
const themeToggle = $<HTMLButtonElement>('theme-toggle');
const attachButton = $<HTMLButtonElement>('attach-files');
const attachmentChips = $<HTMLDivElement>('attachment-chips');
const approvalDialog = $<HTMLDialogElement>('approval-dialog');
const restoreDialog = $<HTMLDialogElement>('restore-dialog');
const scheduleDialog = $<HTMLDialogElement>('schedule-dialog');
const importDialog = $<HTMLDialogElement>('import-dialog');
const emptyState = $('empty-state').cloneNode(true);

let providers: ProviderPreset[] = [];
const usageBySession = new Map<string, ModelUsage>();
let activeKind: SessionKind = DEFAULT_SESSION_KIND;
let pendingAttachments: AttachmentRecord[] = [];
let initialized = false;
let creatingSession = false;
let activeProvider: ProviderId = 'moderado';
let gatewayMode: GatewayMode = 'prod';
let activeSessionId: string | null = null;
let scheduleSessionId: string | null = null;
let importSessionId: string | null = null;
let mode: 'plan' | 'act' = 'act';
let currentApproval: ApprovalEvent | null = null;
let pendingRestore: { sessionId: string; preview: CheckpointPreview } | null = null;
let approvalBefore = '';
let activePanel: SidebarPanel | null = 'tasks';
let selectedProjectWorkspace: string | null = null;
const projectEntries = new Map<string, ProjectEntry[]>();
const expandedFolders = new Set<string>();
let summaries: SessionSummary[] = [];
let projects: ProjectRecord[] = [];
const expandedProjects = new Set<string>();
const lastSessionByKind = new Map<SessionKind, string>();
const lastSessionByProject = new Map<string, string>();
const composerDrafts = new Map<string, { text: string; attachments: AttachmentRecord[] }>();
let selectionRevision = 0;
let selectingContext = false;
let autoApproveSaveRevision = 0;
let autoApproveSaveQueue: Promise<void> = Promise.resolve();
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
const themeStorageKey = 'moderado-theme';
let themePreference: ThemePreference = 'auto';
try { themePreference = parseThemePreference(localStorage.getItem(themeStorageKey)); }
catch (error) { setStatus(`Theme preference could not be loaded: ${String(error)}`); }

function applyTheme(): void {
  const theme = resolveTheme(themePreference, new Date());
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const next = oppositeTheme(theme);
  themeToggle.setAttribute('aria-label', `Switch to ${next} theme`);
  themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
  themeToggle.title = `${theme === 'light' ? 'Light' : 'Dark'}${themePreference === 'auto' ? ', follows local time' : ''} — switch to ${next}`;
}

themeToggle.addEventListener('click', () => {
  themePreference = oppositeTheme(resolveTheme(themePreference, new Date()));
  applyTheme();
  try { localStorage.setItem(themeStorageKey, themePreference); }
  catch (error) { setStatus(`Theme preference could not be saved: ${String(error)}`); }
});
applyTheme();
setInterval(() => { if (themePreference === 'auto') applyTheme(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && themePreference === 'auto') applyTheme(); });
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
  const providerName = providers.find((provider) => provider.id === settings.providerId)?.name;
  selectedModel.textContent = selectedModelLabel(mode, settings, providerName);
  selectedModel.title = mode === 'plan' ? settings.planModel : settings.actModel;
  renderModelUsage();
}

function renderModelUsage(): void {
  const usage = activeSessionId ? usageBySession.get(activeSessionId) : undefined;
  const format = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat().format(value);
  const rate = usage?.rateTps == null ? '— tps' : `${usage.rateTps < 10 ? usage.rateTps.toFixed(1) : Math.round(usage.rateTps)} tps`;
  $('model-usage').textContent = `In: ${format(usage?.inputTokens)} | Out: ${format(usage?.outputTokens)} | Total: ${format(usage?.totalTokens)} | Rate: ${rate} | Context: ${format(usage?.contextTokens)}`;
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
  const applyUrl = preset.applyKeyUrl;
  if (applyUrl) {
    keyApplyLink.href = applyUrl;
    keyApplyLink.textContent = preset.applyKeyLabel || 'Get API key';
    keyApplyLink.removeAttribute('disabled');
    keyApplyLink.style.display = '';
  } else {
    keyApplyLink.setAttribute('disabled', '');
    keyApplyLink.style.display = 'none';
  }
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
    const content = typeof message.content === 'string' ? message.content : message.content?.map((block) => block.type === 'attachment' ? `[${block.name ?? 'Attachment'}]` : block.text ?? '').join('\n') ?? '';
    if (message.role === 'user') return [{ role: 'You', content }];
    if (message.role === 'tool') return [{ role: 'Tool', content }];
    if (message.role === 'system') return [{ role: 'System', content }];
    if (message.role === 'assistant' && content) return [{ role: 'Agent', content }];
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

function sessionRow(session: SessionSummary, group: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'selectable-session-row';
  const radio = document.createElement('input');
  radio.type = 'radio'; radio.name = group; radio.checked = session.id === activeSessionId;
  radio.setAttribute('aria-label', `Select ${session.name}`);
  radio.addEventListener('change', () => { void selectSession(session.id); });
  const button = document.createElement('button'); button.type = 'button';
  button.className = `session-item${session.id === activeSessionId ? ' selected' : ''}`;
  button.textContent = `${running.has(session.id) ? '● ' : ''}${session.name}`;
  button.title = session.workspace;
  button.addEventListener('click', () => { void selectSession(session.id); });
  row.append(button, radio); return row;
}

function renderSessions(): void {
  const work = visibleSessions(summaries, 'work');
  $('task-list').replaceChildren(...work.map((session) => sessionRow(session, 'active-work-task')));
  if (!work.length) $('task-list').textContent = 'Create a task to begin.';
  $('project-list').replaceChildren(...projects.map((project) => {
    const section = document.createElement('section'); section.className = 'project-group';
    const row = document.createElement('div'); row.className = 'selectable-session-row project-heading';
    const children = sessionsForProject(summaries, project.workspace);
    const expanded = expandedProjects.has(project.workspace);
    const expander = document.createElement('button'); expander.type = 'button'; expander.className = 'project-expander';
    expander.textContent = expanded ? '▾' : '▸'; expander.setAttribute('aria-label', `Expand ${project.name}`); expander.setAttribute('aria-expanded', String(expanded));
    expander.addEventListener('click', () => { if (expanded) expandedProjects.delete(project.workspace); else expandedProjects.add(project.workspace); renderSessions(); });
    const button = document.createElement('button'); button.type = 'button';
    button.className = `session-item${activeKind === 'code' && project.workspace === selectedProjectWorkspace ? ' selected' : ''}`;
    button.textContent = `${children.some((session) => running.has(session.id)) ? '● ' : ''}${project.name}`;
    button.title = `${project.workspace}
${children.length} sessions`;
    button.addEventListener('click', () => { void selectProject(project.workspace); });
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'active-code-project';
    radio.checked = activeKind === 'code' && project.workspace === selectedProjectWorkspace;
    radio.setAttribute('aria-label', `Select project ${project.name}`);
    radio.addEventListener('change', () => { void selectProject(project.workspace); });
    row.append(expander, button, radio); section.append(row);
    if (expanded) {
      const list = document.createElement('div'); list.className = 'project-sessions'; list.setAttribute('aria-label', `${project.name} sessions`);
      list.append(...children.map((session) => sessionRow(session, 'active-code-session')));
      if (!children.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No sessions yet.'; list.append(empty); }
      const actions = document.createElement('div'); actions.className = 'project-actions';
      for (const [label, action] of [
        ['New Session', () => { void newProjectSession(project.workspace); }],
        ['Rename', () => { void renameProject(project); }],
        ['Remove', () => { void removeProject(project); }],
      ] as const) {
        const control = document.createElement('button'); control.type = 'button'; control.className = 'text-button'; control.textContent = label;
        control.disabled = creatingSession || (label === 'Remove' && children.some((session) => running.has(session.id)));
        control.addEventListener('click', action); actions.append(control);
      }
      list.append(actions); section.append(list);
    }
    return section;
  }));
  if (!projects.length) $('project-list').textContent = 'Create a project or open an existing folder.';
}

function applyKindUi(): void {
  const work = activeKind === 'work';
  for (const kind of ['work', 'code'] as const) {
    const button = $<HTMLButtonElement>(`kind-${kind}`);
    const selected = kind === activeKind;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.activity-button'))) {
    const panel = button.dataset.panel as SidebarPanel;
    button.hidden = !panelAvailableForKind(panel, activeKind);
  }
  for (const panel of ['tasks', 'projects'] as const) {
    const button = document.querySelector<HTMLButtonElement>(`[data-panel="${panel}"]`);
    if (button) button.hidden = !panelAvailableForKind(panel, activeKind);
  }
  const explorerButton = document.querySelector<HTMLButtonElement>('[data-panel="workspace"]');
  if (explorerButton) explorerButton.hidden = !panelAvailableForKind('workspace', activeKind);
  document.querySelector<HTMLElement>('.mode-control')?.toggleAttribute('hidden', work);
  $('auto-approve-group').toggleAttribute('hidden', !activeSessionId);
  $('approve-command-option').toggleAttribute('hidden', work);
  $('approve-mcp-option').toggleAttribute('hidden', work);
  attachButton.toggleAttribute('hidden', !work);
  attachButton.disabled = !work || !activeSessionId || selectingContext;
  document.querySelector<HTMLElement>('.session-context')?.toggleAttribute('hidden', work);
  prompt.placeholder = work ? 'Describe the task or document you need…' : 'What should the agent work on in this project?';
  const emptyCopy = document.getElementById('empty-state-copy');
  if (emptyCopy) {
    emptyCopy.textContent = work
      ? 'Ask a question or create a document. Files and editable attachment copies stay in this task’s managed folder.'
      : (selectedProjectWorkspace ? 'Start a new session in this project. Existing project files are available in Explorer.' : 'Create a project folder or open an existing codebase to begin.');
  }
  $('workspace-button').textContent = newActionLabel('tasks');
  $('new-project').textContent = 'New';
  $('profile-mode-description').textContent = profileModeDescription(activeKind);
  $('profile-work-content').toggleAttribute('hidden', !work);
  $('profile-code-content').toggleAttribute('hidden', work);
  if (activePanel && !panelAvailableForKind(activePanel, activeKind)) switchPanel(defaultPanelForKind(activeKind));

}

function rememberNavigation(): void {
  try { localStorage.setItem('moderado-navigation', JSON.stringify({ work: lastSessionByKind.get('work'), code: lastSessionByKind.get('code'), project: selectedProjectWorkspace })); }
  catch (error) { setStatus(`Navigation preference could not be saved: ${String(error)}`); }
}
function restoreNavigation(): void {
  try {
    const saved: { work?: unknown; code?: unknown; project?: unknown } | null = JSON.parse(localStorage.getItem('moderado-navigation') ?? '{}');
    if (!saved || typeof saved !== 'object') return;
    for (const kind of ['work', 'code'] as const) { const id = saved[kind]; if (typeof id === 'string' && summaries.some((session) => session.id === id && session.kind === kind)) lastSessionByKind.set(kind, id); }
    if (typeof saved.project === 'string' && projects.some((project) => project.workspace === saved.project)) selectedProjectWorkspace = saved.project;
    const code = summaries.find((session) => session.id === lastSessionByKind.get('code'));
    if (code) lastSessionByProject.set(code.workspace, code.id);
  } catch (error) { setStatus(`Navigation preference could not be loaded: ${String(error)}`); }
}
function draftKey(): string { return activeSessionId ?? `${activeKind}:${activeKind === 'code' ? selectedProjectWorkspace ?? '' : ''}`; }
function saveComposerDraft(): void { composerDrafts.set(draftKey(), { text: prompt.value, attachments: [...pendingAttachments] }); }
function restoreComposerDraft(): void {
  const draft = composerDrafts.get(draftKey()); prompt.value = draft?.text ?? ''; pendingAttachments = draft?.attachments ?? []; renderChips();
}
function currentFolder(): string | null {
  return activeKind === 'code' ? selectedProjectWorkspace : activeSession()?.workspace ?? null;
}
function updateFolderContext(): void {
  const folder = currentFolder();
  const project = projects.find((item) => item.workspace === folder);
  $('workspace-context').textContent = folder ?? (activeKind === 'work' ? 'A managed folder is created when you start a task.' : 'Create or open a project folder.');
  $('workspace-context').title = folder ?? '';
  $('project-root-name').textContent = project?.name ?? (folder ? projectNameFromWorkspace(folder, 'Task files') : 'No folder selected');
}
function enterDraft(kind: SessionKind, workspace: string | null = selectedProjectWorkspace): void {
  selectionRevision++; selectingContext = false; activeSessionId = null; activeKind = kind;
  if (kind === 'code') selectedProjectWorkspace = workspace;
  rememberNavigation();
  $('session-title').textContent = kind === 'work' ? 'New Task' : 'New Session';
  $('profile-session').textContent = 'No conversation selected'; $('profile-provider').textContent = 'Not configured';
  renderTranscript(); restoreComposerDraft(); applyKindUi(); updateFolderContext(); updateSelectedModel(); renderSessions(); updateControls();
  projectEntries.clear(); expandedFolders.clear();
  if (activePanel === 'workspace') void refreshProjectTree();
  if (activePanel === 'source-control') void refreshSourceControl();
  void refreshCheckpoints(); void refreshSchedules();
  setStatus(kind === 'work' ? 'Ready for a new task.' : workspace ? 'Start a session in this project.' : 'Create or open a project to begin.');
}
async function setKind(kind: SessionKind): Promise<void> {
  if (kind === activeKind && !selectingContext) return;
  saveComposerDraft();
  const validProjects = new Set(projects.map((project) => project.workspace));
  const candidates = summaries.filter((session) => session.kind === 'work' || validProjects.has(session.workspace));
  const workspace = selectedProjectWorkspace && validProjects.has(selectedProjectWorkspace) ? selectedProjectWorkspace : null;
  const remembered = kind === 'code' && workspace ? lastSessionByProject.get(workspace) : lastSessionByKind.get(kind);
  const next = sessionForMode(candidates, kind, remembered, kind === 'code' ? workspace : null);
  enterDraft(kind, kind === 'code' ? workspace ?? next?.workspace ?? null : workspace);
  switchPanel(defaultPanelForKind(kind));
  if (next) await selectSession(next.id, false);
}

function renderChips(): void {
  attachmentChips.replaceChildren(...pendingAttachments.map((attachment) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    chip.textContent = attachment.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter((item) => item.id !== attachment.id);
      renderChips();
    });
    chip.append(remove);
    return chip;
  }));
  attachmentChips.toggleAttribute('hidden', pendingAttachments.length === 0);
}

async function refreshSummaries(): Promise<void> {
  [summaries, projects] = await Promise.all([invoke<SessionSummary[]>('list_sessions'), invoke<ProjectRecord[]>('list_projects')]);
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

async function selectSession(id: string, saveDraft = true): Promise<void> {
  if (saveDraft) saveComposerDraft();
  const revision = ++selectionRevision; selectingContext = true; updateControls();
  try {
    const record = await refreshSession(id);
    if (revision !== selectionRevision) return;
    activeSessionId = id; activeKind = record.kind; lastSessionByKind.set(record.kind, id);
    if (record.kind === 'code') { selectedProjectWorkspace = record.workspace; lastSessionByProject.set(record.workspace, id); expandedProjects.add(record.workspace); }
    rememberNavigation();
    applySessionSettings(record.settings); applyAutoApprove(record.autoApprove);
    setMode(record.kind === 'work' ? 'act' : modeBySession.get(id) ?? 'act');
    $('session-title').textContent = record.name; $('profile-session').textContent = record.name;
    $('profile-provider').textContent = `${providers.find((item) => item.id === record.settings.providerId)?.name ?? record.settings.providerId} · ${record.settings.actModel || 'No model selected'}`;
    renderTranscript(); restoreComposerDraft(); applyKindUi(); updateFolderContext(); renderSessions();
    projectEntries.clear(); expandedFolders.clear();
    await Promise.all([refreshCheckpoints(), refreshSchedules(), activePanel === 'workspace' ? refreshProjectTree() : Promise.resolve(), activePanel === 'source-control' ? refreshSourceControl() : Promise.resolve()]);
    if (revision !== selectionRevision) return;
    const searchSettings = await invoke<SearchSettings>('get_search_settings', { sessionId: id });
    if (revision !== selectionRevision) return;
    $<HTMLInputElement>('search-enabled').checked = searchSettings.enabled;
    $<HTMLInputElement>('search-endpoint').value = searchSettings.endpoint; $<HTMLInputElement>('search-key').value = '';
    setStatus(running.has(id) ? 'Agent is working…' : record.kind === 'work' ? 'Task ready.' : 'Session ready.');
  } catch (error) { if (revision === selectionRevision) setStatus(`Could not open conversation: ${String(error)}`); }
  finally { if (revision === selectionRevision) { selectingContext = false; updateControls(); } }
}

function applyAutoApprove(policy: AutoApprovePolicy): void {
  const fields: Array<[string, keyof AutoApprovePolicy]> = [['approve-read', 'readFiles'], ['approve-edit', 'editFiles'], ['approve-web', 'fetchWebContent'], ['approve-command', 'executeCommand'], ['approve-mcp', 'useMcpServers']];
  for (const [id, key] of fields) $<HTMLInputElement>(id).checked = policy[key];
}

function saveAutoApprove(): void {
  const sessionId = activeSessionId;
  if (!sessionId) return;
  const policy: AutoApprovePolicy = {
    readFiles: $<HTMLInputElement>('approve-read').checked,
    editFiles: $<HTMLInputElement>('approve-edit').checked,
    fetchWebContent: $<HTMLInputElement>('approve-web').checked,
    executeCommand: $<HTMLInputElement>('approve-command').checked,
    useMcpServers: $<HTMLInputElement>('approve-mcp').checked,
  };
  const saveRevision = ++autoApproveSaveRevision;
  setStatus('Saving auto-approve settings…');
  autoApproveSaveQueue = autoApproveSaveQueue.catch(() => undefined).then(async () => {
    await invoke('save_auto_approve', { sessionId, policy });
    const record = sessions.get(sessionId);
    if (record) record.autoApprove = policy;
    if (activeSessionId === sessionId && saveRevision === autoApproveSaveRevision) {
      applyAutoApprove(policy);
      setStatus('Auto-approve settings saved for this session.');
    }
  }).catch((error: unknown) => {
    if (saveRevision === autoApproveSaveRevision) {
      const record = sessions.get(sessionId);
      if (activeSessionId === sessionId && record) applyAutoApprove(record.autoApprove);
      setStatus(`Auto-approve settings for ${record?.name ?? 'the selected session'} could not be saved: ${String(error)}`);
    }
  });
}

for (const id of ['approve-read', 'approve-edit', 'approve-web', 'approve-command', 'approve-mcp']) {
  $<HTMLInputElement>(id).addEventListener('change', saveAutoApprove);
}

function updateControls(): void {
  applyKindUi();
  const busy = activeSessionId ? running.has(activeSessionId) : false;
  send.disabled = !canSend(initialized, busy || creatingSession || selectingContext) || (activeKind === 'code' && !selectedProjectWorkspace);
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
  for (const id of ['new-project', 'open-project', 'kind-work', 'kind-code']) $<HTMLButtonElement>(id).disabled = !initialized || creatingSession;
  for (const id of ['approve-read', 'approve-edit', 'approve-web', 'approve-command']) $<HTMLInputElement>(id).disabled = !activeSessionId || selectingContext;
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
      const scheduleKind = sessions.get(id)?.kind ?? 'code';
      policy.textContent = scheduleKind === 'work'
        ? (schedule.mode === 'act' ? 'Act' : 'Plan')
        : `${schedule.mode === 'act' ? 'Act' : 'Plan'} · ${schedule.approvalPolicy === 'auto_write' ? 'auto-approve writes' : 'ask before writes'}`;
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

function closePanel(): void {
  activePanel = null;
  document.querySelector<HTMLElement>('.app')?.classList.add('sidebar-collapsed');
  document.querySelectorAll<HTMLButtonElement>('.activity-button').forEach((button) => {
    button.classList.remove('selected');
    button.setAttribute('aria-pressed', 'false');
  });
  document.querySelectorAll<HTMLElement>('.sidebar-panel').forEach((section) => section.classList.remove('active'));
}
function switchPanel(panel: SidebarPanel): void {
  if (!panelAvailableForKind(panel, activeKind)) panel = defaultPanelForKind(activeKind);
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
}

async function selectProject(workspace: string): Promise<void> {
  if (!projects.some((project) => project.workspace === workspace)) { setStatus('Open this project first.'); return; }
  saveComposerDraft(); enterDraft('code', workspace); expandedProjects.add(workspace); switchPanel('projects');
  const next = sessionForMode(summaries, 'code', lastSessionByProject.get(workspace), workspace);
  if (next) await selectSession(next.id, false);
  else renderSessions();
}
function browserArgs(): { sessionId: string | null; projectWorkspace: string | null } {
  return { sessionId: activeKind === 'work' ? activeSessionId : null, projectWorkspace: activeKind === 'code' ? selectedProjectWorkspace : null };
}

async function loadProjectFolder(path: string): Promise<ProjectEntry[]> {
  const folder = currentFolder(); if (!folder) return [];
  const entries = await invoke<ProjectEntry[]>('list_project_entries', { ...browserArgs(), path });
  if (folder !== currentFolder()) return [];
  projectEntries.set(path, entries); return entries;
}
async function refreshProjectTree(): Promise<void> {
  const tree = $('project-tree'); const folder = currentFolder(); const revision = selectionRevision;
  projectEntries.clear(); expandedFolders.clear(); updateFolderContext();
  if (!folder) { tree.textContent = 'Select a task or project to browse its files.'; return; }
  tree.textContent = 'Loading files…';
  try { await loadProjectFolder('.'); if (revision === selectionRevision && folder === currentFolder()) renderProjectTree(); }
  catch (error) { if (revision === selectionRevision) tree.textContent = `Could not load files: ${String(error)}`; }
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
  const folder = currentFolder();
  if (!folder) return;
  const dialog = $<HTMLDialogElement>('file-preview-dialog');
  $('file-preview-title').textContent = entry.name;
  $('file-preview-path').textContent = entry.path;
  $('file-preview-content').textContent = 'Loading…';
  dialog.showModal();
  try {
    const contents = await invoke<string>('read_project_file', { ...browserArgs(), path: entry.path });
    if (folder === currentFolder()) $('file-preview-content').textContent = contents;
  } catch (error) { $('file-preview-content').textContent = `Could not preview file: ${String(error)}`; }
}

async function refreshSourceControl(): Promise<void> {
  const folder = currentFolder();
  const branch = $('source-branch');
  const message = $('source-control-message');
  const changes = $('source-changes');
  const history = $('commit-history');
  changes.replaceChildren();
  history.replaceChildren();
  if (!folder) { branch.textContent = 'Select a project'; message.textContent = 'Open a workspace to inspect Git.'; return; }
  branch.textContent = 'Loading…';
  message.textContent = 'Reading local Git status…';
  try {
    const snapshot = await invoke<SourceControlSnapshot>('get_source_control', browserArgs());
    if (folder !== currentFolder()) return;
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
    if (folder !== currentFolder()) return;
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
  $('approval-title').textContent = next.title;
  $('approval-detail').textContent = next.detail;
  $('approval-path').textContent = next.path;
  $('approval-path').toggleAttribute('hidden', !next.hasPreview);
  $('approval-dialog').querySelector('.diff')?.toggleAttribute('hidden', !next.hasPreview);
  $('change-summary').toggleAttribute('hidden', !next.hasPreview);
  $<HTMLButtonElement>('edit-approval').hidden = !next.hasPreview;
  $<HTMLButtonElement>('approve').textContent = next.hasPreview ? 'Approve write' : 'Approve';
  $('before').textContent = next.before || '(new file)';
  const editor = $<HTMLTextAreaElement>('after');
  editor.value = next.hasPreview ? next.after : 'approved';
  editor.readOnly = true;
  if (next.hasPreview) showChanges(next.before, next.after);
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
    setStatus(accepted ? (current.hasPreview ? 'Write approved.' : 'Access approved.') : 'Request rejected.');
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
    restoreNavigation();
    await setKind(DEFAULT_SESSION_KIND);
    const firstWorkSession = sessionForMode(summaries, DEFAULT_SESSION_KIND, lastSessionByKind.get(DEFAULT_SESSION_KIND));
    if (firstWorkSession) await selectSession(firstWorkSession.id);
    else await createSession(currentSettings(), DEFAULT_SESSION_KIND);
    const local = await invoke<LocalProviderStatus[]>('probe_local_providers');
    for (const item of local) {
      const preset = providers.find((provider) => provider.id === item.id);
      const option = Array.from(providerSelect.options).find((candidate) => candidate.value === item.id);
      if (preset && option) option.textContent = `${preset.name} (${item.available ? 'available' : 'offline'})`;
    }
  } catch (error) { setStatus(`Session setup failed: ${String(error)}`); }
}

providerSelect.addEventListener('change', () => selectProvider(providerSelect.value as ProviderId));

$<HTMLButtonElement>('kind-work').addEventListener('click', () => { void setKind('work'); });
$<HTMLButtonElement>('kind-code').addEventListener('click', () => { void setKind('code'); });
$<HTMLElement>('about-version').textContent = appVersion.trim();

attachButton.addEventListener('click', async () => {
  const sessionId = activeSessionId;
  if (!sessionId) { setStatus('Create a task before attaching files.'); return; }
  try {
    const picked = await open({ multiple: true, title: 'Attach files (editable copies go into the task folder)' });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    const records = await invoke<AttachmentRecord[]>('add_attachments', { sessionId, paths });
    if (activeSessionId === sessionId) { pendingAttachments = [...pendingAttachments, ...records]; renderChips(); setStatus(`${pendingAttachments.length} file(s) attached. Copies are in Explorer.`); if (activePanel === 'workspace') await refreshProjectTree(); }
    else { const draft = composerDrafts.get(sessionId) ?? { text: '', attachments: [] }; composerDrafts.set(sessionId, { ...draft, attachments: [...draft.attachments, ...records] }); }
  } catch (error) { if (activeSessionId === sessionId) setStatus(String(error)); }
});
keyApplyLink.addEventListener('click', async (event) => {
  event.preventDefault();
  const url = keyApplyLink.href;
  if (!url || url === '#') return;
  try { await openUrl(url); }
  catch (error) { setStatus(`Could not open apply page: ${String(error)}`); }
});
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

async function createSession(settings: ProviderSettings, kind: SessionKind = activeKind, workspace: string | null = selectedProjectWorkspace): Promise<string> {
  if (!initialized || creatingSession) throw new Error('Session setup is already in progress.');
  if (kind === 'code' && !workspace) throw new Error('Create or open a project first.');
  const text = prompt.value;
  const revision = selectionRevision;
  creatingSession = true; updateControls();
  try {
    const record = kind === 'work'
      ? await invoke<SessionRecord>('create_default_session', { settings, kind })
      : await invoke<SessionRecord>('create_session_in_project', { projectWorkspace: workspace, settings });
    sessions.set(record.id, record); views.set(record.id, []);
    await refreshSummaries();
    if (revision === selectionRevision) {
      await selectSession(record.id);
      if (activeSessionId === record.id) { prompt.value = text; saveComposerDraft(); prompt.focus(); }
      else composerDrafts.set(record.id, { text, attachments: [] });
    } else composerDrafts.set(record.id, { text, attachments: [] });
    return record.id;
  } finally { creatingSession = false; renderSessions(); updateControls(); }
}

$('workspace-button').addEventListener('click', async () => {
  if (creatingSession) return;
  saveComposerDraft(); enterDraft('work'); prompt.value = ''; pendingAttachments = []; renderChips();
  try { await createSession(currentSettings(), 'work'); } catch (error) { setStatus(String(error)); }
});

const projectDialog = $<HTMLDialogElement>('new-project-dialog');
$('new-project').addEventListener('click', () => { $<HTMLInputElement>('project-name').value = ''; projectDialog.showModal(); $<HTMLInputElement>('project-name').focus(); });
$('cancel-project').addEventListener('click', () => projectDialog.close());
$<HTMLFormElement>('new-project-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const name = $<HTMLInputElement>('project-name').value.trim(); if (!name || creatingSession) return;
  const revision = selectionRevision;
  projectDialog.close(); creatingSession = true; updateControls();
  try { const project = await invoke<ProjectRecord>('create_project', { name }); await refreshSummaries(); if (revision === selectionRevision) await selectProject(project.workspace); }
  catch (error) { if (String(error) !== 'No folder selected') setStatus(String(error)); }
  finally { creatingSession = false; renderSessions(); updateControls(); }
});
$('open-project').addEventListener('click', async () => {
  if (creatingSession) return; const revision = selectionRevision; creatingSession = true; updateControls();
  try { const project = await invoke<ProjectRecord>('open_project'); await refreshSummaries(); if (revision === selectionRevision) await selectProject(project.workspace); }
  catch (error) { if (String(error) !== 'No folder selected') setStatus(String(error)); }
  finally { creatingSession = false; renderSessions(); updateControls(); }
});
async function newProjectSession(workspace: string): Promise<void> {
  if (creatingSession) return;
  saveComposerDraft(); enterDraft('code', workspace); prompt.value = ''; pendingAttachments = []; renderChips(); expandedProjects.add(workspace); switchPanel('projects');
  try { await createSession(currentSettings(), 'code', workspace); } catch (error) { setStatus(String(error)); }
}
async function renameProject(project: ProjectRecord): Promise<void> {
  const name = window.prompt('Project display name (folder name stays the same)', project.name); if (name === null) return;
  try { await invoke('rename_project', { projectWorkspace: project.workspace, name }); await refreshSummaries(); updateFolderContext(); }
  catch (error) { setStatus(String(error)); }
}
async function removeProject(project: ProjectRecord): Promise<void> {
  if (!window.confirm(`Remove “${project.name}” from Moderado? Its files and session history are kept. Open the folder again to restore it.`)) return;
  const revision = selectionRevision;
  try {
    await invoke('remove_project', { projectWorkspace: project.workspace }); await refreshSummaries();
    if (selectedProjectWorkspace === project.workspace) {
      selectedProjectWorkspace = null; rememberNavigation();
      if (revision === selectionRevision && activeKind === 'code') { saveComposerDraft(); enterDraft('code', null); if (projects[0]) await selectProject(projects[0].workspace); }
    }
  } catch (error) { setStatus(String(error)); }
}

function localDateTime(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

$('new-schedule').addEventListener('click', () => {
  const session = activeSession();
  if (!session) return;
  const work = !scheduleWriteApprovalChoiceVisible(session.kind);
  scheduleSessionId = session.id;
  $<HTMLTextAreaElement>('schedule-prompt').value = '';
  $<HTMLInputElement>('schedule-time').value = localDateTime(new Date(Date.now() + 5 * 60_000));
  $<HTMLInputElement>('schedule-repeat').value = '';
  $<HTMLSelectElement>('schedule-mode').value = work ? 'act' : mode;
  $<HTMLSelectElement>('schedule-policy').value = 'prompt';
  $('schedule-policy-field').hidden = work;
  $('schedule-write-hint').hidden = work;
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
  const scheduledSession = sessions.get(sessionId);
  if (!scheduledSession) return;
  const work = !scheduleWriteApprovalChoiceVisible(scheduledSession.kind);
  const selectedMode = (work ? 'act' : $<HTMLSelectElement>('schedule-mode').value) as 'plan' | 'act';
  const approvalPolicy = (work ? 'prompt' : $<HTMLSelectElement>('schedule-policy').value) as 'prompt' | 'auto_write';
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
  const name = window.prompt(session.kind === 'work' ? 'Task name' : 'Session name', session.name);
  if (name === null) return;
  try {
    await invoke('rename_session', { sessionId: session.id, name });
    session.name = name.trim();
    if (activeSessionId === session.id) { $('session-title').textContent = session.name; updateFolderContext(); }
    await refreshSummaries();
  } catch (error) { setStatus(String(error)); }
});

$('delete-session').addEventListener('click', async () => {
  const session = activeSession();
  if (!session || running.has(session.id) || !window.confirm(`Delete ${session.kind === 'work' ? 'task' : 'session'} “${session.name}”? Its folder and files will remain.`)) return;
  try {
    await invoke('delete_session', { sessionId: session.id });
    sessions.delete(session.id); views.delete(session.id); conversationBindings.delete(session.id); composerDrafts.delete(session.id); usageBySession.delete(session.id);
    lastSessionByKind.delete(session.kind);
    if (session.kind === 'code') lastSessionByProject.delete(session.workspace);
    await refreshSummaries();
    if (activeSessionId !== session.id) return;
    enterDraft(session.kind, session.kind === 'code' ? session.workspace : selectedProjectWorkspace);
    const next = sessionForMode(summaries, session.kind, undefined, session.kind === 'code' ? session.workspace : null);
    if (next) await selectSession(next.id, false);
  } catch (error) { setStatus(String(error)); }
});



$('selected-model').addEventListener('click', () => switchPanel('settings'));
$('selected-model').style.cursor = 'pointer';
document.querySelectorAll<HTMLElement>('.panel-heading').forEach((heading) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '◀';
  btn.className = 'text-button panel-close';
  btn.setAttribute('aria-label', 'Close side panel');
  btn.title = 'Close side panel';
  btn.style.marginLeft = 'auto';
  btn.addEventListener('click', closePanel);
  heading.append(btn);
});
const turnListenerReady = listen<TurnEvent>('turn-event', ({ payload }) => {
  const id = payload.session_id;
  if (payload.kind === 'usage') {
    if (payload.usage) usageBySession.set(id, payload.usage);
    if (id === activeSessionId) renderModelUsage();
    return;
  }
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
    setStatus('Approval expired. The requested operation was not run.');
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
  if (!initialized || creatingSession || selectingContext || (activeSessionId && running.has(activeSessionId))) return;
  const text = prompt.value.trim();
  const sent = [...pendingAttachments];
  const submittedDraftKey = draftKey();
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
  const turnMode = activeKind === 'work' ? 'act' : mode;
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
    addDisplay(id, 'You', sent.length ? `${text}\n\n[${sent.map((item) => item.name).join(', ')}]` : text);
    composerDrafts.delete(submittedDraftKey);
    composerDrafts.set(id, { text: '', attachments: [] });
    if (id === activeSessionId) { prompt.value = ''; pendingAttachments = []; renderChips(); }
    if (id === activeSessionId) setStatus('Agent is working…');
    await invoke('start_turn', {
      sessionId: id,
      settings,
      mode: turnMode,
      prompt: text,
      attachments: sent.map(({ id: attachmentId, name, kind }) => ({ id: attachmentId, name, kind })),
    });
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
