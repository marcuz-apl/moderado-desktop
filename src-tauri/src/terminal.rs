//! A real terminal: one PTY-backed shell per session, streamed to the UI.
//!
//! This is deliberately *not* the agent's sandboxed command path. A terminal is
//! the user typing commands themselves, so it runs a real shell in the project
//! folder with the user's own account and credentials. The agent's
//! `execute_command` stays sandboxed and approval-gated; the two never share a
//! code path.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct TerminalState(Mutex<HashMap<String, TerminalHandle>>);

struct TerminalHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalChunk {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
}

/// The shell to run. Windows gets PowerShell without a profile so startup is
/// predictable; elsewhere the user's own login shell.
pub fn shell_command() -> CommandBuilder {
    #[cfg(windows)]
    {
        let mut builder = CommandBuilder::new("powershell.exe");
        builder.args(["-NoLogo", "-NoProfile"]);
        builder
    }
    #[cfg(not(windows))]
    {
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()))
    }
}

/// Decode as much valid UTF-8 as a chunk holds, keeping an incomplete trailing
/// sequence for the next read. A multi-byte character split across two reads is
/// normal, and decoding each chunk blindly would corrupt non-ASCII output.
fn drain_utf8(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    match std::str::from_utf8(pending) {
        Ok(text) => {
            let out = text.to_owned();
            pending.clear();
            out
        }
        Err(error) => {
            let valid = error.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// The id a shell is stored under. `open` returns this value and the frontend
/// adopts it, so the rule lives here alone: a session when the caller has one,
/// otherwise the project (a Code session sends no session id), otherwise the
/// folder itself.
pub fn key(session_id: Option<String>, project_workspace: Option<String>, root: &Path) -> String {
    session_id
        .or(project_workspace)
        .unwrap_or_else(|| root.to_string_lossy().into_owned())
}

/// Start a shell for this session, replacing any terminal it already had.
pub fn open(
    app: &AppHandle,
    state: &TerminalState,
    session_id: &str,
    cwd: &Path,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    close(state, session_id);
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|error| format!("Could not open a terminal: {error}"))?;
    let mut command = shell_command();
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Could not start a shell: {error}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Could not read the terminal: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Could not write to the terminal: {error}"))?;

    let handle = app.clone();
    let id = session_id.to_owned();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let data = drain_utf8(&mut pending, &buffer[..read]);
                    if !data.is_empty() {
                        let _ = handle.emit(
                            "terminal-output",
                            TerminalChunk {
                                session_id: id.clone(),
                                data,
                            },
                        );
                    }
                }
            }
        }
        let _ = handle.emit("terminal-exit", TerminalExit { session_id: id });
    });

    state.0.lock().unwrap().insert(
        session_id.to_owned(),
        TerminalHandle {
            writer,
            master: pair.master,
            child,
        },
    );
    Ok(())
}

pub fn write(state: &TerminalState, session_id: &str, data: &str) -> Result<(), String> {
    let mut terminals = state.0.lock().unwrap();
    let handle = terminals
        .get_mut(session_id)
        .ok_or("The terminal is not running")?;
    handle
        .writer
        .write_all(data.as_bytes())
        .and_then(|()| handle.writer.flush())
        .map_err(|error| format!("Could not write to the terminal: {error}"))
}

pub fn resize(state: &TerminalState, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let terminals = state.0.lock().unwrap();
    let handle = terminals.get(session_id).ok_or("The terminal is not running")?;
    handle
        .master
        .resize(size(cols, rows))
        .map_err(|error| format!("Could not resize the terminal: {error}"))
}

pub fn close(state: &TerminalState, session_id: &str) {
    if let Some(mut handle) = state.0.lock().unwrap().remove(session_id) {
        let _ = handle.child.kill();
        let _ = handle.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_an_incomplete_multibyte_sequence_for_the_next_read() {
        // "é" is two bytes; split it across reads the way a PTY can.
        let bytes = "é".as_bytes();
        let mut pending = Vec::new();
        assert_eq!(drain_utf8(&mut pending, &bytes[..1]), "");
        assert_eq!(drain_utf8(&mut pending, &bytes[1..]), "é");
        assert!(pending.is_empty());
    }

    #[test]
    fn decodes_plain_text_in_one_pass() {
        let mut pending = Vec::new();
        assert_eq!(drain_utf8(&mut pending, b"hello\r\n"), "hello\r\n");
        assert!(pending.is_empty());
    }

    #[test]
    fn pty_size_never_reports_zero() {
        let small = size(0, 0);
        assert_eq!(small.cols, 1);
        assert_eq!(small.rows, 1);
    }

    #[test]
    fn a_session_keys_its_own_shell() {
        assert_eq!(
            key(Some("s1".into()), Some("p1".into()), Path::new("/repo")),
            "s1"
        );
    }

    #[test]
    fn a_code_session_keys_by_project_because_it_sends_no_session_id() {
        // The renderer sends `sessionId: null` in Code mode. Keying by the open
        // session there addressed a shell that was never created, so typing did
        // nothing; the project is the id both sides agree on.
        assert_eq!(key(None, Some("p1".into()), Path::new("/repo")), "p1");
    }

    #[test]
    fn without_an_id_the_folder_is_the_key() {
        assert_eq!(key(None, None, Path::new("/repo")), "/repo");
    }
}
