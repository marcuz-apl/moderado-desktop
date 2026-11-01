use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 262_144;
const MAX_RESULTS: usize = 5;
const MAX_ERROR_BYTES: usize = 300;
const MAX_KEYLESS_CHARS: usize = 8_000;

/// Keyless hosted MCP search servers, tried in order. This is the same pair the
/// Moderado CLI uses; neither needs a credential, so search works out of the box.
fn keyless_targets() -> Vec<KeylessTarget> {
    vec![
        KeylessTarget {
            name: "Exa",
            url: "https://mcp.exa.ai/mcp".into(),
            tool: "web_search_exa",
        },
        KeylessTarget {
            name: "Parallel",
            url: "https://search.parallel.ai/mcp".into(),
            tool: "web_search",
        },
    ]
}

struct KeylessTarget {
    name: &'static str,
    url: String,
    tool: &'static str,
}

/// Which search API to call. Each provider differs in request shape (headers,
/// method, body) and response shape, so adapters live here and nowhere else.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchProvider {
    /// Keyless hosted MCP search. Needs no setup, so it is the default.
    #[default]
    Automatic,
    /// A user-supplied API that already returns `{"results":[{title,url,snippet}]}`.
    Custom,
    Brave,
    Tavily,
    Serper,
    Searxng,
}

impl SearchProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Custom => "custom",
            Self::Brave => "brave",
            Self::Tavily => "tavily",
            Self::Serper => "serper",
            Self::Searxng => "searxng",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Automatic => "Automatic",
            Self::Custom => "Custom endpoint",
            Self::Brave => "Brave Search",
            Self::Tavily => "Tavily",
            Self::Serper => "Serper (Google)",
            Self::Searxng => "SearXNG",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "automatic" => Self::Automatic,
            "brave" => Self::Brave,
            "tavily" => Self::Tavily,
            "serper" => Self::Serper,
            "searxng" => Self::Searxng,
            _ => Self::Custom,
        }
    }

    /// Hosted APIs have a fixed endpoint, so the endpoint field is an optional override.
    fn default_endpoint(self) -> Option<&'static str> {
        match self {
            Self::Brave => Some("https://api.search.brave.com/res/v1/web/search"),
            Self::Tavily => Some("https://api.tavily.com/search"),
            Self::Serper => Some("https://google.serper.dev/search"),
            Self::Automatic | Self::Custom | Self::Searxng => None,
        }
    }

    fn needs_key(self) -> bool {
        matches!(self, Self::Brave | Self::Tavily | Self::Serper)
    }

    fn requires_endpoint(self) -> bool {
        matches!(self, Self::Custom | Self::Searxng)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchSettings {
    pub enabled: bool,
    #[serde(default)]
    pub provider: SearchProvider,
    #[serde(default)]
    pub endpoint: String,
}

impl Default for SearchSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: SearchProvider::default(),
            endpoint: String::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SearchConfig {
    pub provider: SearchProvider,
    pub endpoint: String,
    pub key: String,
}

#[derive(Clone)]
pub struct SearchStore {
    path: PathBuf,
}

impl SearchStore {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let store = Self { path };
        crate::db::open(&store.path)?;
        Ok(store)
    }

    fn connect(&self) -> Result<Connection, String> {
        crate::db::connect(&self.path)
    }

    pub fn get(&self, session_id: &str) -> Result<SearchSettings, String> {
        let db = self.connect()?;
        db.query_row(
            "SELECT enabled,provider,endpoint FROM search_settings WHERE session_id=?1",
            [session_id],
            |row| {
                let provider: String = row.get(1)?;
                Ok(SearchSettings {
                    enabled: row.get(0)?,
                    provider: SearchProvider::parse(&provider),
                    endpoint: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .map_or(Ok(SearchSettings::default()), Ok)
    }

    pub fn save(&self, session_id: &str, settings: &SearchSettings) -> Result<(), String> {
        let endpoint = validate_settings(settings)?;
        self.connect()?.execute("INSERT INTO search_settings(session_id,enabled,provider,endpoint) VALUES(?1,?2,?3,?4) ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled,provider=excluded.provider,endpoint=excluded.endpoint", params![session_id,settings.enabled,settings.provider.as_str(),endpoint])
            .map_err(|error| format!("Could not save search settings: {error}"))?;
        Ok(())
    }
}

/// Keychain account for a provider's key. Custom and SearXNG endpoints are
/// user-supplied, so their key belongs to that URL; hosted providers keep one
/// key each.
pub fn key_account(provider: SearchProvider, endpoint: &str) -> String {
    match provider {
        SearchProvider::Custom | SearchProvider::Searxng => endpoint.to_string(),
        _ => provider.as_str().to_string(),
    }
}

/// Whether a session can actually search: the provider has what it needs to
/// make a request, so the tool is only advertised when a call could succeed.
pub fn is_configured(provider: SearchProvider, endpoint: &str, key: &str) -> bool {
    if provider.requires_endpoint() && endpoint.trim().is_empty() {
        return false;
    }
    if provider.needs_key() && key.is_empty() {
        return false;
    }
    true
}

/// A provider that requires an endpoint but has none is simply not set up yet.
pub fn is_ready(provider: SearchProvider, endpoint: &str) -> bool {
    !provider.requires_endpoint() || !endpoint.trim().is_empty()
}

/// Endpoint for a turn. `Ok(None)` means search is off or not configured yet:
/// missing settings disable search, they never fail the turn. Sessions default
/// to search enabled with nothing configured, so this case is the normal one.
pub fn turn_endpoint(settings: &SearchSettings) -> Result<Option<String>, String> {
    if !settings.enabled || !is_ready(settings.provider, &settings.endpoint) {
        return Ok(None);
    }
    validate(settings.provider, &settings.endpoint).map(Some)
}

/// Validation for storage. A disabled session may keep an empty endpoint, so
/// turning search off never requires configuring it first.
pub fn validate_settings(settings: &SearchSettings) -> Result<String, String> {
    if settings.endpoint.trim().is_empty() {
        return if settings.enabled {
            validate(settings.provider, "")
        } else {
            Ok(String::new())
        };
    }
    validate_endpoint(settings.endpoint.trim())
}

pub fn validate(provider: SearchProvider, endpoint: &str) -> Result<String, String> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return match provider {
            SearchProvider::Custom => Err("Enter a search endpoint URL".into()),
            SearchProvider::Searxng => Err("Enter the SearXNG URL".into()),
            _ => Ok(String::new()),
        };
    }
    validate_endpoint(endpoint)
}

pub fn validate_endpoint(value: &str) -> Result<String, String> {
    if value.len() > 2048 || value.trim() != value {
        return Err("Search endpoint is invalid".into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "Search endpoint is invalid")?;
    if url.username() != "" || url.password().is_some() || url.fragment().is_some() {
        return Err("Search endpoint cannot contain credentials or a fragment".into());
    }
    let host = url.host_str().ok_or("Search endpoint needs a host")?;
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("Search endpoint must use HTTPS or loopback HTTP".into());
    }
    if url.query_pairs().any(|(key, _)| key == "q") {
        return Err("Search endpoint cannot contain a q parameter".into());
    }
    Ok(url.to_string())
}

/// The endpoint a request goes to: the configured override, else the provider's
/// own API. Custom and SearXNG have no default, so they must be configured.
fn base_url(config: &SearchConfig) -> Result<reqwest::Url, String> {
    let configured = config.endpoint.trim();
    let raw = if configured.is_empty() {
        config
            .provider
            .default_endpoint()
            .ok_or("Search endpoint is required for this provider")?
            .to_string()
    } else {
        validate_endpoint(configured)?
    };
    reqwest::Url::parse(&raw).map_err(|_| "Search endpoint is invalid".into())
}

/// SearXNG serves JSON at `<base>/search`; accept a bare origin or the full path.
fn searxng_url(config: &SearchConfig) -> Result<reqwest::Url, String> {
    let mut url = base_url(config)?;
    if !url.path().trim_end_matches('/').ends_with("/search") {
        let path = format!("{}/search", url.path().trim_end_matches('/'));
        url.set_path(&path);
    }
    Ok(url)
}

pub async fn query(config: &SearchConfig, query: &str) -> Result<String, String> {
    if query.trim().is_empty() || query.len() > 500 {
        return Err("Search query must be 1–500 characters".into());
    }
    let provider = config.provider;
    if provider.needs_key() && config.key.is_empty() {
        return Err(format!(
            "{} needs an API key; add one in Settings → Web search",
            provider.label()
        ));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let request = match provider {
        SearchProvider::Automatic => {
            let text = try_keyless(&client, &keyless_targets(), query).await?;
            return Ok(text);
        }
        SearchProvider::Custom => {
            let mut url = base_url(config)?;
            url.query_pairs_mut().append_pair("q", query);
            let request = client.get(url);
            if config.key.is_empty() {
                request
            } else {
                request.bearer_auth(&config.key)
            }
        }
        SearchProvider::Searxng => {
            let mut url = searxng_url(config)?;
            url.query_pairs_mut()
                .append_pair("q", query)
                .append_pair("format", "json");
            let request = client.get(url).header("Accept", "application/json");
            if config.key.is_empty() {
                request
            } else {
                request.bearer_auth(&config.key)
            }
        }
        SearchProvider::Brave => {
            let mut url = base_url(config)?;
            url.query_pairs_mut()
                .append_pair("q", query)
                .append_pair("count", &MAX_RESULTS.to_string());
            client
                .get(url)
                .header("X-Subscription-Token", &config.key)
                .header("Accept", "application/json")
        }
        SearchProvider::Tavily => client
            .post(base_url(config)?)
            .bearer_auth(&config.key)
            .json(&serde_json::json!({"query": query, "max_results": MAX_RESULTS})),
        SearchProvider::Serper => client
            .post(base_url(config)?)
            .header("X-API-KEY", &config.key)
            .json(&serde_json::json!({"q": query, "num": MAX_RESULTS})),
    };
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("Search request failed: {error}"))?;
    let status = response.status();
    let body = read_body(&mut response).await?;
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&body);
        let detail = detail.split_whitespace().collect::<Vec<_>>().join(" ");
        let detail: String = detail.chars().take(MAX_ERROR_BYTES).collect();
        return Err(if detail.is_empty() {
            format!("{} returned {status}", provider.label())
        } else {
            format!("{} returned {status}: {detail}", provider.label())
        });
    }
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| format!("{} returned invalid JSON", provider.label()))?;
    parse(provider, &value)
}

/// Tries each keyless MCP search server in turn. Neither needs a credential, so
/// a failure means the service is unreachable, not that setup is missing.
async fn try_keyless(
    client: &reqwest::Client,
    targets: &[KeylessTarget],
    query: &str,
) -> Result<String, String> {
    let mut errors = Vec::new();
    for target in targets {
        match mcp_search(client, target, query).await {
            Ok(text) => return Ok(text),
            Err(error) => errors.push(format!("{}: {error}", target.name)),
        }
    }
    Err(format!(
        "No keyless search provider responded ({})",
        errors.join("; ")
    ))
}

async fn mcp_search(
    client: &reqwest::Client,
    target: &KeylessTarget,
    query: &str,
) -> Result<String, String> {
    let arguments = if target.tool == "web_search" {
        serde_json::json!({"objective": query, "search_queries": [query]})
    } else {
        serde_json::json!({"query": query, "objective": query, "numResults": MAX_RESULTS})
    };
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": target.tool, "arguments": arguments},
    });
    let mut response = client
        .post(target.url.as_str())
        .header("Accept", "application/json, text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    let status = response.status();
    let bytes = read_body(&mut response).await?;
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    Ok(readable(&mcp_text(&bytes)?))
}

fn mcp_text(body: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(body);
    let payload = json_payload(&text).ok_or("search server returned no JSON")?;
    let value: serde_json::Value =
        serde_json::from_str(payload).map_err(|_| "search server returned invalid JSON")?;
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown error");
        return Err(message.to_string());
    }
    let content = value
        .pointer("/result/content")
        .and_then(|value| value.as_array())
        .ok_or("search server returned no content")?;
    let mut parts = Vec::new();
    for item in content {
        if let Some(text) = item.get("text").and_then(|value| value.as_str()) {
            if !text.trim().is_empty() {
                parts.push(text.trim().to_string());
            }
        }
    }
    if parts.is_empty() {
        return Err("search server returned no text".into());
    }
    Ok(parts.join("\n\n"))
}

/// Accept either a plain JSON body or a server-sent-events stream.
fn json_payload(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        return Some(trimmed);
    }
    for line in trimmed.lines() {
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data.starts_with('{') {
                return Some(data);
            }
        }
    }
    None
}

/// Exa returns readable prose; Parallel returns JSON. Normalize both, and bound
/// the excerpt so one search cannot flood the model's context.
fn readable(text: &str) -> String {
    let bound = |value: &str| -> String {
        if value.chars().count() <= MAX_KEYLESS_CHARS {
            value.to_string()
        } else {
            let kept: String = value.chars().take(MAX_KEYLESS_CHARS).collect();
            format!("{kept}\n\n[search context truncated at {MAX_KEYLESS_CHARS} characters]")
        }
    };
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) {
        if let Some(results) = value.get("results").and_then(|value| value.as_array()) {
            let mut lines = Vec::new();
            for item in results.iter().take(MAX_RESULTS) {
                let url = item.get("url").and_then(|value| value.as_str()).unwrap_or("");
                if url.is_empty() {
                    continue;
                }
                let title = item.get("title").and_then(|value| value.as_str()).unwrap_or("");
                let excerpt = item
                    .get("excerpts")
                    .and_then(|value| value.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|value| value.as_str())
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .or_else(|| {
                        item.get("excerpt")
                            .and_then(|value| value.as_str())
                            .map(str::to_string)
                    })
                    .unwrap_or_default();
                lines.push(format!("{title}\n{url}\n{excerpt}"));
            }
            if !lines.is_empty() {
                return bound(&lines.join("\n\n"));
            }
        }
    }
    bound(text.trim())
}

async fn read_body(response: &mut reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Search response is too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Search response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse(provider: SearchProvider, value: &serde_json::Value) -> Result<String, String> {
    let (path, title, url, snippet): (&[&str], &str, &str, &str) = match provider {
        SearchProvider::Brave => (&["web", "results"], "title", "url", "description"),
        SearchProvider::Tavily => (&["results"], "title", "url", "content"),
        SearchProvider::Serper => (&["organic"], "title", "link", "snippet"),
        SearchProvider::Searxng => (&["results"], "title", "url", "content"),
        SearchProvider::Custom => (&["results"], "title", "url", "snippet"),
        // Automatic returns before reaching the JSON adapter; keep it total.
        SearchProvider::Automatic => (&["results"], "title", "url", "snippet"),
    };
    let results = array(value, path)
        .ok_or_else(|| format!("{} response did not contain results", provider.label()))?;
    let mut lines = Vec::new();
    for item in results.iter().take(MAX_RESULTS) {
        let title = item
            .get(title)
            .and_then(|value| value.as_str())
            .ok_or("Search result needs a title")?;
        let link = item
            .get(url)
            .and_then(|value| value.as_str())
            .ok_or("Search result needs a URL")?;
        let snippet = item
            .get(snippet)
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if title.len() > 500 || link.len() > 2048 || snippet.len() > 2000 {
            return Err("Search result is too large".into());
        }
        let parsed = reqwest::Url::parse(link).map_err(|_| "Search result URL is invalid")?;
        if !matches!(parsed.scheme(), "https" | "http") {
            return Err("Search result URL is invalid".into());
        }
        lines.push(format!("{}\n{}\n{}", title, link, snippet));
    }
    Ok(if lines.is_empty() {
        "No results.".into()
    } else {
        lines.join("\n\n")
    })
}

fn array<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a Vec<serde_json::Value>> {
    let mut node = value;
    for key in path {
        node = node.get(*key)?;
    }
    node.as_array()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    struct MockRequest {
        head: String,
        body: String,
    }

    impl MockRequest {
        fn path(&self) -> &str {
            self.head.split(' ').nth(1).unwrap_or_default()
        }

        fn header(&self, name: &str) -> Option<String> {
            self.head
                .lines()
                .find(|line| {
                    line.to_ascii_lowercase()
                        .starts_with(&format!("{}:", name.to_ascii_lowercase()))
                })
                .and_then(|line| line.split_once(':'))
                .map(|(_, value)| value.trim().to_string())
        }
    }

    /// Serve one request and reply, reading the headers plus any Content-Length
    /// body so the client is never left writing into a closed socket.
    fn serve_once(
        status: &'static str,
        response: &'static str,
        check: impl FnOnce(&MockRequest) + Send + 'static,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 1024];
            let header_end = loop {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0, "client closed before sending a request");
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            let head = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
            let length: usize = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().ok())?
                })
                .unwrap_or(0);
            while bytes.len() - header_end < length {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0, "client closed mid-body");
                bytes.extend_from_slice(&buffer[..count]);
            }
            let body = String::from_utf8_lossy(&bytes[header_end..header_end + length]).into_owned();
            check(&MockRequest { head, body });
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            )
            .unwrap();
        });
        endpoint
    }

    #[test]
    fn an_unconfigured_session_disables_search_instead_of_failing_the_turn() {
        // Sessions default to keyless search, which needs no setup at all.
        let default = SearchSettings::default();
        assert!(default.enabled);
        assert_eq!(default.provider, SearchProvider::Automatic);
        assert_eq!(turn_endpoint(&default).unwrap().as_deref(), Some(""));

        let off = SearchSettings {
            enabled: false,
            ..SearchSettings::default()
        };
        assert_eq!(turn_endpoint(&off).unwrap(), None);
        assert!(validate_settings(&off).is_ok());

        // A provider that needs a URL but has none is not configured, not an error.
        let custom = SearchSettings {
            enabled: true,
            provider: SearchProvider::Custom,
            endpoint: String::new(),
        };
        assert_eq!(turn_endpoint(&custom).unwrap(), None);

        let configured = SearchSettings {
            enabled: true,
            provider: SearchProvider::Custom,
            endpoint: "https://search.example/api".into(),
        };
        assert_eq!(
            turn_endpoint(&configured).unwrap().as_deref(),
            Some("https://search.example/api")
        );
        assert!(validate_settings(&configured).is_ok());

        // A hosted provider has its own endpoint, so an empty override is fine.
        let brave = SearchSettings {
            enabled: true,
            provider: SearchProvider::Brave,
            endpoint: String::new(),
        };
        assert_eq!(turn_endpoint(&brave).unwrap().as_deref(), Some(""));

        // A stored endpoint that is invalid still surfaces rather than being ignored.
        let bad = SearchSettings {
            enabled: true,
            provider: SearchProvider::Custom,
            endpoint: "http://example.com/api".into(),
        };
        assert!(turn_endpoint(&bad).is_err());
        assert!(validate_settings(&default).is_ok());
    }

    #[tokio::test]
    async fn keyless_search_reads_sse_content_without_a_credential() {
        let endpoint = serve_once(
            "200 OK",
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Title: Tauri\\nURL: https://v2.tauri.app\"}]}}\n\n",
            |request| {
                let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
                assert_eq!(body["method"], "tools/call");
                assert_eq!(body["params"]["name"], "web_search_exa");
                assert_eq!(body["params"]["arguments"]["query"], "tauri");
                assert_eq!(request.header("accept").as_deref(), Some("application/json, text/event-stream"));
            },
        );
        let targets = vec![KeylessTarget {
            name: "Mock",
            url: endpoint,
            tool: "web_search_exa",
        }];
        let client = reqwest::Client::new();
        let result = try_keyless(&client, &targets, "tauri").await.unwrap();
        assert!(result.contains("https://v2.tauri.app"), "{result}");
    }

    #[tokio::test]
    async fn keyless_search_falls_back_to_the_next_server() {
        let failing = serve_once("500 Internal Server Error", "{}", |_request| {});
        let working = serve_once(
            "200 OK",
            r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"results\":[{\"title\":\"Hit\",\"url\":\"https://example.com/p\",\"excerpts\":[\"Excerpt\"]}]}"}]}}"#,
            |request| {
                let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
                assert_eq!(body["params"]["name"], "web_search");
                assert_eq!(body["params"]["arguments"]["search_queries"][0], "tauri");
            },
        );
        let targets = vec![
            KeylessTarget {
                name: "Down",
                url: failing,
                tool: "web_search_exa",
            },
            KeylessTarget {
                name: "Up",
                url: working,
                tool: "web_search",
            },
        ];
        let client = reqwest::Client::new();
        let result = try_keyless(&client, &targets, "tauri").await.unwrap();
        assert!(result.contains("https://example.com/p"), "{result}");
        assert!(result.contains("Excerpt"), "{result}");
    }

    #[tokio::test]
    async fn keyless_search_reports_when_every_server_fails() {
        let failing = serve_once("503 Service Unavailable", "{}", |_request| {});
        let targets = vec![KeylessTarget {
            name: "Down",
            url: failing,
            tool: "web_search_exa",
        }];
        let client = reqwest::Client::new();
        let error = try_keyless(&client, &targets, "tauri").await.unwrap_err();
        assert!(error.contains("No keyless search provider responded"), "{error}");
        assert!(error.contains("Down"), "{error}");
    }

    /// Network check, skipped by default so the suite stays offline. Run with
    /// `cargo test --lib live_keyless_search -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_keyless_search() {
        let client = reqwest::Client::new();
        let text = try_keyless(&client, &keyless_targets(), "tauri rust desktop framework")
            .await
            .unwrap();
        eprintln!("LIVE: {}", text.chars().take(300).collect::<String>());
        assert!(text.len() > 50);
    }

    #[test]
    fn validates_endpoint_and_persists_per_session() {
        assert!(validate_endpoint("http://example.com/search").is_err());
        assert!(validate_endpoint("https://user:pass@example.com/search").is_err());
        assert!(validate_endpoint("http://127.0.0.1:8080/search").is_ok());
        assert!(validate_endpoint("https://example.com/search?q=ignored").is_err());
        assert!(validate(SearchProvider::Custom, "").is_err());
        assert_eq!(validate(SearchProvider::Brave, "").unwrap(), "");
        assert!(!is_configured(SearchProvider::Custom, "", ""));
        assert!(is_configured(SearchProvider::Brave, "", "key"));
        assert!(!is_configured(SearchProvider::Brave, "", ""));
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions.sqlite");
        let sessions = crate::sessions::SessionStore::open(path.clone()).unwrap();
        let session = sessions
            .create(
                root.path(),
                "Test",
                crate::provider::settings::ProviderSettings {
                    provider_id: crate::provider::ProviderId::Ollama,
                    base_url: "http://localhost:11434/v1".into(),
                    plan_model: "p".into(),
                    act_model: "a".into(),
                },
            )
            .unwrap();
        let store = SearchStore::open(path).unwrap();
        assert!(store.get(&session.id).unwrap().enabled);
        store
            .save(
                &session.id,
                &SearchSettings {
                    enabled: false,
                    provider: SearchProvider::Searxng,
                    endpoint: "https://search.example".into(),
                },
            )
            .unwrap();
        let saved = store.get(&session.id).unwrap();
        assert!(!saved.enabled);
        assert_eq!(saved.provider, SearchProvider::Searxng);
    }

    #[tokio::test]
    async fn queries_configured_local_api_with_bearer_key() {
        let endpoint = serve_once(
            "200 OK",
            r#"{"results":[{"title":"Result","url":"https://example.com/a","snippet":"Details"}]}"#,
            |request| {
                assert_eq!(request.path(), "/search?q=rust+tauri");
                assert_eq!(request.header("authorization").as_deref(), Some("Bearer secret"));
            },
        );
        let result = query(
            &SearchConfig {
                provider: SearchProvider::Custom,
                endpoint: format!("{endpoint}/search"),
                key: "secret".into(),
            },
            "rust tauri",
        )
        .await
        .unwrap();
        assert!(result.contains("https://example.com/a"));
    }

    #[tokio::test]
    async fn brave_uses_its_token_header_and_web_results() {
        let endpoint = serve_once(
            "200 OK",
            r#"{"web":{"results":[{"title":"Brave hit","url":"https://example.com/b","description":"Brave snippet"}]}}"#,
            |request| {
                assert!(request.path().starts_with("/res/v1/web/search?q=tauri&count=5"));
                assert_eq!(
                    request.header("x-subscription-token").as_deref(),
                    Some("brave-key")
                );
            },
        );
        let result = query(
            &SearchConfig {
                provider: SearchProvider::Brave,
                endpoint: format!("{endpoint}/res/v1/web/search"),
                key: "brave-key".into(),
            },
            "tauri",
        )
        .await
        .unwrap();
        assert!(result.contains("Brave hit"));
        assert!(result.contains("Brave snippet"));
    }

    #[tokio::test]
    async fn tavily_posts_json_and_reads_content() {
        let endpoint = serve_once(
            "200 OK",
            r#"{"results":[{"title":"Tavily hit","url":"https://example.com/t","content":"Tavily body"}]}"#,
            |request| {
                assert_eq!(request.path(), "/search");
                assert_eq!(request.header("authorization").as_deref(), Some("Bearer tv-key"));
                let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
                assert_eq!(body["query"], "tauri");
                assert_eq!(body["max_results"], 5);
            },
        );
        let result = query(
            &SearchConfig {
                provider: SearchProvider::Tavily,
                endpoint: format!("{endpoint}/search"),
                key: "tv-key".into(),
            },
            "tauri",
        )
        .await
        .unwrap();
        assert!(result.contains("Tavily hit"));
        assert!(result.contains("Tavily body"));
    }

    #[tokio::test]
    async fn serper_posts_json_and_reads_organic_results() {
        let endpoint = serve_once(
            "200 OK",
            r#"{"organic":[{"title":"Serper hit","link":"https://example.com/s","snippet":"Serper snippet"}]}"#,
            |request| {
                assert_eq!(request.path(), "/search");
                assert_eq!(request.header("x-api-key").as_deref(), Some("serper-key"));
                let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
                assert_eq!(body["q"], "tauri");
            },
        );
        let result = query(
            &SearchConfig {
                provider: SearchProvider::Serper,
                endpoint: format!("{endpoint}/search"),
                key: "serper-key".into(),
            },
            "tauri",
        )
        .await
        .unwrap();
        assert!(result.contains("Serper hit"));
        assert!(result.contains("https://example.com/s"));
    }

    #[tokio::test]
    async fn searxng_accepts_a_bare_origin() {
        let endpoint = serve_once(
            "200 OK",
            r#"{"results":[{"title":"SearX hit","url":"https://example.com/x","content":"SearX body"}]}"#,
            |request| {
                assert_eq!(request.path(), "/search?q=tauri&format=json");
            },
        );
        let result = query(
            &SearchConfig {
                provider: SearchProvider::Searxng,
                endpoint,
                key: String::new(),
            },
            "tauri",
        )
        .await
        .unwrap();
        assert!(result.contains("SearX hit"));
        assert!(result.contains("SearX body"));
    }

    #[tokio::test]
    async fn surfaces_provider_errors_and_missing_keys() {
        let endpoint = serve_once(
            "401 Unauthorized",
            r#"{"error":"invalid api key"}"#,
            |_request| {},
        );
        let error = query(
            &SearchConfig {
                provider: SearchProvider::Serper,
                endpoint,
                key: "bad".into(),
            },
            "tauri",
        )
        .await
        .unwrap_err();
        assert!(error.contains("401"), "{error}");
        assert!(error.contains("invalid api key"), "{error}");

        let error = query(
            &SearchConfig {
                provider: SearchProvider::Brave,
                endpoint: String::new(),
                key: String::new(),
            },
            "tauri",
        )
        .await
        .unwrap_err();
        assert!(error.contains("API key"), "{error}");
    }
}
