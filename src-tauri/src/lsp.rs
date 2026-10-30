//! Minimal Language Server Protocol client used by the `diagnostics` tool.
//!
//! Servers are configured in `~/.moderado/lsp.json` by file extension. A
//! server is spawned per turn, initialized, sent `textDocument/didOpen`, and
//! asked for the diagnostics it publishes for that file. LSP framing is
//! `Content-Length: N\r\n\r\n` followed by a JSON body.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SERVERS: usize = 16;

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerConfig {
    pub id: String,
    /// File extensions this server handles, for example `[".rs"]`.
    pub extensions: Vec<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Optional LSP language id; derived from the extension when empty.
    #[serde(default)]
    pub language_id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspConfig {
    #[serde(default)]
    pub servers: Vec<LspServerConfig>,
}

pub fn config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join(".moderado").join("lsp.json"))
}

pub fn load() -> Result<LspConfig, String> {
    let path = config_path()?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Invalid LSP config file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LspConfig::default()),
        Err(error) => Err(format!("Could not read LSP config: {error}")),
    }
}

pub fn save(config: &LspConfig) -> Result<LspConfig, String> {
    validate(config)?;
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create LSP config folder: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(config).map_err(|_| "Could not encode LSP config")?;
    std::fs::write(&path, bytes).map_err(|error| format!("Could not save LSP config: {error}"))?;
    Ok(config.clone())
}

pub fn validate(config: &LspConfig) -> Result<(), String> {
    if config.servers.len() > MAX_SERVERS {
        return Err(format!("At most {MAX_SERVERS} language servers are supported"));
    }
    let mut ids = std::collections::HashSet::new();
    for server in &config.servers {
        if server.id.is_empty() || server.id.len() > 64 {
            return Err("Language server id must be 1-64 characters".into());
        }
        if !ids.insert(server.id.clone()) {
            return Err(format!("Duplicate language server id '{}'", server.id));
        }
        if server.extensions.is_empty() || server.extensions.len() > 32 {
            return Err(format!(
                "Language server '{}' needs 1-32 extensions",
                server.id
            ));
        }
        if server.extensions.iter().any(|extension| {
            !extension.starts_with('.') || extension.len() > 16 || extension.len() < 2
        }) {
            return Err(format!(
                "Language server '{}' extensions must look like '.rs'",
                server.id
            ));
        }
        if server.command.trim().is_empty() || server.command.len() > 4096 {
            return Err(format!(
                "Language server '{}' needs a command of 1-4,096 characters",
                server.id
            ));
        }
        if server.args.len() > 64 || server.args.iter().any(|arg| arg.len() > 4096) {
            return Err(format!(
                "Language server '{}' has too many or too long arguments",
                server.id
            ));
        }
        if server.env.len() > 32
            || server
                .env
                .iter()
                .any(|(key, value)| key.is_empty() || key.len() > 256 || value.len() > 4096)
        {
            return Err(format!(
                "Language server '{}' has an invalid environment",
                server.id
            ));
        }
    }
    Ok(())
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default()
}

fn language_id_for(path: &Path) -> &'static str {
    match extension_of(path).to_ascii_lowercase().as_str() {
        ".rs" => "rust",
        ".ts" | ".tsx" => "typescript",
        ".js" | ".jsx" | ".mjs" | ".cjs" => "javascript",
        ".py" => "python",
        ".go" => "go",
        ".java" => "java",
        ".c" | ".h" => "c",
        ".cc" | ".cpp" | ".hpp" => "cpp",
        ".cs" => "csharp",
        ".rb" => "ruby",
        ".php" => "php",
        ".json" => "json",
        _ => "plaintext",
    }
}

fn path_to_uri(path: &Path) -> String {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut text = path.to_string_lossy().replace('\\', "/");
    if !text.starts_with('/') {
        text.insert(0, '/');
    }
    let mut uri = String::from("file://");
    for character in text.chars() {
        match character {
            ' ' => uri.push_str("%20"),
            '#' => uri.push_str("%23"),
            '?' => uri.push_str("%3F"),
            _ => uri.push(character),
        }
    }
    uri
}

fn severity_name(value: Option<u64>) -> &'static str {
    match value {
        Some(1) => "error",
        Some(2) => "warning",
        Some(3) => "info",
        Some(4) => "hint",
        _ => "diagnostic",
    }
}

fn format_diagnostics(relative: &str, diagnostics: &[Value]) -> String {
    if diagnostics.is_empty() {
        return format!("No diagnostics for {relative}.");
    }
    diagnostics
        .iter()
        .map(|diagnostic| {
            let start = diagnostic
                .get("range")
                .and_then(|range| range.get("start"))
                .cloned()
                .unwrap_or(Value::Null);
            let line = start.get("line").and_then(Value::as_u64).unwrap_or(0) + 1;
            let character = start.get("character").and_then(Value::as_u64).unwrap_or(0) + 1;
            let severity = severity_name(diagnostic.get("severity").and_then(Value::as_u64));
            let message = diagnostic
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("(no message)");
            format!("{relative}:{line}:{character} {severity}: {message}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

struct LspClient {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl LspClient {
    async fn spawn(server: &LspServerConfig) -> Result<Self, String> {
        let mut command = Command::new(&server.command);
        command
            .args(&server.args)
            .envs(&server.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|error| {
            let hint = if cfg!(windows) {
                " (on Windows include the file extension, e.g. rust-analyzer.exe)"
            } else {
                ""
            };
            format!("Could not start language server '{}': {error}{hint}", server.id)
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("Language server '{}' has no stdin", server.id))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("Language server '{}' has no stdout", server.id))?;
        Ok(Self {
            _child: child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }

    async fn send(&mut self, message: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        self.stdin
            .write_all(header.as_bytes())
            .await
            .map_err(|error| format!("Could not write to language server: {error}"))?;
        self.stdin
            .write_all(&body)
            .await
            .map_err(|error| format!("Could not write to language server: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush language server: {error}"))
    }

    async fn read_message(&mut self) -> Result<Value, String> {
        let mut header = String::new();
        loop {
            let mut line = String::new();
            let read = self
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|error| format!("Could not read from language server: {error}"))?;
            if read == 0 {
                return Err("Language server closed the connection".into());
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            header.push_str(&line);
        }
        let length: usize = header
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|value| value.trim().parse().ok())
            })
            .ok_or("Language server response has no Content-Length")?;
        if length > MAX_MESSAGE_BYTES {
            return Err("Language server message is too large".into());
        }
        let mut body = vec![0u8; length];
        self.stdout
            .read_exact(&mut body)
            .await
            .map_err(|error| format!("Could not read language server body: {error}"))?;
        serde_json::from_slice(&body).map_err(|_| "Invalid language server message".into())
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
        loop {
            let message = tokio::time::timeout_at(deadline, self.read_message())
                .await
                .map_err(|_| format!("Language server timed out during {method}"))??;
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                let text = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("language server error");
                return Err(format!("Language server error: {text}"));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }

    async fn initialize(&mut self, root: &Path) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "processId": Value::Null,
                "rootUri": path_to_uri(root),
                "capabilities": {}
            }),
        )
        .await?;
        self.notify("initialized", json!({})).await
    }

    async fn diagnostics(
        &mut self,
        path: &Path,
        text: &str,
        language_id: &str,
    ) -> Result<Vec<Value>, String> {
        let uri = path_to_uri(path);
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id,
                    "version": 1,
                    "text": text
                }
            }),
        )
        .await?;
        let deadline = tokio::time::Instant::now() + DIAGNOSTIC_TIMEOUT;
        loop {
            let message = tokio::time::timeout_at(deadline, self.read_message())
                .await
                .map_err(|_| "Language server did not publish diagnostics in time")??;
            if message.get("method").and_then(Value::as_str)
                != Some("textDocument/publishDiagnostics")
            {
                continue;
            }
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if params.get("uri").and_then(Value::as_str) != Some(uri.as_str()) {
                continue;
            }
            return Ok(params
                .get("diagnostics")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default());
        }
    }
}

struct ServerClient {
    config: LspServerConfig,
    client: LspClient,
}

pub struct LspRegistry {
    servers: Mutex<Vec<ServerClient>>,
    root: PathBuf,
    errors: Vec<String>,
}

impl LspRegistry {
    pub fn empty(root: &Path) -> Self {
        Self {
            servers: Mutex::new(Vec::new()),
            root: root.to_path_buf(),
            errors: Vec::new(),
        }
    }

    /// Connect to every enabled server, best effort; failures are collected and
    /// do not block the turn or the other servers.
    pub async fn connect(config: &LspConfig, root: &Path) -> Self {
        let mut registry = Self::empty(root);
        let mut servers = Vec::new();
        for server in config.servers.iter().filter(|server| server.enabled) {
            let mut client = match LspClient::spawn(server).await {
                Ok(client) => client,
                Err(error) => {
                    registry.errors.push(error);
                    continue;
                }
            };
            if let Err(error) = client.initialize(root).await {
                registry.errors.push(format!("{}: {error}", server.id));
                continue;
            }
            servers.push(ServerClient {
                config: server.clone(),
                client,
            });
        }
        registry.servers = Mutex::new(servers);
        registry
    }

    pub fn errors(&self) -> &[String] {
        &self.errors
    }

    pub fn is_empty(&self) -> bool {
        self.errors.is_empty() && self.servers.try_lock().map(|servers| servers.is_empty()).unwrap_or(true)
    }

    fn find_index(servers: &[ServerClient], path: &Path) -> Option<usize> {
        let extension = extension_of(path).to_ascii_lowercase();
        servers.iter().position(|server| {
            server
                .config
                .extensions
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(&extension))
        })
    }

    pub async fn diagnostics(&self, relative: &str) -> Result<String, String> {
        let path = crate::workspace::resolve_path(&self.root, relative)?;
        let text = crate::workspace::read_text(&self.root, relative)?;
        let mut servers = self.servers.lock().await;
        let index = Self::find_index(&servers, &path)
            .ok_or_else(|| format!("No language server is configured for '{relative}'"))?;
        let server = &mut servers[index];
        let language_id = if server.config.language_id.is_empty() {
            language_id_for(&path)
        } else {
            server.config.language_id.as_str()
        };
        let diagnostics = server.client.diagnostics(&path, &text, language_id).await?;
        Ok(format_diagnostics(relative, &diagnostics))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn mock_server() -> LspServerConfig {
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("mock_lsp_server.mjs");
        LspServerConfig {
            id: "mock".into(),
            extensions: vec![".rs".into()],
            command: "node".into(),
            args: vec![script.to_string_lossy().into_owned()],
            env: BTreeMap::new(),
            language_id: String::new(),
            enabled: true,
        }
    }

    #[test]
    fn validates_servers() {
        let mut config = LspConfig {
            servers: vec![mock_server(), mock_server()],
        };
        assert!(validate(&config).unwrap_err().contains("Duplicate"));
        config.servers.pop();
        config.servers[0].extensions = vec!["rs".into()];
        assert!(validate(&config).is_err());
        config.servers[0].extensions = vec![".rs".into()];
        config.servers[0].command = " ".into();
        assert!(validate(&config).is_err());
    }

    #[test]
    fn maps_extensions_and_language_ids() {
        assert_eq!(language_id_for(Path::new("a.rs")), "rust");
        assert_eq!(language_id_for(Path::new("a.ts")), "typescript");
        assert_eq!(language_id_for(Path::new("a.unknown")), "plaintext");
        assert_eq!(extension_of(Path::new("a.rs")), ".rs");
    }

    #[tokio::test]
    async fn diagnostics_come_from_the_matching_server() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.rs"), "fn main() {}\n").unwrap();
        let config = LspConfig {
            servers: vec![mock_server()],
        };
        let registry = LspRegistry::connect(&config, root.path()).await;
        assert!(registry.errors().is_empty(), "{:?}", registry.errors());
        let text = registry.diagnostics("main.rs").await.unwrap();
        assert!(text.contains("mock error"), "{text}");
        assert!(text.contains("main.rs:1:1"), "{text}");
    }

    #[tokio::test]
    async fn missing_server_for_the_extension_is_an_error() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.py"), "print(1)\n").unwrap();
        let config = LspConfig {
            servers: vec![mock_server()],
        };
        let registry = LspRegistry::connect(&config, root.path()).await;
        assert!(registry
            .diagnostics("main.py")
            .await
            .unwrap_err()
            .contains("No language server"));
    }
}
