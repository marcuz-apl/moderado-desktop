//! Files the user attaches to a Work message.
//!
//! A Work session never browses the disk: the user picks files, they are
//! copied into the app-data attachments folder, and only that copy is ever
//! read. History stores a small reference block, which is expanded into text
//! or an image part just before the provider call so `history_json` never
//! carries base64.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_TEXT_BYTES: u64 = 256 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_PER_MESSAGE: usize = 10;
pub const MAX_MESSAGE_BYTES: u64 = 20 * 1024 * 1024;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Text,
    Image,
}

impl AttachmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRecord {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub kind: AttachmentKind,
    pub bytes: i64,
}

fn new_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{:x}{:04x}",
        now.as_millis(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed) % 0x1_0000
    )
}

fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn mime_for(name: &str) -> &'static str {
    match extension(name).as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    }
}

fn is_image_name(name: &str) -> bool {
    matches!(extension(name).as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif")
}

/// Keeps a user file name usable on disk without losing what it was called.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "attachment".into()
    } else {
        trimmed.chars().take(120).collect()
    }
}

pub fn file_path(root: &Path, session_id: &str, id: &str, name: &str) -> PathBuf {
    root.join(session_id).join(format!("{id}-{}", safe_name(name)))
}

/// Copies the chosen files and describes them. Nothing outside the returned
/// paths is read later, so a moved or deleted original cannot break the
/// conversation.
pub fn store(
    root: &Path,
    session_id: &str,
    sources: &[PathBuf],
) -> Result<Vec<AttachmentRecord>, String> {
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    if sources.len() > MAX_PER_MESSAGE {
        return Err(format!(
            "Attach at most {MAX_PER_MESSAGE} files per message"
        ));
    }
    let directory = root.join(session_id);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the attachments folder: {error}"))?;

    let mut total = 0u64;
    let mut records = Vec::with_capacity(sources.len());
    for source in sources {
        let name = source
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .ok_or_else(|| format!("{} has no file name", source.display()))?;
        let metadata = fs::metadata(source)
            .map_err(|error| format!("{name} could not be read: {error}"))?;
        if !metadata.is_file() {
            return Err(format!("{name} is not a file"));
        }
        let bytes = fs::read(source).map_err(|error| format!("{name} could not be read: {error}"))?;

        let kind = if is_image_name(&name) {
            if bytes.len() as u64 > MAX_IMAGE_BYTES {
                return Err(format!(
                    "{name} is larger than the {} MB image limit",
                    MAX_IMAGE_BYTES / (1024 * 1024)
                ));
            }
            AttachmentKind::Image
        } else {
            if bytes.len() as u64 > MAX_TEXT_BYTES {
                return Err(format!(
                    "{name} is larger than the {} KiB text limit",
                    MAX_TEXT_BYTES / 1024
                ));
            }
            if std::str::from_utf8(&bytes).is_err() || bytes.contains(&0) {
                return Err(format!(
                    "{name} is neither a text file nor a supported image"
                ));
            }
            AttachmentKind::Text
        };

        total += bytes.len() as u64;
        if total > MAX_MESSAGE_BYTES {
            return Err(format!(
                "Attachments exceed the {} MB per-message limit",
                MAX_MESSAGE_BYTES / (1024 * 1024)
            ));
        }

        let id = new_id();
        let path = file_path(root, session_id, &id, &name);
        fs::write(&path, &bytes).map_err(|error| format!("{name} could not be copied: {error}"))?;
        records.push(AttachmentRecord {
            id,
            session_id: session_id.to_owned(),
            name: safe_name(&name),
            kind,
            bytes: bytes.len() as i64,
        });
    }
    Ok(records)
}

/// The block stored in history. It is a reference, not the file.
pub fn reference(record: &AttachmentRecord) -> Value {
    json!({
        "type": "attachment",
        "id": record.id,
        "name": record.name,
        "kind": record.kind.as_str(),
    })
}

/// Turns every stored attachment reference in a history into what the provider
/// expects, leaving other messages untouched.
pub fn expand_history(root: &Path, session_id: &str, history: &[Value]) -> Vec<Value> {
    history
        .iter()
        .map(|message| {
            let Some(blocks) = message.get("content").and_then(Value::as_array) else {
                return message.clone();
            };
            let mut expanded: Vec<Value> = Vec::with_capacity(blocks.len());
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("attachment") {
                    expanded.push(expand_block(root, session_id, block));
                } else {
                    expanded.push(block.clone());
                }
            }
            let mut message = message.clone();
            message["content"] = Value::Array(expanded);
            message
        })
        .collect()
}

fn expand_block(root: &Path, session_id: &str, block: &Value) -> Value {
    let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
    let name = block
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("attachment");
    let path = file_path(root, session_id, id, name);
    let Ok(bytes) = fs::read(&path) else {
        // A deleted copy must not fail the turn.
        return json!({
            "type": "text",
            "text": format!("[{name} is no longer available]"),
        });
    };
    if block.get("kind").and_then(Value::as_str) == Some("image") {
        json!({
            "type": "image_url",
            "image_url": { "url": format!("data:{};base64,{}", mime_for(name), base64(&bytes)) },
        })
    } else {
        json!({
            "type": "text",
            "text": format!("File: {name}\n{}", String::from_utf8_lossy(&bytes)),
        })
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let value = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(value >> 18) as usize & 63] as char);
        out.push(ALPHABET[(value >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(value >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[value as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn stores_a_text_file_and_references_it() {
        let root = workspace();
        let source = root.path().join("notes.md");
        fs::write(&source, "hello").unwrap();
        let attachments_root = root.path().join("attachments");
        let records = store(&attachments_root, "s1", &[source]).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, AttachmentKind::Text);
        assert_eq!(records[0].bytes, 5);
        assert!(file_path(&attachments_root, "s1", &records[0].id, "notes.md").exists());
        assert_eq!(reference(&records[0])["type"], "attachment");
    }

    #[test]
    fn rejects_oversized_text_and_binary_files() {
        let root = workspace();
        let attachments_root = root.path().join("attachments");
        let big = root.path().join("big.txt");
        fs::write(&big, vec![b'a'; MAX_TEXT_BYTES as usize + 1]).unwrap();
        assert!(store(&attachments_root, "s1", &[big])
            .unwrap_err()
            .contains("text limit"));

        let binary = root.path().join("app.bin");
        fs::write(&binary, [0u8, 159, 146, 150]).unwrap();
        assert!(store(&attachments_root, "s1", &[binary])
            .unwrap_err()
            .contains("neither a text file"));
    }

    #[test]
    fn expansion_produces_text_and_image_parts() {
        let root = workspace();
        let attachments_root = root.path().join("attachments");
        let text = root.path().join("a.txt");
        fs::write(&text, "body").unwrap();
        let image = root.path().join("b.png");
        fs::write(&image, [0x89u8, 0x50, 0x4e, 0x47]).unwrap();
        let records = store(&attachments_root, "s1", &[text, image]).unwrap();

        let history = vec![json!({
            "role": "user",
            "content": [
                {"type": "text", "text": "look"},
                reference(&records[0]),
                reference(&records[1]),
            ],
        })];
        let expanded = expand_history(&attachments_root, "s1", &history);
        let blocks = expanded[0]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["text"], "look");
        assert!(blocks[1]["text"].as_str().unwrap().contains("body"));
        assert_eq!(blocks[2]["type"], "image_url");
        assert!(blocks[2]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn a_missing_copy_degrades_to_a_note() {
        let root = workspace();
        let attachments_root = root.path().join("attachments");
        let source = root.path().join("gone.txt");
        fs::write(&source, "x").unwrap();
        let records = store(&attachments_root, "s1", &[source]).unwrap();
        fs::remove_file(file_path(&attachments_root, "s1", &records[0].id, "gone.txt")).unwrap();

        let history = vec![json!({"role":"user","content":[reference(&records[0])]})];
        let expanded = expand_history(&attachments_root, "s1", &history);
        assert!(expanded[0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("no longer available"));
    }

    #[test]
    fn plain_messages_are_left_alone() {
        let root = workspace();
        let history = vec![json!({"role":"user","content":"hi"})];
        assert_eq!(expand_history(root.path(), "s1", &history), history);
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
