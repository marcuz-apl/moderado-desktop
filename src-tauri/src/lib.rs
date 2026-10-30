pub mod agent;
pub mod attachments;
pub mod approval_policy;
pub mod checkpoints;
pub mod command;
pub mod db;
pub mod mcp;
pub mod provider;
pub mod schedules;
pub mod search;
pub mod sessions;
pub mod source_control;
pub mod transcript;
pub mod workspace;

use agent::runner::{run_turn_with_hooks, AgentEvent, RunConfig};
use agent::{ApprovalRequest, Mode};
use provider::settings::ProviderSettings;
use provider::ProviderId;
use schedules::{ApprovalPolicy, Schedule, ScheduleStore};
use search::{SearchConfig, SearchSettings, SearchStore};
use serde::{Deserialize, Serialize};
use sessions::{CheckpointRecord, ProjectRecord, SessionKind, SessionRecord, SessionStore, SessionSummary, WorkTaskRecord};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex};

struct SessionRuntime {
    pending: Mutex<Option<PendingApproval>>,
    turn_lock: AsyncMutex<()>,
    next_approval: AtomicU64,
    cancel_turn: watch::Sender<bool>,
}

impl Default for SessionRuntime {
    fn default() -> Self {
        let (cancel_turn, _) = watch::channel(false);
        Self {
            pending: Mutex::new(None),
            turn_lock: AsyncMutex::new(()),
            next_approval: AtomicU64::new(0),
            cancel_turn,
        }
    }
}

struct PendingApproval {
    id: u64,
    preview: ApprovalEvent,
    decision: oneshot::Sender<Option<String>>,
    shown: Option<oneshot::Sender<()>>,
}

struct AppState {
    store: SessionStore,
    schedules: ScheduleStore,
    search: SearchStore,
    checkpoints: checkpoints::CheckpointStore,
    runtimes: Mutex<HashMap<String, Arc<SessionRuntime>>>,
    workspace_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScheduleRunEvent {
    session_id: String,
    schedule_id: String,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ScheduleStartedEvent {
    session_id: String,
    schedule_id: String,
    prompt: String,
}

impl AppState {
    fn runtime(&self, id: &str) -> Result<Arc<SessionRuntime>, String> {
        self.store.get(id)?;
        let mut runtimes = self
            .runtimes
            .lock()
            .map_err(|_| "Session state unavailable")?;
        Ok(runtimes
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(SessionRuntime::default()))
            .clone())
    }

    fn workspace_lock(&self, workspace: &str) -> Result<Arc<AsyncMutex<()>>, String> {
        let mut locks = self
            .workspace_locks
            .lock()
            .map_err(|_| "Workspace state unavailable")?;
        Ok(locks
            .entry(workspace.to_owned())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone())
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TurnEvent {
    Text { session_id: String, value: String },
    ToolStarted { session_id: String, tool_id: String, name: String },
    Tool { session_id: String, tool_id: String, name: String, value: String },
    Usage {
        session_id: String,
        usage: crate::agent::runner::ModelUsage,
    },
    Error { session_id: String, value: String },
    Done { session_id: String },
    Cancelled { session_id: String },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApprovalEvent {
    session_id: String,
    id: u64,
    category: crate::approval_policy::ApprovalCategory,
    title: String,
    detail: String,
    has_preview: bool,
    path: String,
    before: String,
    after: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApprovalExpired {
    session_id: String,
    id: u64,
}

#[tauri::command]
async fn create_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    settings: ProviderSettings,
    kind: SessionKind,
) -> Result<SessionRecord, String> {
    if matches!(kind, SessionKind::Work) {
        return create_work_session_in_documents(&state.store, settings);
    }
    let (sender, receiver) = oneshot::channel();
    app.dialog().file().pick_folder(move |selection| {
        let _ = sender.send(selection);
    });
    let selected = receiver
        .await
        .map_err(|_| "Workspace picker closed unexpectedly")?
        .ok_or("No workspace selected")?;
    let path = PathBuf::from(selected.to_string());
    let path = path
        .canonicalize()
        .map_err(|error| format!("Workspace unavailable: {error}"))?;
    if !path.is_dir() {
        return Err("Workspace must be a directory".into());
    }
    if let Some(existing) = state.store.find_code_project_session(&path)? {
        return Ok(existing);
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Workspace".into());
    state
        .store
        .create_with_kind(&path, &name, settings, SessionKind::Code)
}

#[tauri::command]
fn create_session_in_project(
    state: tauri::State<'_, AppState>,
    project_workspace: String,
    settings: ProviderSettings,
) -> Result<SessionRecord, String> {
    let existing = state.store.list()?;
    let mut number = 1;
    while existing.iter().any(|session| session.workspace == project_workspace && session.name == format!("Session {number}")) { number += 1; }
    state.store.create_session_for_project(
        &project_workspace,
        &format!("Session {number}"),
        settings,
    )
}

#[tauri::command]
fn create_work_task(state: tauri::State<'_, AppState>) -> Result<WorkTaskRecord, String> {
    let documents = dirs::document_dir().or_else(|| dirs::home_dir().map(|home| home.join("Documents"))).ok_or("Documents folder is unavailable")?;
    let workspace = sessions::create_default_work_workspace(&documents)?;
    let name = workspace.file_name().ok_or("Task folder has no name")?.to_string_lossy().into_owned();
    state.store.create_work_task(&workspace, &name)
}

#[tauri::command]
fn list_work_tasks(state: tauri::State<'_, AppState>) -> Result<Vec<WorkTaskRecord>, String> {
    state.store.list_work_tasks()
}

#[tauri::command]
fn rename_work_task(state: tauri::State<'_, AppState>, task_id: String, name: String) -> Result<(), String> {
    state.store.rename_work_task(&task_id, &name)
}

#[tauri::command]
fn create_work_session_for_task(state: tauri::State<'_, AppState>, task_id: String, settings: ProviderSettings) -> Result<SessionRecord, String> {
    let existing = state.store.list()?;
    let mut number = 1;
    while existing.iter().any(|session| session.task_id.as_deref() == Some(&task_id) && session.name == format!("Session {number}")) { number += 1; }
    state.store.create_work_session_for_task(&task_id, &format!("Session {number}"), settings)
}

#[tauri::command]
fn delete_work_task(app: tauri::AppHandle, state: tauri::State<'_, AppState>, task_id: String) -> Result<(), String> {
    let children: Vec<_> = state.store.list()?.into_iter().filter(|session| session.task_id.as_deref() == Some(&task_id)).collect();
    let runtimes: Vec<_> = children.iter().map(|session| state.runtime(&session.id)).collect::<Result<_, _>>()?;
    let _guards: Vec<_> = runtimes.iter().map(|runtime| runtime.turn_lock.try_lock().map_err(|_| "Stop the running sessions before removing this task")).collect::<Result<_, _>>()?;
    let removed = state.store.delete_work_task(&task_id)?;
    if let Ok(root) = app.path().app_data_dir() {
        for id in &removed { let _ = std::fs::remove_dir_all(root.join("attachments").join(id)); }
    }
    state.runtimes.lock().map_err(|_| "Session state unavailable")?.retain(|id, _| !removed.contains(id));
    Ok(())
}

async fn pick_project_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog().file().pick_folder(move |selection| { let _ = sender.send(selection); });
    let selected = receiver.await.map_err(|_| "Folder picker closed unexpectedly")?.ok_or("No folder selected")?;
    Ok(PathBuf::from(selected.to_string()))
}

#[tauri::command]
async fn create_project(app: tauri::AppHandle, state: tauri::State<'_, AppState>, name: String) -> Result<ProjectRecord, String> {
    let parent = pick_project_folder(&app).await?;
    state.store.create_project_folder(&parent, &name)
}

#[tauri::command]
async fn open_project(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<ProjectRecord, String> {
    let folder = pick_project_folder(&app).await?;
    state.store.register_project(&folder)
}

#[tauri::command]
fn list_projects(state: tauri::State<'_, AppState>) -> Result<Vec<ProjectRecord>, String> { state.store.list_projects() }

#[tauri::command]
fn rename_project(state: tauri::State<'_, AppState>, project_workspace: String, name: String) -> Result<(), String> {
    state.store.rename_project(&project_workspace, &name)
}

#[tauri::command]
fn remove_project(state: tauri::State<'_, AppState>, project_workspace: String) -> Result<(), String> {
    for session in state.store.list()?.iter().filter(|session| session.kind == SessionKind::Code && session.workspace == project_workspace) {
        let runtime = state.runtime(&session.id)?;
        let _guard = runtime.turn_lock.try_lock().map_err(|_| "Stop the running sessions before removing this project")?;
    }
    state.store.remove_project(&project_workspace)
}

#[tauri::command]
fn create_default_session(
    state: tauri::State<'_, AppState>,
    settings: ProviderSettings,
    kind: SessionKind,
) -> Result<SessionRecord, String> {
    if matches!(kind, SessionKind::Work) {
        return create_work_session_in_documents(&state.store, settings);
    }
    let documents = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or("Documents folder is unavailable")?;
    let workspace = sessions::create_default_workspace(&documents)?;
    let name = workspace
        .file_name()
        .ok_or("Session folder has no name")?
        .to_string_lossy()
        .into_owned();
    state
        .store
        .create_with_kind(&workspace, &name, settings, SessionKind::Code)
}

fn create_work_session_in_documents(
    store: &SessionStore,
    settings: ProviderSettings,
) -> Result<SessionRecord, String> {
    let documents = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .ok_or("Documents folder is unavailable")?;
    let workspace = sessions::create_default_work_workspace(&documents)?;
    let task_name = workspace.file_name().ok_or("Work session folder has no name")?.to_string_lossy().into_owned();
    let task = store.create_work_task(&workspace, &task_name)?;
    store.create_work_session_for_task(&task.id, "Session 1", settings)
}

#[tauri::command]
fn list_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<SessionSummary>, String> {
    state.store.list()
}

#[tauri::command]
fn get_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    state.store.get(&session_id)
}

#[tauri::command]
fn save_auto_approve(
    state: tauri::State<'_, AppState>,
    session_id: String,
    mut policy: crate::approval_policy::AutoApprovePolicy,
) -> Result<(), String> {
    if state.store.get(&session_id)?.kind == SessionKind::Work {
        policy.execute_command = false;
        policy.use_mcp_servers = false;
    }
    state.store.update_auto_approve(&session_id, policy)
}

fn browser_workspace(state: &AppState, session_id: Option<String>, project_workspace: Option<String>, work_task_id: Option<String>) -> Result<PathBuf, String> {
    if let Some(workspace) = project_workspace {
        return Ok(PathBuf::from(state.store.get_project(&workspace)?.workspace));
    }
    if let Some(task_id) = work_task_id {
        return Ok(PathBuf::from(state.store.get_work_task(&task_id)?.workspace));
    }
    let id = session_id.ok_or("Select a task or project first")?;
    Ok(PathBuf::from(state.store.get(&id)?.workspace))
}

#[tauri::command]
fn list_project_entries(
    state: tauri::State<'_, AppState>,
    session_id: Option<String>,
    project_workspace: Option<String>,
    work_task_id: Option<String>,
    path: String,
) -> Result<Vec<workspace::ProjectEntry>, String> {
    let root = browser_workspace(&state, session_id, project_workspace, work_task_id)?;
    workspace::list_project_entries(&root, &path)
}

#[tauri::command]
fn read_project_file(
    state: tauri::State<'_, AppState>,
    session_id: Option<String>,
    project_workspace: Option<String>,
    work_task_id: Option<String>,
    path: String,
) -> Result<String, String> {
    let root = browser_workspace(&state, session_id, project_workspace, work_task_id)?;
    workspace::read_text(&root, &path)
}

fn registered_project_root(state: &AppState, project_workspace: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(state.store.get_project(project_workspace)?.workspace))
}

#[tauri::command]
fn create_project_file(
    state: tauri::State<'_, AppState>,
    project_workspace: String,
    parent_path: String,
    name: String,
) -> Result<(), String> {
    let root = registered_project_root(&state, &project_workspace)?;
    workspace::create_project_file(&root, &parent_path, &name)
}

#[tauri::command]
fn create_project_folder(
    state: tauri::State<'_, AppState>,
    project_workspace: String,
    parent_path: String,
    name: String,
) -> Result<(), String> {
    let root = registered_project_root(&state, &project_workspace)?;
    workspace::create_project_folder(&root, &parent_path, &name)
}

#[tauri::command]
fn rename_project_entry(
    state: tauri::State<'_, AppState>,
    project_workspace: String,
    path: String,
    new_name: String,
) -> Result<(), String> {
    let root = registered_project_root(&state, &project_workspace)?;
    workspace::rename_project_entry(&root, &path, &new_name)
}

#[tauri::command]
fn delete_project_entry(
    state: tauri::State<'_, AppState>,
    project_workspace: String,
    path: String,
) -> Result<(), String> {
    let root = registered_project_root(&state, &project_workspace)?;
    workspace::delete_project_entry(&root, &path)
}

#[tauri::command]
fn get_source_control(
    state: tauri::State<'_, AppState>,
    session_id: Option<String>,
    project_workspace: Option<String>,
    work_task_id: Option<String>,
) -> Result<source_control::SourceControlSnapshot, String> {
    let root = browser_workspace(&state, session_id, project_workspace, work_task_id)?;
    source_control::get_source_control(&root)
}

#[tauri::command]
fn rename_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    state.store.rename(&session_id, &name)
}

#[tauri::command]
async fn add_attachments(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
    paths: Vec<String>,
) -> Result<Vec<attachments::AttachmentRecord>, String> {
    let record = state.store.get(&session_id)?;
    if !matches!(record.kind, SessionKind::Work) {
        return Err("Attachments are only available in Work sessions".into());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("attachments");
    let sources: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let records = attachments::store(&root, &session_id, &sources)?;
    attachments::copy_into_workspace(&root, PathBuf::from(record.workspace).as_path(), &records)?;
    state.store.add_attachments(&records)?;
    Ok(records)
}

#[tauri::command]
fn delete_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let runtime = state.runtime(&session_id)?;
    let _guard = runtime
        .turn_lock
        .try_lock()
        .map_err(|_| "Session is running")?;
    state.store.delete(&session_id)?;
    if let Ok(root) = app.path().app_data_dir() {
        let _ = std::fs::remove_dir_all(root.join("attachments").join(&session_id));
    }
    state
        .runtimes
        .lock()
        .map_err(|_| "Session state unavailable")?
        .remove(&session_id);
    Ok(())
}

#[tauri::command]
fn create_schedule(
    state: tauri::State<'_, AppState>,
    session_id: String,
    prompt: String,
    mode: Mode,
    approval_policy: ApprovalPolicy,
    next_run_at: i64,
    interval_seconds: Option<i64>,
) -> Result<Schedule, String> {
    let session = state.store.get(&session_id)?;
    let model = match mode {
        Mode::Plan => &session.settings.plan_model,
        Mode::Act => &session.settings.act_model,
    };
    if model.trim().is_empty() {
        return Err("Save a model for this session before scheduling".into());
    }
    session
        .settings
        .provider_id
        .base_url(&session.settings.base_url)?;
    if matches!(mode, Mode::Plan) && matches!(approval_policy, ApprovalPolicy::AutoWrite) {
        return Err("Auto-write approval applies only to Act mode".into());
    }
    if next_run_at <= schedules::unix_now() {
        return Err("Schedule time must be in the future".into());
    }
    state.schedules.create(
        &session_id,
        &session.settings,
        &state.search.get(&session_id)?,
        schedules::ScheduleSpec {
            prompt: &prompt,
            mode,
            approval_policy,
            next_run_at,
            interval_seconds,
        },
    )
}

#[tauri::command]
fn list_schedules(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Schedule>, String> {
    state.store.get(&session_id)?;
    state.schedules.list(&session_id)
}

#[tauri::command]
fn delete_schedule(
    state: tauri::State<'_, AppState>,
    session_id: String,
    schedule_id: String,
) -> Result<(), String> {
    state.schedules.delete(&session_id, &schedule_id)
}

#[tauri::command]
fn retry_schedule(
    state: tauri::State<'_, AppState>,
    session_id: String,
    schedule_id: String,
) -> Result<(), String> {
    state
        .schedules
        .retry(&session_id, &schedule_id, schedules::unix_now())
}

#[tauri::command]
fn get_search_settings(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<SearchSettings, String> {
    state.store.get(&session_id)?;
    state.search.get(&session_id)
}

#[tauri::command]
fn save_search_settings(
    state: tauri::State<'_, AppState>,
    session_id: String,
    settings: SearchSettings,
) -> Result<(), String> {
    state.store.get(&session_id)?;
    state.search.save(&session_id, &settings)
}

#[tauri::command]
async fn save_search_key(endpoint: String, api_key: String) -> Result<(), String> {
    let endpoint = search::validate_endpoint(&endpoint)?;
    if api_key.is_empty() {
        return Err("Search API key cannot be empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new("com.moderado.desktop.search", &endpoint)
            .map_err(|_| "Could not access OS keychain")?;
        entry
            .set_password(&api_key)
            .map_err(|_| "Could not save search key to OS keychain".into())
    })
    .await
    .map_err(|_| "Keychain task failed")?
}

async fn search_key(endpoint: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new("com.moderado.desktop.search", &endpoint)
            .map_err(|_| "Could not access OS keychain")?;
        match entry.get_password() {
            Ok(key) => Ok(key),
            Err(keyring::Error::NoEntry) => Ok(String::new()),
            Err(_) => Err("Could not read search key from OS keychain".into()),
        }
    })
    .await
    .map_err(|_| "Keychain task failed")?
}

#[tauri::command]
async fn import_transcript(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    source_session_id: String,
    name: String,
    format: transcript::TranscriptFormat,
) -> Result<SessionRecord, String> {
    let source = state.store.get(&source_session_id)?;
    let (sender, receiver) = oneshot::channel();
    app.dialog().file().pick_file(move |selection| {
        let _ = sender.send(selection);
    });
    let selected = receiver
        .await
        .map_err(|_| "Transcript picker closed unexpectedly")?
        .ok_or("No transcript selected")?;
    let path = PathBuf::from(selected.to_string());
    let size = std::fs::metadata(&path)
        .map_err(|error| format!("Transcript unavailable: {error}"))?
        .len();
    if size > 8 * 1024 * 1024 {
        return Err("Transcript exceeds 8 MiB".into());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("Could not read transcript: {error}"))?;
    let history = transcript::parse_jsonl(&text, format)?;
    let session = if source.kind == SessionKind::Work {
        let documents = dirs::document_dir().or_else(|| dirs::home_dir().map(|home| home.join("Documents"))).ok_or("Documents folder is unavailable")?;
        let workspace = sessions::create_default_work_workspace(&documents)?;
        let task_name = workspace.file_name().ok_or("Task folder has no name")?.to_string_lossy().into_owned();
        let task = state.store.create_work_task(&workspace, &task_name)?;
        state.store.create_work_session_for_task(&task.id, &name, source.settings)?
    } else {
        state.store.create_session_for_project(&source.workspace, &name, source.settings)?
    };
    if let Err(error) = state
        .store
        .save_state(&session.id, &session.settings, &history)
    {
        let _ = state.store.delete(&session.id);
        return Err(error);
    }
    state.store.get(&session.id)
}

#[tauri::command]
fn list_checkpoints(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<Vec<CheckpointRecord>, String> {
    state.store.get(&session_id)?;
    state.store.list_checkpoints(&session_id)
}

#[tauri::command]
fn preview_checkpoint(
    state: tauri::State<'_, AppState>,
    session_id: String,
    checkpoint_id: String,
) -> Result<checkpoints::CheckpointPreview, String> {
    let record = state.store.get(&session_id)?;
    let checkpoint = state.store.get_checkpoint(&session_id, &checkpoint_id)?;
    state
        .checkpoints
        .preview(PathBuf::from(record.workspace).as_path(), &checkpoint)
}

#[tauri::command]
async fn restore_checkpoint(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
    checkpoint_id: String,
    expected_tree: String,
) -> Result<usize, String> {
    let runtime = state.runtime(&session_id)?;
    let _guard = runtime
        .turn_lock
        .try_lock()
        .map_err(|_| "Session is running")?;
    let record = state.store.get(&session_id)?;
    let workspace_lock = state.workspace_lock(&record.workspace)?;
    let _workspace_guard = workspace_lock.lock().await;
    let checkpoint = state.store.get_checkpoint(&session_id, &checkpoint_id)?;
    let workspace = PathBuf::from(&record.workspace);
    let preview = state.checkpoints.preview(&workspace, &checkpoint)?;
    if preview.current_tree != expected_tree {
        return Err("Workspace changed after the restore preview; review it again".into());
    }
    if preview.changes.is_empty() {
        return Ok(0);
    }
    let backup = state
        .checkpoints
        .create(&workspace, &session_id, &checkpoint.path)?;
    state.store.add_checkpoint(&backup)?;
    let restored = state
        .checkpoints
        .restore(&workspace, &checkpoint, &expected_tree)?;
    state
        .store
        .append_restore_marker(&record.workspace, &checkpoint_id, restored)?;
    let _ = app.emit("checkpoint-created", backup);
    Ok(restored)
}

#[tauri::command]
fn respond_approval(
    state: tauri::State<'_, AppState>,
    session_id: String,
    id: u64,
    content: Option<String>,
) -> Result<(), String> {
    let runtime = state.runtime(&session_id)?;
    let mut pending = runtime
        .pending
        .lock()
        .map_err(|_| "Approval state unavailable")?;
    match pending.take() {
        Some(mut current) if current.id == id => {
            if let Some(shown) = current.shown.take() {
                let _ = shown.send(());
            }
            current
                .decision
                .send(content)
                .map_err(|_| "Approval expired".into())
        }
        Some(other) => {
            *pending = Some(other);
            Err("Approval ID does not match".into())
        }
        None => Err("No approval is pending".into()),
    }
}

#[tauri::command]
fn activate_approval(
    state: tauri::State<'_, AppState>,
    session_id: String,
    id: u64,
) -> Result<(), String> {
    let runtime = state.runtime(&session_id)?;
    let mut pending = runtime
        .pending
        .lock()
        .map_err(|_| "Approval state unavailable")?;
    let request = pending.as_mut().ok_or("No approval is pending")?;
    if request.id != id {
        return Err("Approval ID does not match".into());
    }
    if let Some(shown) = request.shown.take() {
        shown.send(()).map_err(|_| "Approval expired")?;
    }
    Ok(())
}

#[tauri::command]
fn list_pending_approvals(state: tauri::State<'_, AppState>) -> Result<Vec<ApprovalEvent>, String> {
    let runtimes = state
        .runtimes
        .lock()
        .map_err(|_| "Session state unavailable")?;
    let mut events = Vec::new();
    for runtime in runtimes.values() {
        if let Some(pending) = runtime
            .pending
            .lock()
            .map_err(|_| "Approval state unavailable")?
            .as_ref()
        {
            events.push(pending.preview.clone());
        }
    }
    Ok(events)
}

#[tauri::command]
async fn save_provider_key(
    provider_id: ProviderId,
    base_url: String,
    api_key: String,
) -> Result<(), String> {
    let base_url = provider_id.base_url(&base_url)?;
    if provider_id.preset().local {
        return Err("Local providers do not use API keys".into());
    }
    if api_key.is_empty() {
        return Err("API key cannot be empty".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new("com.moderado.desktop", &base_url)
            .map_err(|_| "Could not access OS keychain")?;
        entry
            .set_password(&api_key)
            .map_err(|_| "Could not save API key to OS keychain".into())
    })
    .await
    .map_err(|_| "Keychain task failed")?
}

async fn provider_key(base_url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new("com.moderado.desktop", &base_url)
            .map_err(|_| "Could not access OS keychain")?;
        match entry.get_password() {
            Ok(value) => Ok(value),
            Err(keyring::Error::NoEntry) => Ok(String::new()),
            Err(_) => Err("Could not read API key from OS keychain".into()),
        }
    })
    .await
    .map_err(|_| "Keychain task failed")?
}

async fn configured_key(provider_id: ProviderId, base_url: &str) -> Result<String, String> {
    if provider_id.preset().local {
        Ok(String::new())
    } else {
        provider_key(base_url.to_owned()).await
    }
}

#[tauri::command]
async fn discover_models(
    provider_id: ProviderId,
    base_url: String,
) -> Result<Vec<provider::ModelInfo>, String> {
    let base_url = provider_id.base_url(&base_url)?;
    let key = configured_key(provider_id, &base_url).await?;
    provider::list_model_catalog(&base_url, &key).await
}

#[tauri::command]
fn load_mcp_config() -> Result<mcp::McpConfig, String> {
    mcp::load()
}

#[tauri::command]
fn save_mcp_config(config: mcp::McpConfig) -> Result<mcp::McpConfig, String> {
    mcp::save(&config)
}

#[tauri::command]
async fn discover_mcp_tools(config: mcp::McpConfig) -> Result<mcp::McpDiscovery, String> {
    mcp::validate(&config)?;
    let registry = mcp::McpRegistry::connect(&config).await;
    Ok(mcp::McpDiscovery {
        tools: registry.tools().to_vec(),
        errors: registry.errors().to_vec(),
    })
}

#[tauri::command]
fn provider_catalog() -> Vec<provider::ProviderPreset> {
    provider::PRESETS.to_vec()
}

#[tauri::command]
async fn probe_local_providers() -> Vec<provider::LocalProviderStatus> {
    provider::probe_local_providers().await
}

/// Provider defaults live in a dotfile in the user's home folder, which is
/// `$HOME` on macOS and Linux and `%USERPROFILE%` on Windows — the same folder
/// in every case. The app handle is unused by design: this file deliberately
/// sits beside the user rather than inside the platform app-data directory, so
/// it can be inspected and edited by hand.
fn settings_path(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join(".moderado").join("config.json"))
}

#[tauri::command]
fn load_provider_settings(app: tauri::AppHandle) -> Result<Option<ProviderSettings>, String> {
    provider::settings::load(&settings_path(&app)?)
}

#[tauri::command]
async fn save_provider_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: Option<String>,
    settings: ProviderSettings,
) -> Result<ProviderSettings, String> {
    let base_url = settings.provider_id.base_url(&settings.base_url)?;
    let key = configured_key(settings.provider_id, &base_url).await?;
    let saved = provider::settings::save(&settings_path(&app)?, settings, &key).await?;
    if let Some(id) = session_id {
        let record = state.store.get(&id)?;
        state.store.save_state(&id, &saved, &record.history)?;
    }
    Ok(saved)
}

#[tauri::command]
async fn stop_turn(state: tauri::State<'_, AppState>, session_id: String) -> Result<(), String> {
    let runtime = state.runtime(&session_id)?;
    runtime.cancel_turn.send_replace(true);
    Ok(())
}

#[tauri::command]
async fn ask_btw(
    state: tauri::State<'_, AppState>,
    session_id: String,
    settings: ProviderSettings,
    model: String,
    question: String,
) -> Result<String, String> {
    if question.trim().is_empty() || question.len() > 8_000 {
        return Err("Side question must be 1–8,000 characters".into());
    }
    if model.trim().is_empty() || model.len() > 200 {
        return Err("Model name is required".into());
    }
    let runtime = state.runtime(&session_id)?;
    let _guard = runtime
        .turn_lock
        .try_lock()
        .map_err(|_| "This session is already running")?;
    runtime.cancel_turn.send_replace(false);
    let mut cancel = runtime.cancel_turn.subscribe();
    let (base_url, api_key) = (
        settings.provider_id.base_url(&settings.base_url)?,
        configured_key(
            settings.provider_id,
            &settings.provider_id.base_url(&settings.base_url)?,
        )
        .await?,
    );
    let messages = vec![
        serde_json::json!({"role":"system","content":"You are Moderado answering a quick side question (by-the-way). Answer in 1 to 3 short sentences or under 35 words. No conversational filler, pleasantries, or preambles. Output only the direct answer or code."}),
        serde_json::json!({"role":"user","content":question}),
    ];
    tokio::select! {
        result = provider::chat_completion(&base_url, &model, &api_key, &messages, &[], |_| {}) => result.map(|completion| completion.content),
        _ = cancel.changed() => Err("Side question stopped by user".into()),
    }
}

async fn await_approval(
    app: &tauri::AppHandle,
    runtime: &SessionRuntime,
    session_id: &str,
    request: ApprovalRequest,
) -> Option<String> {
    let id = runtime.next_approval.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = oneshot::channel();
    let (shown_sender, shown_receiver) = oneshot::channel();
    let event = ApprovalEvent {
        session_id: session_id.to_owned(),
        id,
        category: request.category,
        title: request.title,
        detail: request.detail,
        has_preview: request.preview.is_some(),
        path: request.preview.as_ref().map(|preview| preview.path.clone()).unwrap_or_default(),
        before: request.preview.as_ref().map(|preview| preview.before.clone()).unwrap_or_default(),
        after: request.preview.as_ref().map(|preview| preview.after.clone()).unwrap_or_default(),
    };
    if let Ok(mut pending) = runtime.pending.lock() {
        *pending = Some(PendingApproval {
            id,
            preview: event.clone(),
            decision: sender,
            shown: Some(shown_sender),
        });
    } else {
        return None;
    }
    if app.emit("approval-request", event).is_err() {
        if let Ok(mut pending) = runtime.pending.lock() {
            pending.take();
        }
        return None;
    }
    if !matches!(
        tokio::time::timeout(std::time::Duration::from_secs(300), shown_receiver).await,
        Ok(Ok(()))
    ) {
        if let Ok(mut pending) = runtime.pending.lock() {
            pending.take();
        }
        let _ = app.emit(
            "approval-expired",
            ApprovalExpired {
                session_id: session_id.to_owned(),
                id,
            },
        );
        return None;
    }
    let decision = tokio::time::timeout(std::time::Duration::from_secs(300), receiver).await;
    let expired = if let Ok(mut pending) = runtime.pending.lock() {
        pending.take().is_some() && !matches!(&decision, Ok(Ok(_)))
    } else {
        false
    };
    if expired {
        let _ = app.emit(
            "approval-expired",
            ApprovalExpired {
                session_id: session_id.to_owned(),
                id,
            },
        );
    }
    match decision {
        Ok(Ok(content)) => content,
        _ => None,
    }
}

#[tauri::command]
async fn start_turn(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    session_id: String,
    settings: ProviderSettings,
    mode: Mode,
    prompt: String,
    attachments: Option<Vec<AttachmentRef>>,
) -> Result<(), String> {
    execute_turn(
        &app,
        state.inner(),
        TurnRequest {
            session_id,
            settings,
            mode,
            prompt,
            approval_policy: ApprovalPolicy::Prompt,
            scheduled: false,
            expected_search: None,
            attachments: attachments.unwrap_or_default(),
        },
    )
    .await
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentRef {
    id: String,
    name: String,
    kind: String,
}

struct TurnRequest {
    session_id: String,
    settings: ProviderSettings,
    mode: Mode,
    prompt: String,
    approval_policy: ApprovalPolicy,
    scheduled: bool,
    expected_search: Option<SearchSettings>,
    attachments: Vec<AttachmentRef>,
}

async fn execute_turn(
    app: &tauri::AppHandle,
    state: &AppState,
    request: TurnRequest,
) -> Result<(), String> {
    let TurnRequest {
        session_id,
        settings,
        mode,
        prompt,
        approval_policy,
        scheduled,
        expected_search,
        attachments,
    } = request;
    let runtime = state.runtime(&session_id)?;
    let _guard = if scheduled {
        runtime.turn_lock.lock().await
    } else {
        runtime
            .turn_lock
            .try_lock()
            .map_err(|_| "This session is already running")?
    };
    runtime.cancel_turn.send_replace(false);
    let mut cancel = runtime.cancel_turn.subscribe();
    let record = state.store.get(&session_id)?;
    let workspace = PathBuf::from(&record.workspace);
    let workspace_lock = state.workspace_lock(&record.workspace)?;
    let _workspace_guard = workspace_lock.lock().await;
    let record = state.store.get(&session_id)?;
    if scheduled && record.settings != settings {
        return Err("Session provider or models changed; recreate this schedule to authorize the new settings".into());
    }
    let live_search = state.search.get(&session_id)?;
    if expected_search
        .as_ref()
        .is_some_and(|expected| *expected != live_search)
    {
        return Err(
            "Session web search settings changed; recreate this schedule to authorize them".into(),
        );
    }
    if prompt.trim().is_empty() || prompt.len() > 64_000 {
        return Err("Prompt must be 1–64,000 characters".into());
    }
    let model = match mode {
        Mode::Plan => settings.plan_model.clone(),
        Mode::Act => settings.act_model.clone(),
    };
    if model.trim().is_empty() || model.len() > 200 {
        return Err("Model name is required".into());
    }
    let base_url = settings.provider_id.base_url(&settings.base_url)?;
    let api_key = configured_key(settings.provider_id, &base_url).await?;
    let search_settings = expected_search.unwrap_or(live_search);
    let search = if search_settings.enabled && !search_settings.endpoint.is_empty() {
        let endpoint = search::validate_endpoint(&search_settings.endpoint)?;
        Some(SearchConfig {
            key: search_key(endpoint.clone()).await?,
            endpoint,
        })
    } else {
        None
    };
    let attachments_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("attachments");
    let attachment_refs: Vec<serde_json::Value> = attachments
        .iter()
        .map(|attachment| {
            serde_json::json!({
                "type": "attachment",
                "id": attachment.id,
                "name": attachment.name,
                "kind": attachment.kind,
            })
        })
        .collect();
    let mut messages = if record.settings.provider_id == settings.provider_id
        && record.settings.base_url == base_url
    {
        record.history
    } else {
        Vec::new()
    };
    sessions::repair_interrupted_tool_calls(&mut messages);
    let mut settings = settings;
    settings.base_url = base_url.clone();
    state.store.save_state(&session_id, &settings, &messages)?;
    if scheduled && matches!(mode, Mode::Act) {
        let checkpoint = state
            .checkpoints
            .create_before_run(&workspace, &session_id)?;
        state.store.add_checkpoint(&checkpoint)?;
        let _ = app.emit("checkpoint-created", &checkpoint);
    }
    // Connect MCP servers for Code sessions only. A server that fails to start
    // is recorded and skipped, never allowed to block the turn.
    let mcp_registry = if record.kind == SessionKind::Code {
        let config = mcp::load().unwrap_or_default();
        Some(mcp::McpRegistry::connect(&config).await)
    } else {
        None
    };
    let turn = run_turn_with_hooks(
        RunConfig {
            workspace: &workspace,
            base_url: &base_url,
            model: &model,
            api_key: &api_key,
            mode,
            search: search.as_ref(),
            kind: record.kind,
            auto_approve: record.auto_approve,
            attachments: &attachment_refs,
            attachments_root: &attachments_root,
            session_id: &session_id,
            mcp: mcp_registry.as_ref(),
        },
        &mut messages,
        &prompt,
        |request| {
            let runtime = &runtime;
            let session_id = &session_id;
            async move {
                if matches!(approval_policy, ApprovalPolicy::AutoWrite) && request.category == crate::approval_policy::ApprovalCategory::EditFiles {
                    Some(request.preview.map(|preview| preview.after).unwrap_or_default())
                } else {
                    await_approval(app, runtime, session_id, request).await
                }
            }
        },
        |event| match event {
            AgentEvent::Text(value) => {
                let _ = app.emit(
                    "turn-event",
                    TurnEvent::Text {
                        session_id: session_id.clone(),
                        value,
                    },
                );
            }
            AgentEvent::ToolStarted { id, name } => {
                let _ = app.emit(
                    "turn-event",
                    TurnEvent::ToolStarted {
                        session_id: session_id.clone(),
                        tool_id: id,
                        name,
                    },
                );
            }
            AgentEvent::ToolCompleted { id, name, value } => {
                let _ = app.emit(
                    "turn-event",
                    TurnEvent::Tool {
                        session_id: session_id.clone(),
                        tool_id: id,
                        name,
                        value,
                    },
                );
            }
            AgentEvent::Usage(usage) => {
                let _ = app.emit(
                    "turn-event",
                    TurnEvent::Usage {
                        session_id: session_id.clone(),
                        usage,
                    },
                );
            }
        },
        |preview| {
            let checkpoint = state
                .checkpoints
                .create(&workspace, &session_id, &preview.path)?;
            state.store.add_checkpoint(&checkpoint)?;
            let _ = app.emit("checkpoint-created", &checkpoint);
            Ok(())
        },
        |history| state.store.save_state(&session_id, &settings, history),
    );
    let result = tokio::select! {
        result = turn => Some(result),
        _ = cancel.changed() => None,
    };
    state.store.save_state(&session_id, &settings, &messages)?;
    match result {
        Some(Ok(())) => {
            let _ = app.emit("turn-event", TurnEvent::Done { session_id });
            Ok(())
        }
        Some(Err(error)) => {
            let _ = app.emit(
                "turn-event",
                TurnEvent::Error {
                    session_id,
                    value: error.clone(),
                },
            );
            Err(error)
        }
        None => {
            if let Ok(mut pending) = runtime.pending.lock() {
                if let Some(pending) = pending.take() {
                    let _ = pending.decision.send(None);
                }
            }
            sessions::repair_interrupted_tool_calls(&mut messages);
            state.store.save_state(&session_id, &settings, &messages)?;
            let _ = app.emit("turn-event", TurnEvent::Cancelled { session_id });
            Ok(())
        }
    }
}

async fn run_due_schedule(app: tauri::AppHandle, schedule: Schedule) {
    let _ = app.emit(
        "schedule-started",
        ScheduleStartedEvent {
            session_id: schedule.session_id.clone(),
            schedule_id: schedule.id.clone(),
            prompt: schedule.prompt.clone(),
        },
    );
    let state = app.state::<AppState>();
    let result = match state.store.get(&schedule.session_id) {
        Ok(session) if session.settings != schedule.settings => {
            let error = "Session provider or models changed; recreate this schedule to authorize the new settings".to_owned();
            Err(error)
        }
        Ok(_)
            if state.search.get(&schedule.session_id).as_ref() != Ok(&schedule.search_settings) =>
        {
            Err(
                "Session web search settings changed; recreate this schedule to authorize them"
                    .into(),
            )
        }
        Ok(session) => {
            execute_turn(
                &app,
                state.inner(),
                TurnRequest {
                    session_id: schedule.session_id.clone(),
                    settings: session.settings,
                    mode: schedule.mode,
                    prompt: schedule.prompt.clone(),
                    approval_policy: schedule.approval_policy,
                    scheduled: true,
                    expected_search: Some(schedule.search_settings.clone()),
                    attachments: Vec::new(),
                },
            )
            .await
        }
        Err(error) => Err(error),
    };
    let error = result.err();
    let finish = state
        .schedules
        .list(&schedule.session_id)
        .and_then(|items| {
            if items
                .into_iter()
                .find(|item| item.id == schedule.id)
                .is_some_and(|item| item.in_flight)
            {
                if state.store.get(&schedule.session_id)?.settings != schedule.settings {
                    state.schedules.pause(&schedule.id, "Session provider or models changed; recreate this schedule to authorize the new settings")
                } else if state.search.get(&schedule.session_id)? != schedule.search_settings {
                    state.schedules.pause(&schedule.id, "Session web search settings changed; recreate this schedule to authorize them")
                } else {
                    state.schedules.finish(&schedule.id, error.as_deref(), schedules::unix_now())
                }
            } else {
                Ok(())
            }
        });
    if let Err(failure) = finish {
        let _ = app.emit("scheduler-error", failure);
    }
    let _ = app.emit(
        "schedule-run",
        ScheduleRunEvent {
            session_id: schedule.session_id,
            schedule_id: schedule.id,
            error,
        },
    );
}

async fn poll_schedules(app: tauri::AppHandle) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(10));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticker.tick().await;
        let due = {
            let state = app.state::<AppState>();
            state.schedules.claim_due(schedules::unix_now(), 8)
        };
        match due {
            Ok(schedules) => {
                for schedule in schedules {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        run_due_schedule(handle, schedule).await;
                    });
                }
            }
            Err(error) => {
                let _ = app.emit("scheduler-error", error);
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("sessions.sqlite");
            let store = SessionStore::open(path.clone()).map_err(std::io::Error::other)?;
            let schedules = ScheduleStore::open(path.clone()).map_err(std::io::Error::other)?;
            let search = SearchStore::open(path).map_err(std::io::Error::other)?;
            schedules
                .recover_interrupted()
                .map_err(std::io::Error::other)?;
            let checkpoints =
                checkpoints::CheckpointStore::new(app.path().app_data_dir()?.join("checkpoints"))
                    .map_err(std::io::Error::other)?;
            app.manage(AppState {
                store,
                schedules,
                search,
                checkpoints,
                runtimes: Mutex::new(HashMap::new()),
                workspace_locks: Mutex::new(HashMap::new()),
            });
            // The window starts hidden so WebView2's default white surface never
            // flashes on launch. The frontend reveals it after the themed first
            // paint; this fallback shows it even if the webview fails to load.
            let reveal = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(window) = reveal.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                }
            });
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                poll_schedules(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            create_session_in_project,
            create_work_task,
            list_work_tasks,
            rename_work_task,
            create_work_session_for_task,
            delete_work_task,
            create_project,
            open_project,
            list_projects,
            rename_project,
            remove_project,
            create_default_session,
            list_sessions,
            get_session,
            save_auto_approve,
            list_project_entries,
            read_project_file,
            create_project_file,
            create_project_folder,
            rename_project_entry,
            delete_project_entry,
            get_source_control,
            rename_session,
            delete_session,
            create_schedule,
            list_schedules,
            delete_schedule,
            retry_schedule,
            get_search_settings,
            save_search_settings,
            save_search_key,
            import_transcript,
            list_checkpoints,
            preview_checkpoint,
            restore_checkpoint,
            respond_approval,
            activate_approval,
            list_pending_approvals,
            save_provider_key,
            discover_models,
            load_mcp_config,
            save_mcp_config,
            discover_mcp_tools,
            provider_catalog,
            probe_local_providers,
            load_provider_settings,
            save_provider_settings,
            start_turn,
            add_attachments,
            stop_turn,
            ask_btw
        ])
        .run(tauri::generate_context!())
        .expect("error while running Moderado Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn separate_sessions_can_hold_turn_locks_at_the_same_time() {
        let root = tempfile::tempdir().unwrap();
        let store = SessionStore::open(root.path().join("sessions.sqlite")).unwrap();
        let settings = ProviderSettings {
            provider_id: ProviderId::Ollama,
            base_url: "http://localhost:11434/v1".into(),
            plan_model: "plan".into(),
            act_model: "act".into(),
        };
        let first = store
            .create(root.path(), "First", settings.clone())
            .unwrap();
        let second = store.create(root.path(), "Second", settings).unwrap();
        let state = AppState {
            schedules: ScheduleStore::open(root.path().join("sessions.sqlite")).unwrap(),
            search: SearchStore::open(root.path().join("sessions.sqlite")).unwrap(),
            store,
            checkpoints: checkpoints::CheckpointStore::new(root.path().join("checkpoints"))
                .unwrap(),
            runtimes: Mutex::new(HashMap::new()),
            workspace_locks: Mutex::new(HashMap::new()),
        };
        let first_runtime = state.runtime(&first.id).unwrap();
        let second_runtime = state.runtime(&second.id).unwrap();
        let _first_turn = first_runtime.turn_lock.lock().await;
        assert!(first_runtime.turn_lock.try_lock().is_err());
        assert!(second_runtime.turn_lock.try_lock().is_ok());
    }
}
