//! Minimal Model Context Protocol (MCP) client over stdio.
//!
//! Servers are configured in `~/.moderado/mcp.json`, spawned per turn, and
//! spoken to with newline-delimited JSON-RPC 2.0: `initialize`, `tools/list`,
//! then `tools/call`. Their tools are advertised to Code/Act sessions as
//! `mcp__<server>__<tool>` and gated by the `UseMcpServers` approval category.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_SERVERS: usize = 16;
const MAX_TOOLS_PER_SERVER: usize = 256;

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    #[serde(default)]
    pub servers: Vec<McpServerConfig>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server_id: String,
    pub name: String,
    pub public_name: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiscovery {
    pub tools: Vec<McpToolInfo>,
    pub errors: Vec<String>,
}

pub fn config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join(".moderado").join("mcp.json"))
}

pub fn load() -> Result<McpConfig, String> {
    let path = config_path()?;
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Invalid MCP config file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(McpConfig::default()),
        Err(error) => Err(format!("Could not read MCP config: {error}")),
    }
}

pub fn save(config: &McpConfig) -> Result<McpConfig, String> {
    validate(config)?;
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create MCP config folder: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(config).map_err(|_| "Could not encode MCP config")?;
    std::fs::write(&path, bytes).map_err(|error| format!("Could not save MCP config: {error}"))?;
    Ok(config.clone())
}

pub fn validate(config: &McpConfig) -> Result<(), String> {
    if config.servers.len() > MAX_SERVERS {
        return Err(format!("At most {MAX_SERVERS} MCP servers are supported"));
    }
    let mut ids = HashSet::new();
    for server in &config.servers {
        let id = &server.id;
        if id.is_empty() || id.len() > 64 {
            return Err("MCP server id must be 1-64 characters".into());
        }
        if !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
            || id.contains("__")
        {
            return Err(format!(
                "MCP server id '{id}' may only contain letters, digits, '-' and '_' (no double underscore)"
            ));
        }
        if !ids.insert(id.clone()) {
            return Err(format!("Duplicate MCP server id '{id}'"));
        }
        if server.command.trim().is_empty() || server.command.len() > 4096 {
            return Err(format!("MCP server '{id}' needs a command of 1-4,096 characters"));
        }
        if server.args.len() > 64 || server.args.iter().any(|arg| arg.len() > 4096) {
            return Err(format!("MCP server '{id}' has too many or too long arguments"));
        }
        if server.env.len() > 32
            || server
                .env
                .iter()
                .any(|(key, value)| key.is_empty() || key.len() > 256 || value.len() > 4096)
        {
            return Err(format!("MCP server '{id}' has an invalid environment"));
        }
    }
    Ok(())
}

pub fn public_tool_name(server_id: &str, tool_name: &str) -> String {
    format!("mcp__{server_id}__{tool_name}")
}

fn split_public_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    if server.is_empty() || tool.is_empty() {
        None
    } else {
        Some((server, tool))
    }
}

struct McpClient {
    /// Held only so `kill_on_drop` terminates the server when the turn ends.
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl McpClient {
    async fn spawn(server: &McpServerConfig) -> Result<Self, String> {
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
                " (on Windows include the file extension, e.g. npx.cmd)"
            } else {
                ""
            };
            format!("Could not start MCP server '{}': {error}{hint}", server.id)
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("MCP server '{}' has no stdin", server.id))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("MCP server '{}' has no stdout", server.id))?;
        Ok(Self {
            _child: child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }

    async fn send(&mut self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        line.push(b'\n');
        self.stdin
            .write_all(&line)
            .await
            .map_err(|error| format!("Could not write to MCP server: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush MCP server: {error}"))
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
        loop {
            let mut line = String::new();
            let read = tokio::time::timeout_at(deadline, self.stdout.read_line(&mut line))
                .await
                .map_err(|_| format!("MCP server timed out during {method}"))?
                .map_err(|error| format!("Could not read from MCP server: {error}"))?;
            if read == 0 {
                return Err("MCP server closed the connection".into());
            }
            if line.len() > MAX_MESSAGE_BYTES {
                return Err("MCP message is too large".into());
            }
            // Servers may log to stdout; ignore anything that is not our response.
            let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("MCP server error");
                return Err(format!("MCP server error: {message}"));
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "moderado-desktop", "version": env!("CARGO_PKG_VERSION")}
            }),
        )
        .await?;
        self.send(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await
    }

    async fn list_tools(&mut self) -> Result<Vec<(String, String, Value)>, String> {
        let result = self.request("tools/list", json!({})).await?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut listed = Vec::new();
        for tool in tools.into_iter().take(MAX_TOOLS_PER_SERVER) {
            let Some(name) = tool.get("name").and_then(Value::as_str) else {
                continue;
            };
            if name.is_empty() || name.len() > 128 {
                continue;
            }
            let description: String = tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(600)
                .collect();
            let schema = tool
                .get("inputSchema")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({"type":"object","properties":{}}));
            listed.push((name.to_owned(), description, schema));
        }
        Ok(listed)
    }

    async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<String, String> {
        let result = self
            .request("tools/call", json!({"name": name, "arguments": arguments}))
            .await?;
        let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
        let mut text = String::new();
        if let Some(blocks) = result.get("content").and_then(Value::as_array) {
            for block in blocks {
                if let Some(value) = block.get("text").and_then(Value::as_str) {
                    text.push_str(value);
                } else if block.get("type").and_then(Value::as_str) == Some("image") {
                    text.push_str("[image]");
                }
            }
        }
        if text.is_empty() {
            text = result.to_string();
        }
        if is_error {
            Err(text)
        } else {
            Ok(text)
        }
    }
}

struct ServerClient {
    id: String,
    client: McpClient,
}

pub struct McpRegistry {
    clients: Mutex<Vec<ServerClient>>,
    tools: Vec<McpToolInfo>,
    schemas: HashMap<String, Value>,
    errors: Vec<String>,
}

impl McpRegistry {
    pub fn empty() -> Self {
        Self {
            clients: Mutex::new(Vec::new()),
            tools: Vec::new(),
            schemas: HashMap::new(),
            errors: Vec::new(),
        }
    }

    /// Connect to every enabled server, best effort. Failures are collected in
    /// `errors()` instead of aborting the turn; a broken server must not stop
    /// the others or the session.
    pub async fn connect(config: &McpConfig) -> Self {
        let mut registry = Self::empty();
        let mut clients = Vec::new();
        for server in config.servers.iter().filter(|server| server.enabled) {
            let mut client = match McpClient::spawn(server).await {
                Ok(client) => client,
                Err(error) => {
                    registry.errors.push(error);
                    continue;
                }
            };
            if let Err(error) = client.initialize().await {
                registry.errors.push(format!("{}: {error}", server.id));
                continue;
            }
            let listed = match client.list_tools().await {
                Ok(listed) => listed,
                Err(error) => {
                    registry.errors.push(format!("{}: {error}", server.id));
                    continue;
                }
            };
            for (name, description, schema) in listed {
                let public_name = public_tool_name(&server.id, &name);
                registry.schemas.insert(public_name.clone(), schema);
                registry.tools.push(McpToolInfo {
                    server_id: server.id.clone(),
                    name,
                    public_name,
                    description,
                });
            }
            clients.push(ServerClient {
                id: server.id.clone(),
                client,
            });
        }
        registry.clients = Mutex::new(clients);
        registry
    }

    pub fn tool_definitions(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|tool| {
                let description = if tool.description.is_empty() {
                    format!("MCP tool '{}' from server '{}'", tool.name, tool.server_id)
                } else {
                    tool.description.clone()
                };
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.public_name,
                        "description": description,
                        "parameters": self.schemas.get(&tool.public_name).cloned()
                            .unwrap_or_else(|| json!({"type":"object","properties":{}}))
                    }
                })
            })
            .collect()
    }

    pub fn tools(&self) -> &[McpToolInfo] {
        &self.tools
    }

    pub fn errors(&self) -> &[String] {
        &self.errors
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    pub async fn call(&self, public_name: &str, arguments: &str) -> Result<String, String> {
        let (server_id, tool_name) =
            split_public_name(public_name).ok_or("Invalid MCP tool name")?;
        let arguments: Value = if arguments.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(arguments).map_err(|_| "Invalid MCP tool arguments")?
        };
        let mut clients = self.clients.lock().await;
        let client = clients
            .iter_mut()
            .find(|client| client.id == server_id)
            .ok_or_else(|| format!("MCP server '{server_id}' is not connected"))?;
        client.client.call_tool(tool_name, arguments).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn mock_server() -> McpServerConfig {
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("mock_mcp_server.mjs");
        McpServerConfig {
            id: "mock".into(),
            command: "node".into(),
            args: vec![script.to_string_lossy().into_owned()],
            env: BTreeMap::new(),
            enabled: true,
        }
    }

    fn server(id: &str) -> McpServerConfig {
        McpServerConfig {
            id: id.into(),
            command: "node".into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            enabled: true,
        }
    }

    #[test]
    fn rejects_duplicate_and_malformed_servers() {
        let mut config = McpConfig {
            servers: vec![server("a"), server("a")],
        };
        assert!(validate(&config).unwrap_err().contains("Duplicate"));
        config.servers.pop();
        config.servers[0].id = "bad id".into();
        assert!(validate(&config).is_err());
        config.servers[0].id = "a__b".into();
        assert!(validate(&config).is_err());
        config.servers[0].id = "ok".into();
        config.servers[0].command = "  ".into();
        assert!(validate(&config).is_err());
    }

    #[test]
    fn public_names_round_trip() {
        assert_eq!(public_tool_name("srv", "echo"), "mcp__srv__echo");
        assert_eq!(split_public_name("mcp__srv__echo"), Some(("srv", "echo")));
        assert_eq!(split_public_name("echo"), None);
        assert_eq!(split_public_name("mcp__srv"), None);
    }

    #[tokio::test]
    async fn registry_lists_and_calls_tools() {
        let config = McpConfig {
            servers: vec![mock_server()],
        };
        let registry = McpRegistry::connect(&config).await;
        assert!(registry.errors().is_empty(), "{:?}", registry.errors());
        let names: Vec<&str> = registry
            .tools()
            .iter()
            .map(|tool| tool.public_name.as_str())
            .collect();
        assert!(names.contains(&"mcp__mock__echo"), "{names:?}");
        let definitions = registry.tool_definitions();
        assert!(definitions
            .iter()
            .any(|tool| tool["function"]["name"] == "mcp__mock__echo"));
        assert_eq!(
            registry
                .call("mcp__mock__echo", r#"{"text":"hello"}"#)
                .await
                .unwrap(),
            "echo:hello"
        );
    }

    #[tokio::test]
    async fn failing_and_unknown_tools_report_errors() {
        let config = McpConfig {
            servers: vec![mock_server()],
        };
        let registry = McpRegistry::connect(&config).await;
        assert!(registry
            .call("mcp__mock__fail", "{}")
            .await
            .unwrap_err()
            .contains("boom"));
        assert!(registry.call("mcp__mock__nope", "{}").await.is_err());
        assert!(registry.call("mcp__missing__echo", "{}").await.is_err());
        assert!(registry.call("not_an_mcp_name", "{}").await.is_err());
    }

    #[tokio::test]
    async fn a_broken_server_is_reported_without_stopping_the_others() {
        let config = McpConfig {
            servers: vec![
                McpServerConfig {
                    id: "broken".into(),
                    command: "definitely-not-a-real-command".into(),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                    enabled: true,
                },
                mock_server(),
            ],
        };
        let registry = McpRegistry::connect(&config).await;
        assert_eq!(registry.errors().len(), 1);
        assert!(registry
            .tools()
            .iter()
            .any(|tool| tool.public_name == "mcp__mock__echo"));
    }
}
