use crate::provider::ToolCall;
use crate::workspace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::path::Path;

pub mod runner;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Plan,
    Act,
}

#[derive(Clone, Debug, Serialize)]
pub struct Approval {
    pub path: String,
    pub before: String,
    pub after: String,
}

pub fn tool_definitions(mode: Mode) -> Vec<Value> {
    let mut tools = vec![
        json!({"type":"function","function":{"name":"list_files","description":"List direct children of a workspace directory","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Relative directory path"}},"required":["path"]}}}),
        json!({"type":"function","function":{"name":"read_file","description":"Read a UTF-8 file in the workspace","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Relative file path"}},"required":["path"]}}}),
        json!({"type":"function","function":{"name":"search_files","description":"Search UTF-8 workspace files for a literal text query","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}),
    ];
    if matches!(mode, Mode::Act) {
        tools.push(json!({"type":"function","function":{"name":"write_file","description":"Create or replace a UTF-8 file after user approval","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Relative file path"},"content":{"type":"string"}},"required":["path","content"]}}}));
        tools.push(json!({"type":"function","function":{"name":"edit_file","description":"Replace one unique text span in a UTF-8 file after user approval","parameters":{"type":"object","properties":{"path":{"type":"string"},"old_text":{"type":"string"},"new_text":{"type":"string"}},"required":["path","old_text","new_text"]}}}));
    }
    tools
}

pub async fn dispatch_tool<F, Fut>(
    root: &Path,
    mode: Mode,
    call: &ToolCall,
    approve: F,
) -> Result<String, String>
where
    F: FnOnce(Approval) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    dispatch_tool_with_checkpoint(root, mode, call, approve, |_| Ok(())).await
}

pub async fn dispatch_tool_with_checkpoint<F, Fut, C>(
    root: &Path,
    mode: Mode,
    call: &ToolCall,
    approve: F,
    checkpoint: C,
) -> Result<String, String>
where
    F: FnOnce(Approval) -> Fut,
    Fut: Future<Output = Option<String>>,
    C: FnOnce(&Approval) -> Result<(), String>,
{
    if matches!(call.name.as_str(), "write_file" | "edit_file") && matches!(mode, Mode::Plan) {
        return Err("Plan mode blocks file writes".into());
    }
    let args: Value =
        serde_json::from_str(&call.arguments).map_err(|_| "Invalid tool arguments")?;
    if call.name == "search_files" {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .ok_or("Search query is required")?;
        return Ok(workspace::search_files(root, query)?.join("\n"));
    }
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("Tool path is required")?;
    if path.len() > 4096 {
        return Err("Tool path is too long".into());
    }
    match call.name.as_str() {
        "list_files" => Ok(workspace::list_files(root, path)?.join("\n")),
        "read_file" => workspace::read_text(root, path),
        "write_file" => {
            let content = args
                .get("content")
                .and_then(Value::as_str)
                .ok_or("File content is required")?;
            let original = workspace::read_optional(root, path)?;
            let before = original.clone().unwrap_or_default();
            let preview = Approval {
                path: path.into(),
                before,
                after: content.into(),
            };
            let approved_content = approve(preview.clone())
                .await
                .ok_or("File write rejected by user")?;
            if workspace::read_optional(root, path)? != original {
                return Err("File changed while awaiting approval".into());
            }
            checkpoint(&preview)?;
            workspace::write_text(root, path, &approved_content)?;
            Ok(if approved_content == content {
                format!("Wrote {path}")
            } else {
                format!("Wrote {path} with user-edited content")
            })
        }
        "edit_file" => {
            let old_text = args
                .get("old_text")
                .and_then(Value::as_str)
                .ok_or("old_text is required")?;
            let new_text = args
                .get("new_text")
                .and_then(Value::as_str)
                .ok_or("new_text is required")?;
            if old_text.is_empty() {
                return Err("old_text cannot be empty".into());
            }
            let before = workspace::read_text(root, path)?;
            if before.matches(old_text).count() != 1 {
                return Err("old_text must appear exactly once".into());
            }
            let after = before.replacen(old_text, new_text, 1);
            let preview = Approval {
                path: path.into(),
                before: before.clone(),
                after: after.clone(),
            };
            let approved_content = approve(preview.clone())
                .await
                .ok_or("File edit rejected by user")?;
            if workspace::read_text(root, path)? != before {
                return Err("File changed while awaiting approval".into());
            }
            checkpoint(&preview)?;
            workspace::write_text(root, path, &approved_content)?;
            Ok(if approved_content == after {
                format!("Edited {path}")
            } else {
                format!("Edited {path} with user-edited content")
            })
        }
        _ => Err(format!("Unknown tool: {}", call.name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn plan_mode_rejects_write_before_approval() {
        let root = tempfile::tempdir().unwrap();
        let call = ToolCall {
            id: "1".into(),
            name: "write_file".into(),
            arguments: r#"{"path":"a.txt","content":"new"}"#.into(),
        };
        let result = dispatch_tool(root.path(), Mode::Plan, &call, |_| async {
            panic!("approval must not be requested")
        })
        .await;
        assert!(result.unwrap_err().contains("Plan mode"));
    }

    #[tokio::test]
    async fn rejected_write_keeps_old_content() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "old").unwrap();
        let call = ToolCall {
            id: "1".into(),
            name: "write_file".into(),
            arguments: r#"{"path":"a.txt","content":"new"}"#.into(),
        };
        let result = dispatch_tool(root.path(), Mode::Act, &call, |preview| async move {
            assert_eq!(preview.before, "old");
            assert_eq!(preview.after, "new");
            None
        })
        .await;
        assert!(result.unwrap_err().contains("rejected"));
        assert_eq!(
            fs::read_to_string(root.path().join("a.txt")).unwrap(),
            "old"
        );
    }

    #[tokio::test]
    async fn approved_write_creates_file() {
        let root = tempfile::tempdir().unwrap();
        let call = ToolCall {
            id: "1".into(),
            name: "write_file".into(),
            arguments: r#"{"path":"src/a.txt","content":"new"}"#.into(),
        };
        dispatch_tool(root.path(), Mode::Act, &call, |_| async {
            Some("new".into())
        })
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("src/a.txt")).unwrap(),
            "new"
        );
    }

    #[tokio::test]
    async fn edited_approval_writes_reviewed_content() {
        let root = tempfile::tempdir().unwrap();
        let call = ToolCall {
            id: "1".into(),
            name: "write_file".into(),
            arguments: r#"{"path":"a.txt","content":"draft"}"#.into(),
        };
        dispatch_tool(root.path(), Mode::Act, &call, |_| async {
            Some("reviewed".into())
        })
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("a.txt")).unwrap(),
            "reviewed"
        );
    }

    #[tokio::test]
    async fn write_rejects_external_change_during_approval() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a.txt");
        fs::write(&path, "before").unwrap();
        let call = ToolCall {
            id: "1".into(),
            name: "write_file".into(),
            arguments: r#"{"path":"a.txt","content":"proposal"}"#.into(),
        };
        let result = dispatch_tool(root.path(), Mode::Act, &call, |_| async {
            fs::write(&path, "external change").unwrap();
            Some("proposal".into())
        })
        .await;
        assert!(result
            .unwrap_err()
            .contains("changed while awaiting approval"));
        assert_eq!(fs::read_to_string(path).unwrap(), "external change");
    }

    #[tokio::test]
    async fn edit_file_replaces_only_the_unique_match_after_approval() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "before needle after").unwrap();
        let call = ToolCall {
            id: "1".into(),
            name: "edit_file".into(),
            arguments: r#"{"path":"a.txt","old_text":"needle","new_text":"thread"}"#.into(),
        };
        dispatch_tool(root.path(), Mode::Act, &call, |preview| async move {
            assert_eq!(preview.after, "before thread after");
            Some(preview.after)
        })
        .await
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("a.txt")).unwrap(),
            "before thread after"
        );
    }

    #[tokio::test]
    async fn plan_mode_blocks_edit_file_before_approval() {
        let root = tempfile::tempdir().unwrap();
        let call = ToolCall {
            id: "1".into(),
            name: "edit_file".into(),
            arguments: "{}".into(),
        };
        let result = dispatch_tool(root.path(), Mode::Plan, &call, |_| async {
            panic!("approval must not be requested")
        })
        .await;
        assert!(result.unwrap_err().contains("Plan mode"));
    }

    #[tokio::test]
    async fn invalid_tool_reports_error() {
        let root = tempfile::tempdir().unwrap();
        let call = ToolCall {
            id: "1".into(),
            name: "run_command".into(),
            arguments: "{}".into(),
        };
        assert!(dispatch_tool(root.path(), Mode::Act, &call, |_| async {
            Some(String::new())
        })
        .await
        .is_err());
    }
}
