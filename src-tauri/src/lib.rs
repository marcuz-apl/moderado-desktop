pub mod agent;
pub mod checkpoints;
pub mod provider;
pub mod sessions;
pub mod workspace;

use agent::runner::{run_turn_with_hooks, AgentEvent, RunConfig};
use agent::{Approval, Mode};
use provider::settings::ProviderSettings;
use provider::ProviderId;
use serde::Serialize;
use sessions::{CheckpointRecord, SessionRecord, SessionStore, SessionSummary};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

#[derive(Default)]
struct SessionRuntime {
    pending: Mutex<Option<PendingApproval>>,
    turn_lock: AsyncMutex<()>,
    next_approval: AtomicU64,
}

struct PendingApproval {
    id: u64,
    decision: oneshot::Sender<Option<String>>,
    shown: Option<oneshot::Sender<()>>,
}

struct AppState {
    store: SessionStore,
    checkpoints: checkpoints::CheckpointStore,
    runtimes: Mutex<HashMap<String, Arc<SessionRuntime>>>,
    workspace_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
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
    Tool { session_id: String, value: String },
    Error { session_id: String, value: String },
    Done { session_id: String },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ApprovalEvent {
    session_id: String,
    id: u64,
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
) -> Result<SessionRecord, String> {
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
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Workspace".into());
    state.store.create(&path, &name, settings)
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
fn rename_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    state.store.rename(&session_id, &name)
}

#[tauri::command]
fn delete_session(state: tauri::State<'_, AppState>, session_id: String) -> Result<(), String> {
    let runtime = state.runtime(&session_id)?;
    let _guard = runtime
        .turn_lock
        .try_lock()
        .map_err(|_| "Session is running")?;
    state.store.delete(&session_id)?;
    state
        .runtimes
        .lock()
        .map_err(|_| "Session state unavailable")?
        .remove(&session_id);
    Ok(())
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
async fn discover_models(provider_id: ProviderId, base_url: String) -> Result<Vec<String>, String> {
    let base_url = provider_id.base_url(&base_url)?;
    let key = configured_key(provider_id, &base_url).await?;
    provider::list_models(&base_url, &key).await
}

#[tauri::command]
fn provider_catalog() -> Vec<provider::ProviderPreset> {
    provider::PRESETS.to_vec()
}

#[tauri::command]
async fn probe_local_providers() -> Vec<provider::LocalProviderStatus> {
    provider::probe_local_providers().await
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("provider.json"))
        .map_err(|error| format!("Settings location unavailable: {error}"))
}

#[tauri::command]
fn load_provider_settings(app: tauri::AppHandle) -> Result<Option<ProviderSettings>, String> {
    provider::settings::load(&settings_path(&app)?)
}

#[tauri::command]
async fn save_provider_settings(
    app: tauri::AppHandle,
    settings: ProviderSettings,
) -> Result<ProviderSettings, String> {
    let base_url = settings.provider_id.base_url(&settings.base_url)?;
    let key = configured_key(settings.provider_id, &base_url).await?;
    provider::settings::save(&settings_path(&app)?, settings, &key).await
}

async fn await_approval(
    app: &tauri::AppHandle,
    runtime: &SessionRuntime,
    session_id: &str,
    preview: Approval,
) -> Option<String> {
    let id = runtime.next_approval.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = oneshot::channel();
    let (shown_sender, shown_receiver) = oneshot::channel();
    if let Ok(mut pending) = runtime.pending.lock() {
        *pending = Some(PendingApproval {
            id,
            decision: sender,
            shown: Some(shown_sender),
        });
    } else {
        return None;
    }
    let event = ApprovalEvent {
        session_id: session_id.to_owned(),
        id,
        path: preview.path,
        before: preview.before,
        after: preview.after,
    };
    if app.emit("approval-request", event).is_err() {
        return None;
    }
    if shown_receiver.await.is_err() {
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
) -> Result<(), String> {
    let runtime = state.runtime(&session_id)?;
    let _guard = runtime
        .turn_lock
        .try_lock()
        .map_err(|_| "This session is already running")?;
    let record = state.store.get(&session_id)?;
    let workspace = PathBuf::from(&record.workspace);
    let workspace_lock = state.workspace_lock(&record.workspace)?;
    let _workspace_guard = workspace_lock.lock().await;
    let record = state.store.get(&session_id)?;
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
    let result = run_turn_with_hooks(
        RunConfig {
            workspace: &workspace,
            base_url: &base_url,
            model: &model,
            api_key: &api_key,
            mode,
        },
        &mut messages,
        &prompt,
        |preview| await_approval(&app, &runtime, &session_id, preview),
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
            AgentEvent::Tool(value) => {
                let _ = app.emit(
                    "turn-event",
                    TurnEvent::Tool {
                        session_id: session_id.clone(),
                        value,
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
    )
    .await;
    state.store.save_state(&session_id, &settings, &messages)?;
    match result {
        Ok(()) => {
            let _ = app.emit("turn-event", TurnEvent::Done { session_id });
            Ok(())
        }
        Err(error) => {
            let _ = app.emit(
                "turn-event",
                TurnEvent::Error {
                    session_id,
                    value: error.clone(),
                },
            );
            Err(error)
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("sessions.sqlite");
            let store = SessionStore::open(path).map_err(std::io::Error::other)?;
            let checkpoints =
                checkpoints::CheckpointStore::new(app.path().app_data_dir()?.join("checkpoints"))
                    .map_err(std::io::Error::other)?;
            app.manage(AppState {
                store,
                checkpoints,
                runtimes: Mutex::new(HashMap::new()),
                workspace_locks: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            list_sessions,
            get_session,
            rename_session,
            delete_session,
            list_checkpoints,
            preview_checkpoint,
            restore_checkpoint,
            respond_approval,
            activate_approval,
            save_provider_key,
            discover_models,
            provider_catalog,
            probe_local_providers,
            load_provider_settings,
            save_provider_settings,
            start_turn
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
