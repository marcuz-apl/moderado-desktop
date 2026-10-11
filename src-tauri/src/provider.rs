use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};

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
    pub fn push(&mut self, event: &Value) -> Option<String> {
        let delta = event.get("choices")?.get(0)?.get("delta")?;
        let mut text = None;
        if let Some(content) = delta.get("content").and_then(Value::as_str) {
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
                    target.id.push_str(id);
                }
                if let Some(function) = call.get("function") {
                    if let Some(name) = function.get("name").and_then(Value::as_str) {
                        target.name.push_str(name);
                    }
                    if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                        target.arguments.push_str(arguments);
                    }
                }
            }
        }
        text
    }
}

#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
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
        events
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

pub async fn chat_completion(
    base: &str,
    model: &str,
    key: &str,
    messages: &[Value],
    tools: &[Value],
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
    let response = request
        .send()
        .await
        .map_err(|error| format!("Provider connection failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Provider returned HTTP {}", response.status()));
    }
    let mut stream = response.bytes_stream();
    let mut parser = SseParser::default();
    let mut result = Completion::default();
    let mut done = false;
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|error| format!("Provider stream failed: {error}"))?;
        for event in parser.push(&bytes) {
            if event == "[DONE]" {
                done = true;
                break;
            }
            let value: Value =
                serde_json::from_str(&event).map_err(|_| "Invalid provider stream event")?;
            if let Some(delta) = result.push(&value) {
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
    fn parses_events_across_chunks() {
        let mut parser = SseParser::default();
        assert!(parser.push(b"data: {\"a\":").is_empty());
        assert_eq!(
            parser.push(b"1}\n\ndata: [DONE]\n\n"),
            vec!["{\"a\":1}", "[DONE]"]
        );
    }

    #[test]
    fn parses_crlf_and_split_utf8() {
        let mut parser = SseParser::default();
        let event = "data: {\"text\":\"é\"}\r\n\r\n".as_bytes();
        let split = event.iter().position(|byte| *byte == 0xc3).unwrap() + 1;
        assert!(parser.push(&event[..split]).is_empty());
        assert_eq!(parser.push(&event[split..]), vec!["{\"text\":\"é\"}"]);
    }

    #[test]
    fn parses_mixed_newline_events_in_order() {
        let mut parser = SseParser::default();
        assert_eq!(
            parser.push(b"data: first\r\n\r\ndata: second\n\n"),
            vec!["first", "second"]
        );
    }

    #[test]
    fn combines_tool_call_deltas() {
        let mut response = Completion::default();
        response.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}));
        response.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]}}]}));
        assert_eq!(response.tool_calls[0].arguments, "{\"path\":\"a.txt\"}");
    }

    #[test]
    fn rejects_insecure_remote_endpoint() {
        assert!(completion_url("http://example.com/v1").is_err());
        assert!(completion_url("http://localhost:11434/v1").is_ok());
        assert!(completion_url("https://example.com/v1").is_ok());
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
