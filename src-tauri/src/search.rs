use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchSettings {
    pub enabled: bool,
    pub endpoint: String,
}

impl Default for SearchSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            endpoint: String::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SearchConfig {
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
            "SELECT enabled,endpoint FROM search_settings WHERE session_id=?1",
            [session_id],
            |row| {
                Ok(SearchSettings {
                    enabled: row.get(0)?,
                    endpoint: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .map_or(Ok(SearchSettings::default()), Ok)
    }

    pub fn save(&self, session_id: &str, settings: &SearchSettings) -> Result<(), String> {
        if !settings.endpoint.is_empty() {
            validate_endpoint(&settings.endpoint)?;
        }
        self.connect()?.execute("INSERT INTO search_settings(session_id,enabled,endpoint) VALUES(?1,?2,?3) ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled,endpoint=excluded.endpoint", params![session_id,settings.enabled,settings.endpoint])
            .map_err(|error| format!("Could not save search settings: {error}"))?;
        Ok(())
    }
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

pub async fn query(config: &SearchConfig, query: &str) -> Result<String, String> {
    if query.trim().is_empty() || query.len() > 500 {
        return Err("Search query must be 1–500 characters".into());
    }
    let mut url = reqwest::Url::parse(&validate_endpoint(&config.endpoint)?)
        .map_err(|_| "Search endpoint is invalid")?;
    url.query_pairs_mut().append_pair("q", query);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(url);
    if !config.key.is_empty() {
        request = request.bearer_auth(&config.key);
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("Search request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Search endpoint returned {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > 262_144)
    {
        return Err("Search response is too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > 262_144 {
            return Err("Search response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Search endpoint returned invalid JSON")?;
    let results = value
        .get("results")
        .and_then(|item| item.as_array())
        .ok_or("Search response needs a results array")?;
    let mut lines = Vec::new();
    for item in results.iter().take(5) {
        let title = item
            .get("title")
            .and_then(|value| value.as_str())
            .ok_or("Search result needs a title")?;
        let link = item
            .get("url")
            .and_then(|value| value.as_str())
            .ok_or("Search result needs a URL")?;
        let snippet = item
            .get("snippet")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_endpoint_and_persists_per_session() {
        assert!(validate_endpoint("http://example.com/search").is_err());
        assert!(validate_endpoint("https://user:pass@example.com/search").is_err());
        assert!(validate_endpoint("http://127.0.0.1:8080/search").is_ok());
        assert!(validate_endpoint("https://example.com/search?q=ignored").is_err());
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
                    endpoint: "https://search.example/api".into(),
                },
            )
            .unwrap();
        assert!(!store.get(&session.id).unwrap().enabled);
    }

    #[tokio::test]
    async fn queries_configured_local_api_with_bearer_key() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/search", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let count = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..count]);
            assert!(request.starts_with("GET /search?q=rust+tauri HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer secret"));
            let body = r#"{"results":[{"title":"Result","url":"https://example.com/a","snippet":"Details"}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let result = query(
            &SearchConfig {
                endpoint,
                key: "secret".into(),
            },
            "rust tauri",
        )
        .await
        .unwrap();
        assert!(result.contains("https://example.com/a"));
        server.join().unwrap();
    }
}
