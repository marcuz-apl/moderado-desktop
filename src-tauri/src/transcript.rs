use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptFormat {
    Codex,
    ClaudeCode,
}

pub fn parse_jsonl(source: &str, format: TranscriptFormat) -> Result<Vec<Value>, String> {
    if source.len() > 8 * 1024 * 1024 {
        return Err("Transcript exceeds 8 MiB".into());
    }
    let mut history = Vec::new();
    let mut seen = HashSet::new();
    for (index, line) in source.lines().enumerate() {
        if index >= 20_000 {
            return Err("Transcript exceeds 20,000 lines".into());
        }
        if line.trim().is_empty() {
            continue;
        }
        let item: Value = serde_json::from_str(line)
            .map_err(|_| format!("Invalid JSON on transcript line {}", index + 1))?;
        let message = match format {
            TranscriptFormat::Codex => codex_message(&item),
            TranscriptFormat::ClaudeCode => claude_message(&item, &mut seen),
        };
        if let Some((role, text)) = message {
            if history.len() >= 2_000 {
                return Err("Transcript exceeds 2,000 text messages".into());
            }
            history.push(json!({"role":role,"content":text}));
        }
    }
    if history.is_empty() {
        return Err("Transcript contains no supported text messages".into());
    }
    Ok(history)
}

fn codex_message(item: &Value) -> Option<(&'static str, String)> {
    if item.get("type")?.as_str()? != "response_item" {
        return None;
    }
    let payload = item.get("payload")?;
    if payload.get("type")?.as_str()? != "message" {
        return None;
    }
    let role = match payload.get("role")?.as_str()? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    text_blocks(payload.get("content")?, &["input_text", "output_text"]).map(|text| (role, text))
}

fn claude_message(item: &Value, seen: &mut HashSet<String>) -> Option<(&'static str, String)> {
    if item.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || item.get("isMeta").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let role = match item.get("type")?.as_str()? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    let message = item.get("message")?;
    let text = match message.get("content")? {
        Value::String(text) if !text.trim().is_empty() => text.clone(),
        blocks => text_blocks(blocks, &["text"])?,
    };
    if let Some(id) = item.get("uuid").and_then(Value::as_str) {
        if !seen.insert(id.to_owned()) {
            return None;
        }
    }
    Some((role, text))
}

fn text_blocks(value: &Value, accepted: &[&str]) -> Option<String> {
    let blocks = value.as_array()?;
    let text = blocks
        .iter()
        .filter_map(|block| {
            if accepted.contains(&block.get("type")?.as_str()?) {
                block.get("text")?.as_str()
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_codex_text_without_tool_or_reasoning_payloads() {
        let source = concat!(
            "{\"type\":\"session_meta\",\"payload\":{}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Hello\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\",\"content\":[{\"text\":\"hidden\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hi\"}]}}\n"
        );
        let history = parse_jsonl(source, TranscriptFormat::Codex).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["content"], "Hello");
        assert_eq!(history[1]["content"], "Hi");
    }

    #[test]
    fn imports_claude_text_and_skips_tools_sidechains_and_duplicates() {
        let source = concat!(
            "{\"type\":\"user\",\"uuid\":\"1\",\"message\":{\"content\":\"Do it\"}}\n",
            "{\"type\":\"assistant\",\"uuid\":\"2\",\"message\":{\"content\":[{\"type\":\"thinking\",\"thinking\":\"private\"},{\"type\":\"text\",\"text\":\"Done\"},{\"type\":\"tool_use\",\"name\":\"Bash\"}]}}\n",
            "{\"type\":\"assistant\",\"uuid\":\"2\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Done\"}]}}\n",
            "{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"content\":\"ignore\"}}\n"
        );
        let history = parse_jsonl(source, TranscriptFormat::ClaudeCode).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1]["content"], "Done");
    }
}
