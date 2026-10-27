use crate::provider::settings::ProviderSettings;
use crate::approval_policy::AutoApprovePolicy;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// A Work session keeps a private scratch folder so every session still has a
/// jailed root, even though the user never sees or chooses it.
pub fn create_scratch_workspace(base: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(base)
        .map_err(|error| format!("Could not create the Work folder: {error}"))?;
    for number in 0..=u32::MAX {
        let name = if number == 0 {
            "Work".to_string()
        } else {
            format!("Work {number}")
        };
        let path = base.join(name);
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create the Work folder: {error}")),
        }
    }
    Err("Could not find a free Work folder name".into())
}

pub fn create_default_workspace(documents: &Path) -> Result<PathBuf, String> {
    create_numbered_workspace(documents, "session")
}

pub fn create_default_work_workspace(documents: &Path) -> Result<PathBuf, String> {
    create_numbered_workspace(documents, "work-session")
}

fn create_numbered_workspace(documents: &Path, prefix: &str) -> Result<PathBuf, String> {
    let root = documents.join("Moderado-Desktop");
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create session folder in Documents: {error}"))?;
    for number in 0..=u32::MAX {
        let path = root.join(format!("{prefix}{number}"));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create session folder: {error}")),
        }
    }
        Err("No available session folder name in Documents".into())
}

pub fn new_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{nanos:x}-{:x}-{:x}",
        std::process::id(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    /// Answers general questions and reads only files the user attaches.
    Work,
    /// Bound to a project folder with autonomous file tools.
    #[default]
    Code,
}

impl SessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Work => "work",
            Self::Code => "code",
        }
    }

    fn from_db(value: &str) -> Self {
        match value {
            "work" => Self::Work,
            _ => Self::Code,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub name: String,
    pub workspace: String,
    pub kind: SessionKind,
    pub auto_approve: AutoApprovePolicy,
    pub settings: ProviderSettings,
    pub history: Vec<Value>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub name: String,
    pub workspace: String,
    pub kind: SessionKind,
    pub auto_approve: AutoApprovePolicy,
    pub settings: ProviderSettings,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRecord {
    pub id: String,
    pub session_id: String,
    pub git_ref: String,
    pub path: String,
    pub created_at: i64,
}

#[derive(Clone)]
pub struct SessionStore {
    path: PathBuf,
}

impl SessionStore {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create app data: {error}"))?;
        }
        let store = Self { path };
        crate::db::open(&store.path)?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, String> {
        crate::db::connect(&self.path)
    }

    pub fn create(
        &self,
        workspace: &Path,
        name: &str,
        settings: ProviderSettings,
    ) -> Result<SessionRecord, String> {
        self.create_with_kind(workspace, name, settings, SessionKind::Code)
    }

    pub fn create_with_kind(
        &self,
        workspace: &Path,
        name: &str,
        settings: ProviderSettings,
        kind: SessionKind,
    ) -> Result<SessionRecord, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("Workspace unavailable: {error}"))?;
        if !workspace.is_dir() {
            return Err("Workspace must be a directory".into());
        }
        validate_name(name)?;
        let record = SessionRecord {
            id: new_id(),
            name: name.trim().to_owned(),
            workspace: workspace.to_string_lossy().into_owned(),
            kind,
            auto_approve: AutoApprovePolicy::for_new_session(kind),
            settings,
            history: Vec::new(),
            updated_at: now(),
        };
        let db = self.connect()?;
        db.execute(
            "INSERT INTO sessions (id,name,workspace,kind,settings_json,history_json,updated_at,auto_approve_json) VALUES (?1,?2,?3,?4,?5,'[]',?6,?7)",
            params![record.id, record.name, record.workspace, record.kind.as_str(), serde_json::to_string(&record.settings).map_err(|error| error.to_string())?, record.updated_at, serde_json::to_string(&record.auto_approve).map_err(|error| error.to_string())?],
        ).map_err(|error| format!("Could not create session: {error}"))?;
        Ok(record)
    }

    pub fn create_session_in_project(
        &self,
        source_session_id: &str,
        name: &str,
        settings: ProviderSettings,
    ) -> Result<SessionRecord, String> {
        let source = self.get(source_session_id)?;
        if source.kind != SessionKind::Code {
            return Err("A Code session is required to create a session in a project".into());
        }
        self.create_with_kind(Path::new(&source.workspace), name, settings, SessionKind::Code)
    }

    pub fn find_code_project_session(
        &self,
        workspace: &Path,
    ) -> Result<Option<SessionRecord>, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("Workspace unavailable: {error}"))?;
        let workspace = workspace.to_string_lossy();
        let existing = self
            .list()?
            .into_iter()
            .find(|session| session.kind == SessionKind::Code && session.workspace == workspace);
        existing.map(|session| self.get(&session.id)).transpose()
    }

    pub fn list(&self) -> Result<Vec<SessionSummary>, String> {
        let db = self.connect()?;
        let mut query = db.prepare("SELECT id,name,workspace,settings_json,updated_at,kind,auto_approve_json FROM sessions ORDER BY updated_at DESC, id DESC")
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            let (id, name, workspace, settings_json, updated_at, kind, auto_approve_json) =
                row.map_err(|error| error.to_string())?;
            let settings = serde_json::from_str(&settings_json)
                .map_err(|_| "Invalid saved provider settings")?;
            Ok(SessionSummary {
                id,
                name,
                workspace,
                kind: SessionKind::from_db(&kind),
                auto_approve: serde_json::from_str(&auto_approve_json).map_err(|_| "Invalid saved approval policy")?,
                settings,
                updated_at,
            })
        })
        .collect()
    }

    pub fn get(&self, id: &str) -> Result<SessionRecord, String> {
        let db = self.connect()?;
        let row = db.query_row(
            "SELECT id,name,workspace,settings_json,history_json,updated_at,kind,auto_approve_json FROM sessions WHERE id=?1",
            [id],
            |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?, row.get::<_,String>(4)?, row.get::<_,i64>(5)?, row.get::<_,String>(6)?, row.get::<_,String>(7)?)),
        ).optional().map_err(|error| error.to_string())?.ok_or("Session not found")?;
        Ok(SessionRecord {
            id: row.0,
            name: row.1,
            workspace: row.2,
            settings: serde_json::from_str(&row.3)
                .map_err(|_| "Invalid saved provider settings")?,
            history: serde_json::from_str(&row.4).map_err(|_| "Invalid saved session history")?,
            updated_at: row.5,
            kind: SessionKind::from_db(&row.6),
            auto_approve: serde_json::from_str(&row.7).map_err(|_| "Invalid saved approval policy")?,
        })
    }

    pub fn update_auto_approve(&self, session_id: &str, policy: AutoApprovePolicy) -> Result<(), String> {
        let changed = self.connect()?.execute("UPDATE sessions SET auto_approve_json=?2,updated_at=?3 WHERE id=?1", params![session_id, serde_json::to_string(&policy).map_err(|error| error.to_string())?, now()]).map_err(|error| error.to_string())?;
        if changed == 0 { return Err("Session not found".into()); }
        Ok(())
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        validate_name(name)?;
        let changed = self
            .connect()?
            .execute(
                "UPDATE sessions SET name=?2,updated_at=?3 WHERE id=?1",
                params![id, name.trim(), now()],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Session not found".into());
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let changed = self
            .connect()?
            .execute("DELETE FROM sessions WHERE id=?1", [id])
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Session not found".into());
        }
        Ok(())
    }

    /// Records the attachment copies already written to disk. The foreign key
    /// cascades, so deleting a session forgets its attachments.
    pub fn add_attachments(&self, records: &[crate::attachments::AttachmentRecord]) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(|error| error.to_string())?;
        for record in records {
            tx.execute(
                "INSERT INTO attachments (id,session_id,name,kind,bytes,created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                params![record.id, record.session_id, record.name, record.kind.as_str(), record.bytes, now()],
            )
            .map_err(|error| format!("Could not record the attachment: {error}"))?;
        }
        tx.commit().map_err(|error| error.to_string())
    }

    pub fn save_state(
        &self,
        id: &str,
        settings: &ProviderSettings,
        history: &[Value],
    ) -> Result<(), String> {
        let changed = self
            .connect()?
            .execute(
                "UPDATE sessions SET settings_json=?2,history_json=?3,updated_at=?4 WHERE id=?1",
                params![
                    id,
                    serde_json::to_string(settings).map_err(|error| error.to_string())?,
                    serde_json::to_string(history).map_err(|error| error.to_string())?,
                    now()
                ],
            )
            .map_err(|error| format!("Could not save session: {error}"))?;
        if changed == 0 {
            return Err("Session not found".into());
        }
        Ok(())
    }

    pub fn add_checkpoint(&self, checkpoint: &CheckpointRecord) -> Result<(), String> {
        self.connect()?.execute(
            "INSERT INTO checkpoints (id,session_id,git_ref,path,created_at) VALUES (?1,?2,?3,?4,?5)",
            params![checkpoint.id, checkpoint.session_id, checkpoint.git_ref, checkpoint.path, checkpoint.created_at],
        ).map_err(|error| format!("Could not save checkpoint: {error}"))?;
        Ok(())
    }

    pub fn list_checkpoints(&self, session_id: &str) -> Result<Vec<CheckpointRecord>, String> {
        let db = self.connect()?;
        let mut query = db.prepare("SELECT id,session_id,git_ref,path,created_at FROM checkpoints WHERE session_id=?1 ORDER BY created_at DESC,id DESC")
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map([session_id], |row| {
                Ok(CheckpointRecord {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    git_ref: row.get(2)?,
                    path: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| row.map_err(|error| error.to_string()))
            .collect()
    }

    pub fn get_checkpoint(&self, session_id: &str, id: &str) -> Result<CheckpointRecord, String> {
        self.list_checkpoints(session_id)?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or("Checkpoint not found".into())
    }

    pub fn append_restore_marker(
        &self,
        workspace: &str,
        checkpoint_id: &str,
        changed_files: usize,
    ) -> Result<(), String> {
        let mut db = self.connect()?;
        let transaction = db.transaction().map_err(|error| error.to_string())?;
        let sessions: Vec<(String, String)> = {
            let mut query = transaction
                .prepare("SELECT id,history_json FROM sessions WHERE workspace=?1")
                .map_err(|error| error.to_string())?;
            let rows = query
                .query_map([workspace], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|error| error.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|error| error.to_string())?;
            rows
        };
        for (session_id, history_json) in sessions {
            let mut history: Vec<Value> =
                serde_json::from_str(&history_json).map_err(|_| "Invalid saved session history")?;
            history.push(serde_json::json!({"role":"system","content":format!("Workspace restored from checkpoint {checkpoint_id}; {changed_files} files changed. Re-read files before relying on prior file contents or edits.")}));
            transaction
                .execute(
                    "UPDATE sessions SET history_json=?2,updated_at=?3 WHERE id=?1",
                    params![
                        session_id,
                        serde_json::to_string(&history).map_err(|error| error.to_string())?,
                        now()
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())
    }
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.len() > 100 {
        return Err("Session name must be 1–100 characters".into());
    }
    Ok(())
}

pub fn checkpoint_time() -> i64 {
    now()
}

pub fn repair_interrupted_tool_calls(history: &mut Vec<Value>) {
    let mut pending = Vec::<String>::new();
    let mut repaired = Vec::with_capacity(history.len());
    for message in history.drain(..) {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if role != "tool" {
            for id in pending.drain(..) {
                repaired.push(serde_json::json!({"role":"tool","tool_call_id":id,"content":"Error: Previous turn was interrupted before this tool finished"}));
            }
        }
        if role == "assistant" {
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                pending.extend(
                    calls.iter().filter_map(|call| {
                        call.get("id").and_then(Value::as_str).map(str::to_owned)
                    }),
                );
            }
        } else if role == "tool" {
            if let Some(id) = message.get("tool_call_id").and_then(Value::as_str) {
                pending.retain(|expected| expected != id);
            }
        }
        repaired.push(message);
    }
    for id in pending {
        repaired.push(serde_json::json!({"role":"tool","tool_call_id":id,"content":"Error: Previous turn was interrupted before this tool finished"}));
    }
    *history = repaired;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderId;
    use serde_json::json;

    fn settings() -> ProviderSettings {
        ProviderSettings {
            provider_id: ProviderId::Ollama,
            base_url: "http://localhost:11434/v1".into(),
            plan_model: "plan".into(),
            act_model: "act".into(),
        }
    }

    #[test]
    fn sessions_and_history_survive_reopening_the_database() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("work");
        std::fs::create_dir(&workspace).unwrap();
        let path = root.path().join("app").join("sessions.sqlite");
        let store = SessionStore::open(path.clone()).unwrap();
        let first = store.create(&workspace, "First", settings()).unwrap();
        let second = store.create(&workspace, "Second", settings()).unwrap();
        store
            .save_state(
                &first.id,
                &settings(),
                &[json!({"role":"user","content":"one"})],
            )
            .unwrap();
        drop(store);
        let reopened = SessionStore::open(path).unwrap();
        assert_eq!(reopened.list().unwrap().len(), 2);
        assert_eq!(
            reopened.get(&first.id).unwrap().history[0]["content"],
            "one"
        );
        assert!(reopened.get(&second.id).unwrap().history.is_empty());
        reopened
            .append_restore_marker(&first.workspace, "checkpoint-1", 2)
            .unwrap();
        assert!(
            reopened.get(&first.id).unwrap().history.last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains("Re-read files")
        );
        assert_eq!(reopened.get(&second.id).unwrap().history.len(), 1);
        reopened.rename(&second.id, "Renamed").unwrap();
        assert_eq!(reopened.get(&second.id).unwrap().name, "Renamed");
        reopened.delete(&second.id).unwrap();
        assert_eq!(reopened.list().unwrap().len(), 1);
    }

    #[test]
    fn auto_approve_policy_is_per_session_and_persists() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("project");
        std::fs::create_dir(&workspace).unwrap();
        let store = SessionStore::open(root.path().join("sessions.sqlite")).unwrap();
        let first = store.create(&workspace, "First", settings()).unwrap();
        let second = store.create(&workspace, "Second", settings()).unwrap();
        assert!(first.auto_approve.edit_files && first.auto_approve.execute_command && first.auto_approve.use_mcp_servers);
        let mut policy = first.auto_approve;
        policy.edit_files = false;
        store.update_auto_approve(&first.id, policy).unwrap();
        assert!(!store.get(&first.id).unwrap().auto_approve.edit_files);
        assert!(store.get(&second.id).unwrap().auto_approve.edit_files);
        assert!(!store.list().unwrap().iter().find(|item| item.id == first.id).unwrap().auto_approve.edit_files);
    }

    #[test]
    fn creates_code_session_in_project_from_existing_code_session() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("project");
        std::fs::create_dir(&workspace).unwrap();
        let store = SessionStore::open(root.path().join("sessions.sqlite")).unwrap();
        let source = store.create(&workspace, "Project", settings()).unwrap();

        let created = store
            .create_session_in_project(&source.id, "New Session", settings())
            .unwrap();

        assert_eq!(created.kind, SessionKind::Code);
        assert_eq!(created.workspace, source.workspace);
        assert_eq!(created.name, "New Session");
    }

    #[test]
    fn rejects_work_session_as_project_session_source() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("work");
        std::fs::create_dir(&workspace).unwrap();
        let store = SessionStore::open(root.path().join("sessions.sqlite")).unwrap();
        let source = store
            .create_with_kind(&workspace, "Task", settings(), SessionKind::Work)
            .unwrap();

        let error = store
            .create_session_in_project(&source.id, "New Session", settings())
            .unwrap_err();
        assert!(error.contains("Code session"));
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn finds_most_recent_code_session_for_project_workspace() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("project");
        std::fs::create_dir(&workspace).unwrap();
        let store = SessionStore::open(root.path().join("sessions.sqlite")).unwrap();
        let first = store.create(&workspace, "Project", settings()).unwrap();
        let second = store
            .create_session_in_project(&first.id, "New Session", settings())
            .unwrap();

        let found = store
            .find_code_project_session(&workspace)
            .unwrap()
            .unwrap();
        assert_eq!(found.id, second.id);
        assert_eq!(found.workspace, second.workspace);
    }

    #[test]
    fn interrupted_tool_calls_are_repaired_before_resuming() {
        let mut history = vec![
            json!({"role":"assistant","tool_calls":[{"id":"one"},{"id":"two"}]}),
            json!({"role":"tool","tool_call_id":"one","content":"done"}),
        ];
        repair_interrupted_tool_calls(&mut history);
        assert_eq!(history.len(), 3);
        assert_eq!(history[2]["tool_call_id"], "two");
        repair_interrupted_tool_calls(&mut history);
        assert_eq!(history.len(), 3);
    }

    #[test]
    fn default_workspaces_get_unique_session_folders_in_documents() {
        let documents = tempfile::tempdir().unwrap();
        let first = create_default_workspace(documents.path()).unwrap();
        let second = create_default_workspace(documents.path()).unwrap();
        assert_eq!(first, documents.path().join("Moderado-Desktop").join("session0"));
        assert_eq!(second, documents.path().join("Moderado-Desktop").join("session1"));
        assert!(first.is_dir());
        assert!(second.is_dir());
    }

    #[test]
    fn default_workspace_skips_an_existing_session_folder() {
        let documents = tempfile::tempdir().unwrap();
        let existing = documents.path().join("Moderado-Desktop").join("session0");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("keep.txt"), "existing work").unwrap();
        let next = create_default_workspace(documents.path()).unwrap();
        assert_eq!(next, documents.path().join("Moderado-Desktop").join("session1"));
        assert_eq!(std::fs::read_to_string(existing.join("keep.txt")).unwrap(), "existing work");
    }

    #[test]
    fn default_workspaces_get_named_folders_in_documents() {
        let documents = tempfile::tempdir().unwrap();
        let first = create_default_work_workspace(documents.path()).unwrap();
        let second = create_default_work_workspace(documents.path()).unwrap();
        assert_eq!(
            first,
            documents.path().join("Moderado-Desktop").join("work-session0")
        );
        assert_eq!(
            second,
            documents.path().join("Moderado-Desktop").join("work-session1")
        );
    }
}
