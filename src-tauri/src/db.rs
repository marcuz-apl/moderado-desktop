//! Schema ownership for the SQLite database.
//!
//! Every table is created here, and every change after the first release is a
//! numbered migration applied in order and recorded in `PRAGMA user_version`.
//! Stores open connections through this module so they never carry DDL.

use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;

/// Bump this and add a migration below when the schema changes.
pub const SCHEMA_VERSION: i64 = 6;

/// Version 1 is the schema as it shipped before versioning existed. It is
/// written with `IF NOT EXISTS` so a database created by an older build passes
/// through it unchanged.
const V1: &str = "
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workspace TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    history_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    git_ref TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_session ON checkpoints(session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('plan','act')),
    approval_policy TEXT NOT NULL CHECK(approval_policy IN ('prompt','auto_write')),
    settings_json TEXT NOT NULL,
    search_json TEXT NOT NULL,
    next_run_at INTEGER NOT NULL,
    interval_seconds INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    in_flight INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled,next_run_at);
CREATE TABLE IF NOT EXISTS search_settings (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL,
    endpoint TEXT NOT NULL
);
";

pub fn open(path: &Path) -> Result<Connection, String> {
    let mut db = connect(path)?;
    migrate(&mut db)?;
    Ok(db)
}

pub fn connect(path: &Path) -> Result<Connection, String> {
    let db = Connection::open(path).map_err(|error| format!("Could not open database: {error}"))?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    db.pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| error.to_string())?;
    Ok(db)
}

pub fn schema_version(db: &Connection) -> Result<i64, String> {
    db.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Could not read the schema version: {error}"))
}

fn migrate(db: &mut Connection) -> Result<(), String> {
    let mut version = schema_version(db)?;

    if version < 1 {
        let tx = db.transaction().map_err(|error| error.to_string())?;
        tx.execute_batch(V1)
            .map_err(|error| format!("Could not create the schema: {error}"))?;
        // Databases created before versioning can predate these columns.
        let mut repaired = add_column_if_missing(
            &tx,
            "schedules",
            "settings_json",
            "TEXT NOT NULL DEFAULT '{}'",
        )?;
        repaired |= add_column_if_missing(
            &tx,
            "schedules",
            "search_json",
            "TEXT NOT NULL DEFAULT '{\"enabled\":true,\"endpoint\":\"\"}'",
        )?;
        repaired |= add_column_if_missing(&tx, "schedules", "in_flight", "INTEGER NOT NULL DEFAULT 0")?;
        if repaired {
            tx.execute(
                "UPDATE schedules SET settings_json=COALESCE((SELECT settings_json FROM sessions WHERE sessions.id=schedules.session_id),'{}')",
                [],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE schedules SET enabled=0,in_flight=0,last_error='Schedule settings changed during upgrade. Review and recreate this schedule.'",
                [],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.pragma_update(None, "user_version", 1)
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        version = 1;
    }

    if version < 2 {
        let tx = db.transaction().map_err(|error| error.to_string())?;
        // Work sessions have no project folder and no file tools; existing
        // sessions are all Code.
        add_column_if_missing(&tx, "sessions", "kind", "TEXT NOT NULL DEFAULT 'code'")?;
        tx.pragma_update(None, "user_version", 2)
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        version = 2;
    }

    if version < 3 {
        let tx = db.transaction().map_err(|error| error.to_string())?;
        // One row per file the user attached. The bytes live on disk under the
        // app-data attachments folder; this table is what makes them
        // discoverable, replayable, and deletable with their session.
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS attachments (
                id TEXT NOT NULL,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('text','image')),
                bytes INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY(session_id, id)
            );",
        )
        .map_err(|error| format!("Could not create attachments: {error}"))?;
        tx.pragma_update(None, "user_version", 3)
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        version = 3;
    }

    if version < 4 {
        let tx = db.transaction().map_err(|error| error.to_string())?;
        add_column_if_missing(&tx, "sessions", "auto_approve_json", "TEXT NOT NULL DEFAULT '{}'")?;
        tx.execute("UPDATE sessions SET auto_approve_json=CASE WHEN kind='code' THEN '{\"readFiles\":true,\"editFiles\":true,\"fetchWebContent\":true,\"executeCommand\":true,\"useMcpServers\":true}' ELSE '{\"readFiles\":false,\"editFiles\":false,\"fetchWebContent\":true,\"executeCommand\":false,\"useMcpServers\":false}' END WHERE auto_approve_json='{}'", [])
            .map_err(|error| format!("Could not initialize approval policies: {error}"))?;
        tx.pragma_update(None, "user_version", 4).map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        version = 4;
    }

    if version < 5 {
        let tx = db.transaction().map_err(|error| error.to_string())?;
        tx.execute("UPDATE sessions SET auto_approve_json='{\"readFiles\":true,\"editFiles\":true,\"fetchWebContent\":true,\"executeCommand\":true,\"useMcpServers\":true}' WHERE kind='code' AND auto_approve_json='{\"readFiles\":true,\"editFiles\":false,\"fetchWebContent\":true,\"executeCommand\":false,\"useMcpServers\":false}'", [])
            .map_err(|error| format!("Could not apply default Code session permissions: {error}"))?;
        tx.pragma_update(None, "user_version", 5).map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        version = 5;
    }

    if version < 6 {
        let tx = db.transaction().map_err(|error| error.to_string())?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS projects (
            workspace TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
        );
        INSERT OR IGNORE INTO projects (workspace,name,updated_at)
            SELECT workspace,workspace,MAX(updated_at) FROM sessions WHERE kind='code' GROUP BY workspace;")
            .map_err(|error| format!("Could not migrate projects: {error}"))?;
        let roots = {
            let mut query = tx.prepare("SELECT workspace FROM projects").map_err(|error| error.to_string())?;
            let rows = query.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
        };
        for workspace in roots {
            let name = workspace.split(['/', '\\']).rfind(|part| !part.is_empty()).unwrap_or("Project");
            tx.execute("UPDATE projects SET name=?2 WHERE workspace=?1 AND name=workspace", rusqlite::params![workspace, name]).map_err(|error| error.to_string())?;
        }
        tx.execute("UPDATE sessions SET auto_approve_json='{\"readFiles\":true,\"editFiles\":true,\"fetchWebContent\":true,\"executeCommand\":false,\"useMcpServers\":false}' WHERE kind='work' AND auto_approve_json='{\"readFiles\":false,\"editFiles\":false,\"fetchWebContent\":true,\"executeCommand\":false,\"useMcpServers\":false}'", [])
            .map_err(|error| format!("Could not enable Work document defaults: {error}"))?;
        tx.pragma_update(None, "user_version", 6).map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn columns(db: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut query = db
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("Could not read the {table} columns: {error}"))?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn add_column_if_missing(
    db: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<bool, String> {
    if columns(db, table)?.iter().any(|existing| existing == column) {
        return Ok(false);
    }
    db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition};"))
        .map_err(|error| format!("Could not add {table}.{column}: {error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions.sqlite");
        (root, path)
    }

    #[test]
    fn version_five_upgrade_registers_projects_and_preserves_custom_work_policy_and_history() {
        let (_root, path) = temporary();
        {
            let db = open(&path).unwrap();
            db.execute_batch("DELETE FROM projects;
                INSERT INTO sessions (id,name,workspace,settings_json,history_json,updated_at,kind,auto_approve_json) VALUES
                ('c1','One','/code/alpha','{}','[]',1,'code','{}'),
                ('c2','Two','/code/alpha','{}','[]',2,'code','{}'),
                ('w1','Task','/tasks/one','{}','[{\"role\":\"user\",\"content\":\"keep\"}]',3,'work','{\"readFiles\":false,\"editFiles\":false,\"fetchWebContent\":true,\"executeCommand\":false,\"useMcpServers\":false}'),
                ('w2','Custom','/tasks/two','{}','[]',4,'work','{\"readFiles\":false,\"editFiles\":false,\"fetchWebContent\":false,\"executeCommand\":false,\"useMcpServers\":false}');
                PRAGMA user_version=5;").unwrap();
        }
        let db = open(&path).unwrap();
        let count: i64 = db.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        let name: String = db.query_row("SELECT name FROM projects", [], |row| row.get(0)).unwrap();
        assert_eq!(name, "alpha");
        let (policy, history): (String, String) = db.query_row("SELECT auto_approve_json,history_json FROM sessions WHERE id='w1'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&policy).unwrap()["editFiles"], true);
        assert!(history.contains("keep"));
        let custom: String = db.query_row("SELECT auto_approve_json FROM sessions WHERE id='w2'", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&custom).unwrap()["editFiles"], false);
        assert_eq!(schema_version(&db).unwrap(), 6);
    }

    #[test]
    fn a_fresh_database_lands_on_the_current_version() {
        let (_root, path) = temporary();
        let db = open(&path).unwrap();
        assert_eq!(schema_version(&db).unwrap(), SCHEMA_VERSION);
        assert!(columns(&db, "sessions").unwrap().iter().any(|c| c == "kind"));
        assert!(columns(&db, "sessions").unwrap().iter().any(|c| c == "auto_approve_json"));
    }

    #[test]
    fn a_pre_versioning_database_gains_kind_and_keeps_its_rows() {
        let (_root, path) = temporary();
        {
            // The schema as an older build wrote it: no user_version, no kind.
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace TEXT NOT NULL,settings_json TEXT NOT NULL,history_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
                 CREATE TABLE schedules (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,prompt TEXT NOT NULL,mode TEXT NOT NULL,approval_policy TEXT NOT NULL,next_run_at INTEGER NOT NULL,interval_seconds INTEGER,enabled INTEGER NOT NULL,in_flight INTEGER NOT NULL,last_run_at INTEGER,last_error TEXT);
                 INSERT INTO sessions VALUES ('s1','Old','/tmp','{\"providerId\":\"moderado\",\"baseUrl\":\"https://x/v1\",\"planModel\":\"p\",\"actModel\":\"a\"}','[]',1);",
            )
            .unwrap();
            assert_eq!(schema_version(&db).unwrap(), 0);
        }

        let db = open(&path).unwrap();
        assert_eq!(schema_version(&db).unwrap(), SCHEMA_VERSION);
        let kind: String = db
            .query_row("SELECT kind FROM sessions WHERE id='s1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kind, "code");
        // The repair added the missing schedule columns and paused the schedule.
        assert!(columns(&db, "schedules")
            .unwrap()
            .iter()
            .any(|c| c == "settings_json"));
    }

    #[test]
    fn opening_twice_is_a_no_op() {
        let (_root, path) = temporary();
        open(&path).unwrap();
        let db = open(&path).unwrap();
        assert_eq!(schema_version(&db).unwrap(), SCHEMA_VERSION);
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn a_version_three_database_gets_all_default_code_permissions_without_losing_rows() {
        let (_root, path) = temporary();
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(V1).unwrap();
            add_column_if_missing(&db, "sessions", "kind", "TEXT NOT NULL DEFAULT 'code'").unwrap();
            db.execute_batch("CREATE TABLE attachments (id TEXT,session_id TEXT, name TEXT,kind TEXT,bytes INTEGER,created_at INTEGER,PRIMARY KEY(session_id,id));
                INSERT INTO sessions VALUES ('s1','Old','/tmp','{}','[]',1,'code');
                PRAGMA user_version=3;").unwrap();
        }
        let db = open(&path).unwrap();
        let policy: String = db.query_row("SELECT auto_approve_json FROM sessions WHERE id='s1'", [], |r| r.get(0)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&policy).unwrap();
        assert_eq!(value["readFiles"], true);
        assert_eq!(value["fetchWebContent"], true);
        assert_eq!(value["editFiles"], true);
        assert_eq!(value["executeCommand"], true);
        assert_eq!(value["useMcpServers"], true);
        assert_eq!(schema_version(&db).unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn version_four_code_default_policy_is_upgraded_to_all_five_enabled() {
        let (_root, path) = temporary();
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(V1).unwrap();
            add_column_if_missing(&db, "sessions", "kind", "TEXT NOT NULL DEFAULT 'code'").unwrap();
            db.execute_batch("CREATE TABLE attachments (id TEXT,session_id TEXT,name TEXT,kind TEXT,bytes INTEGER,created_at INTEGER,PRIMARY KEY(session_id,id));
                ALTER TABLE sessions ADD COLUMN auto_approve_json TEXT NOT NULL DEFAULT '{}';
                INSERT INTO sessions VALUES ('s1','Old','/tmp','{}','[]',1,'code','{\"readFiles\":true,\"editFiles\":false,\"fetchWebContent\":true,\"executeCommand\":false,\"useMcpServers\":false}');
                INSERT INTO sessions VALUES ('s2','Custom','/tmp','{}','[]',2,'code','{\"readFiles\":false,\"editFiles\":false,\"fetchWebContent\":true,\"executeCommand\":false,\"useMcpServers\":true}');
                PRAGMA user_version=4;").unwrap();
        }
        let db = open(&path).unwrap();
        let policy: String = db.query_row("SELECT auto_approve_json FROM sessions WHERE id='s1'", [], |r| r.get(0)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&policy).unwrap();
        assert_eq!(value["readFiles"], true);
        assert_eq!(value["editFiles"], true);
        assert_eq!(value["fetchWebContent"], true);
        assert_eq!(value["executeCommand"], true);
        assert_eq!(value["useMcpServers"], true);
        let custom: String = db.query_row("SELECT auto_approve_json FROM sessions WHERE id='s2'", [], |r| r.get(0)).unwrap();
        let custom: serde_json::Value = serde_json::from_str(&custom).unwrap();
        assert_eq!(custom["readFiles"], false);
        assert_eq!(custom["useMcpServers"], true);
    }
}
