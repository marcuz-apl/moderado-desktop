use crate::agent::Mode;
use crate::provider::settings::ProviderSettings;
use crate::search::SearchSettings;
use crate::sessions::new_id;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    Prompt,
    AutoWrite,
}

impl ApprovalPolicy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::AutoWrite => "auto_write",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub mode: Mode,
    pub approval_policy: ApprovalPolicy,
    #[serde(skip_serializing)]
    pub settings: ProviderSettings,
    #[serde(skip_serializing)]
    pub search_settings: SearchSettings,
    pub next_run_at: i64,
    pub interval_seconds: Option<i64>,
    pub enabled: bool,
    pub in_flight: bool,
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct ScheduleStore {
    path: PathBuf,
}

pub struct ScheduleSpec<'a> {
    pub prompt: &'a str,
    pub mode: Mode,
    pub approval_policy: ApprovalPolicy,
    pub next_run_at: i64,
    pub interval_seconds: Option<i64>,
}

const SELECT_SCHEDULE: &str = "SELECT id,session_id,prompt,mode,approval_policy,settings_json,search_json,next_run_at,interval_seconds,enabled,in_flight,last_run_at,last_error FROM schedules";

pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

impl ScheduleStore {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let store = Self { path };
        crate::db::open(&store.path)?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, String> {
        crate::db::connect(&self.path)
    }

    pub fn create(
        &self,
        session_id: &str,
        settings: &ProviderSettings,
        search_settings: &SearchSettings,
        spec: ScheduleSpec<'_>,
    ) -> Result<Schedule, String> {
        let ScheduleSpec {
            prompt,
            mode,
            approval_policy,
            next_run_at,
            interval_seconds,
        } = spec;
        if prompt.trim().is_empty() || prompt.len() > 64_000 {
            return Err("Schedule prompt must be 1–64,000 characters".into());
        }
        if next_run_at <= 0 {
            return Err("Schedule time is invalid".into());
        }
        if interval_seconds.is_some_and(|interval| !(60..=2_592_000).contains(&interval)) {
            return Err("Repeat interval must be 1 minute to 30 days".into());
        }
        let schedule = Schedule {
            id: new_id(),
            session_id: session_id.to_owned(),
            prompt: prompt.trim().to_owned(),
            mode,
            approval_policy,
            settings: settings.clone(),
            search_settings: search_settings.clone(),
            next_run_at,
            interval_seconds,
            enabled: true,
            in_flight: false,
            last_run_at: None,
            last_error: None,
        };
        self.connect()?.execute(
            "INSERT INTO schedules (id,session_id,prompt,mode,approval_policy,settings_json,search_json,next_run_at,interval_seconds) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![schedule.id,schedule.session_id,schedule.prompt,mode_str(mode),approval_policy.as_str(),serde_json::to_string(settings).map_err(|error| error.to_string())?,serde_json::to_string(search_settings).map_err(|error| error.to_string())?,next_run_at,interval_seconds]
        ).map_err(|error| format!("Could not create schedule: {error}"))?;
        Ok(schedule)
    }

    pub fn list(&self, session_id: &str) -> Result<Vec<Schedule>, String> {
        let db = self.connect()?;
        let mut query = db
            .prepare(&format!(
                "{SELECT_SCHEDULE} WHERE session_id=?1 ORDER BY enabled DESC,next_run_at,id"
            ))
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map([session_id], row_schedule)
            .map_err(|error| error.to_string())?;
        rows.map(|row| row.map_err(|error| error.to_string()))
            .collect()
    }

    pub fn delete(&self, session_id: &str, id: &str) -> Result<(), String> {
        let changed = self
            .connect()?
            .execute(
                "DELETE FROM schedules WHERE session_id=?1 AND id=?2",
                params![session_id, id],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Schedule not found".into());
        }
        Ok(())
    }

    pub fn claim_due(&self, now: i64, limit: usize) -> Result<Vec<Schedule>, String> {
        let mut db = self.connect()?;
        let transaction = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let due: Vec<Schedule> = {
            let mut query = transaction.prepare(&format!("{SELECT_SCHEDULE} WHERE enabled=1 AND in_flight=0 AND next_run_at<=?1 ORDER BY next_run_at,id LIMIT ?2"))
                .map_err(|error| error.to_string())?;
            let rows = query
                .query_map(params![now, limit.min(16) as i64], row_schedule)
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<_, _>>()
                .map_err(|error| error.to_string())?
        };
        for schedule in &due {
            transaction
                .execute(
                    "UPDATE schedules SET in_flight=1,last_run_at=?2,last_error=NULL WHERE id=?1",
                    params![schedule.id, now],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(due)
    }

    pub fn finish(&self, id: &str, error: Option<&str>, now: i64) -> Result<(), String> {
        let mut db = self.connect()?;
        let transaction = db.transaction().map_err(|error| error.to_string())?;
        let timing: Option<(i64, Option<i64>)> = transaction
            .query_row(
                "SELECT next_run_at,interval_seconds FROM schedules WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some((due, interval)) = timing {
            let next = interval.map(|interval| {
                due.saturating_add(
                    (now.saturating_sub(due) / interval + 1).saturating_mul(interval),
                )
            });
            transaction.execute("UPDATE schedules SET in_flight=0,enabled=?2,next_run_at=COALESCE(?3,next_run_at),last_error=?4 WHERE id=?1", params![id,i64::from(next.is_some()),next,error])
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn recover_interrupted(&self) -> Result<(), String> {
        self.connect()?.execute("UPDATE schedules SET in_flight=0,enabled=0,last_error='Previous run was interrupted. Review before retrying.' WHERE in_flight=1", [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn retry(&self, session_id: &str, id: &str, now: i64) -> Result<(), String> {
        let changed = self.connect()?.execute("UPDATE schedules SET enabled=1,in_flight=0,next_run_at=?3,last_error=NULL WHERE session_id=?1 AND id=?2 AND enabled=0 AND last_error IS NOT NULL", params![session_id,id,now])
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Schedule is not paused after a failure".into());
        }
        Ok(())
    }

    pub fn pause(&self, id: &str, error: &str) -> Result<(), String> {
        self.connect()?
            .execute(
                "UPDATE schedules SET in_flight=0,enabled=0,last_error=?2 WHERE id=?1",
                params![id, error],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn mode_str(mode: Mode) -> &'static str {
    match mode {
        Mode::Plan => "plan",
        Mode::Act => "act",
    }
}

fn row_schedule(row: &rusqlite::Row<'_>) -> rusqlite::Result<Schedule> {
    use rusqlite::types::Type;
    let mode: String = row.get(3)?;
    let policy: String = row.get(4)?;
    let settings_json: String = row.get(5)?;
    let search_json: String = row.get(6)?;
    Ok(Schedule {
        id: row.get(0)?,
        session_id: row.get(1)?,
        prompt: row.get(2)?,
        mode: match mode.as_str() {
            "plan" => Mode::Plan,
            "act" => Mode::Act,
            _ => {
                return Err(rusqlite::Error::InvalidColumnType(
                    3,
                    "mode".into(),
                    Type::Text,
                ))
            }
        },
        approval_policy: match policy.as_str() {
            "prompt" => ApprovalPolicy::Prompt,
            "auto_write" => ApprovalPolicy::AutoWrite,
            _ => {
                return Err(rusqlite::Error::InvalidColumnType(
                    4,
                    "approval_policy".into(),
                    Type::Text,
                ))
            }
        },
        settings: serde_json::from_str(&settings_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(5, Type::Text, Box::new(error))
        })?,
        search_settings: serde_json::from_str(&search_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(6, Type::Text, Box::new(error))
        })?,
        next_run_at: row.get(7)?,
        interval_seconds: row.get(8)?,
        enabled: row.get(9)?,
        in_flight: row.get(10)?,
        last_run_at: row.get(11)?,
        last_error: row.get(12)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{settings::ProviderSettings, ProviderId};
    use crate::sessions::SessionStore;

    #[test]
    fn due_recurring_schedule_is_claimed_once_and_survives_restart() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions.sqlite");
        let sessions = SessionStore::open(path.clone()).unwrap();
        let session = sessions
            .create(
                root.path(),
                "Test",
                ProviderSettings {
                    provider_id: ProviderId::Ollama,
                    base_url: "http://localhost:11434/v1".into(),
                    plan_model: "p".into(),
                    act_model: "a".into(),
                },
            )
            .unwrap();
        let store = ScheduleStore::open(path.clone()).unwrap();
        let search = SearchSettings {
            enabled: true,
            endpoint: "https://search.example/api".into(),
        };
        let schedule = store
            .create(
                &session.id,
                &session.settings,
                &search,
                ScheduleSpec {
                    prompt: "Do work",
                    mode: Mode::Act,
                    approval_policy: ApprovalPolicy::AutoWrite,
                    next_run_at: 100,
                    interval_seconds: Some(60),
                },
            )
            .unwrap();
        assert_eq!(store.claim_due(100, 8).unwrap().len(), 1);
        assert!(store.claim_due(160, 8).unwrap().is_empty());
        drop(store);
        let reopened = ScheduleStore::open(path).unwrap();
        assert_eq!(reopened.list(&session.id).unwrap()[0].next_run_at, 100);
        assert_eq!(
            reopened.list(&session.id).unwrap()[0].search_settings,
            search
        );
        reopened.recover_interrupted().unwrap();
        assert!(!reopened.list(&session.id).unwrap()[0].enabled);
        reopened.retry(&session.id, &schedule.id, 160).unwrap();
        assert_eq!(reopened.claim_due(160, 8).unwrap()[0].id, schedule.id);
        reopened.finish(&schedule.id, Some("offline"), 160).unwrap();
        assert_eq!(reopened.list(&session.id).unwrap()[0].next_run_at, 220);
        assert_eq!(
            reopened.list(&session.id).unwrap()[0].last_error.as_deref(),
            Some("offline")
        );
    }

    #[test]
    fn one_time_schedule_disables_after_claim_and_delete_cascades() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions.sqlite");
        let sessions = SessionStore::open(path.clone()).unwrap();
        let session = sessions
            .create(
                root.path(),
                "Test",
                ProviderSettings {
                    provider_id: ProviderId::Ollama,
                    base_url: "http://localhost:11434/v1".into(),
                    plan_model: "p".into(),
                    act_model: "a".into(),
                },
            )
            .unwrap();
        let store = ScheduleStore::open(path).unwrap();
        store
            .create(
                &session.id,
                &session.settings,
                &SearchSettings::default(),
                ScheduleSpec {
                    prompt: "One time",
                    mode: Mode::Plan,
                    approval_policy: ApprovalPolicy::Prompt,
                    next_run_at: 100,
                    interval_seconds: None,
                },
            )
            .unwrap();
        assert_eq!(store.claim_due(101, 8).unwrap().len(), 1);
        assert!(store.claim_due(102, 8).unwrap().is_empty());
        store
            .finish(&store.list(&session.id).unwrap()[0].id, None, 101)
            .unwrap();
        assert!(!store.list(&session.id).unwrap()[0].enabled);
        sessions.delete(&session.id).unwrap();
        assert!(store.list(&session.id).unwrap().is_empty());
    }

    #[test]
    fn existing_schedule_table_gains_search_binding_and_pauses() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions.sqlite");
        let sessions = SessionStore::open(path.clone()).unwrap();
        let settings = ProviderSettings {
            provider_id: ProviderId::Ollama,
            base_url: "http://localhost:11434/v1".into(),
            plan_model: "p".into(),
            act_model: "a".into(),
        };
        let session = sessions
            .create(root.path(), "Test", settings.clone())
            .unwrap();
        let db = Connection::open(&path).unwrap();
        // Rewind to the pre-versioning schema: a schedules table without
        // search_json and no recorded schema version.
        db.execute_batch("DROP TABLE schedules; CREATE TABLE schedules (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,prompt TEXT NOT NULL,mode TEXT NOT NULL,approval_policy TEXT NOT NULL,settings_json TEXT NOT NULL,next_run_at INTEGER NOT NULL,interval_seconds INTEGER,enabled INTEGER NOT NULL,in_flight INTEGER NOT NULL,last_run_at INTEGER,last_error TEXT); PRAGMA user_version = 0;").unwrap();
        db.execute("INSERT INTO schedules(id,session_id,prompt,mode,approval_policy,settings_json,next_run_at,interval_seconds,enabled,in_flight) VALUES('old',?1,'Task','act','auto_write',?2,100,60,1,0)", params![session.id,serde_json::to_string(&settings).unwrap()]).unwrap();
        drop(db);
        let store = ScheduleStore::open(path).unwrap();
        let migrated = &store.list(&session.id).unwrap()[0];
        assert!(!migrated.enabled);
        assert_eq!(migrated.search_settings, SearchSettings::default());
        assert!(migrated.last_error.is_some());
    }
}
