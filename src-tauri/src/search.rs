//! Web search over hosted MCP search servers.
//!
//! No credential and no configuration are involved: the same pair of servers
//! the Moderado CLI uses is tried in order, so the tool works out of the box.

use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 262_144;
const MAX_RESULTS: usize = 5;
const MAX_KEYLESS_CHARS: usize = 8_000;

struct KeylessTarget {
    name: &'static str,
    url: String,
    tool: &'static str,
}

/// Tried in order. Both answer without an API key.
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

pub async fn query(query: &str) -> Result<String, String> {
    if query.trim().is_empty() || query.len() > 500 {
        return Err("Search query must be 1–500 characters".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    try_targets(&client, &keyless_targets(), query).await
}

/// Tries each server in turn so one outage does not disable the tool.
async fn try_targets(
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
        "Web search is unavailable; no provider responded ({})",
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
        let url = format!("http://{}", listener.local_addr().unwrap());
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
        url
    }

    fn target(url: &str, tool: &'static str) -> KeylessTarget {
        KeylessTarget {
            name: "Mock",
            url: url.to_string(),
            tool,
        }
    }

    #[tokio::test]
    async fn reads_sse_content_without_a_credential() {
        let url = serve_once(
            "200 OK",
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Title: Tauri\\nURL: https://v2.tauri.app\"}]}}\n\n",
            |request| {
                let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
                assert_eq!(body["method"], "tools/call");
                assert_eq!(body["params"]["name"], "web_search_exa");
                assert_eq!(body["params"]["arguments"]["query"], "tauri");
                assert_eq!(
                    request.header("accept").as_deref(),
                    Some("application/json, text/event-stream")
                );
                assert!(request.header("authorization").is_none());
            },
        );
        let client = reqwest::Client::new();
        let result = try_targets(&client, &[target(&url, "web_search_exa")], "tauri")
            .await
            .unwrap();
        assert!(result.contains("https://v2.tauri.app"), "{result}");
    }

    #[tokio::test]
    async fn falls_back_to_the_next_server() {
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
        let client = reqwest::Client::new();
        let result = try_targets(
            &client,
            &[target(&failing, "web_search_exa"), target(&working, "web_search")],
            "tauri",
        )
        .await
        .unwrap();
        assert!(result.contains("https://example.com/p"), "{result}");
        assert!(result.contains("Excerpt"), "{result}");
    }

    #[tokio::test]
    async fn reports_when_every_server_fails() {
        let failing = serve_once("503 Service Unavailable", "{}", |_request| {});
        let client = reqwest::Client::new();
        let error = try_targets(&client, &[target(&failing, "web_search_exa")], "tauri")
            .await
            .unwrap_err();
        assert!(error.contains("no provider responded"), "{error}");
    }

    #[tokio::test]
    async fn rejects_an_empty_query_before_sending() {
        assert!(query("   ").await.is_err());
        assert!(query(&"x".repeat(501)).await.is_err());
    }

    /// Network check, skipped by default so the suite stays offline. Run with
    /// `cargo test --lib live_search -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_search() {
        let text = query("tauri rust desktop framework").await.unwrap();
        eprintln!("LIVE: {}", text.chars().take(300).collect::<String>());
        assert!(text.len() > 50);
    }
}
