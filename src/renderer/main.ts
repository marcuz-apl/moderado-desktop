import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import MarkdownIt from 'markdown-it';
import { lineDiff } from './diff';
import { canSend, selectedModelLabel, sessionForSubmit, shouldAutoScroll } from './composer';
import { defaultModelId, explainProviderError, keylessModelCount, modelOptionLabel, type ModelInfo } from './models';
import { oppositeTheme, parseThemePreference, resolveTheme, type ThemePreference } from './theme';
import appVersion from '../../VERSION?raw';
import { DEFAULT_SESSION_KIND, defaultPanelForKind, newActionLabel, panelAvailableForKind, profileModeDescription, projectNameFromWorkspace, sessionForMode, scheduleWriteApprovalChoiceVisible, sessionsForProject, type SessionKind, type SidebarPanel } from './sessions-view';

export type ProviderId = 'moderado' | 'nvidia_nim' | 'open_router' | 'ollama' | 'lm_studio' | 'other_openai_compatible';
type ProviderPreset = { id: ProviderId; name: string; defaultBaseUrl: string; editableUrl: boolean; local: boolean; keyless: boolean; applyKeyUrl: string | null; applyKeyLabel: string };
type ProviderSettings = { providerId: ProviderId; baseUrl: string; planModel: string; actModel: string };
type AutoApprovePolicy = { readFiles: boolean; editFiles: boolean; fetchWebContent: boolean; executeCommand: boolean; useMcpServers: boolean };
type ModelUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; rateTps: number | null; contextTokens: number | null };
type LocalProviderStatus = { id: ProviderId; available: boolean };
type AttachmentRecord = { id: string; sessionId: string; name: string; kind: 'text' | 'image'; bytes: number };
type HistoryMessage = { role: string; content?: string | Array<{ type?: string; text?: string; name?: string }>; tool_call_id?: string; tool_calls?: Array<{ id: string; function?: { name?: string } }> };
type SessionSummary = { id: string; name: string; workspace: string; kind: SessionKind; taskId: string | null; settings: ProviderSettings; autoApprove: AutoApprovePolicy; updatedAt: number };
type SessionRecord = SessionSummary & { history: HistoryMessage[] };
type DisplayMessage = { role: string; content: string; toolName?: string; toolId?: string; activityState?: 'working' | 'completed' | 'attention'; createdAt?: number };
type TurnEvent = { kind: 'text' | 'tool_started' | 'tool' | 'usage' | 'error' | 'done' | 'cancelled'; session_id: string; tool_id?: string; name?: string; value?: string; usage?: ModelUsage };
type ApprovalEvent = { sessionId: string; id: number; category: 'read_files' | 'edit_files' | 'fetch_web_content' | 'execute_command' | 'use_mcp_servers'; title: string; detail: string; hasPreview: boolean; path: string; before: string; after: string };
type ApprovalExpired = { sessionId: string; id: number };
type Checkpoint = { id: string; sessionId: string; gitRef: string; path: string; createdAt: number };
type CheckpointPreview = { checkpointId: string; currentTree: string; changes: { path: string; before: string; after: string }[] };
type Schedule = { id: string; sessionId: string; prompt: string; mode: 'plan' | 'act'; approvalPolicy: 'prompt' | 'auto_write'; nextRunAt: number; intervalSeconds: number | null; enabled: boolean; inFlight: boolean; lastRunAt: number | null; lastError: string | null };
type SearchSettings = { enabled: boolean; endpoint: string };
type ScheduleStarted = { sessionId: string; scheduleId: string; prompt: string };
type ScheduleRun = { sessionId: string; scheduleId: string; error: string | null };
type ProjectRecord = { workspace: string; name: string; updatedAt: number };
type WorkTaskRecord = { id: string; name: string; workspace: string; updatedAt: number };
type ProjectEntry = { name: string; path: string; isDir: boolean };
type ExplorerOperation = { action: 'new-file' | 'new-folder' | 'rename'; projectWorkspace: string; entry: ProjectEntry | null; parentPath: string };
type CommitSummary = { hash: string; subject: string; author: string; timestamp: number };
type SourceControlSnapshot = { branch: string; changes: string[]; commits: CommitSummary[] };
type GatewayMode = 'prod' | 'dev';

const GATEWAY_URLS: Record<GatewayMode, string> = {
  prod: 'https://modr.alfazen.org/v1',
  dev: 'http://127.0.0.1:4788/v1',
};
const markdown = new MarkdownIt({ html: false, linkify: true });

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
const explorerContextMenu = $<HTMLDivElement>('explorer-context-menu');
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
let selectedWorkTaskId: string | null = null;
const projectEntries = new Map<string, ProjectEntry[]>();
const expandedFolders = new Set<string>();
let selectedExplorerPath: string | null = null;
let pendingExplorerOperation: ExplorerOperation | null = null;
let summaries: SessionSummary[] = [];
let projects: ProjectRecord[] = [];
let workTasks: WorkTaskRecord[] = [];
const expandedProjects = new Set<string>();
const expandedWorkTasks = new Set<string>();
const lastSessionByKind = new Map<SessionKind, string>();
const lastSessionByProject = new Map<string, string>();
const lastSessionByTask = new Map<string, string>();
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

// The window is created hidden (visible: false in tauri.conf.json) so the
// WebView2 default white surface never flashes on launch. Reveal it once the
// themed first paint has happened; the timer covers a paint/rAF that never
// arrives. The Rust side has a matching fallback so the window cannot stay
// invisible.
const revealWindow = (): void => {
  try { void getCurrentWindow().show().catch(() => {}); } catch { /* not running inside Tauri */ }
};
requestAnimationFrame(() => requestAnimationFrame(revealWindow));
setTimeout(revealWindow, 400);
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

function setModelOptions(models: ModelInfo[], planValue: string, actValue: string): void {
  const ids = models.map((model) => model.id);
  const fallback = defaultModelId(models);
  for (const [id, selected] of [['plan-model', planValue], ['act-model', actValue]] as const) {
    const select = $<HTMLSelectElement>(id);
    const options = [new Option('Choose a model', '')];
    for (const model of models) options.push(new Option(modelOptionLabel(model), model.id));
    const value = selected || fallback;
    if (value && !ids.includes(value)) options.push(new Option(value, value));
    select.replaceChildren(...options);
    select.value = value;
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
  keyField.placeholder = preset.keyless ? 'Optional — free models work without a key' : 'Saved in OS keychain';
  $('keyless-hint').hidden = !preset.keyless;
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
    if (message.role === 'tool') return [{ role: 'Activity', content, toolId: message.tool_call_id, toolName: history.flatMap((item) => item.tool_calls ?? []).find((call) => call.id === message.tool_call_id)?.function?.name, activityState: content.startsWith('Error:') ? 'attention' : 'completed' }];
    if (message.role === 'system') return [{ role: 'System', content }];
    if (message.role === 'assistant' && content) {
      if (message.tool_calls?.length) return [{ role: 'Agent', content }];
      const summary = splitTurnSummary(content);
      return [
        ...(summary.response ? [{ role: 'Agent', content: summary.response }] : []),
        { role: 'Turn summary', content: summary.summary },
      ];
    }
    return [];
  });
}

function splitTurnSummary(content: string): { response: string; summary: string } {
  const heading = /^ {0,3}#{1,3}\s+turn summary\s*$/im.exec(content);
  if (!heading || heading.index === undefined) return { response: '', summary: content.trim() };
  const headingEnd = content.indexOf('\n', heading.index);
  return { response: content.slice(0, heading.index).trim(), summary: content.slice(headingEnd < 0 ? content.length : headingEnd + 1).trim() };
}

function activityTitle(name: string | undefined): string {
  const titles: Record<string, string> = {
    list_files: 'Browsed files', read_file: 'Read a file', search_files: 'Searched files',
    write_file: 'Created a file', edit_file: 'Edited a file', execute_command: 'Ran a command', web_search: 'Searched the web',
  };
  return name ? titles[name] ?? name.replaceAll('_', ' ') : 'Tool activity';
}

function messageElement(message: DisplayMessage): HTMLElement {
  if (message.role === 'Activity') {
    const entry = document.createElement('article');
    entry.className = `message activity-entry${message.activityState === 'attention' ? ' needs-attention' : ''}`;
    const track = document.createElement('div'); track.className = 'activity-track'; track.setAttribute('aria-hidden', 'true');
    const marker = document.createElement('span'); marker.className = `activity-marker${message.activityState === 'working' ? ' is-working' : ''}`;
    marker.textContent = message.activityState === 'completed' ? '✓' : message.activityState === 'attention' ? '!' : '';
    track.append(marker);
    const card = document.createElement('div'); card.className = 'activity-card';
    const heading = document.createElement('div'); heading.className = 'activity-heading';
    const title = document.createElement('strong'); title.className = 'activity-title'; title.textContent = activityTitle(message.toolName);
    const state = document.createElement('span'); state.className = 'activity-status';
    state.textContent = message.activityState === 'working' ? 'Working' : message.activityState === 'attention' ? 'Needs attention' : 'Completed';
    const time = document.createElement('time');
    if (message.createdAt) { time.dateTime = new Date(message.createdAt).toISOString(); time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    heading.append(title, state, time); card.append(heading);
    if (message.content) {
      const details = document.createElement('details'); details.className = 'activity-details';
      const summary = document.createElement('summary'); summary.textContent = 'Details';
      const output = document.createElement('pre');
      try { output.textContent = JSON.stringify(JSON.parse(message.content), null, 2); }
      catch { output.textContent = message.content; }
      details.append(summary, output); card.append(details);
    }
    entry.append(track, card);
    return entry;
  }
  const card = document.createElement('article');
  card.className = `message ${message.role.toLowerCase().replaceAll(' ', '-')}`;
  const label = document.createElement('span');
  label.className = 'message-role';
  label.textContent = message.role;
  const body = document.createElement('div');
  body.className = 'message-body';
  if (message.role === 'Agent' || message.role === 'Turn summary') {
    body.classList.add('markdown-body');
    body.innerHTML = markdown.render(message.content);
    body.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.addEventListener('click', (event) => { event.preventDefault(); void openUrl(link.href).catch((error: unknown) => setStatus(String(error))); });
    });
  } else body.textContent = message.content;
  card.append(label, body);
  return card;
}

function setToolActivity(sessionId: string, toolId: string, toolName: string, activityState: 'working' | 'completed' | 'attention', content = ''): void {
  const messages = views.get(sessionId) ?? [];
  let activity = messages.find((message) => message.role === 'Activity' && message.toolId === toolId);
  if (!activity) {
    activity = { role: 'Activity', content, toolId, toolName, activityState, createdAt: Date.now() };
    messages.push(activity);
  } else {
    activity.toolName = toolName;
    activity.content = content;
    activity.activityState = activityState;
  }
  views.set(sessionId, messages);
  if (sessionId === activeSessionId) {
    const stickToBottom = shouldAutoScroll(transcript.scrollTop, transcript.scrollHeight, transcript.clientHeight);
    renderTranscript(!stickToBottom);
  }
}

function renderTranscript(keepReadingPosition = false): void {
  const previousScrollTop = transcript.scrollTop;
  const stickToBottom = !keepReadingPosition || shouldAutoScroll(transcript.scrollTop, transcript.scrollHeight, transcript.clientHeight);
  const messages = activeSessionId ? views.get(activeSessionId) ?? [] : [];
  transcript.replaceChildren(...(messages.length ? messages.map((item) => messageElement(item)) : [emptyState.cloneNode(true)]));
  transcript.scrollTop = stickToBottom ? transcript.scrollHeight : previousScrollTop;
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
    transcript.append(messageElement({ role, content }));
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
  $('task-list').replaceChildren(...workTasks.map((task) => {
    const section = document.createElement('section'); section.className = 'task-group';
    const row = document.createElement('div'); row.className = 'selectable-session-row task-heading';
    const children = summaries.filter((session) => session.kind === 'work' && session.taskId === task.id);
    const expanded = expandedWorkTasks.has(task.id);
    const expander = document.createElement('button'); expander.type = 'button'; expander.className = 'project-expander';
    expander.textContent = expanded ? '▾' : '▸'; expander.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${task.name}`); expander.setAttribute('aria-expanded', String(expanded));
    expander.addEventListener('click', () => { if (expanded) expandedWorkTasks.delete(task.id); else expandedWorkTasks.add(task.id); renderSessions(); });
    const button = document.createElement('button'); button.type = 'button';
    button.className = `session-item${activeKind === 'work' && task.id === selectedWorkTaskId ? ' selected' : ''}`;
    button.textContent = `${children.some((session) => running.has(session.id)) ? '● ' : ''}${task.name}`;
    button.title = `${task.workspace}\n${children.length} sessions`;
    button.addEventListener('click', () => { void selectWorkTask(task.id); });
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'active-work-task'; radio.checked = activeKind === 'work' && task.id === selectedWorkTaskId;
    radio.setAttribute('aria-label', `Select task ${task.name}`);
    radio.addEventListener('change', () => { void selectWorkTask(task.id); });
    row.append(button, expander, radio); section.append(row);
    if (expanded) {
      const list = document.createElement('div'); list.className = 'task-sessions'; list.setAttribute('aria-label', `${task.name} sessions`);
      list.append(...children.map((session) => sessionRow(session, 'active-work-session')));
      if (!children.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No sessions yet.'; list.append(empty); }
      section.append(list);
    }
    return section;
  }));
  if (!workTasks.length) $('task-list').textContent = 'Create a task to begin.';
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
      section.append(list);
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
      ? selectedWorkTaskId ? 'Ask a question or create a document. Files and editable attachment copies stay in this task’s managed folder.' : 'Create or select a task in the Tasks panel, then start a session here.'
      : (selectedProjectWorkspace ? 'Start a new session in this project. Existing project files are available in Explorer.' : 'Create a project folder or open an existing codebase to begin.');
  }
  $('workspace-button').textContent = newActionLabel('tasks');
  $('new-project').textContent = 'New';
  $('new-session').toggleAttribute('hidden', false);
  $('profile-mode-description').textContent = profileModeDescription(activeKind);
  $('profile-work-content').toggleAttribute('hidden', !work);
  $('profile-code-content').toggleAttribute('hidden', work);
  if (activePanel && !panelAvailableForKind(activePanel, activeKind)) switchPanel(defaultPanelForKind(activeKind));

}

function rememberNavigation(): void {
  try { localStorage.setItem('moderado-navigation', JSON.stringify({ work: lastSessionByKind.get('work'), workTask: selectedWorkTaskId, code: lastSessionByKind.get('code'), project: selectedProjectWorkspace })); }
  catch (error) { setStatus(`Navigation preference could not be saved: ${String(error)}`); }
}
function restoreNavigation(): void {
  try {
    const saved: { work?: unknown; workTask?: unknown; code?: unknown; project?: unknown } | null = JSON.parse(localStorage.getItem('moderado-navigation') ?? '{}');
    if (!saved || typeof saved !== 'object') return;
    for (const kind of ['work', 'code'] as const) { const id = saved[kind]; if (typeof id === 'string' && summaries.some((session) => session.id === id && session.kind === kind)) lastSessionByKind.set(kind, id); }
    if (typeof saved.project === 'string' && projects.some((project) => project.workspace === saved.project)) selectedProjectWorkspace = saved.project;
    if (typeof saved.workTask === 'string' && workTasks.some((task) => task.id === saved.workTask)) selectedWorkTaskId = saved.workTask;
    const work = summaries.find((session) => session.id === lastSessionByKind.get('work'));
    if (work?.taskId) lastSessionByTask.set(work.taskId, work.id);
    const code = summaries.find((session) => session.id === lastSessionByKind.get('code'));
    if (code) lastSessionByProject.set(code.workspace, code.id);
  } catch (error) { setStatus(`Navigation preference could not be loaded: ${String(error)}`); }
}
function draftKey(): string { return activeSessionId ?? `${activeKind}:${activeKind === 'code' ? selectedProjectWorkspace ?? '' : selectedWorkTaskId ?? ''}`; }
function saveComposerDraft(): void { composerDrafts.set(draftKey(), { text: prompt.value, attachments: [...pendingAttachments] }); }
function restoreComposerDraft(): void {
  const draft = composerDrafts.get(draftKey()); prompt.value = draft?.text ?? ''; pendingAttachments = draft?.attachments ?? []; renderChips();
}
function currentFolder(): string | null {
  return activeKind === 'code' ? selectedProjectWorkspace : workTasks.find((task) => task.id === selectedWorkTaskId)?.workspace ?? activeSession()?.workspace ?? null;
}
function updateFolderContext(): void {
  const folder = currentFolder();
  const project = projects.find((item) => item.workspace === folder);
  const task = workTasks.find((item) => item.id === selectedWorkTaskId);
  $('workspace-context').textContent = folder ?? (activeKind === 'work' ? 'Select a task to start a session.' : 'Create or open a project folder.');
  $('workspace-context').title = folder ?? '';
  $('project-root-name').textContent = activeKind === 'work' ? task?.name ?? (folder ? projectNameFromWorkspace(folder, 'Task files') : 'No task selected') : project?.name ?? (folder ? projectNameFromWorkspace(folder, 'Project files') : 'No project selected');
}
function enterDraft(kind: SessionKind, workspace: string | null = selectedProjectWorkspace): void {
  selectionRevision++; selectingContext = false; activeSessionId = null; activeKind = kind;
  if (kind === 'code') selectedProjectWorkspace = workspace;
  rememberNavigation();
  $('session-title').textContent = kind === 'work' && !selectedWorkTaskId ? 'Select a task' : 'New Session';
  $('profile-session').textContent = 'No conversation selected'; $('profile-provider').textContent = 'Not configured';
  renderTranscript(); restoreComposerDraft(); applyKindUi(); updateFolderContext(); updateSelectedModel(); renderSessions(); updateControls();
  projectEntries.clear(); expandedFolders.clear();
  if (activePanel === 'workspace') void refreshProjectTree();
  if (activePanel === 'source-control') void refreshSourceControl();
  void refreshCheckpoints(); void refreshSchedules();
  setStatus(kind === 'work' ? selectedWorkTaskId ? 'Start a session in this task.' : 'Create or select a task to begin.' : workspace ? 'Start a session in this project.' : 'Create or open a project to begin.');
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
  if (kind === 'work') {
    const task = workTasks.find((item) => item.id === selectedWorkTaskId) ?? workTasks[0];
    if (task) await selectWorkTask(task.id, false);
    else if (next) await selectSession(next.id, false);
  } else if (next) await selectSession(next.id, false);
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
  [summaries, projects, workTasks] = await Promise.all([invoke<SessionSummary[]>('list_sessions'), invoke<ProjectRecord[]>('list_projects'), invoke<WorkTaskRecord[]>('list_work_tasks')]);
  renderSessions();
}

async function refreshSession(id: string, replaceView = false): Promise<SessionRecord> {
  const record = await invoke<SessionRecord>('get_session', { sessionId: id });
  sessions.set(id, record);
  if (replaceView || !views.has(id)) {
    const previousActivityTimes = new Map((views.get(id) ?? []).filter((message) => message.role === 'Activity' && message.toolId && message.createdAt).map((message) => [message.toolId!, message.createdAt!]));
    const nextView = historyToView(record.history);
    for (const message of nextView) if (message.role === 'Activity' && message.toolId) message.createdAt = previousActivityTimes.get(message.toolId);
    views.set(id, nextView);
  }
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
    else if (record.taskId) { selectedWorkTaskId = record.taskId; lastSessionByTask.set(record.taskId, id); expandedWorkTasks.add(record.taskId); }
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
  send.disabled = !canSend(initialized, busy || creatingSession || selectingContext) || (activeKind === 'code' && !selectedProjectWorkspace) || (activeKind === 'work' && !selectedWorkTaskId);
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
  $<HTMLButtonElement>('new-session').disabled = !initialized || creatingSession || (activeKind === 'code' ? !selectedProjectWorkspace : !selectedWorkTaskId);
  const selectedProject = projects.find((project) => project.workspace === selectedProjectWorkspace);
  const projectSessions = selectedProject ? sessionsForProject(summaries, selectedProject.workspace) : [];
  const selectedTask = activeKind === 'work' ? workTasks.find((task) => task.id === selectedWorkTaskId) : undefined;
  const taskSessions = selectedTask ? summaries.filter((session) => session.kind === 'work' && session.taskId === selectedTask.id) : [];
  $<HTMLButtonElement>('rename-task').disabled = !selectedTask || creatingSession;
  $<HTMLButtonElement>('delete-task').disabled = !selectedTask || creatingSession || taskSessions.some((session) => running.has(session.id));
  $<HTMLButtonElement>('rename-project').disabled = !selectedProject || creatingSession;
  $<HTMLButtonElement>('remove-project').disabled = !selectedProject || creatingSession || projectSessions.some((session) => running.has(session.id));
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
async function selectWorkTask(taskId: string, saveDraft = true): Promise<void> {
  const task = workTasks.find((item) => item.id === taskId);
  if (!task) { setStatus('Task is no longer available.'); return; }
  if (saveDraft) saveComposerDraft();
  selectedWorkTaskId = taskId;
  expandedWorkTasks.add(taskId);
  const children = summaries.filter((session) => session.kind === 'work' && session.taskId === taskId);
  const remembered = lastSessionByTask.get(taskId) ?? (summaries.find((session) => session.id === lastSessionByKind.get('work') && session.taskId === taskId)?.id);
  const next = children.find((session) => session.id === remembered) ?? children[0];
  switchPanel('tasks');
  if (next) await selectSession(next.id, false);
  else {
    enterDraft('work');
    updateFolderContext();
    renderSessions();
    if (activePanel === 'workspace') void refreshProjectTree();
  }
}
function browserArgs(): { sessionId: string | null; projectWorkspace: string | null; workTaskId: string | null } {
  return { sessionId: activeKind === 'work' ? activeSessionId : null, projectWorkspace: activeKind === 'code' ? selectedProjectWorkspace : null, workTaskId: activeKind === 'work' ? selectedWorkTaskId : null };
}

async function loadProjectFolder(path: string): Promise<ProjectEntry[]> {
  const folder = currentFolder(); if (!folder) return [];
  const entries = await invoke<ProjectEntry[]>('list_project_entries', { ...browserArgs(), path });
  if (folder !== currentFolder()) return [];
  projectEntries.set(path, entries); return entries;
}
async function refreshProjectTree(preserveExpanded = false): Promise<void> {
  const tree = $('project-tree'); const folder = currentFolder(); const revision = selectionRevision;
  projectEntries.clear(); if (!preserveExpanded) { expandedFolders.clear(); selectedExplorerPath = null; } updateFolderContext();
  if (!folder) { tree.textContent = 'Select a task or project to browse its files.'; return; }
  tree.textContent = 'Loading files…';
  try {
    await loadProjectFolder('.');
    if (preserveExpanded) {
      for (const path of [...expandedFolders].sort((left, right) => left.split('/').length - right.split('/').length)) {
        try { await loadProjectFolder(path); }
        catch { expandedFolders.delete(path); }
      }
    }
    if (revision === selectionRevision && folder === currentFolder()) renderProjectTree();
  }
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
      if (entry.path === selectedExplorerPath) row.classList.add('selected');
      row.style.paddingLeft = `${12 + depth * 14}px`;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', String(entry.path === selectedExplorerPath));
      row.dataset.path = entry.path;
      if (entry.isDir) {
        const open = expandedFolders.has(entry.path);
        row.setAttribute('aria-expanded', String(open));
        row.textContent = `${open ? '▾' : '▸'}  ${entry.name}`;
        row.addEventListener('click', async () => {
          hideExplorerContextMenu();
          selectedExplorerPath = entry.path;
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
        row.addEventListener('click', () => { hideExplorerContextMenu(); selectedExplorerPath = entry.path; renderProjectTree(); void previewProjectFile(entry); });
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

function hideExplorerContextMenu(): void { explorerContextMenu.hidden = true; }

function parentExplorerPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '.' : path.slice(0, slash) || '.';
}

function openExplorerEntryDialog(operation: ExplorerOperation): void {
  pendingExplorerOperation = operation;
  const isRename = operation.action === 'rename';
  const isFolder = operation.action === 'new-folder' || (isRename && operation.entry?.isDir === true);
  const title = isRename ? `Rename ${operation.entry?.isDir ? 'folder' : 'file'}` : operation.action === 'new-folder' ? 'New folder' : 'New file';
  $('project-entry-kind').textContent = `${operation.projectWorkspace.split(/[\\/]/).pop() || 'PROJECT'} · ${isRename ? operation.entry?.path : operation.parentPath}`;
  $('project-entry-title').textContent = title;
  $('project-entry-location').textContent = isRename ? `In ${parentExplorerPath(operation.entry?.path ?? '.')}` : 'Create inside the selected folder.';
  const name = $<HTMLInputElement>('project-entry-name');
  name.value = isRename && operation.entry ? operation.entry.name : '';
  name.placeholder = isFolder ? 'Folder name' : 'File name';
  $('project-entry-error').textContent = '';
  $('project-entry-error').hidden = true;
  $('save-project-entry').textContent = isRename ? 'Rename' : 'Create';
  const dialog = $<HTMLDialogElement>('project-entry-dialog');
  dialog.showModal();
  name.focus();
  name.select();
}

function showExplorerContextMenu(event: MouseEvent, entry: ProjectEntry | null): void {
  event.preventDefault();
  if (activeKind !== 'code' || !selectedProjectWorkspace) { hideExplorerContextMenu(); return; }
  selectedExplorerPath = entry?.path ?? null;
  renderProjectTree();
  const parentPath = !entry ? '.' : entry.isDir ? entry.path : parentExplorerPath(entry.path);
  const menuActions = new Map(Array.from(explorerContextMenu.querySelectorAll<HTMLButtonElement>('[data-explorer-action]')).map((button) => [button.dataset.explorerAction ?? '', button]));
  menuActions.get('open-file')!.hidden = !entry || entry.isDir;
  menuActions.get('rename')!.hidden = !entry;
  menuActions.get('delete')!.hidden = !entry;
  explorerContextMenu.dataset.parentPath = parentPath;
  explorerContextMenu.dataset.entryPath = entry?.path ?? '';
  explorerContextMenu.hidden = false;
  const bounds = explorerContextMenu.getBoundingClientRect();
  explorerContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
  explorerContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
  menuActions.get('new-file')?.focus();
}

async function runExplorerContextAction(action: string): Promise<void> {
  const workspace = selectedProjectWorkspace;
  if (activeKind !== 'code' || !workspace) return;
  const entryPath = explorerContextMenu.dataset.entryPath ?? '';
  const entry = entryPath ? Array.from(projectEntries.values()).flatMap((items) => items).find((item) => item.path === entryPath) ?? null : null;
  const parentPath = explorerContextMenu.dataset.parentPath || '.';
  hideExplorerContextMenu();
  if (action === 'new-file' || action === 'new-folder' || action === 'rename') {
    openExplorerEntryDialog({ action, projectWorkspace: workspace, entry, parentPath });
    return;
  }
  if (action === 'open-file' && entry && !entry.isDir) { void previewProjectFile(entry); return; }
  if (action !== 'delete' || !entry) return;
  const message = entry.isDir
    ? `Delete folder “${entry.name}” and everything inside it? This cannot be undone.`
    : `Delete file “${entry.name}”? This cannot be undone.`;
  if (!window.confirm(message)) return;
  try {
    await invoke('delete_project_entry', { projectWorkspace: workspace, path: entry.path });
    if (selectedExplorerPath === entry.path || selectedExplorerPath?.startsWith(`${entry.path}/`)) selectedExplorerPath = null;
    for (const path of [...expandedFolders]) if (path === entry.path || path.startsWith(`${entry.path}/`)) expandedFolders.delete(path);
    const previewPath = $('file-preview-path').textContent;
    if (previewPath === entry.path || previewPath?.startsWith(`${entry.path}/`)) $<HTMLDialogElement>('file-preview-dialog').close();
    if (selectedProjectWorkspace === workspace) await refreshProjectTree(true);
    setStatus(`${entry.isDir ? 'Folder' : 'File'} deleted.`);
  } catch (error) { setStatus(`Could not delete ${entry.name}: ${String(error)}`); }
}

explorerContextMenu.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-explorer-action]');
  if (button) void runExplorerContextAction(button.dataset.explorerAction ?? '');
});

$<HTMLDivElement>('project-tree').addEventListener('contextmenu', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLButtonElement>('.tree-row');
  showExplorerContextMenu(event, row ? Array.from(projectEntries.values()).flatMap((items) => items).find((entry) => entry.path === row.dataset.path) ?? null : null);
});

document.addEventListener('pointerdown', (event) => {
  if (!explorerContextMenu.contains(event.target as Node)) hideExplorerContextMenu();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideExplorerContextMenu(); });

$<HTMLButtonElement>('cancel-project-entry').addEventListener('click', () => $<HTMLDialogElement>('project-entry-dialog').close());
$<HTMLFormElement>('project-entry-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const operation = pendingExplorerOperation;
  if (!operation) return;
  const name = $<HTMLInputElement>('project-entry-name').value;
  const save = $<HTMLButtonElement>('save-project-entry');
  const error = $('project-entry-error');
  error.hidden = true;
  save.disabled = true;
  try {
    if (operation.action === 'new-file') {
      await invoke('create_project_file', { projectWorkspace: operation.projectWorkspace, parentPath: operation.parentPath, name });
      selectedExplorerPath = operation.parentPath === '.' ? name : `${operation.parentPath}/${name}`;
    } else if (operation.action === 'new-folder') {
      await invoke('create_project_folder', { projectWorkspace: operation.projectWorkspace, parentPath: operation.parentPath, name });
      selectedExplorerPath = operation.parentPath === '.' ? name : `${operation.parentPath}/${name}`;
    } else if (operation.entry) {
      const oldPath = operation.entry.path;
      await invoke('rename_project_entry', { projectWorkspace: operation.projectWorkspace, path: oldPath, newName: name });
      const nextPath = parentExplorerPath(oldPath) === '.' ? name : `${parentExplorerPath(oldPath)}/${name}`;
      selectedExplorerPath = nextPath;
      for (const path of [...expandedFolders]) {
        if (path === oldPath || path.startsWith(`${oldPath}/`)) {
          expandedFolders.delete(path);
          expandedFolders.add(path === oldPath ? nextPath : `${nextPath}${path.slice(oldPath.length)}`);
        }
      }
    }
    if (operation.parentPath !== '.') expandedFolders.add(operation.parentPath);
    pendingExplorerOperation = null;
    $<HTMLDialogElement>('project-entry-dialog').close();
    if (selectedProjectWorkspace === operation.projectWorkspace) await refreshProjectTree(true);
    setStatus(operation.action === 'rename' ? 'Explorer item renamed.' : `${operation.action === 'new-folder' ? 'Folder' : 'File'} created.`);
  } catch (cause) {
    error.textContent = String(cause);
    error.hidden = false;
  } finally { save.disabled = false; }
});

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
    switchPanel(defaultPanelForKind(DEFAULT_SESSION_KIND));
    const restoredTask = workTasks.find((task) => task.id === selectedWorkTaskId);
    if (restoredTask) await selectWorkTask(restoredTask.id, false);
    else {
      const firstWorkSession = sessionForMode(summaries, DEFAULT_SESSION_KIND, lastSessionByKind.get(DEFAULT_SESSION_KIND));
      if (firstWorkSession) await selectSession(firstWorkSession.id);
      else await createSession(currentSettings(), DEFAULT_SESSION_KIND);
    }
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
$<HTMLElement>('about-version').textContent = appVersion.trim().split('+')[0] || appVersion.trim();

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
    const models = await invoke<ModelInfo[]>('discover_models', { providerId: settings.providerId, baseUrl: settings.baseUrl });
    if (settings.providerId === activeProvider && settings.baseUrl === endpoint.value.trim()) {
      const first = defaultModelId(models);
      const planModel = $<HTMLSelectElement>('plan-model').value || first;
      const actModel = $<HTMLSelectElement>('act-model').value || first;
      setModelOptions(models, planModel, actModel);
    }
    const keyless = keylessModelCount(models);
    setStatus(models.length
      ? `${models.length} models available${keyless ? ` · ${keyless} work without a key` : ''}.`
      : 'The endpoint returned no models.');
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

async function createSession(settings: ProviderSettings, kind: SessionKind = activeKind, workspace: string | null = selectedProjectWorkspace, taskId: string | null = selectedWorkTaskId): Promise<string> {
  if (!initialized || creatingSession) throw new Error('Session setup is already in progress.');
  if (kind === 'code' && !workspace) throw new Error('Create or open a project first.');
  const text = prompt.value;
  const revision = selectionRevision;
  creatingSession = true; updateControls();
  try {
    const record = kind === 'work'
      ? taskId ? await invoke<SessionRecord>('create_work_session_for_task', { taskId, settings }) : await invoke<SessionRecord>('create_default_session', { settings, kind })
      : await invoke<SessionRecord>('create_session_in_project', { projectWorkspace: workspace, settings });
    sessions.set(record.id, record); views.set(record.id, []);
    if (record.taskId) selectedWorkTaskId = record.taskId;
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
  saveComposerDraft(); creatingSession = true; updateControls();
  try {
    const task = await invoke<WorkTaskRecord>('create_work_task');
    await refreshSummaries(); selectedWorkTaskId = task.id; expandedWorkTasks.add(task.id); lastSessionByTask.delete(task.id); rememberNavigation();
    prompt.value = ''; pendingAttachments = []; renderChips(); enterDraft('work'); switchPanel('tasks');
    setStatus(`Task “${task.name}” created. Create a session in the workspace to begin.`);
  } catch (error) { setStatus(String(error)); }
  finally { creatingSession = false; renderSessions(); updateControls(); }
});

async function renameWorkTask(task: WorkTaskRecord): Promise<void> {
  const name = window.prompt('Task name', task.name);
  if (name === null) return;
  try { await invoke('rename_work_task', { taskId: task.id, name }); await refreshSummaries(); updateFolderContext(); }
  catch (error) { setStatus(String(error)); }
}

async function removeWorkTask(task: WorkTaskRecord): Promise<void> {
  if (!window.confirm(`Delete task “${task.name}” and its sessions from Moderado? Its managed folder and files will remain.`)) return;
  const wasSelected = selectedWorkTaskId === task.id;
  try {
    const removed = await invoke<string[]>('delete_work_task', { taskId: task.id });
    for (const id of removed) { sessions.delete(id); views.delete(id); conversationBindings.delete(id); composerDrafts.delete(id); usageBySession.delete(id); running.delete(id); }
    lastSessionByTask.delete(task.id);
    if (removed.includes(lastSessionByKind.get('work') ?? '')) lastSessionByKind.delete('work');
    await refreshSummaries();
    if (!wasSelected) return;
    selectedWorkTaskId = null; rememberNavigation();
    if (activeKind === 'work') {
      const next = workTasks[0];
      if (next) await selectWorkTask(next.id, false);
      else { enterDraft('work'); updateFolderContext(); }
    }
  } catch (error) { setStatus(String(error)); }
}

$('rename-task').addEventListener('click', () => { const task = workTasks.find((item) => item.id === selectedWorkTaskId); if (task) void renameWorkTask(task); });
$('delete-task').addEventListener('click', () => { const task = workTasks.find((item) => item.id === selectedWorkTaskId); if (task) void removeWorkTask(task); });

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
$('new-session').addEventListener('click', () => {
  if (activeKind === 'work') {
    if (selectedWorkTaskId) void createSession(currentSettings(), 'work', null, selectedWorkTaskId).catch((error) => setStatus(String(error)));
  } else if (selectedProjectWorkspace) void newProjectSession(selectedProjectWorkspace);
});
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
$('rename-project').addEventListener('click', () => {
  const project = projects.find((item) => item.workspace === selectedProjectWorkspace);
  if (project) void renameProject(project);
});
$('remove-project').addEventListener('click', () => {
  const project = projects.find((item) => item.workspace === selectedProjectWorkspace);
  if (project) void removeProject(project);
});

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
  const name = window.prompt('Session name', session.name);
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
  if (!session || running.has(session.id) || !window.confirm(`Delete session “${session.name}”? Its task/project folder and files will remain.`)) return;
  try {
    await invoke('delete_session', { sessionId: session.id });
    sessions.delete(session.id); views.delete(session.id); conversationBindings.delete(session.id); composerDrafts.delete(session.id); usageBySession.delete(session.id);
    lastSessionByKind.delete(session.kind);
    if (session.kind === 'code') lastSessionByProject.delete(session.workspace);
    if (session.taskId && lastSessionByTask.get(session.taskId) === session.id) lastSessionByTask.delete(session.taskId);
    await refreshSummaries();
    if (activeSessionId !== session.id) return;
    enterDraft(session.kind, session.kind === 'code' ? session.workspace : selectedProjectWorkspace);
    const next = session.kind === 'work'
      ? summaries.find((item) => item.kind === 'work' && item.taskId === session.taskId)
      : sessionForMode(summaries, session.kind, undefined, session.workspace);
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
  else if (payload.kind === 'tool_started') setToolActivity(id, payload.tool_id ?? '', payload.name ?? '', 'working');
  else if (payload.kind === 'tool') setToolActivity(id, payload.tool_id ?? '', payload.name ?? '', payload.value?.startsWith('Error:') ? 'attention' : 'completed', payload.value ?? '');
  else if (payload.kind === 'error') {
    if (!scheduledPending.has(id)) running.delete(id);
    if (id === activeSessionId) setStatus(explainProviderError(payload.value ?? 'Turn failed.', providers.find((provider) => provider.id === activeProvider)));
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
    const detail = explainProviderError(String(error), providers.find((provider) => provider.id === activeProvider));
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
