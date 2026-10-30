//! Minimal Model Context Protocol (MCP) client.
//!
//! Servers are configured in `~/.moderado/mcp.json`, connected per turn, and
//! spoken to with JSON-RPC 2.0. Two transports are supported: `stdio`
//! (newline-delimited JSON over a child process) and `http` (Streamable HTTP:
//! POST with a JSON or `text/event-stream` response). Their tools are exposed
//! to Code/Act sessions as `mcp__<server>__<tool>` and gated by the
//! `UseMcpServers` approval category.

use futures_util::StreamExt;
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

fn default_transport() -> String {
    "stdio".into()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    /// `stdio` (default) or `http`.
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// `None` exposes every tool the server advertises; `Some` limits it to the
    /// listed tool names.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
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
pub struct McpServerStatus {
    pub id: String,
    pub transport: String,
    pub connected: bool,
    pub tool_count: usize,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDiscovery {
    pub tools: Vec<McpToolInfo>,
    pub servers: Vec<McpServerStatus>,
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
        match server.transport.as_str() {
            "stdio" => {
                if server.command.trim().is_empty() || server.command.len() > 4096 {
                    return Err(format!(
                        "MCP server '{id}' needs a command of 1-4,096 characters"
                    ));
                }
            }
            "http" => validate_url(id, &server.url)?,
            other => {
                return Err(format!(
                    "MCP server '{id}' has unknown transport '{other}' (use 'stdio' or 'http')"
                ))
            }
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
        if let Some(tools) = &server.tools {
            if tools.len() > MAX_TOOLS_PER_SERVER {
                return Err(format!("MCP server '{id}' lists too many tools"));
            }
            let mut seen = HashSet::new();
            for tool in tools {
                if tool.is_empty() || tool.len() > 128 {
                    return Err(format!("MCP server '{id}' has an invalid tool name"));
                }
                if !seen.insert(tool) {
                    return Err(format!("MCP server '{id}' lists tool '{tool}' twice"));
                }
            }
        }
    }
    Ok(())
}

fn validate_url(id: &str, url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| format!("MCP server '{id}' has an invalid URL"))?;
    let local = parsed
        .host_str()
        .is_some_and(|host| host == "localhost" || host == "127.0.0.1" || host == "[::1]");
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local) {
        return Err(format!(
            "MCP server '{id}' must use HTTPS, except for localhost"
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("MCP server '{id}' URL cannot contain credentials"));
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

fn tool_allowed(server: &McpServerConfig, name: &str) -> bool {
    match &server.tools {
        None => true,
        Some(tools) => tools.iter().any(|tool| tool == name),
    }
}

fn result_text(result: &Value) -> (String, bool) {
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
    (text, is_error)
}

fn response_result(message: &Value, id: u64) -> Option<Result<Value, String>> {
    if message.get("id").and_then(Value::as_u64) != Some(id) {
        return None;
    }
    if let Some(error) = message.get("error") {
        let text = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP server error");
        return Some(Err(format!("MCP server error: {text}")));
    }
    Some(Ok(message.get("result").cloned().unwrap_or(Value::Null)))
}

struct StdioClient {
    /// Held only so `kill_on_drop` terminates the server when the turn ends.
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl StdioClient {
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
            if let Some(result) = response_result(&value, id) {
                return result;
            }
        }
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.request("initialize", initialize_params()).await?;
        self.send(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await
    }
}

struct HttpClient {
    client: reqwest::Client,
    url: String,
    session_id: Option<String>,
    next_id: u64,
}

impl HttpClient {
    fn new(server: &McpServerConfig) -> Result<Self, String> {
        validate_url(&server.id, &server.url)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // A turn makes only a handful of calls; not reusing idle sockets
            // avoids a stale keep-alive connection after a server restart.
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|_| "Could not create MCP HTTP client")?;
        Ok(Self {
            client,
            url: server.url.trim().to_owned(),
            session_id: None,
            next_id: 1,
        })
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        let mut request = self
            .client
            .post(&self.url)
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .json(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        if let Some(session) = &self.session_id {
            request = request.header("Mcp-Session-Id", session);
        }
        let response = tokio::time::timeout(REQUEST_TIMEOUT, request.send())
            .await
            .map_err(|_| format!("MCP HTTP server timed out during {method}"))?
            .map_err(|error| format!("MCP HTTP connection failed: {error}"))?;
        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
        {
            self.session_id = Some(session.to_owned());
        }
        let status = response.status();
        if !status.is_success() {
            return Err(format!("MCP HTTP server returned HTTP {status}"));
        }
        let event_stream = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/event-stream"));
        if event_stream {
            read_event_stream(response, id).await
        } else {
            let value: Value = response
                .json()
                .await
                .map_err(|_| "Invalid MCP HTTP response")?;
            let messages: Vec<&Value> = match &value {
                Value::Array(items) => items.iter().collect(),
                other => vec![other],
            };
            messages
                .into_iter()
                .find_map(|message| response_result(message, id))
                .unwrap_or_else(|| Err("MCP HTTP response did not include the request id".into()))
        }
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.request("initialize", initialize_params()).await?;
        let _ = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json")
            .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .send()
            .await;
        Ok(())
    }
}

fn initialize_params() -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "moderado-desktop", "version": env!("CARGO_PKG_VERSION")}
    })
}

async fn read_event_stream(response: reqwest::Response, id: u64) -> Result<Value, String> {
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut data = String::new();
    loop {
        let chunk = tokio::time::timeout(REQUEST_TIMEOUT, stream.next())
            .await
            .map_err(|_| "MCP HTTP stream timed out")?
            .transpose()
            .map_err(|error| format!("MCP HTTP stream failed: {error}"))?;
        let Some(chunk) = chunk else { break };
        if buffer.len() + chunk.len() > MAX_MESSAGE_BYTES {
            return Err("MCP HTTP message is too large".into());
        }
        buffer.extend_from_slice(&chunk);
        while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
            let line = String::from_utf8_lossy(&buffer[..position])
                .trim_end_matches('\r')
                .to_owned();
            buffer.drain(..=position);
            if line.is_empty() {
                if data.is_empty() {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<Value>(&data) {
                    if let Some(result) = response_result(&value, id) {
                        return result;
                    }
                }
                data.clear();
            } else if let Some(payload) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(payload.trim_start());
            }
        }
    }
    Err("MCP HTTP stream ended before the response".into())
}

enum Transport {
    Stdio(Box<StdioClient>),
    Http(HttpClient),
}

struct McpClient {
    transport: Transport,
}

impl McpClient {
    async fn connect(server: &McpServerConfig) -> Result<Self, String> {
        let transport = match server.transport.as_str() {
            "http" => Transport::Http(HttpClient::new(server)?),
            _ => Transport::Stdio(Box::new(StdioClient::spawn(server).await?)),
        };
        Ok(Self { transport })
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        match &mut self.transport {
            Transport::Stdio(client) => client.request(method, params).await,
            Transport::Http(client) => client.request(method, params).await,
        }
    }

    async fn initialize(&mut self) -> Result<(), String> {
        match &mut self.transport {
            Transport::Stdio(client) => client.initialize().await,
            Transport::Http(client) => client.initialize().await,
        }
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
        let (text, is_error) = result_text(&result);
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
    servers: Vec<McpServerStatus>,
    errors: Vec<String>,
}

impl McpRegistry {
    pub fn empty() -> Self {
        Self {
            clients: Mutex::new(Vec::new()),
            tools: Vec::new(),
            schemas: HashMap::new(),
            servers: Vec::new(),
            errors: Vec::new(),
        }
    }

    /// Connect to every enabled server, best effort. Failures are collected in
    /// `errors()` and per-server `servers()` status instead of aborting the
    /// turn; a broken server must not stop the others or the session.
    pub async fn connect(config: &McpConfig) -> Self {
        let mut registry = Self::empty();
        let mut clients = Vec::new();
        for server in config.servers.iter().filter(|server| server.enabled) {
            let mut status = McpServerStatus {
                id: server.id.clone(),
                transport: server.transport.clone(),
                connected: false,
                tool_count: 0,
                error: None,
            };
            let mut client = match McpClient::connect(server).await {
                Ok(client) => client,
                Err(error) => {
                    status.error = Some(error.clone());
                    registry.errors.push(error);
                    registry.servers.push(status);
                    continue;
                }
            };
            if let Err(error) = client.initialize().await {
                let error = format!("{}: {error}", server.id);
                status.error = Some(error.clone());
                registry.errors.push(error);
                registry.servers.push(status);
                continue;
            }
            let listed = match client.list_tools().await {
                Ok(listed) => listed,
                Err(error) => {
                    let error = format!("{}: {error}", server.id);
                    status.error = Some(error.clone());
                    registry.errors.push(error);
                    registry.servers.push(status);
                    continue;
                }
            };
            for (name, description, schema) in listed {
                if !tool_allowed(server, &name) {
                    continue;
                }
                let public_name = public_tool_name(&server.id, &name);
                registry.schemas.insert(public_name.clone(), schema);
                registry.tools.push(McpToolInfo {
                    server_id: server.id.clone(),
                    name,
                    public_name,
                    description,
                });
            }
            status.connected = true;
            status.tool_count = registry
                .tools
                .iter()
                .filter(|tool| tool.server_id == server.id)
                .count();
            registry.servers.push(status);
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

    pub fn servers(&self) -> &[McpServerStatus] {
        &self.servers
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
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::Path;

    fn mock_server() -> McpServerConfig {
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("mock_mcp_server.mjs");
        McpServerConfig {
            id: "mock".into(),
            transport: "stdio".into(),
            command: "node".into(),
            url: String::new(),
            args: vec![script.to_string_lossy().into_owned()],
            env: BTreeMap::new(),
            tools: None,
            enabled: true,
        }
    }

    fn server(id: &str) -> McpServerConfig {
        McpServerConfig {
            id: id.into(),
            transport: "stdio".into(),
            command: "node".into(),
            url: String::new(),
            args: Vec::new(),
            env: BTreeMap::new(),
            tools: None,
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
    fn validates_http_servers_and_tool_lists() {
        let mut config = McpConfig {
            servers: vec![McpServerConfig {
                id: "remote".into(),
                transport: "http".into(),
                command: String::new(),
                url: "http://example.com/mcp".into(),
                args: Vec::new(),
                env: BTreeMap::new(),
                tools: None,
                enabled: true,
            }],
        };
        assert!(validate(&config).unwrap_err().contains("HTTPS"));
        config.servers[0].url = "https://example.com/mcp".into();
        assert!(validate(&config).is_ok());
        config.servers[0].transport = "carrier-pigeon".into();
        assert!(validate(&config).is_err());
        config.servers[0].transport = "http".into();
        config.servers[0].tools = Some(vec!["echo".into(), "echo".into()]);
        assert!(validate(&config).unwrap_err().contains("twice"));
    }

    #[test]
    fn public_names_round_trip() {
        assert_eq!(public_tool_name("srv", "echo"), "mcp__srv__echo");
        assert_eq!(split_public_name("mcp__srv__echo"), Some(("srv", "echo")));
        assert_eq!(split_public_name("echo"), None);
        assert_eq!(split_public_name("mcp__srv"), None);
    }

    #[test]
    fn tool_allow_list_filters_names() {
        let mut server = server("srv");
        server.tools = Some(vec!["echo".into()]);
        assert!(tool_allowed(&server, "echo"));
        assert!(!tool_allowed(&server, "fail"));
        server.tools = None;
        assert!(tool_allowed(&server, "anything"));
    }

    #[tokio::test]
    async fn registry_lists_and_calls_tools() {
        let config = McpConfig {
            servers: vec![mock_server()],
        };
        let registry = McpRegistry::connect(&config).await;
        assert!(registry.errors().is_empty(), "{:?}", registry.errors());
        assert!(registry.servers()[0].connected);
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
    async fn allow_list_hides_tools_the_server_still_advertises() {
        let mut server = mock_server();
        server.tools = Some(vec!["echo".into()]);
        let config = McpConfig {
            servers: vec![server],
        };
        let registry = McpRegistry::connect(&config).await;
        let names: Vec<&str> = registry
            .tools()
            .iter()
            .map(|tool| tool.public_name.as_str())
            .collect();
        assert_eq!(names, vec!["mcp__mock__echo"]);
        assert!(registry.call("mcp__mock__fail", "{}").await.is_err());
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
                    transport: "stdio".into(),
                    command: "definitely-not-a-real-command".into(),
                    url: String::new(),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                    tools: None,
                    enabled: true,
                },
                mock_server(),
            ],
        };
        let registry = McpRegistry::connect(&config).await;
        assert_eq!(registry.errors().len(), 1);
        assert_eq!(registry.servers().len(), 2);
        assert!(registry.servers()[0].error.is_some());
        assert!(registry.servers()[1].connected);
        assert!(registry
            .tools()
            .iter()
            .any(|tool| tool.public_name == "mcp__mock__echo"));
    }

    fn read_http_request(socket: &mut TcpStream) -> Value {
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        let header_end = loop {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let length: usize = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                    .and_then(|value| value.trim().parse().ok())
            })
            .unwrap();
        while bytes.len() - header_end < length {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
        }
        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
    }

    #[tokio::test]
    async fn http_transport_handles_json_and_event_stream_responses() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            // The `notifications/initialized` POST is best effort and may not
            // arrive, so count only the three request-bearing calls.
            let mut handled = 0;
            while handled < 3 {
                let (mut socket, _) = listener.accept().unwrap();
                let request = read_http_request(&mut socket);
                let Some(id) = request["id"].as_u64() else {
                    socket
                        .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .unwrap();
                    continue;
                };
                handled += 1;
                let method = request["method"].as_str().unwrap();
                match method {
                    "initialize" => {
                        let body = json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"mock","version":"1"}}}).to_string();
                        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: test-session\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
                    }
                    "tools/list" => {
                        let body = json!({"jsonrpc":"2.0","id":id,"result":{"tools":[{"name":"echo","description":"Echo","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}}).to_string();
                        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
                    }
                    "tools/call" => {
                        let message = json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":"http:ok"}],"isError":false}}).to_string();
                        let body = format!("event: message\ndata: {message}\n\n");
                        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
                    }
                    other => panic!("unexpected method {other}"),
                }
            }
        });
        let config = McpConfig {
            servers: vec![McpServerConfig {
                id: "remote".into(),
                transport: "http".into(),
                command: String::new(),
                url: format!("http://127.0.0.1:{port}/mcp"),
                args: Vec::new(),
                env: BTreeMap::new(),
                tools: None,
                enabled: true,
            }],
        };
        let registry = McpRegistry::connect(&config).await;
        assert!(registry.errors().is_empty(), "{:?}", registry.errors());
        assert_eq!(registry.tools().len(), 1);
        assert_eq!(registry.tools()[0].public_name, "mcp__remote__echo");
        assert_eq!(
            registry
                .call("mcp__remote__echo", r#"{"text":"hi"}"#)
                .await
                .unwrap(),
            "http:ok"
        );
        server.join().unwrap();
    }
}
