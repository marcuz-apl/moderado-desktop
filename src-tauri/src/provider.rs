use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub mod settings;

const NETWORK_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_STREAM_EVENT_BYTES: usize = 1024 * 1024;
const MAX_COMPLETION_BYTES: usize = 1024 * 1024;
const MAX_MODEL_LIST_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    Gateway,
    NvidiaNim,
    OpenRouter,
    AgnesAi,
    OrcaRouter,
    Ollama,
    LmStudio,
    Custom,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreset {
    pub id: ProviderId,
    pub name: &'static str,
    pub default_base_url: &'static str,
    pub editable_url: bool,
    pub local: bool,
}

pub const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        id: ProviderId::Gateway,
        name: "Moderado Gateway",
        default_base_url: "",
        editable_url: true,
        local: false,
    },
    ProviderPreset {
        id: ProviderId::NvidiaNim,
        name: "NVIDIA NIM",
        default_base_url: "https://integrate.api.nvidia.com/v1",
        editable_url: false,
        local: false,
    },
    ProviderPreset {
        id: ProviderId::OpenRouter,
        name: "OpenRouter",
        default_base_url: "https://openrouter.ai/api/v1",
        editable_url: false,
        local: false,
    },
    ProviderPreset {
        id: ProviderId::AgnesAi,
        name: "Agnes AI",
        default_base_url: "https://apihub.agnes-ai.com/v1",
        editable_url: false,
        local: false,
    },
    ProviderPreset {
        id: ProviderId::OrcaRouter,
        name: "OrcaRouter",
        default_base_url: "https://api.orcarouter.ai/v1",
        editable_url: false,
        local: false,
    },
    ProviderPreset {
        id: ProviderId::Ollama,
        name: "Ollama",
        default_base_url: "http://localhost:11434/v1",
        editable_url: false,
        local: true,
    },
    ProviderPreset {
        id: ProviderId::LmStudio,
        name: "LM Studio",
        default_base_url: "http://localhost:1234/v1",
        editable_url: false,
        local: true,
    },
    ProviderPreset {
        id: ProviderId::Custom,
        name: "Custom endpoint",
        default_base_url: "",
        editable_url: true,
        local: false,
    },
];

impl ProviderId {
    pub fn preset(self) -> &'static ProviderPreset {
        PRESETS
            .iter()
            .find(|preset| preset.id == self)
            .expect("Provider catalog is complete")
    }

    pub fn base_url(self, entered: &str) -> Result<String, String> {
        let preset = self.preset();
        let value = if preset.editable_url {
            entered.trim()
        } else {
            preset.default_base_url
        };
        completion_url(value)?;
        Ok(value.to_owned())
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, Default)]
pub struct Completion {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

impl Completion {
    pub fn push(&mut self, event: &Value) -> Result<Option<String>, String> {
        let Some(delta) = event
            .get("choices")
            .and_then(|value| value.get(0))
            .and_then(|value| value.get("delta"))
        else {
            return Ok(None);
        };
        let mut text = None;
        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            if self.content.len().saturating_add(content.len()) > MAX_COMPLETION_BYTES {
                return Err("Provider response exceeds 1 MiB".into());
            }
            self.content.push_str(content);
            text = Some(content.to_owned());
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let Some(index) = call.get("index").and_then(Value::as_u64) else {
                    continue;
                };
                if index > 32 {
                    continue;
                }
                while self.tool_calls.len() <= index as usize {
                    self.tool_calls.push(ToolCall::default());
                }
                let target = &mut self.tool_calls[index as usize];
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    if target.id.len().saturating_add(id.len()) > 200 {
                        return Err("Provider tool call ID is too long".into());
                    }
                    target.id.push_str(id);
                }
                if let Some(function) = call.get("function") {
                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                        if target.name.len().saturating_add(name.len()) > 200 {
                            return Err("Provider tool name is too long".into());
                        }
                        target.name.push_str(name);
                    }
                    if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                        if target.arguments.len().saturating_add(arguments.len())
                            > MAX_COMPLETION_BYTES
                        {
                            return Err("Provider tool arguments exceed 1 MiB".into());
                        }
                        target.arguments.push_str(arguments);
                    }
                }
            }
        }
        Ok(text)
    }
}

#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        loop {
            let lf = self
                .buffer
                .windows(2)
                .position(|part| part == b"\n\n")
                .map(|end| (end, 2));
            let crlf = self
                .buffer
                .windows(4)
                .position(|part| part == b"\r\n\r\n")
                .map(|end| (end, 4));
            let Some((end, separator)) = (match (lf, crlf) {
                (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                (None, None) => None,
            }) else {
                break;
            };
            if end > MAX_STREAM_EVENT_BYTES {
                return Err("Provider stream event exceeds 1 MiB".into());
            }
            let block = String::from_utf8_lossy(&self.buffer[..end]).into_owned();
            self.buffer.drain(..end + separator);
            let data = block
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim_start)
                .collect::<Vec<_>>()
                .join("\n");
            if !data.is_empty() {
                events.push(data);
            }
        }
        if self.buffer.len() > MAX_STREAM_EVENT_BYTES {
            return Err("Provider stream event exceeds 1 MiB".into());
        }
        Ok(events)
    }
}

pub fn completion_url(base: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|_| "Invalid provider URL")?;
    let local = url
        .host_str()
        .is_some_and(|host| host == "localhost" || host == "127.0.0.1" || host == "[::1]");
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("Provider URL must use HTTPS, except for localhost".into());
    }
    if url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Provider URL cannot contain credentials, query, or fragment".into());
    }
    let path = format!("{}/chat/completions", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

pub async fn list_models(base: &str, key: &str) -> Result<Vec<String>, String> {
    list_models_with_timeout(base, key, NETWORK_IDLE_TIMEOUT).await
}

async fn list_models_with_timeout(
    base: &str,
    key: &str,
    idle_timeout: Duration,
) -> Result<Vec<String>, String> {
    let mut url = completion_url(base)?;
    let path = url.path().trim_end_matches("/chat/completions").to_owned() + "/models";
    url.set_path(&path);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create provider client")?;
    let mut request = client.get(url);
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let response = tokio::time::timeout(idle_timeout, request.send())
        .await
        .map_err(|_| "Model list connection timed out")?
        .map_err(|error| format!("Model list connection failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Model list returned HTTP {}", response.status()));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = tokio::time::timeout(idle_timeout, stream.next())
        .await
        .map_err(|_| "Model list stalled")?
    {
        let chunk = chunk.map_err(|error| format!("Model list failed: {error}"))?;
        if bytes.len() + chunk.len() > MAX_MODEL_LIST_BYTES {
            return Err("Model list exceeds 4 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid model list response")?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Model list response has no data array")?;
    let mut models: Vec<String> = data
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .take(2000)
        .map(str::to_owned)
        .collect();
    models.sort();
    models.dedup();
    Ok(models)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalProviderStatus {
    pub id: ProviderId,
    pub available: bool,
}

pub async fn probe_local_providers() -> Vec<LocalProviderStatus> {
    let ollama = list_models_with_timeout(
        ProviderId::Ollama.preset().default_base_url,
        "",
        Duration::from_secs(2),
    );
    let lm_studio = list_models_with_timeout(
        ProviderId::LmStudio.preset().default_base_url,
        "",
        Duration::from_secs(2),
    );
    let (ollama, lm_studio) = tokio::join!(ollama, lm_studio);
    vec![
        LocalProviderStatus {
            id: ProviderId::Ollama,
            available: ollama.is_ok(),
        },
        LocalProviderStatus {
            id: ProviderId::LmStudio,
            available: lm_studio.is_ok(),
        },
    ]
}

pub async fn chat_completion(
    base: &str,
    model: &str,
    key: &str,
    messages: &[Value],
    tools: &[Value],
    on_text: impl FnMut(&str),
) -> Result<Completion, String> {
    chat_completion_with_timeout(
        base,
        model,
        key,
        messages,
        tools,
        NETWORK_IDLE_TIMEOUT,
        on_text,
    )
    .await
}

async fn chat_completion_with_timeout(
    base: &str,
    model: &str,
    key: &str,
    messages: &[Value],
    tools: &[Value],
    idle_timeout: Duration,
    mut on_text: impl FnMut(&str),
) -> Result<Completion, String> {
    let url = completion_url(base)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create provider client")?;
    let mut request = client.post(url).json(&json!({
        "model": model, "messages": messages, "tools": tools, "stream": true,
    }));
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let response = tokio::time::timeout(idle_timeout, request.send())
        .await
        .map_err(|_| "Provider connection timed out")?
        .map_err(|error| format!("Provider connection failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Provider returned HTTP {}", response.status()));
    }
    let mut stream = response.bytes_stream();
    let mut parser = SseParser::default();
    let mut result = Completion::default();
    let mut done = false;
    while let Some(chunk) = tokio::time::timeout(idle_timeout, stream.next())
        .await
        .map_err(|_| "Provider stream stalled")?
    {
        let bytes = chunk.map_err(|error| format!("Provider stream failed: {error}"))?;
        for event in parser.push(&bytes)? {
            if event == "[DONE]" {
                done = true;
                break;
            }
            let value: Value =
                serde_json::from_str(&event).map_err(|_| "Invalid provider stream event")?;
            if let Some(delta) = result.push(&value)? {
                on_text(&delta);
            }
        }
        if done {
            break;
        }
    }
    if !done {
        return Err("Provider stream ended before [DONE]".into());
    }
    if result.content.is_empty() && result.tool_calls.is_empty() {
        return Err("Provider returned an empty response".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn provider_catalog_resolves_supported_endpoints() {
        assert_eq!(PRESETS.len(), 8);
        for preset in PRESETS {
            let entered = if preset.editable_url {
                "https://example.test/v1"
            } else {
                "ignored"
            };
            let base = preset.id.base_url(entered).unwrap();
            assert_eq!(
                base,
                if preset.editable_url {
                    entered
                } else {
                    preset.default_base_url
                }
            );
            assert_eq!(
                completion_url(&base).unwrap().path(),
                format!(
                    "{}/chat/completions",
                    reqwest::Url::parse(&base)
                        .unwrap()
                        .path()
                        .trim_end_matches('/')
                )
            );
        }
        assert!(ProviderId::Custom
            .base_url("http://example.test/v1")
            .is_err());
        assert!(ProviderId::Gateway.base_url("").is_err());
    }

    #[test]
    fn parses_events_across_chunks() {
        let mut parser = SseParser::default();
        assert!(parser.push(b"data: {\"a\":").unwrap().is_empty());
        assert_eq!(
            parser.push(b"1}\n\ndata: [DONE]\n\n").unwrap(),
            vec!["{\"a\":1}", "[DONE]"]
        );
    }

    #[test]
    fn parses_crlf_and_split_utf8() {
        let mut parser = SseParser::default();
        let event = "data: {\"text\":\"é\"}\r\n\r\n".as_bytes();
        let split = event.iter().position(|byte| *byte == 0xc3).unwrap() + 1;
        assert!(parser.push(&event[..split]).unwrap().is_empty());
        assert_eq!(
            parser.push(&event[split..]).unwrap(),
            vec!["{\"text\":\"é\"}"]
        );
    }

    #[test]
    fn parses_mixed_newline_events_in_order() {
        let mut parser = SseParser::default();
        assert_eq!(
            parser.push(b"data: first\r\n\r\ndata: second\n\n").unwrap(),
            vec!["first", "second"]
        );
    }

    #[test]
    fn combines_tool_call_deltas() {
        let mut response = Completion::default();
        response.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]})).unwrap();
        response.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]}}]})).unwrap();
        assert_eq!(response.tool_calls[0].arguments, "{\"path\":\"a.txt\"}");
    }

    #[test]
    fn rejects_oversized_stream_event_and_completion() {
        let mut parser = SseParser::default();
        assert!(parser
            .push(&vec![b'x'; MAX_STREAM_EVENT_BYTES + 1])
            .unwrap_err()
            .contains("exceeds"));
        let mut completion = Completion::default();
        let event = json!({"choices":[{"delta":{"content":"x".repeat(MAX_COMPLETION_BYTES + 1)}}]});
        assert!(completion.push(&event).unwrap_err().contains("exceeds"));
    }

    #[tokio::test]
    async fn stalled_stream_returns_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            assert!(socket.read(&mut request).unwrap() > 0);
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
            std::thread::sleep(Duration::from_millis(100));
        });
        let result = chat_completion_with_timeout(
            &format!("http://127.0.0.1:{port}/v1"),
            "test-model",
            "",
            &[],
            &[],
            Duration::from_millis(20),
            |_| {},
        )
        .await;
        server.join().unwrap();
        assert!(result.unwrap_err().contains("stalled"));
    }

    #[test]
    fn rejects_insecure_remote_endpoint() {
        assert!(completion_url("http://example.com/v1").is_err());
        assert!(completion_url("http://localhost:11434/v1").is_ok());
        assert!(completion_url("https://example.com/v1").is_ok());
    }

    #[tokio::test]
    async fn discovers_models_from_gateway_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let count = socket.read(&mut request).unwrap();
            assert!(
                String::from_utf8_lossy(&request[..count]).starts_with("GET /v1/models HTTP/1.1")
            );
            let body = r#"{"data":[{"id":"model-b"},{"id":"model-a"}]}"#;
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        });
        let models = list_models(&format!("http://127.0.0.1:{port}/v1"), "")
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(models, vec!["model-a", "model-b"]);
    }

    #[tokio::test]
    async fn streams_from_local_mock_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let count = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
            let body =
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\ndata: [DONE]\n\n";
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        });
        let mut text = String::new();
        let result = chat_completion(
            &format!("http://127.0.0.1:{port}/v1"),
            "test-model",
            "",
            &[json!({"role":"user","content":"hi"})],
            &[],
            |delta| text.push_str(delta),
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(text, "Hello");
        assert_eq!(result.content, "Hello");
    }

    #[tokio::test]
    async fn does_not_follow_provider_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let count = socket.read(&mut request).unwrap();
            assert!(count > 0);
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/v1/chat/completions\r\nContent-Length: 0\r\n\r\n").unwrap();
        });
        let result = chat_completion(
            &format!("http://127.0.0.1:{port}/v1"),
            "model",
            "",
            &[],
            &[],
            |_| {},
        )
        .await;
        server.join().unwrap();
        assert!(result.unwrap_err().contains("HTTP 302"));
    }
}
