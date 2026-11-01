use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 262_144;
const MAX_RESULTS: usize = 5;
const MAX_ERROR_BYTES: usize = 300;

/// Which search API to call. Each provider differs in request shape (headers,
/// method, body) and response shape, so adapters live here and nowhere else.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SearchProvider {
    /// A user-supplied API that already returns `{"results":[{title,url,snippet}]}`.
    #[default]
    Custom,
    Brave,
    Tavily,
    Serper,
    Searxng,
}

impl SearchProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Custom => "custom",
            Self::Brave => "brave",
            Self::Tavily => "tavily",
            Self::Serper => "serper",
            Self::Searxng => "searxng",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Custom => "Custom endpoint",
            Self::Brave => "Brave Search",
            Self::Tavily => "Tavily",
            Self::Serper => "Serper (Google)",
            Self::Searxng => "SearXNG",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
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
            Self::Custom | Self::Searxng => None,
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
            provider: SearchProvider::Custom,
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
        let endpoint = validate(settings.provider, &settings.endpoint)?;
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

pub fn validate(provider: SearchProvider, endpoint: &str) -> Result<String, String> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        if provider.requires_endpoint() {
            return Err(format!("{} needs a search endpoint", provider.label()));
        }
        return Ok(String::new());
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
