use crate::provider::ToolCall;
use crate::workspace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::path::Path;

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
    ];
    if matches!(mode, Mode::Act) {
        tools.push(json!({"type":"function","function":{"name":"write_file","description":"Create or replace a UTF-8 file after user approval","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Relative file path"},"content":{"type":"string"}},"required":["path","content"]}}}));
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
    Fut: Future<Output = bool>,
{
    if call.name == "write_file" && matches!(mode, Mode::Plan) {
        return Err("Plan mode blocks file writes".into());
    }
    let args: Value =
        serde_json::from_str(&call.arguments).map_err(|_| "Invalid tool arguments")?;
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
            let before = workspace::read_optional(root, path)?.unwrap_or_default();
            let preview = Approval {
                path: path.into(),
                before,
                after: content.into(),
            };
            if !approve(preview).await {
                return Err("File write rejected by user".into());
            }
            workspace::write_text(root, path, content)?;
            Ok(format!("Wrote {path}"))
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
            false
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
        dispatch_tool(root.path(), Mode::Act, &call, |_| async { true })
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("src/a.txt")).unwrap(),
            "new"
        );
    }

    #[tokio::test]
    async fn invalid_tool_reports_error() {
        let root = tempfile::tempdir().unwrap();
        let call = ToolCall {
            id: "1".into(),
            name: "run_command".into(),
            arguments: "{}".into(),
        };
        assert!(
            dispatch_tool(root.path(), Mode::Act, &call, |_| async { true })
                .await
                .is_err()
        );
    }
}
