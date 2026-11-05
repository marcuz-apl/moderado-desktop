import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import MarkdownIt from 'markdown-it';
import { lineDiff } from './diff';
import { canSend, selectedModelLabel, sessionForSubmit, shouldAutoScroll } from './composer';
import { defaultModelId, explainProviderError, keylessModelCount, modelOptionLabel, type ModelInfo } from './models';
import { parseMcpArgs, parseMcpEnv, parseMcpTools } from './mcp-config';
import { EMPTY_RECALL, canRecall, recall, type RecallState } from './prompt-history';
import { applyMention, filterFiles, mentionQuery } from './mention';
import { parseFontFamily, parseTextSize, parseUiScale, zoomFor, type FontFamily, type TextSize, type UiScale } from './appearance';
import { applyLanguage, DEFAULT_LANGUAGE, parseLanguage, t, translateTree, type Language } from './i18n';
import { LIGHT_FROM_HOUR, LIGHT_UNTIL_HOUR, nextThemePreference, parseThemePreference, resolveTheme, type ThemePreference } from './theme';
import appVersion from '../../VERSION?raw';
import manual from '../../docs/manual.md?raw';
import { displayPath, folderContextLabel, parseGitView, parseLeftView, parseSessionKind, projectNameFromWorkspace, sessionForMode, sessionLabel, sessionStamp, scheduleWriteApprovalChoiceVisible, sessionsForProject, startupSessionKind, type SessionKind, type LeftView, type GitView, type AppPage } from './sessions-view';
import { nextMenuIndex, toolDisabledReason, type ToolAction } from './tools-menu';
import {
  artifactsFromActivity,
  backgroundRows,
  checkpointUpdates,
  mergeUpdates,
  shortText,
  turnUpdate,
  updatesFromActivity,
  type MonitorRun,
} from './task-monitor';

export type ProviderId = 'moderado' | 'nvidia_nim' | 'open_router' | 'ollama' | 'lm_studio' | 'other_openai_compatible';
type ProviderPreset = { id: ProviderId; name: string; defaultBaseUrl: string; local: boolean; keyless: boolean; applyKeyUrl: string | null; applyKeyLabel: string };
type ProviderSettings = { providerId: ProviderId; baseUrl: string; planModel: string; actModel: string };
type AutoApprovePolicy = { readFiles: boolean; editFiles: boolean; fetchWebContent: boolean; executeCommand: boolean; useMcpServers: boolean };
type ModelUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; rateTps: number | null; contextTokens: number | null };
type LocalProviderStatus = { id: ProviderId; available: boolean };
type AttachmentRecord = { id: string; sessionId: string; name: string; kind: 'text' | 'image'; bytes: number };
type HistoryMessage = { role: string; content?: string | Array<{ type?: string; text?: string; name?: string }>; tool_call_id?: string; tool_calls?: Array<{ id: string; function?: { name?: string } }> };
type SessionSummary = { id: string; name: string; workspace: string; kind: SessionKind; taskId: string | null; settings: ProviderSettings; autoApprove: AutoApprovePolicy; updatedAt: number; createdAt: number };
type SessionRecord = SessionSummary & { history: HistoryMessage[] };
type DisplayMessage = { role: string; content: string; toolName?: string; toolId?: string; activityState?: 'working' | 'completed' | 'attention'; createdAt?: number };
type TurnEvent = { kind: 'text' | 'tool_started' | 'tool' | 'usage' | 'error' | 'done' | 'cancelled'; session_id: string; tool_id?: string; name?: string; value?: string; usage?: ModelUsage };
type ApprovalEvent = { sessionId: string; id: number; category: 'read_files' | 'edit_files' | 'fetch_web_content' | 'execute_command' | 'use_mcp_servers'; title: string; detail: string; hasPreview: boolean; path: string; before: string; after: string };
type ApprovalExpired = { sessionId: string; id: number };
type Checkpoint = { id: string; sessionId: string; gitRef: string; path: string; createdAt: number };
type CheckpointPreview = { checkpointId: string; currentTree: string; changes: { path: string; before: string; after: string }[] };
type Schedule = { id: string; sessionId: string; prompt: string; mode: 'plan' | 'act'; approvalPolicy: 'prompt' | 'auto_write'; nextRunAt: number; intervalSeconds: number | null; enabled: boolean; inFlight: boolean; lastRunAt: number | null; lastError: string | null };
type ScheduleStarted = { sessionId: string; scheduleId: string; prompt: string };
type ScheduleRun = { sessionId: string; scheduleId: string; error: string | null };
type ProjectRecord = { workspace: string; name: string; updatedAt: number };
type WorkTaskRecord = { id: string; name: string; workspace: string; updatedAt: number };
type ProjectEntry = { name: string; path: string; isDir: boolean };
type ExplorerOperation = { action: 'new-file' | 'new-folder' | 'rename'; projectWorkspace: string; entry: ProjectEntry | null; parentPath: string };
type CommitSummary = { hash: string; subject: string; author: string; timestamp: number };
type SourceControlSnapshot = { branch: string; changes: string[]; commits: CommitSummary[] };
type GitIdentity = { name: string; email: string; branch: string; remote: string | null; credential: 'ready' | 'missing' | 'none' | 'unknown'; detail: string };
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
const themeSelect = $<HTMLSelectElement>('theme-mode');
const attachButton = $<HTMLButtonElement>('attach-files');
const mentionButton = $<HTMLButtonElement>('mention-files');
const attachmentChips = $<HTMLDivElement>('attachment-chips');
const explorerContextMenu = $<HTMLDivElement>('explorer-context-menu');
const approvalDialog = $<HTMLDialogElement>('approval-dialog');
const restoreDialog = $<HTMLDialogElement>('restore-dialog');
const scheduleDialog = $<HTMLDialogElement>('schedule-dialog');
const importDialog = $<HTMLDialogElement>('import-dialog');
// Captured in English before the active language is applied; each clone is
// translated for the language that is active when it is shown.
const emptyState = $('empty-state').cloneNode(true) as HTMLElement;
const languageStorageKey = 'moderado-language';
let language: Language = parseLanguage(localStorage.getItem(languageStorageKey));
applyLanguage(language);

let providers: ProviderPreset[] = [];
const usageBySession = new Map<string, ModelUsage>();
const lastKindKey = 'moderado-last-kind';
/** Start in the mode you left, the way WorkBuddy does, not always in Work. */
let activeKind: SessionKind = parseSessionKind(localStorage.getItem(lastKindKey));
let pendingAttachments: AttachmentRecord[] = [];
/** Questions typed while a turn runs wait here, one queue per session. */
type QueuedTurn = { key: string; text: string; attachments: AttachmentRecord[] };
const queuedTurns = new Map<string, QueuedTurn[]>();
/** A drain is in flight for these sessions, so two events cannot dispatch twice. */
const dispatchingQueuedTurn = new Set<string>();
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
/** The rail destination that owns the Left Pane, remembered like the mode. */
const leftViewKey = 'moderado-left-view';
let activeLeftView: LeftView = parseLeftView(localStorage.getItem(leftViewKey));
/** Files shows the Preview sub-view instead of the tree. */
let previewOpen = false;
/** The tab inside the Git destination. */
const gitViewKey = 'moderado-git-view';
let gitView: GitView = parseGitView(localStorage.getItem(gitViewKey));
/** The Tools menu popover, closed until the topbar button asks for it. */
let toolsOpen = false;
// Declared with the rest of the state: applyTheme() runs at load and reads pty.
let pty: Pty | null = null;
let terminalEventsBound = false;
/** The terminal drawer below the composer, closed until asked for. */
let terminalOpen = false;
let activePage: AppPage | null = null;
/** The bottom rail button that opened the current page, so Back can return focus to it. */
let pageOrigin: HTMLElement | null = null;
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
const promptHistory = new Map<string, string[]>();
const mentionFiles = new Map<string, string[]>();
const mentionMenu = $<HTMLDivElement>('mention-menu');
let mentionState: { start: number; end: number; items: string[]; index: number } | null = null;
let mentionRequest = 0;
const PROMPT_HISTORY_LIMIT = 100;
let recallState: RecallState = { ...EMPTY_RECALL };
let selectionRevision = 0;
let selectingContext = false;
let autoApproveSaveRevision = 0;
let autoApproveSaveQueue: Promise<void> = Promise.resolve();
const sessions = new Map<string, SessionRecord>();
const views = new Map<string, DisplayMessage[]>();
const running = new Set<string>();
const scheduledPending = new Map<string, number>();
/** What each running session is doing, for the task monitor's process rows. */
const runInfo = new Map<string, MonitorRun>();
/** The last list each refresh saw, so the monitor renders without a second invoke. */
const schedulesBySession = new Map<string, Schedule[]>();
const checkpointsBySession = new Map<string, Checkpoint[]>();
/** How the last turn in each session ended, for the monitor's turn row. */
const turnCompleted = new Map<string, { at: number; stopped: boolean }>();
/** The right-hand monitor, closed until the Tools menu or a stored preference asks for it. */
let taskMonitorOpen = false;
/** A manual open survives a mode switch; an auto-open does not. */
const taskMonitorPinKey = 'moderado-task-monitor-pinned';
let taskMonitorPinned = localStorage.getItem(taskMonitorPinKey) === 'true';
const approvalQueue: ApprovalEvent[] = [];
const modeBySession = new Map<string, 'plan' | 'act'>();
const providerDrafts = new Map<ProviderId, Omit<ProviderSettings, 'providerId'>>();
const conversationBindings = new Map<string, string>();
const btwHistory = new Map<string, Array<{ question: string; answer: string }>>();

function setStatus(message: string): void {
  status.textContent = message;
  translateTree(status);
}
const fontFamilyKey = 'moderado-font-family';
const textSizeKey = 'moderado-text-size';
const uiScaleKey = 'moderado-ui-scale';
let fontFamily: FontFamily = parseFontFamily(localStorage.getItem(fontFamilyKey));
let textSize: TextSize = parseTextSize(localStorage.getItem(textSizeKey));
/** The retired Display size stored a percentage; parseUiScale keeps its intent. */
let uiScale: UiScale = parseUiScale(localStorage.getItem(uiScaleKey) ?? localStorage.getItem('moderado-display-size'));
/** Font and text size reach CSS as root attributes; one zoom scales the window. */
function applyAppearance(): void {
  const root = document.documentElement;
  root.dataset.font = fontFamily;
  root.dataset.textSize = textSize;
  root.style.zoom = zoomFor(uiScale);
}
applyAppearance();
const themeStorageKey = 'moderado-theme';
let themePreference: ThemePreference = 'auto';
try { themePreference = parseThemePreference(localStorage.getItem(themeStorageKey)); }
catch (error) { setStatus(`Theme preference could not be loaded: ${String(error)}`); }

let syncedWindowTheme: string | null = null;
function applyTheme(): void {
  const theme = resolveTheme(themePreference, new Date());
  const next = nextThemePreference(themePreference);
  themeSelect.value = themePreference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  if (theme !== syncedWindowTheme) {
    syncedWindowTheme = theme;
    // The native caption is drawn by Windows, not CSS, so it follows on demand.
    void invoke('set_window_theme', { theme }).catch(() => { /* not running inside Tauri */ });
  }
  if (pty) pty.terminal.options.theme = terminalTheme();
  themeToggle.dataset.themeMode = themePreference;
  themeToggle.setAttribute('aria-label', `Theme: ${themePreference}${themePreference === 'auto' ? `, ${theme} now` : ''}. Switch to ${next} theme.`);
  themeToggle.title = themePreference === 'auto'
    ? `Theme: auto — ${theme} now (light ${LIGHT_FROM_HOUR}:00–${LIGHT_UNTIL_HOUR}:00) — switch to light`
    : `Theme: ${themePreference} — switch to ${next}`;
}

const fontSelect = $<HTMLSelectElement>('font-family');
fontSelect.value = fontFamily;
fontSelect.addEventListener('change', () => {
  fontFamily = parseFontFamily(fontSelect.value);
  try { localStorage.setItem(fontFamilyKey, fontFamily); } catch { /* the setting still applies for this run */ }
  applyAppearance();
});
const textSizeSelect = $<HTMLSelectElement>('text-size');
textSizeSelect.value = textSize;
textSizeSelect.addEventListener('change', () => {
  textSize = parseTextSize(textSizeSelect.value);
  try { localStorage.setItem(textSizeKey, textSize); } catch { /* the setting still applies for this run */ }
  applyAppearance();
});
const uiScaleSelect = $<HTMLSelectElement>('ui-scale');
uiScaleSelect.value = uiScale;
uiScaleSelect.addEventListener('change', () => {
  uiScale = parseUiScale(uiScaleSelect.value);
  try { localStorage.setItem(uiScaleKey, uiScale); } catch { /* the setting still applies for this run */ }
  applyAppearance();
});
const languageSelect = $<HTMLSelectElement>('language');
languageSelect.value = language;
languageSelect.addEventListener('change', () => {
  language = parseLanguage(languageSelect.value);
  try { localStorage.setItem(languageStorageKey, language); } catch { /* the switch still applies for this run */ }
  applyLanguage(language);
  refreshLanguageUi();
});
/** Rebuilds the copy that render code writes, in the newly chosen language. */
function refreshLanguageUi(): void {
  applyKindUi();
  renderSessions();
  updateFolderContext();
  updateControls();
  applyAccount();
  // The render code writes English; one pass converts everything it rebuilt.
  translateTree(document.body);
}
themeSelect.addEventListener('change', () => {
  themePreference = parseThemePreference(themeSelect.value);
  applyTheme();
  try { localStorage.setItem(themeStorageKey, themePreference); }
  catch (error) { setStatus(`Theme preference could not be saved: ${String(error)}`); }
});
$('docs-content').innerHTML = markdown.render(manual);
for (const id of ['close-page', 'close-docs']) {
  $(id).addEventListener('click', leavePage);
}
themeToggle.addEventListener('click', () => {
  themePreference = nextThemePreference(themePreference);
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
  // The User pane follows the gateway: each one has its own signed-in email.
  if (changed) refreshAccount();
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
    // A customized Moderado Base URL survives reselecting the provider.
    if (draft?.baseUrl) endpoint.value = draft.baseUrl;
  } else {
    endpoint.value = draft?.baseUrl ?? preset.defaultBaseUrl;
  }
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
  refreshAccount();
  if (activeSession()) setStatus(`${preset.name} selected. Changing provider starts a new conversation on the next task.`);
}

function applySessionSettings(settings: ProviderSettings): void {
  selectProvider(settings.providerId);
  if (settings.providerId === 'moderado') {
    setGatewayMode(settings.baseUrl === GATEWAY_URLS.dev ? 'dev' : 'prod', false);
  }
  endpoint.value = settings.baseUrl;
  setModelOptions([], settings.planModel, settings.actModel);
  refreshAccount();
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

/** A fresh English template clone, shown in the active language. */
function emptyStateNode(): Node {
  const node = emptyState.cloneNode(true) as HTMLElement;
  translateTree(node);
  return node;
}

function renderTranscript(keepReadingPosition = false): void {
  const previousScrollTop = transcript.scrollTop;
  const stickToBottom = !keepReadingPosition || shouldAutoScroll(transcript.scrollTop, transcript.scrollHeight, transcript.clientHeight);
  const messages = activeSessionId ? views.get(activeSessionId) ?? [] : [];
  transcript.replaceChildren(...(messages.length ? messages.map((item) => messageElement(item)) : [emptyStateNode()]));
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
  radio.setAttribute('aria-label', `Select ${sessionLabel(session)}`);
  radio.addEventListener('change', () => { void selectSession(session.id); });
  const button = document.createElement('button'); button.type = 'button';
  button.className = `session-item${session.id === activeSessionId ? ' selected' : ''}`;
  button.textContent = `${running.has(session.id) ? '● ' : ''}${sessionLabel(session)}`;
  button.title = displayPath(session.workspace);
  button.addEventListener('click', () => { void selectSession(session.id); });
  row.append(button, radio); return row;
}

type LibraryEntry = { kind: SessionKind; key: string; name: string; workspace: string; updatedAt: number };

/** Tasks and projects in one list, newest first, so the panel never swaps. */
function libraryEntries(): LibraryEntry[] {
  return [
    ...workTasks.map((task) => ({ kind: 'work' as const, key: task.id, name: task.name, workspace: task.workspace, updatedAt: task.updatedAt })),
    ...projects.map((project) => ({ kind: 'code' as const, key: project.workspace, name: project.name, workspace: project.workspace, updatedAt: project.updatedAt })),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
}

function entryExpanded(entry: LibraryEntry): boolean {
  return entry.kind === 'work' ? expandedWorkTasks.has(entry.key) : expandedProjects.has(entry.key);
}

function toggleEntry(entry: LibraryEntry): void {
  const expanded = entry.kind === 'work' ? expandedWorkTasks : expandedProjects;
  if (expanded.has(entry.key)) expanded.delete(entry.key); else expanded.add(entry.key);
  renderSessions();
}

/** Which container the list has selected, so the action row can follow it. */
function selectedEntryKind(): SessionKind | null {
  if (activeKind === 'work') return selectedWorkTaskId ? 'work' : null;
  return selectedProjectWorkspace ? 'code' : null;
}

/** Task actions for a selected task, project actions for a selected project. */
function applyLibraryActions(): void {
  const kind = selectedEntryKind() ?? activeKind;
  $('task-operations').toggleAttribute('hidden', kind !== 'work');
  $('project-operations').toggleAttribute('hidden', kind !== 'code');
}

function renderSessions(): void {
  const entries = libraryEntries();
  $('library-list').replaceChildren(...entries.map((entry) => {
    const work = entry.kind === 'work';
    const children = work
      ? summaries.filter((session) => session.kind === 'work' && session.taskId === entry.key)
      : sessionsForProject(summaries, entry.workspace);
    const expanded = entryExpanded(entry);
    const section = document.createElement('section');
    section.className = work ? 'task-group' : 'project-group';
    const row = document.createElement('div');
    row.className = `selectable-session-row ${work ? 'task-heading' : 'project-heading'}`;
    const expander = document.createElement('button');
    expander.type = 'button';
    expander.className = 'project-expander';
    expander.textContent = expanded ? '▾' : '▸';
    expander.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${entry.name}`);
    expander.setAttribute('aria-expanded', String(expanded));
    expander.addEventListener('click', () => toggleEntry(entry));
    const button = document.createElement('button');
    button.type = 'button';
    const selected = work
      ? activeKind === 'work' && entry.key === selectedWorkTaskId
      : activeKind === 'code' && entry.key === selectedProjectWorkspace;
    button.className = `session-item library-entry${selected ? ' selected' : ''}`;
    const badge = document.createElement('span');
    badge.className = 'library-badge';
    badge.textContent = work ? 'Work' : 'Code';
    const name = document.createElement('span');
    name.className = 'library-name';
    name.textContent = `${children.some((session) => running.has(session.id)) ? '● ' : ''}${entry.name}`;
    // Name first so it reads from the row's left edge; the kind tag sits at the end.
    button.append(name, badge);
    button.title = `${displayPath(entry.workspace)}\n${children.length} sessions`;
    button.addEventListener('click', () => { if (work) void selectWorkTask(entry.key); else void selectProject(entry.workspace); });
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'active-library-entry';
    radio.checked = selected;
    radio.setAttribute('aria-label', `Select ${work ? 'task' : 'project'} ${entry.name}`);
    radio.addEventListener('change', () => { if (work) void selectWorkTask(entry.key); else void selectProject(entry.workspace); });
    row.append(expander, button, radio);
    section.append(row);
    if (expanded) {
      const list = document.createElement('div');
      list.className = work ? 'task-sessions' : 'project-sessions';
      list.setAttribute('aria-label', `${entry.name} sessions`);
      list.append(...children.map((session) => sessionRow(session, work ? 'active-work-session' : 'active-code-session')));
      if (!children.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No sessions yet.'; list.append(empty); }
      section.append(list);
    }
    return section;
  }));
  if (!entries.length) $('library-list').textContent = 'Create a task or open a project to begin.';
  applyLibraryActions();
}

function applyKindUi(): void {
  const work = activeKind === 'work';
  for (const kind of ['work', 'code'] as const) {
    const button = $<HTMLButtonElement>(`kind-${kind}`);
    const selected = kind === activeKind;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  // One list holds both kinds, so only the action row follows what is selected.
  applyLibraryActions();
  // The workspace manages sessions in both modes; tasks are created in the Library.
  $('session-eyebrow').textContent = 'AGENT SESSION';
  $('new-session').textContent = 'New Session';
  // Plan/Act changes what the agent may do in a Code workspace; Work tasks
  // always run in Act, so the selector is hidden rather than disabled.
  $('agent-mode').toggleAttribute('hidden', work);
  // The approval toggles keep the footer's shape before a session exists;
  // they stay visible, disabled, and say when they take effect.
  const approvals = $('auto-approve-group');
  approvals.removeAttribute('hidden');
  approvals.title = activeSessionId ? '' : work ? 'Start with the next task.' : 'Start with the next session.';
  // Work tasks run sandboxed commands too (a python conversion, say), so the
  // Run commands toggle shows there as well; MCP servers stay Code-only.
  $('approve-mcp-option').toggleAttribute('hidden', work);
  // Work tasks own no repository, so the Git icon leaves the rail entirely
  // instead of sitting there dimmed and unclickable. This also covers session
  // selection changing the kind, which does not re-run applyLeftView.
  document.querySelector<HTMLElement>('.rail-tabs .rail-tab[data-rail="git"]')
    ?.toggleAttribute('hidden', work);
  // "+" attaches a file's content in both modes; "@" references a project file.
  attachButton.disabled = selectingContext || !activeSessionId;
  attachButton.title = 'Attach files';
  attachButton.setAttribute('aria-label', 'Attach files');
  mentionButton.disabled = selectingContext || work || (!activeSessionId && !selectedProjectWorkspace);
  const mentionLabel = work ? 'File references are available in Code sessions' : 'Reference a project file';
  mentionButton.title = mentionLabel;
  mentionButton.setAttribute('aria-label', mentionLabel);
  document.querySelector<HTMLElement>('.session-context')?.toggleAttribute('hidden', work);
  prompt.placeholder = work ? 'Describe the task or document you need…' : 'What should the agent work on in this project?';
  const emptyCopy = document.getElementById('empty-state-copy');
  if (emptyCopy) {
    emptyCopy.textContent = work
      ? selectedWorkTaskId ? 'Ask a question or create a document. Files and editable attachment copies stay in this task’s managed folder.' : 'Create or select a task in the Library, then start a session here.'
      : (selectedProjectWorkspace ? 'Start a new session in this project. Existing project files are available in Explorer.' : 'Create a project folder or open an existing codebase to begin.');
  }
  $('new-project').textContent = 'New Project';
  $('new-session').toggleAttribute('hidden', false);
  $('profile-git').toggleAttribute('hidden', work);
  // The shell is Code-only, like every other command path.
  if (work) void setTerminalOpen(false);
  const terminalNote = document.getElementById('terminal-note');
  if (terminalNote) {
    terminalNote.textContent = work
      ? 'Commands run in Code sessions only.'
      : 'A real shell in the project folder. It runs as you, outside the agent sandbox.';
  }
  syncToolMenu();
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
function saveComposerDraft(): void {
  // While browsing history the box shows a recalled prompt, not what the user
  // typed, so their real draft stays untouched.
  if (recallState.index !== null) return;
  composerDrafts.set(draftKey(), { text: prompt.value, attachments: [...pendingAttachments] });
}
function restoreComposerDraft(): void {
  const draft = composerDrafts.get(draftKey()); prompt.value = draft?.text ?? ''; pendingAttachments = draft?.attachments ?? []; renderChips();
  recallState = { ...EMPTY_RECALL };
  mentionFiles.clear();
}
/** The prompts this session already sent, seeded from its transcript on first use. */
function historyFor(sessionId: string): string[] {
  const cached = promptHistory.get(sessionId);
  if (cached) return cached;
  const seeded = (views.get(sessionId) ?? [])
    .filter((message) => message.role === 'You')
    .map((message) => message.content.replace(/\n\n\[[^\]]*\]$/, '').trim())
    .filter(Boolean)
    .slice(-PROMPT_HISTORY_LIMIT);
  promptHistory.set(sessionId, seeded);
  return seeded;
}
function rememberPrompt(sessionId: string, text: string): void {
  const history = historyFor(sessionId);
  if (history.at(-1) !== text) history.push(text);
  if (history.length > PROMPT_HISTORY_LIMIT) history.splice(0, history.length - PROMPT_HISTORY_LIMIT);
  recallState = { ...EMPTY_RECALL };
}
/** Up/Down recall for the composer, keeping multi-line editing intact. */
function recallPrompt(direction: -1 | 1): boolean {
  const sessionId = activeSessionId;
  if (!sessionId) return false;
  if (!canRecall(prompt.value, prompt.selectionStart, prompt.selectionEnd, direction)) return false;
  const next = recall(historyFor(sessionId), recallState, direction, prompt.value);
  if (!next) return false;
  recallState = next.state;
  prompt.value = next.text;
  prompt.setSelectionRange(next.text.length, next.text.length);
  return true;
}
/** Project files the composer can reference, cached per session or project. */
async function projectFiles(): Promise<string[]> {
  const key = activeSessionId ?? `project:${selectedProjectWorkspace ?? ''}`;
  const cached = mentionFiles.get(key);
  if (cached) return cached;
  const files = await invoke<string[]>('list_project_files', {
    sessionId: activeSessionId,
    workspace: selectedProjectWorkspace,
  });
  mentionFiles.set(key, files);
  return files;
}

function closeMention(): void {
  mentionState = null;
  mentionMenu.hidden = true;
  mentionMenu.replaceChildren();
}

function renderMention(): void {
  if (!mentionState || !mentionState.items.length) { closeMention(); return; }
  const { items, index } = mentionState;
  mentionMenu.replaceChildren(...items.map((path, position) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mention-item';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(position === index));
    button.textContent = path;
    // mousedown keeps focus in the textarea, so the caret survives the click.
    button.addEventListener('mousedown', (event) => { event.preventDefault(); acceptMention(position); });
    return button;
  }));
  mentionMenu.hidden = false;
}

async function openMentions(start: number, end: number, query: string): Promise<void> {
  const request = ++mentionRequest;
  try {
    const files = await projectFiles();
    if (request !== mentionRequest) return;
    mentionState = { start, end, items: filterFiles(files, query), index: 0 };
    renderMention();
  } catch (error) { if (request === mentionRequest) { closeMention(); setStatus(String(error)); } }
}

function acceptMention(position: number): void {
  const state = mentionState;
  const path = state?.items[position];
  if (!state || !path) return;
  const next = applyMention(prompt.value, state.start, state.end, path);
  prompt.value = next.text;
  prompt.setSelectionRange(next.caret, next.caret);
  closeMention();
  prompt.focus();
}

function currentFolder(): string | null {
  return activeKind === 'code' ? selectedProjectWorkspace : workTasks.find((task) => task.id === selectedWorkTaskId)?.workspace ?? activeSession()?.workspace ?? null;
}
function updateFolderContext(): void {
  const folder = currentFolder();
  const project = projects.find((item) => item.workspace === folder);
  const task = workTasks.find((item) => item.id === selectedWorkTaskId);
  $('workspace-context').textContent = folderContextLabel(activeKind, folder, project?.name, task?.name);
  $('workspace-context').title = folder ? displayPath(folder) : '';
  $('project-root-name').textContent = activeKind === 'work' ? task?.name ?? (folder ? projectNameFromWorkspace(folder, 'Task files') : 'No task selected') : project?.name ?? (folder ? projectNameFromWorkspace(folder, 'Project files') : 'No project selected');
  $('project-root-name').title = folder ? displayPath(folder) : '';
  const pathLine = $('project-path');
  pathLine.textContent = folder ? displayPath(folder) : '';
  pathLine.title = folder ? displayPath(folder) : '';
  pathLine.toggleAttribute('hidden', !folder);
}
function enterDraft(kind: SessionKind, workspace: string | null = selectedProjectWorkspace): void {
  selectionRevision++; selectingContext = false; activeSessionId = null; activeKind = kind; closeMention();
  // Settle the view before any refresh reads it: Work cannot show Git.
  if (kind === 'work' && activeLeftView === 'git') activeLeftView = 'library';
  if (kind === 'code') selectedProjectWorkspace = workspace;
  rememberNavigation();
  $('session-title').textContent = kind === 'work' && !selectedWorkTaskId ? 'Select a task' : 'New Session';
  renderTranscript(); restoreComposerDraft(); applyKindUi(); updateFolderContext(); updateSelectedModel(); renderSessions(); updateControls();
  projectEntries.clear(); expandedFolders.clear();
  if (viewingFiles()) void refreshProjectTree();
  if (viewingChanges()) void refreshSourceControl();
  void refreshCheckpoints(); void refreshSchedules();
  setStatus(kind === 'work' ? selectedWorkTaskId ? 'Start a session in this task.' : 'Create or select a task to begin.' : workspace ? 'Start a session in this project.' : 'Create or open a project to begin.');
}
async function setKind(kind: SessionKind): Promise<void> {
  if (kind === activeKind && !selectingContext) { if (activePage) setPageMode(null); return; }
  try { localStorage.setItem(lastKindKey, kind); } catch { /* the mode still switches for this run */ }
  saveComposerDraft();
  const validProjects = new Set(projects.map((project) => project.workspace));
  const candidates = summaries.filter((session) => session.kind === 'work' || validProjects.has(session.workspace));
  const workspace = selectedProjectWorkspace && validProjects.has(selectedProjectWorkspace) ? selectedProjectWorkspace : null;
  const remembered = kind === 'code' && workspace ? lastSessionByProject.get(workspace) : lastSessionByKind.get(kind);
  const next = sessionForMode(candidates, kind, remembered, kind === 'code' ? workspace : null);
  enterDraft(kind, kind === 'code' ? workspace ?? next?.workspace ?? null : workspace);
  // Code is the workspace-heavy mode, so its Right Pane opens with it. Work
  // closes it again unless the user opened the pane by hand.
  if (kind === 'code') setTaskMonitor(true);
  else if (!taskMonitorPinned) setTaskMonitor(false);
  // Only the rail selects the Left Pane view, so switching kind keeps it and persists nothing.
  setPageMode(null);
  previewOpen = false;
  applyLeftView();
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
    $('session-title').textContent = sessionLabel(record);
    renderTranscript(); restoreComposerDraft(); renderQueuedTurns(); applyKindUi(); updateFolderContext(); renderSessions();
    projectEntries.clear(); expandedFolders.clear();
    if (terminalOpen) {
      if (record.kind === 'work') void setTerminalOpen(false);
      else void ensureTerminal();
    }
    await Promise.all([refreshCheckpoints(), refreshSchedules(), viewingFiles() ? refreshProjectTree() : Promise.resolve(), viewingChanges() ? refreshSourceControl() : Promise.resolve()]);
    renderTaskMonitor();
    setStatus(running.has(id) ? 'Agent is working…' : record.kind === 'work' ? 'Task ready.' : 'Session ready.');
    // Coming back to a session with waiting questions starts the first one.
    if (!running.has(id)) void drainQueuedTurn(id);
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
  // Sending stays available while a turn runs: the question waits in the queue.
  send.disabled = !canSend(initialized, creatingSession || selectingContext) || (activeKind === 'code' && !selectedProjectWorkspace) || (activeKind === 'work' && !selectedWorkTaskId);
  // The stop button is always present so the action row never shifts; it shows a
  // grey play triangle while idle and a red square while a turn is running.
  stop.disabled = !busy;
  stop.classList.toggle('running', busy);
  const stopLabel = busy ? 'Stop the task' : 'Idle';
  stop.title = stopLabel;
  stop.setAttribute('aria-label', stopLabel);
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
  // The workspace starts a session in a task or a project; the Library creates tasks.
  $<HTMLButtonElement>('new-session').disabled = !initialized || creatingSession
    || (activeKind === 'work' ? !selectedWorkTaskId : !selectedProjectWorkspace);
  const selectedProject = projects.find((project) => project.workspace === selectedProjectWorkspace);
  const projectSessions = selectedProject ? sessionsForProject(summaries, selectedProject.workspace) : [];
  const selectedTask = activeKind === 'work' ? workTasks.find((task) => task.id === selectedWorkTaskId) : undefined;
  const taskSessions = selectedTask ? summaries.filter((session) => session.kind === 'work' && session.taskId === selectedTask.id) : [];
  $<HTMLButtonElement>('rename-task').disabled = !selectedTask || creatingSession;
  $<HTMLButtonElement>('delete-task').disabled = !selectedTask || creatingSession || taskSessions.some((session) => running.has(session.id));
  $<HTMLButtonElement>('rename-project').disabled = !selectedProject || creatingSession;
  $<HTMLButtonElement>('delete-project').disabled = !selectedProject || creatingSession || projectSessions.some((session) => running.has(session.id));
  $<HTMLButtonElement>('workspace-button').disabled = !initialized || creatingSession;
  for (const id of ['new-project', 'open-project', 'kind-work', 'kind-code']) $<HTMLButtonElement>(id).disabled = !initialized || creatingSession;
  for (const id of ['approve-read', 'approve-edit', 'approve-web', 'approve-command']) $<HTMLInputElement>(id).disabled = !activeSessionId || selectingContext;
  $<HTMLButtonElement>('new-schedule').disabled = !activeSessionId;
  $<HTMLButtonElement>('import-transcript').disabled = !activeSessionId;
  syncToolMenu();
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
    checkpointsBySession.set(id, checkpoints);
    renderTaskMonitor();
    if (!checkpoints.length) { list.textContent = 'No checkpoints yet.'; return; }
    list.replaceChildren(...checkpoints.map((checkpoint) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'checkpoint-item';
      // Path and time are separate lines: the sidebar is too narrow for both on one.
      const path = document.createElement('span');
      path.className = 'checkpoint-path';
      path.textContent = checkpoint.path;
      const time = document.createElement('span');
      time.className = 'checkpoint-time';
      time.textContent = new Date(checkpoint.createdAt * 1000).toLocaleString();
      button.append(path, time);
      button.title = `${checkpoint.path} · ${time.textContent}`;
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
    schedulesBySession.set(id, schedules);
    renderTaskMonitor();
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

function setTaskMonitor(open: boolean, focus = false, pin?: boolean): void {
  if (pin !== undefined) {
    taskMonitorPinned = pin;
    try { localStorage.setItem(taskMonitorPinKey, String(pin)); } catch { /* applies for this run */ }
  }
  taskMonitorOpen = open;
  document.querySelector<HTMLElement>('.app')?.classList.toggle('task-monitor-open', open);
  $('task-monitor').toggleAttribute('hidden', !open);
  $('task-monitor-open').toggleAttribute('hidden', open);
  closeToolsMenu();
  try { localStorage.setItem('moderado-task-monitor', String(open)); } catch { /* applies for this run */ }
  syncToolMenu();
  if (open) renderTaskMonitor();
  if (focus) (open ? $('task-monitor-close') : $('task-monitor-open')).focus();
}

function hintText(text: string): HTMLParagraphElement {
  const empty = document.createElement('p');
  empty.className = 'hint';
  empty.textContent = text;
  return empty;
}

function renderTaskMonitor(): void {
  if (!taskMonitorOpen) return;
  const id = activeSessionId;
  const updatesList = $('monitor-updates');
  const processesList = $('monitor-processes');
  const artifactsList = $('monitor-artifacts');
  if (!id) {
    updatesList.replaceChildren(hintText('Select a session.'));
    processesList.replaceChildren(hintText('Select a session.'));
    artifactsList.replaceChildren(hintText('Select a session.'));
    return;
  }
  const now = Date.now();
  const turn = turnCompleted.get(id);
  const updates = mergeUpdates([
    updatesFromActivity(views.get(id) ?? [], now),
    checkpointUpdates(checkpointsBySession.get(id) ?? []),
    turn ? [turnUpdate(turn.at, turn.stopped)] : [],
  ]);
  const artifacts = artifactsFromActivity(views.get(id) ?? [], now);
  const processes = backgroundRows(runInfo.get(id), schedulesBySession.get(id) ?? [], now);

  updatesList.replaceChildren(...(updates.length ? updates.map((update) => {
    const item = document.createElement('div');
    item.className = `monitor-item ${update.kind === 'error' ? 'error' : ''}`.trim();
    const label = document.createElement('strong');
    label.textContent = update.label;
    const detail = document.createElement('span');
    detail.textContent = update.detail || new Date(update.at).toLocaleTimeString();
    item.append(label, detail);
    return item;
  }) : [hintText('No activity yet in this session.')]));

  processesList.replaceChildren(...(processes.length ? processes.map((process) => {
    const item = document.createElement('div');
    item.className = `monitor-item ${process.state === 'running' ? 'running' : ''}`.trim();
    const label = document.createElement('strong');
    label.textContent = process.label;
    const detail = document.createElement('span');
    detail.textContent = process.detail;
    item.append(label, detail);
    return item;
  }) : [hintText('No background work.')]));

  artifactsList.replaceChildren(...(artifacts.length ? artifacts.map((artifact) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'monitor-item monitor-artifact';
    item.textContent = artifact.path;
    item.title = `${artifact.action} · ${artifact.path}`;
    item.addEventListener('click', () => {
      void previewProjectFile({ name: artifact.path.split('/').pop() ?? artifact.path, path: artifact.path, isDir: false });
    });
    return item;
  }) : [hintText('No files changed yet.')]));
}

/** A running turn is both a busy flag and a labelled row; the two never drift apart. */
function markRunning(id: string, label: string, scheduled = false, scheduleId?: string): void {
  running.add(id);
  turnCompleted.delete(id);
  runInfo.set(id, { label, startedAt: Date.now(), scheduled, scheduleId });
  renderTaskMonitor();
}

function clearRunning(id: string): void {
  running.delete(id);
  runInfo.delete(id);
  renderTaskMonitor();
}

function setPageMode(page: AppPage | null): void {
  activePage = page;
  const open = page !== null;
  document.querySelector<HTMLElement>('.app')?.classList.toggle('page-mode', open);
  document.querySelector<HTMLElement>('.main')?.classList.toggle('page-mode', open);
  document.querySelectorAll<HTMLElement>('.page').forEach((section) => {
    section.classList.toggle('active', section.dataset.page === page);
  });
  document.querySelectorAll<HTMLButtonElement>('.rail-pages .rail-tab').forEach((button) => {
    if (button.dataset.pageLink === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  // The User entry shares the bottom group, so it yields while a page owns the main area.
  const userRail = document.querySelector<HTMLButtonElement>('.rail-pages .rail-tab[data-rail]');
  if (userRail) {
    const selected = !open && userRail.dataset.rail === activeLeftView;
    userRail.classList.toggle('selected', selected);
    userRail.setAttribute('aria-pressed', String(selected));
  }
  if (open) {
    closeMention();
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.page.active .page-head .text-button')?.focus());
  }
}

function switchPage(page: AppPage): void {
  const trigger = document.activeElement;
  pageOrigin = trigger instanceof HTMLElement && trigger.matches('.rail-pages .rail-tab') ? trigger : null;
  setPageMode(page);
}

/** Back from a page: focus returns to the rail button that opened it, else the composer. */
function leavePage(): void {
  setPageMode(null);
  if (pageOrigin?.isConnected) pageOrigin.focus();
  else prompt.focus();
  pageOrigin = null;
}

const viewingFiles = (): boolean => activeLeftView === 'files' && !previewOpen;
const viewingChanges = (): boolean => activeLeftView === 'git' && gitView === 'changes';
/** Git inspects a repository, and only Code mode owns one. */
const gitAvailable = (): boolean => activeKind === 'code';

/** Shows one rail destination and loads the data it needs. */
function applyLeftView(): void {
  // Work has no repository, so its Git entry is hidden and the Library takes over.
  const enabled = gitAvailable();
  if (!enabled && activeLeftView === 'git') activeLeftView = 'library';
  const gitRail = document.querySelector<HTMLButtonElement>('.rail-tabs .rail-tab[data-rail="git"]');
  if (gitRail) {
    // Hidden in Work: a repository-backed tool has no business in that rail.
    gitRail.toggleAttribute('hidden', !enabled);
    gitRail.setAttribute('aria-disabled', String(!enabled));
    gitRail.classList.toggle('unavailable', !enabled);
    gitRail.title = enabled ? 'Git' : 'Git is available in Code mode';
    gitRail.setAttribute('aria-label', enabled ? 'Git' : 'Git (Code mode only)');
  }
  document.querySelectorAll<HTMLButtonElement>('.rail-tabs .rail-tab, .rail-pages .rail-tab[data-rail]').forEach((button) => {
    const selected = button.dataset.rail === activeLeftView;
    button.classList.toggle('selected', selected);
    if (button.closest('.rail-tabs')) {
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    } else {
      button.setAttribute('aria-pressed', String(selected));
    }
  });
  document.querySelectorAll<HTMLElement>('[data-left-view]').forEach((section) => {
    section.classList.toggle('active', section.dataset.leftView === activeLeftView);
  });
  if (activeLeftView === 'files') applyFilesView();
  if (activeLeftView === 'git') applyGitView();
}

function selectLeftView(view: LeftView): void {
  setPageMode(null);
  activeLeftView = view;
  previewOpen = false;
  try { localStorage.setItem(leftViewKey, view); } catch { /* the pane still switches for this run */ }
  applyLeftView();
  if (view === 'user') void refreshGitIdentity();
}

function applyFilesView(): void {
  const files = $('files-view');
  const preview = $('preview-view');
  files.classList.toggle('active', !previewOpen);
  files.toggleAttribute('hidden', previewOpen);
  preview.classList.toggle('active', previewOpen);
  preview.toggleAttribute('hidden', !previewOpen);
  if (!previewOpen) void refreshProjectTree();
}

/** Preview keeps the Files rail tab selected; only the sub-view changes. */
function openPreview(): void {
  setPageMode(null);
  if (activeLeftView !== 'files') {
    activeLeftView = 'files';
    try { localStorage.setItem(leftViewKey, 'files'); } catch { /* the pane still switches for this run */ }
  }
  previewOpen = true;
  applyLeftView();
}

function closePreview(): void {
  previewOpen = false;
  applyFilesView();
}

function applyGitView(): void {
  document.querySelectorAll<HTMLElement>('[data-git-view]').forEach((view) => {
    const active = view.dataset.gitView === gitView;
    view.classList.toggle('active', active);
    view.toggleAttribute('hidden', !active);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-git-tab]').forEach((tab) => {
    const active = tab.dataset.gitTab === gitView;
    tab.classList.toggle('selected', active);
    tab.setAttribute('aria-selected', String(active));
  });
  if (gitView === 'changes') void refreshSourceControl();
  else void refreshCheckpoints();
}

function switchGitView(view: GitView): void {
  gitView = view;
  try { localStorage.setItem(gitViewKey, view); } catch { /* the tab still switches for this run */ }
  applyGitView();
}

function menuToolButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('#tools-menu [data-tool]'));
}

function syncToolMenu(): void {
  const context = { kind: activeKind, hasWorkspace: Boolean(currentFolder()) };
  for (const button of menuToolButtons()) {
    const action = button.dataset.tool as ToolAction;
    const reason = toolDisabledReason(action, context);
    button.disabled = reason !== null;
    button.toggleAttribute('aria-disabled', reason !== null);
    button.title = reason ?? '';
  }
  const terminal = $<HTMLButtonElement>('terminal-panel');
  const terminalReason = toolDisabledReason('terminal-panel', context);
  terminal.disabled = terminalReason !== null;
  terminal.setAttribute('aria-disabled', String(terminalReason !== null));
  terminal.title = terminalReason ?? (terminalOpen ? 'Close terminal panel' : 'Open terminal panel');
  terminal.setAttribute('aria-pressed', String(terminalOpen));
}

function openToolsMenu(): void {
  toolsOpen = true;
  $('tools-menu').toggleAttribute('hidden', false);
  $('tools-toggle').setAttribute('aria-expanded', 'true');
  syncToolMenu();
  // The trigger is not a menu item, so this lands on the first enabled item;
  // an empty menu leaves focus where it is.
  moveToolsFocus('ArrowDown');
}

function closeToolsMenu(returnFocus = false): void {
  toolsOpen = false;
  $('tools-menu').toggleAttribute('hidden', true);
  $('tools-toggle').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('tools-toggle').focus();
}

function moveToolsFocus(key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): void {
  const items = menuToolButtons().filter((button) => !button.disabled);
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  items[nextMenuIndex(current, items.length, key)]?.focus();
}

function runTool(action: ToolAction): void {
  closeToolsMenu(true);
  if (action === 'file-browser') {
    void invoke('open_file_browser', browserArgs()).catch((error) => setStatus(String(error)));
    return;
  }
  if (action === 'vscode') {
    void invoke('open_in_editor', browserArgs()).catch((error) => setStatus(String(error)));
    return;
  }
  if (action === 'system-terminal') {
    void invoke('open_system_terminal', browserArgs()).catch((error) => setStatus(String(error)));
  }
}

async function selectProject(workspace: string): Promise<void> {
  if (!projects.some((project) => project.workspace === workspace)) { setStatus('Open this project first.'); return; }
  saveComposerDraft(); enterDraft('code', workspace); expandedProjects.add(workspace); selectLeftView('library');
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
  selectLeftView('library');
  if (next) await selectSession(next.id, false);
  else {
    enterDraft('work');
    updateFolderContext();
    renderSessions();
    if (viewingFiles()) void refreshProjectTree();
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
  if (!rootEntries?.length) { tree.replaceChildren(hintText('This folder is empty.')); return; }
  append(rootEntries, 0);
  tree.replaceChildren(fragment);
}

async function previewProjectFile(entry: ProjectEntry): Promise<void> {
  const folder = currentFolder();
  if (!folder) return;
  $('file-preview-title').textContent = entry.name;
  $('file-preview-path').textContent = entry.path;
  $('file-preview-content').textContent = 'Loading…';
  openPreview();
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
    if (previewPath === entry.path || previewPath?.startsWith(`${entry.path}/`)) $('file-preview-title').textContent = 'No file selected';
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

/** Git identity and credential readiness. Code only: a Work task folder is not a repo. */
type Pty = { terminal: Terminal; fit: FitAddon; key: string; started: boolean };
/** The value the backend also keys write/resize/close with. */
function terminalKey(): string {
  // Must mirror `terminal_open`: the session when this mode sends one, else the
  // project. A Code session deliberately sends no session id, so its shell is
  // keyed by the project folder — reading `activeSessionId` here would address
  // a terminal that was never created.
  const args = browserArgs();
  return args.sessionId ?? args.projectWorkspace ?? '';
}

/** A light palette is not the dark one with a pale background: Windows shells
 *  paint prompts and echoed input in ANSI white/gray, which disappears on a
 *  light page. Map those slots dark, then let xterm enforce a readable floor. */
function terminalTheme(): ITheme {
  if (document.documentElement.dataset.theme !== 'light') {
    return { background: '#0c1d2d', foreground: '#b9cbd5', cursor: '#65cbbd', selectionBackground: '#2a4258' };
  }
  return {
    background: '#ffffff', foreground: '#203744', cursor: '#08766d', selectionBackground: '#c9d9de',
    black: '#203744', red: '#b3322d', green: '#1f7a4d', yellow: '#8a6100',
    blue: '#1f5f9e', magenta: '#7a3f8f', cyan: '#0f6f7d', white: '#3a5561',
    brightBlack: '#5d7480', brightRed: '#c2433d', brightGreen: '#238a57', brightYellow: '#9c6f00',
    brightBlue: '#2a70b5', brightMagenta: '#8b4ba1', brightCyan: '#147a88', brightWhite: '#203744',
  };
}

function fitTerminal(): void {
  if (!pty) return;
  try { pty.fit.fit(); } catch { /* the host has no size while the panel is hidden */ }
}

async function startShell(): Promise<void> {
  if (!pty || !pty.key) return;
  fitTerminal();
  try {
    // The backend decides which id it stores the shell under and returns it, so
    // this side never has to reconstruct the rule and drift from it.
    pty.key = await invoke<string>('terminal_open', { ...browserArgs(), cols: pty.terminal.cols, rows: pty.terminal.rows });
    pty.started = true;
    pty.terminal.focus();
  } catch (error) {
    pty.terminal.write(`\r\n${String(error)}\r\n`);
  }
}

/** Opens or closes the drawer; the shell starts only once, when it is first shown. */
async function setTerminalOpen(open: boolean): Promise<void> {
  if (open && activeKind !== 'code') { setStatus('Commands run in Code sessions only.'); return; }
  terminalOpen = open;
  $('terminal-drawer').toggleAttribute('hidden', !open);
  syncToolMenu();
  if (!open) return;
  await ensureTerminal();
  requestAnimationFrame(() => { fitTerminal(); pty?.terminal.focus(); });
}

/** Mounts the terminal once, then starts a shell for whichever project is open. */
async function ensureTerminal(): Promise<void> {
  const host = $('terminal-host');
  if (!host) return;
  if (!pty) {
    const terminal = new Terminal({
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      minimumContrastRatio: 4.5,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    pty = { terminal, fit, key: terminalKey(), started: false };
    terminal.onData((data) => {
      if (!pty) return;
      // A shell that has exited cannot take input; say so once rather than
      // swallowing the keystroke and leaving the user typing into a void.
      void invoke('terminal_write', { sessionId: pty.key, data }).catch((error) => {
        if (!pty || !pty.started) return;
        pty.started = false;
        pty.terminal.write(`\r\n${String(error)}\r\n`);
      });
    });
    if (!terminalEventsBound) {
      terminalEventsBound = true;
      void listen<{ sessionId: string; data: string }>('terminal-output', (event) => {
        if (pty && event.payload.sessionId === pty.key) pty.terminal.write(event.payload.data);
      });
      void listen<{ sessionId: string }>('terminal-exit', (event) => {
        if (pty && event.payload.sessionId === pty.key) {
          pty.terminal.write('\r\n[shell exited]\r\n');
          pty.started = false;
        }
      });
      new ResizeObserver(() => {
        if (!pty || !terminalOpen) return;
        fitTerminal();
        void invoke('terminal_resize', { sessionId: pty.key, cols: pty.terminal.cols, rows: pty.terminal.rows }).catch(() => {});
      }).observe(host);
    }
  }
  const key = terminalKey();
  if (pty.key !== key) {
    // Another project: end the old shell rather than reusing it in a new folder.
    await invoke('terminal_close', { sessionId: pty.key }).catch(() => {});
    pty.terminal.reset();
    pty.key = key;
    pty.started = false;
  }
  if (!key) { pty.terminal.write('\r\nOpen a project to start a shell.\r\n'); return; }
  if (!pty.started) await startShell();
  // Opening the drawer should put the caret in the shell, so the user can type
  // immediately instead of hunting for the click target.
  requestAnimationFrame(() => { if (terminalOpen) pty?.terminal.focus(); });
}

async function refreshGitIdentity(): Promise<void> {
  const block = $('profile-git');
  const actions = $('git-actions');
  if (activeKind !== 'code' || !selectedProjectWorkspace) {
    block.toggleAttribute('hidden', true);
    actions.toggleAttribute('hidden', true);
    return;
  }
  block.toggleAttribute('hidden', false);
  try {
    const identity = await invoke<GitIdentity>('git_identity', browserArgs());
    $('profile-git-name').textContent = identity.name ? `${identity.name} · ${identity.email || 'no email set'}` : 'No git user.name set';
    $('profile-git-remote').textContent = identity.remote ?? 'No origin remote';
    $('profile-git-credential').textContent = identity.detail;
    // Without a remote there is nothing to commit for, and without credentials
    // Push cannot succeed, so only offer what can actually work.
    actions.toggleAttribute('hidden', !identity.remote);
    $('git-credential').textContent = identity.credential === 'ready' ? '' : identity.detail;
    $<HTMLButtonElement>('git-push').disabled = identity.credential !== 'ready';
  } catch (error) {
    block.toggleAttribute('hidden', false);
    $('profile-git-name').textContent = 'Not a repository';
    $('profile-git-remote').textContent = '';
    $('profile-git-credential').textContent = String(error);
    actions.toggleAttribute('hidden', true);
  }
}

async function refreshSourceControl(): Promise<void> {
  const folder = currentFolder();
  const branch = $('source-branch');
  const message = $('source-control-message');
  const changes = $('source-changes');
  const history = $('commit-history');
  changes.replaceChildren();
  history.replaceChildren();
  // A Work task folder is not a repository, so say why rather than probing for Git.
  if (activeKind === 'work') {
    branch.textContent = 'No repository';
    message.textContent = 'Work sessions keep files in a managed task folder, so there is no Git history. Open a Code session to inspect a repository.';
    return;
  }
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
    void refreshGitIdentity();
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
    void loadMcpConfig();
    void loadLspConfig();
    initialized = true;
    await refreshSummaries();
    restoreNavigation();
    // A stored mode only wins while a session still backs it; otherwise Work is the default.
    const validProjects = new Set(projects.map((project) => project.workspace));
    const codeSessions = summaries.filter((session) => session.kind === 'code' && validProjects.has(session.workspace));
    const storedKind = activeKind;
    activeKind = startupSessionKind(storedKind, codeSessions.length > 0);
    if (activeKind !== storedKind) {
      try { localStorage.setItem(lastKindKey, activeKind); } catch { /* the default still applies for this run */ }
    }
    const storedLeftView = activeLeftView;
    const storedMonitor = localStorage.getItem('moderado-task-monitor') !== 'false';
    setTaskMonitor(taskMonitorPinned || (activeKind === 'code' && storedMonitor));
    if (activeKind === 'work') {
      const restoredTask = workTasks.find((task) => task.id === selectedWorkTaskId);
      if (restoredTask) await selectWorkTask(restoredTask.id, false);
      else {
        const firstWorkSession = sessionForMode(summaries, 'work', lastSessionByKind.get('work'));
        if (firstWorkSession) await selectSession(firstWorkSession.id);
        else await createSession(currentSettings(), 'work');
      }
    } else {
      const rememberedCode = codeSessions.find((session) => session.id === lastSessionByKind.get('code'));
      const workspace = (selectedProjectWorkspace && codeSessions.some((session) => session.workspace === selectedProjectWorkspace) ? selectedProjectWorkspace : null)
        ?? rememberedCode?.workspace
        ?? codeSessions[0]?.workspace
        ?? projects[0]?.workspace
        ?? null;
      // Nothing to code in yet: fall back to Work rather than an empty shell.
      if (workspace) await selectProject(workspace); else await setKind('work');
    }
    // Selecting a task or project moves the rail, so the persisted view is restored last.
    selectLeftView(storedLeftView);
    const local = await invoke<LocalProviderStatus[]>('probe_local_providers');
    for (const item of local) {
      const preset = providers.find((provider) => provider.id === item.id);
      const option = Array.from(providerSelect.options).find((candidate) => candidate.value === item.id);
      if (preset && option) option.textContent = `${preset.name} (${item.available ? 'available' : 'offline'})`;
    }
    // Startup renders rebuilt some copy after the first pass; translate what stands now.
    if (language !== DEFAULT_LANGUAGE) translateTree(document.body);
  } catch (error) { setStatus(`Session setup failed: ${String(error)}`); }
}

providerSelect.addEventListener('change', () => selectProvider(providerSelect.value as ProviderId));

$<HTMLButtonElement>('kind-work').addEventListener('click', () => { void setKind('work'); });
$<HTMLButtonElement>('kind-code').addEventListener('click', () => { void setKind('code'); });
// The OS window title carries the product name, so the left pane header uses
// that space to show which build is running. Hover reveals the full identifier.
const versionLabel = appVersion.trim().split('+')[0] || appVersion.trim();
$<HTMLElement>('about-version').textContent = versionLabel;
const brandVersion = $<HTMLElement>('brand-version');
brandVersion.textContent = versionLabel;
brandVersion.title = `Moderado Desktop ${appVersion.trim()}`;
brandVersion.setAttribute('aria-label', brandVersion.title);
const footerYear = new Date().getFullYear();
document.querySelectorAll<HTMLElement>('[data-page-footer]').forEach((footer) => {
  footer.textContent = `${footerYear} Moderado Desktop by Moderado AI, an Alfazen platform, all rights reserved.`;
});

mentionButton.addEventListener('click', async () => {
  if (!activeSessionId && !selectedProjectWorkspace) { setStatus('Open a project before referencing files.'); return; }
  await openMentions(prompt.selectionStart, prompt.selectionStart, '');
  prompt.focus();
});
attachButton.addEventListener('click', async () => {
  const sessionId = activeSessionId;
  if (!sessionId) { setStatus(activeKind === 'work' ? 'Create a task before attaching files.' : 'Start a session before attaching files.'); return; }
  const work = activeKind === 'work';
  try {
    const picked = await open({ multiple: true, title: work ? 'Attach files (editable copies go into the task folder)' : 'Attach files to this message' });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    const records = await invoke<AttachmentRecord[]>('add_attachments', { sessionId, paths });
    if (activeSessionId === sessionId) {
      pendingAttachments = [...pendingAttachments, ...records]; renderChips();
      setStatus(work ? `${pendingAttachments.length} file(s) attached. Copies are in Explorer.` : `${pendingAttachments.length} file(s) attached.`);
      if (work && viewingFiles()) await refreshProjectTree();
    }
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
/**
 * Sign-in follows the Base URL in the Connection card. A typed dev URL must not
 * keep the prod identity, or the User pane hides "Sign in" and mints a prod key.
 */
function accountGateway(): { mode: GatewayMode; url: string } {
  const entered = endpoint.value.trim().replace(/\/+$/, '');
  if (entered === GATEWAY_URLS.dev) return { mode: 'dev', url: entered };
  if (entered === GATEWAY_URLS.prod) return { mode: 'prod', url: entered };
  return { mode: gatewayMode, url: GATEWAY_URLS[gatewayMode] };
}
/** Each gateway keeps its own identity, so a dev sign-in never poses as the prod account. */
const accountEmailKey = (url: string) => `moderado-account-email:${url}`;
/** Earlier builds keyed the email by mode, then by nothing at all. */
const legacyModeKey = (mode: GatewayMode) => `moderado-account-email:${mode}`;
const legacyAccountEmailKey = 'moderado-account-email';
const storedAccountEmail = (): string => {
  const { mode, url } = accountGateway();
  try {
    return localStorage.getItem(accountEmailKey(url))
      ?? localStorage.getItem(legacyModeKey(mode))
      ?? (mode === 'prod' ? localStorage.getItem(legacyAccountEmailKey) : null)
      ?? '';
  } catch { return ''; }
};
let accountEmail = '';
function applyAccount(): void {
  const { mode } = accountGateway();
  $('user-account-name').textContent = accountEmail || t('Not signed in');
  $('user-signin').toggleAttribute('hidden', Boolean(accountEmail));
  $('user-signout').toggleAttribute('hidden', !accountEmail);
  $('user-signin').textContent = mode === 'dev'
    ? t('Sign in at 127.0.0.1:4788')
    : t('Sign in at modr.alfazen.org');
}
function refreshAccount(): void {
  accountEmail = storedAccountEmail();
  applyAccount();
}
accountEmail = storedAccountEmail();
applyAccount();
for (const event of ['change', 'input']) endpoint.addEventListener(event, refreshAccount);
$('user-signin').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('user-signin');
  button.disabled = true;
  setStatus('Waiting for the browser to finish signing in…');
  const { url } = accountGateway();
  try {
    // The browser authorizes on the website; the loopback callback mints the
    // key, stores it in the OS keychain, and reports the signed-in email.
    const identity = await invoke<{ email: string }>('moderado_sign_in', { baseUrl: url });
    accountEmail = identity.email;
    try { localStorage.setItem(accountEmailKey(url), accountEmail); } catch { /* the pane shows it for this run */ }
    applyAccount();
    setStatus(`Signed in as ${accountEmail}.`);
  } catch (error) {
    setStatus(`Sign-in failed: ${String(error)}`);
  } finally {
    button.disabled = false;
  }
});
$('user-signout').addEventListener('click', async () => {
  const { mode, url } = accountGateway();
  try { await invoke('moderado_sign_out', { baseUrl: url }); }
  catch (error) { setStatus(`Sign-out failed: ${String(error)}`); return; }
  accountEmail = '';
  try {
    localStorage.removeItem(accountEmailKey(url));
    localStorage.removeItem(legacyModeKey(mode));
    if (mode === 'prod') localStorage.removeItem(legacyAccountEmailKey);
  } catch { /* nothing else caches it */ }
  applyAccount();
  setStatus('Signed out. Local work is unchanged.');
});
$<HTMLSelectElement>('plan-model').addEventListener('change', updateSelectedModel);
$<HTMLSelectElement>('act-model').addEventListener('change', updateSelectedModel);
document.querySelectorAll<HTMLButtonElement>('[data-gateway-mode]').forEach((button) => {
  button.addEventListener('click', () => setGatewayMode(button.dataset.gatewayMode as GatewayMode));
});
function moveRailFocus(key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.rail-tabs .rail-tab'))
    .filter((button) => button.getAttribute('aria-disabled') !== 'true');
  if (!tabs.length) return;
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
  tabs[nextMenuIndex(current, tabs.length, key)]?.focus();
}
document.querySelectorAll<HTMLButtonElement>('.rail-tabs .rail-tab').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.rail === 'git' && !gitAvailable()) { setStatus('Git is available in Code mode.'); return; }
    // Choosing a destination is a request to see it, even from the rail-only state.
    if (sidebarCollapsed) setSidebarCollapsed(false);
    selectLeftView(parseLeftView(button.dataset.rail ?? null));
  });
});
document.querySelector<HTMLElement>('.rail-tabs')?.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    moveRailFocus(event.key);
  }
});
document.querySelectorAll<HTMLButtonElement>('.rail-pages .rail-tab').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.rail) { selectLeftView(parseLeftView(button.dataset.rail)); return; }
    const page = button.dataset.pageLink as AppPage;
    if (activePage === page) { setPageMode(null); button.focus(); }
    else switchPage(page);
  });
});
$('preview-back').addEventListener('click', closePreview);
$('terminal-close').addEventListener('click', () => { void setTerminalOpen(false); });
$('task-monitor-close').addEventListener('click', () => setTaskMonitor(false, true, false));
$('task-monitor-open').addEventListener('click', () => setTaskMonitor(true, true, true));
$('terminal-panel').addEventListener('click', () => { void setTerminalOpen(!terminalOpen); });
$('tools-toggle').addEventListener('click', () => {
  if (toolsOpen) closeToolsMenu(true);
  else openToolsMenu();
});
$<HTMLDivElement>('tools-menu').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]');
  if (button) runTool(button.dataset.tool as ToolAction);
});
$<HTMLDivElement>('tools-menu').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closeToolsMenu(true); return; }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    moveToolsFocus(event.key);
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!toolsOpen) return;
  if (!(event.target as HTMLElement).closest('.tools-wrap')) closeToolsMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && toolsOpen) closeToolsMenu(true);
});
document.querySelectorAll<HTMLButtonElement>('[data-git-tab]').forEach((tab) => {
  tab.addEventListener('click', () => switchGitView(parseGitView(tab.dataset.gitTab ?? null)));
});
const sidebarWidthKey = 'moderado-sidebar-width';
const sidebarCollapsedKey = 'moderado-sidebar-collapsed';
let sidebarCollapsed = false;
function setSidebarCollapsed(collapsed: boolean): void {
  sidebarCollapsed = collapsed;
  document.querySelector<HTMLElement>('.app')?.classList.toggle('sidebar-collapsed', collapsed);
  const toggle = $<HTMLButtonElement>('sidebar-toggle');
  const label = collapsed ? 'Expand left pane' : 'Collapse left pane';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  try { localStorage.setItem(sidebarCollapsedKey, String(collapsed)); } catch { /* applies for this run */ }
}
$('sidebar-toggle').addEventListener('click', () => setSidebarCollapsed(!sidebarCollapsed));
if (localStorage.getItem(sidebarCollapsedKey) === 'true') setSidebarCollapsed(true);
let sidebarWidth = 0; // 0 follows --pane-width; a drag pins an exact pixel width.
function applySidebarWidth(px: number): number {
  // The floor keeps the wordmark, the mode slider and the collapse button on one line.
  const clamped = Math.max(260, Math.min(560, Math.round(px)));
  document.querySelector<HTMLElement>('.app')?.style.setProperty('--sidebar-width', `${clamped}px`);
  return clamped;
}
function saveSidebarWidth(): void {
  try { localStorage.setItem(sidebarWidthKey, String(sidebarWidth)); } catch { /* applies for this run */ }
}
const storedSidebarWidth = Number(localStorage.getItem(sidebarWidthKey));
if (Number.isFinite(storedSidebarWidth) && storedSidebarWidth > 0) sidebarWidth = applySidebarWidth(storedSidebarWidth);
const resizer = $<HTMLElement>('sidebar-resizer');
resizer.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  resizer.setPointerCapture(event.pointerId);
  resizer.classList.add('dragging');
  document.body.classList.add('resizing');
});
resizer.addEventListener('pointermove', (event) => {
  if (!resizer.hasPointerCapture(event.pointerId)) return;
  const left = document.querySelector<HTMLElement>('.sidebar')?.getBoundingClientRect().left ?? 0;
  sidebarWidth = applySidebarWidth(event.clientX - left);
});
const endResize = (event: PointerEvent): void => {
  if (!resizer.hasPointerCapture(event.pointerId)) return;
  resizer.releasePointerCapture(event.pointerId);
  resizer.classList.remove('dragging');
  document.body.classList.remove('resizing');
  saveSidebarWidth();
};
resizer.addEventListener('pointerup', endResize);
resizer.addEventListener('pointercancel', endResize);
resizer.addEventListener('dblclick', () => {
  // Drop the pin so the pane returns to the width the window gives it.
  try { localStorage.removeItem(sidebarWidthKey); } catch { /* applies for this run */ }
  document.querySelector<HTMLElement>('.app')?.style.removeProperty('--sidebar-width');
  sidebarWidth = 0;
});
resizer.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const current = sidebarWidth || Math.round(document.querySelector<HTMLElement>('.sidebar')?.getBoundingClientRect().width ?? 260);
  sidebarWidth = applySidebarWidth(current + (event.key === 'ArrowRight' ? 16 : -16));
  saveSidebarWidth();
});
$<HTMLButtonElement>('refresh-project').addEventListener('click', () => { void refreshProjectTree(); });
$<HTMLButtonElement>('refresh-source-control').addEventListener('click', () => { void refreshSourceControl(); });
$<HTMLButtonElement>('git-commit').addEventListener('click', async () => {
  const message = $<HTMLInputElement>('git-commit-message').value.trim();
  if (!message) { setStatus('Enter a commit message first.'); return; }
  const commitButton = $<HTMLButtonElement>('git-commit');
  commitButton.disabled = true;
  try {
    const head = await invoke<string>('git_commit', { ...browserArgs(), message });
    $<HTMLInputElement>('git-commit-message').value = '';
    setStatus(`Committed ${head}.`);
    await refreshSourceControl();
  } catch (error) { setStatus(String(error)); }
  finally { commitButton.disabled = false; }
});
$<HTMLButtonElement>('git-push').addEventListener('click', async () => {
  const pushButton = $<HTMLButtonElement>('git-push');
  pushButton.disabled = true;
  try {
    const result = await invoke<string>('git_push', browserArgs());
    setStatus(result ? `Pushed — ${result}` : 'Pushed.');
    await refreshSourceControl();
  } catch (error) { setStatus(String(error)); }
  finally { pushButton.disabled = false; }
});
$('plan-mode').addEventListener('click', () => setMode('plan'));
$('act-mode').addEventListener('click', () => setMode('act'));
$('close-btw').addEventListener('click', () => $<HTMLDialogElement>('btw-dialog').close());
stop.addEventListener('click', async () => {
  const id = activeSessionId;
  if (!id || !running.has(id)) return;
  stop.disabled = true;
  setStatus('Stopping task…');
  try { await invoke('stop_turn', { sessionId: id }); }
  catch (error) { setStatus(String(error)); updateControls(); }
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

type McpServerConfig = { id: string; transport: 'stdio' | 'http'; command: string; url: string; args: string[]; env: Record<string, string>; tools: string[] | null; enabled: boolean };
type McpServerStatus = { id: string; transport: string; connected: boolean; toolCount: number; error?: string | null };
type McpToolInfo = { serverId: string; name: string; publicName: string; description: string };

function mcpField(label: string, input: HTMLElement): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.className = 'mcp-field';
  wrap.append(document.createTextNode(label), input);
  return wrap;
}

function mcpRow(server: McpServerConfig): HTMLElement {
  const row = document.createElement('div');
  row.className = 'mcp-server-row';
  const id = document.createElement('input');
  id.value = server.id;
  id.placeholder = 'id';
  id.dataset.field = 'id';
  const transport = document.createElement('select');
  transport.dataset.field = 'transport';
  for (const value of ['stdio', 'http']) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    transport.append(option);
  }
  transport.value = server.transport;
  const target = document.createElement('input');
  target.dataset.field = 'target';
  const placeholder = () => (transport.value === 'http' ? 'https://host/mcp' : 'npx.cmd');
  target.placeholder = placeholder();
  target.value = server.transport === 'http' ? server.url : server.command;
  transport.addEventListener('change', () => { target.placeholder = placeholder(); });
  const args = document.createElement('input');
  args.dataset.field = 'args';
  args.placeholder = '["-y","pkg"]';
  args.value = server.args.length ? JSON.stringify(server.args) : '';
  const tools = document.createElement('input');
  tools.dataset.field = 'tools';
  tools.placeholder = 'blank = all tools';
  tools.value = (server.tools ?? []).join(', ');
  const env = document.createElement('input');
  env.dataset.field = 'env';
  env.placeholder = '{"KEY":"value"}';
  env.value = Object.keys(server.env).length ? JSON.stringify(server.env) : '';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.dataset.field = 'enabled';
  enabled.checked = server.enabled;
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'mcp-enabled';
  enabledLabel.append(enabled, document.createTextNode(' enabled'));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'text-button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => row.remove());
  row.append(mcpField('Id', id), mcpField('Transport', transport), mcpField('Command / URL', target), mcpField('Args (JSON)', args), mcpField('Tools', tools), mcpField('Env (JSON)', env), enabledLabel, remove);
  return row;
}

/** An empty row keeps the Add server form enabled inside the card. */
function emptyMcpServer(): McpServerConfig {
  return { id: '', transport: 'stdio', command: '', url: '', args: [], env: {}, tools: null, enabled: true };
}

function renderMcpServers(config: { servers: McpServerConfig[] }): void {
  const servers = config.servers.length ? config.servers : [emptyMcpServer()];
  $('mcp-servers').replaceChildren(...servers.map((server) => mcpRow(server)));
}

function readMcpServers(): { servers: McpServerConfig[] } {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('#mcp-servers .mcp-server-row'));
  return {
    servers: rows.map((row): McpServerConfig => {
      const value = (field: string) => row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-field="${field}"]`)?.value ?? '';
      const transport = value('transport') === 'http' ? 'http' : 'stdio';
      const target = value('target').trim();
      return {
        id: value('id').trim(),
        transport,
        command: transport === 'stdio' ? target : '',
        url: transport === 'http' ? target : '',
        args: parseMcpArgs(value('args')),
        env: parseMcpEnv(value('env')),
        tools: parseMcpTools(value('tools')),
        enabled: row.querySelector<HTMLInputElement>('[data-field="enabled"]')?.checked ?? true,
      };
    }).filter((server) => Boolean(server.id || server.command || server.url)),
  };
}

function renderMcpStatus(servers: McpServerStatus[], tools: McpToolInfo[]): void {
  const container = $('mcp-status-list');
  container.replaceChildren(...servers.map((server) => {
    const row = document.createElement('div');
    row.className = `mcp-status-row ${server.connected ? 'ok' : 'error'}`;
    const head = document.createElement('strong');
    head.textContent = `${server.connected ? '✓' : '✗'} ${server.id}`;
    const detail = document.createElement('span');
    if (server.connected) {
      const names = tools.filter((tool) => tool.serverId === server.id).map((tool) => tool.name);
      detail.textContent = `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}${names.length ? `: ${names.join(', ')}` : ''}`;
    } else {
      detail.textContent = server.error ?? 'failed';
    }
    row.append(head, detail);
    return row;
  }));
}

async function loadMcpConfig(): Promise<void> {
  try {
    renderMcpServers(await invoke<{ servers: McpServerConfig[] }>('load_mcp_config'));
  } catch (error) {
    $('mcp-status').textContent = String(error);
  }
}

$('add-mcp-server').addEventListener('click', () => {
  $('mcp-servers').append(mcpRow(emptyMcpServer()));
});

$('save-mcp-config').addEventListener('click', async () => {
  try {
    await invoke('save_mcp_config', { config: readMcpServers() });
    $('mcp-status').textContent = 'MCP config saved.';
    $('mcp-status-list').replaceChildren();
  } catch (error) {
    $('mcp-status').textContent = String(error);
  }
});

$('discover-mcp').addEventListener('click', async () => {
  $('mcp-status').textContent = 'Testing MCP servers…';
  $('mcp-status-list').replaceChildren();
  try {
    const discovery = await invoke<{ tools: McpToolInfo[]; servers: McpServerStatus[] }>('discover_mcp_tools', { config: readMcpServers() });
    renderMcpStatus(discovery.servers, discovery.tools);
    $('mcp-status').textContent = discovery.servers.length ? 'Test complete.' : 'No enabled servers.';
  } catch (error) {
    $('mcp-status').textContent = String(error);
  }
});

async function loadLspConfig(): Promise<void> {
  try {
    const config = await invoke<unknown>('load_lsp_config');
    $<HTMLTextAreaElement>('lsp-config').value = JSON.stringify(config, null, 2);
  } catch (error) {
    $('lsp-status').textContent = String(error);
  }
}

$('save-lsp-config').addEventListener('click', async () => {
  try {
    const config = JSON.parse($<HTMLTextAreaElement>('lsp-config').value.trim() || '{"servers":[]}');
    await invoke('save_lsp_config', { config });
    $('lsp-status').textContent = 'LSP config saved.';
  } catch (error) {
    $('lsp-status').textContent = String(error);
  }
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
      : await invoke<SessionRecord>('create_session_in_project', { projectWorkspace: workspace, settings, name: sessionStamp(Date.now() / 1000) });
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

/** The Library's New Task action creates a numbered `work-task-##`. */
async function createWorkTask(): Promise<void> {
  if (creatingSession) return;
  saveComposerDraft(); creatingSession = true; updateControls();
  try {
    const task = await invoke<WorkTaskRecord>('create_work_task');
    await refreshSummaries(); selectedWorkTaskId = task.id; expandedWorkTasks.add(task.id); lastSessionByTask.delete(task.id); rememberNavigation();
    prompt.value = ''; pendingAttachments = []; renderChips(); enterDraft('work'); selectLeftView('library');
    setStatus(`Task “${task.name}” created.`);
  } catch (error) { setStatus(String(error)); }
  finally { creatingSession = false; renderSessions(); updateControls(); }
}
$('workspace-button').addEventListener('click', () => { void createWorkTask(); });

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
    for (const id of removed) { sessions.delete(id); views.delete(id); conversationBindings.delete(id); composerDrafts.delete(id); usageBySession.delete(id); clearRunning(id); }
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
  saveComposerDraft(); enterDraft('code', workspace); prompt.value = ''; pendingAttachments = []; renderChips(); expandedProjects.add(workspace); selectLeftView('library');
  try { await createSession(currentSettings(), 'code', workspace); } catch (error) { setStatus(String(error)); }
}
async function newWorkSession(taskId: string): Promise<void> {
  if (creatingSession) return;
  saveComposerDraft(); enterDraft('work'); prompt.value = ''; pendingAttachments = []; renderChips(); expandedWorkTasks.add(taskId); selectLeftView('library');
  try { await createSession(currentSettings(), 'work', null, taskId); } catch (error) { setStatus(String(error)); }
}
$('new-session').addEventListener('click', () => {
  if (activeKind === 'work') { if (selectedWorkTaskId) void newWorkSession(selectedWorkTaskId); }
  else if (selectedProjectWorkspace) void newProjectSession(selectedProjectWorkspace);
});
async function renameProject(project: ProjectRecord): Promise<void> {
  const name = window.prompt('Project display name (folder name stays the same)', project.name); if (name === null) return;
  try { await invoke('rename_project', { projectWorkspace: project.workspace, name }); await refreshSummaries(); updateFolderContext(); }
  catch (error) { setStatus(String(error)); }
}
async function deleteProject(project: ProjectRecord): Promise<void> {
  if (!window.confirm(`Delete project “${project.name}”? Its sessions and histories are removed from Moderado; the project folder and files remain.`)) return;
  const revision = selectionRevision;
  const wasSelected = selectedProjectWorkspace === project.workspace;
  try {
    const removed = await invoke<string[]>('delete_project', { projectWorkspace: project.workspace });
    for (const id of removed) { sessions.delete(id); views.delete(id); conversationBindings.delete(id); composerDrafts.delete(id); usageBySession.delete(id); clearRunning(id); }
    lastSessionByProject.delete(project.workspace);
    if (removed.includes(lastSessionByKind.get('code') ?? '')) lastSessionByKind.delete('code');
    await refreshSummaries();
    if (!wasSelected) return;
    selectedProjectWorkspace = null; rememberNavigation();
    if (revision === selectionRevision && activeKind === 'code') {
      saveComposerDraft(); enterDraft('code', null);
      if (projects[0]) await selectProject(projects[0].workspace);
    }
  } catch (error) { setStatus(String(error)); }
}
$('rename-project').addEventListener('click', () => {
  const project = projects.find((item) => item.workspace === selectedProjectWorkspace);
  if (project) void renameProject(project);
});
$('delete-project').addEventListener('click', () => {
  const project = projects.find((item) => item.workspace === selectedProjectWorkspace);
  if (project) void deleteProject(project);
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
    if (activeSessionId === session.id) { $('session-title').textContent = sessionLabel(session); updateFolderContext(); }
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



$('selected-model').addEventListener('click', () => switchPage('settings'));
$('selected-model').style.cursor = 'pointer';
const turnListenerReady = listen<TurnEvent>('turn-event', ({ payload }) => {
  const id = payload.session_id;
  if (payload.kind === 'usage') {
    if (payload.usage) usageBySession.set(id, payload.usage);
    if (id === activeSessionId) renderModelUsage();
    return;
  }
  if (payload.kind === 'text') addDisplay(id, 'Agent', payload.value ?? '', true);
  else if (payload.kind === 'tool_started') { setToolActivity(id, payload.tool_id ?? '', payload.name ?? '', 'working'); renderTaskMonitor(); }
  else if (payload.kind === 'tool') { setToolActivity(id, payload.tool_id ?? '', payload.name ?? '', payload.value?.startsWith('Error:') ? 'attention' : 'completed', payload.value ?? ''); renderTaskMonitor(); }
  else if (payload.kind === 'error') {
    if (!scheduledPending.has(id)) clearRunning(id);
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
    if (!scheduledPending.has(id)) clearRunning(id);
    turnCompleted.set(id, { at: Date.now(), stopped: payload.kind === 'cancelled' });
    renderTaskMonitor();
    mentionFiles.clear();
    if (id === activeSessionId) setStatus(payload.kind === 'cancelled' ? 'Task stopped.' : 'Ready.');
    void refreshSession(id, true).then(async () => {
      await refreshSummaries();
      if (id === activeSessionId && viewingFiles()) await refreshProjectTree();
      if (id === activeSessionId && viewingChanges()) await refreshSourceControl();
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
  markRunning(payload.sessionId, `Scheduled: ${shortText(payload.prompt, 60)}`, true, payload.scheduleId);
  addDisplay(payload.sessionId, 'You', `[Scheduled] ${payload.prompt}`);
  if (payload.sessionId === activeSessionId) setStatus('Scheduled task is running…');
  renderSessions();
  renderTaskMonitor();
  updateControls();
});

const scheduleRunReady = listen<ScheduleRun>('schedule-run', ({ payload }) => {
  const remaining = (scheduledPending.get(payload.sessionId) ?? 1) - 1;
  if (remaining > 0) scheduledPending.set(payload.sessionId, remaining);
  else { scheduledPending.delete(payload.sessionId); clearRunning(payload.sessionId); void drainQueuedTurn(payload.sessionId); }
  if (payload.sessionId === activeSessionId) {
    setStatus(payload.error ? `Scheduled task failed: ${payload.error}` : 'Scheduled task completed.');
    void refreshSchedules();
    renderTaskMonitor();
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
  if (mentionState && mentionState.items.length && !event.isComposing) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      mentionState.index = (mentionState.index + step + mentionState.items.length) % mentionState.items.length;
      renderMention();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      acceptMention(mentionState.index);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMention();
      return;
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $<HTMLFormElement>('composer').requestSubmit();
    return;
  }
  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  if (recallPrompt(event.key === 'ArrowUp' ? -1 : 1)) event.preventDefault();
});

prompt.addEventListener('input', () => {
  if (activeKind !== 'code') { closeMention(); return; }
  const found = mentionQuery(prompt.value, prompt.selectionStart);
  if (!found) { closeMention(); return; }
  void openMentions(found.start, prompt.selectionStart, found.query);
});
prompt.addEventListener('blur', () => closeMention());

const queuedTurnKey = (): string => `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Waiting questions sit above the composer, each with a Steer button in front. */
function renderQueuedTurns(): void {
  const host = $('queued-turns');
  const queue = activeSessionId ? queuedTurns.get(activeSessionId) ?? [] : [];
  host.replaceChildren(...queue.map((item, index) => {
    const row = document.createElement('div');
    row.className = 'queued-turn';
    const steer = document.createElement('button');
    steer.type = 'button';
    steer.className = 'queued-steer';
    steer.textContent = 'Steer';
    steer.title = 'Send this question into the running turn right now.';
    steer.setAttribute('aria-label', `Steer: ${item.text}`);
    steer.addEventListener('click', () => steerQueuedTurn(index));
    const text = document.createElement('span');
    text.className = 'queued-text';
    text.textContent = item.text;
    text.title = item.text;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'queued-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove queued question');
    remove.addEventListener('click', () => {
      const id = activeSessionId;
      if (!id) return;
      const current = queuedTurns.get(id) ?? [];
      current.splice(index, 1);
      queuedTurns.set(id, current);
      renderQueuedTurns();
      setStatus(current.length ? `${current.length} question(s) queued.` : 'Queue cleared.');
    });
    row.append(steer, text, remove);
    return row;
  }));
  host.toggleAttribute('hidden', queue.length === 0);
}

function enqueueTurn(id: string, text: string, attachments: AttachmentRecord[]): void {
  const queue = queuedTurns.get(id) ?? [];
  queue.push({ key: queuedTurnKey(), text, attachments });
  queuedTurns.set(id, queue);
  if (id === activeSessionId) renderQueuedTurns();
}

/** Steer injects the question into the turn that is running right now. */
function steerQueuedTurn(index: number): void {
  const id = activeSessionId;
  if (!id) return;
  const queue = queuedTurns.get(id) ?? [];
  const [item] = queue.splice(index, 1);
  if (!item) return;
  queuedTurns.set(id, queue);
  renderQueuedTurns();
  void steerRunningTurn(id, item);
}

async function steerRunningTurn(id: string, item: QueuedTurn): Promise<void> {
  try {
    await invoke('steer_turn', {
      sessionId: id,
      prompt: item.text,
      attachments: item.attachments.map(({ id: attachmentId, name, kind }) => ({ id: attachmentId, name, kind })),
    });
    // The backend history carries the question; the transcript mirrors it.
    addDisplay(id, 'You', item.attachments.length ? `${item.text}\n\n[${item.attachments.map((attachment) => attachment.name).join(', ')}]` : item.text);
    if (id === activeSessionId) setStatus('Steered: the agent answers this inside the running turn.');
  } catch (error) {
    // The turn may have finished first; the question still gets answered.
    enqueueTurn(id, item.text, item.attachments);
    if (id === activeSessionId) setStatus(`Steer failed: ${String(error)}`);
    if (!running.has(id)) void drainQueuedTurn(id);
  }
}

/** A running turn cannot take a second prompt, so the queue feeds the next one. */
async function drainQueuedTurn(id: string): Promise<void> {
  if (id !== activeSessionId || running.has(id) || dispatchingQueuedTurn.has(id)) return;
  dispatchingQueuedTurn.add(id);
  try {
    // Keep handing the agent the next waiting question until the queue is empty.
    while (id === activeSessionId && !running.has(id)) {
      const queue = queuedTurns.get(id) ?? [];
      const next = queue.shift();
      if (!next) return;
      queuedTurns.set(id, queue);
      renderQueuedTurns();
      await submitTurn(next.text, next.attachments, true);
    }
  } finally { dispatchingQueuedTurn.delete(id); }
}

/** Runs one turn for the current settings; queued questions reuse this path. */
async function submitTurn(text: string, sent: AttachmentRecord[], fromQueue = false): Promise<void> {
  const submittedDraftKey = draftKey();
  const settings = currentSettings();
  const turnMode = activeKind === 'work' ? 'act' : mode;
  const model = turnMode === 'plan' ? settings.planModel : settings.actModel;
  const btw = /^\/btw(?:\s|$)/i.test(text);
  const sideQuestion = btw ? text.replace(/^\/btw\s*/i, '').trim() : '';
  if (!settings.baseUrl || (btw ? !settings.planModel : !model)) { setStatus('Enter an endpoint, choose a model, and enter a task.'); return; }
  let id: string;
  try { id = await sessionForSubmit(activeSessionId, () => createSession(settings)); }
  catch (error) { setStatus(String(error) === 'No workspace selected' ? 'Choose a workspace to send your message.' : String(error)); return; }
  rememberPrompt(id, text);
  markRunning(id, `Turn: ${shortText(text, 60)}`);
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
    // A queued question never clears the draft the user is typing right now.
    if (!fromQueue) {
      composerDrafts.delete(submittedDraftKey);
      composerDrafts.set(id, { text: '', attachments: [] });
      if (id === activeSessionId) { prompt.value = ''; pendingAttachments = []; renderChips(); }
    }
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
    if (!scheduledPending.has(id)) clearRunning(id);
    renderSessions();
    updateControls();
    if (id === activeSessionId) prompt.focus();
    // A queued question starts only after this turn has fully finished.
    if (!fromQueue) void drainQueuedTurn(id);
  }
}

$<HTMLFormElement>('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!initialized || creatingSession || selectingContext) return;
  const text = prompt.value.trim();
  const sent = [...pendingAttachments];
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
    recallState = { ...EMPTY_RECALL };
    return;
  }
  const settings = currentSettings();
  const turnMode = activeKind === 'work' ? 'act' : mode;
  const model = turnMode === 'plan' ? settings.planModel : settings.actModel;
  if (!settings.baseUrl || (btw ? !settings.planModel : !model)) { setStatus('Enter an endpoint, choose a model, and enter a task.'); return; }
  // While a turn runs the question waits, so several can be lined up at once.
  if (activeSessionId && running.has(activeSessionId)) {
    enqueueTurn(activeSessionId, text, sent);
    prompt.value = '';
    pendingAttachments = [];
    renderChips();
    const waiting = queuedTurns.get(activeSessionId)?.length ?? 1;
    setStatus(`Queued ${waiting} question(s). Steer one to send it next.`);
    prompt.focus();
    return;
  }
  await submitTurn(text, sent);
});

void initialize();
