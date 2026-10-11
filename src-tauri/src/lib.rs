pub mod agent;
pub mod provider;
pub mod workspace;

use agent::{dispatch_tool, tool_definitions, Approval, Mode};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

#[derive(Default)]
struct Session {
    workspace: Mutex<Option<PathBuf>>,
    history: Mutex<Vec<Value>>,
    pending: Mutex<Option<(u64, oneshot::Sender<bool>)>>,
    turn_lock: AsyncMutex<()>,
    next_approval: AtomicU64,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum TurnEvent {
    Text { value: String },
    Tool { value: String },
    Error { value: String },
    Done,
}

#[derive(Serialize, Clone)]
struct ApprovalEvent {
    id: u64,
    path: String,
    before: String,
    after: String,
}

#[tauri::command]
async fn choose_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, Session>,
) -> Result<String, String> {
    let _guard = state
        .turn_lock
        .try_lock()
        .map_err(|_| "A turn is already running")?;
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
    *state
        .workspace
        .lock()
        .map_err(|_| "Session state unavailable")? = Some(path.clone());
    state
        .history
        .lock()
        .map_err(|_| "Session state unavailable")?
        .clear();
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn respond_approval(
    state: tauri::State<'_, Session>,
    id: u64,
    accepted: bool,
) -> Result<(), String> {
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "Approval state unavailable")?;
    match pending.take() {
        Some((current, sender)) if current == id => {
            sender.send(accepted).map_err(|_| "Approval expired".into())
        }
        Some(other) => {
            *pending = Some(other);
            Err("Approval ID does not match".into())
        }
        None => Err("No approval is pending".into()),
    }
}

#[tauri::command]
async fn save_provider_key(base_url: String, api_key: String) -> Result<(), String> {
    if provider::completion_url(&base_url)?.scheme() != "https" {
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

async fn await_approval(app: &tauri::AppHandle, state: &Session, preview: Approval) -> bool {
    let id = state.next_approval.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = oneshot::channel();
    if let Ok(mut pending) = state.pending.lock() {
        *pending = Some((id, sender));
    } else {
        return false;
    }
    let event = ApprovalEvent {
        id,
        path: preview.path,
        before: preview.before,
        after: preview.after,
    };
    if app.emit("approval-request", event).is_err() {
        return false;
    }
    let decision = tokio::time::timeout(std::time::Duration::from_secs(300), receiver).await;
    if let Ok(mut pending) = state.pending.lock() {
        pending.take();
    }
    matches!(decision, Ok(Ok(true)))
}

#[tauri::command]
async fn start_turn(
    app: tauri::AppHandle,
    state: tauri::State<'_, Session>,
    base_url: String,
    model: String,
    mode: Mode,
    prompt: String,
) -> Result<(), String> {
    let _guard = state
        .turn_lock
        .try_lock()
        .map_err(|_| "A turn is already running")?;
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "Session state unavailable")?
        .clone()
        .ok_or("Choose a workspace first")?;
    if prompt.trim().is_empty() || prompt.len() > 64_000 {
        return Err("Prompt must be 1–64,000 characters".into());
    }
    if model.trim().is_empty() || model.len() > 200 {
        return Err("Model name is required".into());
    }
    let provider_url = provider::completion_url(&base_url)?;
    let api_key = if provider_url.scheme() == "http" {
        String::new()
    } else {
        provider_key(base_url.clone()).await?
    };
    let mut messages = state
        .history
        .lock()
        .map_err(|_| "Session state unavailable")?
        .clone();
    messages.push(json!({"role":"user","content":prompt}));
    *state
        .history
        .lock()
        .map_err(|_| "Session state unavailable")? = messages.clone();
    let tools = tool_definitions(mode);
    for _ in 0..8 {
        let completion = match provider::chat_completion(
            &base_url,
            &model,
            &api_key,
            &messages,
            &tools,
            |text| {
                let _ = app.emit("turn-event", TurnEvent::Text { value: text.into() });
            },
        )
        .await
        {
            Ok(completion) => completion,
            Err(error) => {
                let _ = app.emit(
                    "turn-event",
                    TurnEvent::Error {
                        value: error.clone(),
                    },
                );
                return Err(error);
            }
        };
        let calls = completion.tool_calls;
        let wire_calls: Vec<Value> = calls.iter().map(|call| json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments}})).collect();
        messages
            .push(json!({"role":"assistant","content":completion.content,"tool_calls":wire_calls}));
        if calls.is_empty() {
            *state
                .history
                .lock()
                .map_err(|_| "Session state unavailable")? = messages;
            let _ = app.emit("turn-event", TurnEvent::Done);
            return Ok(());
        }
        for call in calls {
            let result = dispatch_tool(&workspace, mode, &call, |preview| {
                await_approval(&app, &state, preview)
            })
            .await;
            let value = match result {
                Ok(value) => value,
                Err(error) => format!("Error: {error}"),
            };
            let _ = app.emit(
                "turn-event",
                TurnEvent::Tool {
                    value: format!("{}: {}", call.name, value),
                },
            );
            messages.push(json!({"role":"tool","tool_call_id":call.id,"content":value}));
        }
        *state
            .history
            .lock()
            .map_err(|_| "Session state unavailable")? = messages.clone();
    }
    let error = "Agent stopped after 8 tool rounds".to_string();
    let _ = app.emit(
        "turn-event",
        TurnEvent::Error {
            value: error.clone(),
        },
    );
    Err(error)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Session::default())
        .invoke_handler(tauri::generate_handler![
            choose_workspace,
            respond_approval,
            save_provider_key,
            start_turn
        ])
        .run(tauri::generate_context!())
        .expect("error while running Moderado Desktop");
}
