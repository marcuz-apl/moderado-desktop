use crate::provider::ToolCall;
use crate::sessions::SessionKind;
use crate::approval_policy::{ApprovalCategory, AutoApprovePolicy};
use crate::workspace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::path::Path;

pub mod runner;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
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

pub fn tool_definitions(kind: SessionKind, mode: Mode, web_search: bool) -> Vec<Value> {
    tool_definitions_with_mcp(kind, mode, web_search, &[])
}

/// The built-in tools plus any MCP tools the caller discovered for this turn.
/// MCP tools are only ever passed in for Code/Act sessions.
pub fn tool_definitions_with_mcp(
    kind: SessionKind,
    mode: Mode,
    web_search: bool,
    mcp_tools: &[Value],
) -> Vec<Value> {
    let mut tools = vec![
        json!({"type":"function","function":{"name":"list_files","description":"List direct children of a workspace directory","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Relative directory path"}},"required":["path"]}}}),
        json!({"type":"function","function":{"name":"read_file","description":"Read a UTF-8 file in the workspace","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Relative file path"}},"required":["path"]}}}),
        json!({"type":"function","function":{"name":"search_files","description":"Search UTF-8 workspace files for a literal text query","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}),
        ];
    if web_search {
        tools.push(json!({"type":"function","function":{"name":"web_search","description":"Search the configured web search API","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}));
    }
    if matches!(mode, Mode::Act) {
        tools.push(json!({"type":"function","function":{"name":"write_file","description":"Create or replace a UTF-8 file after user approval","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Relative file path"},"content":{"type":"string"}},"required":["path","content"]}}}));
        tools.push(json!({"type":"function","function":{"name":"edit_file","description":"Replace one unique text span in a UTF-8 file after user approval","parameters":{"type":"object","properties":{"path":{"type":"string"},"old_text":{"type":"string"},"new_text":{"type":"string"}},"required":["path","old_text","new_text"]}}}));
        #[cfg(windows)]
        if matches!(kind, SessionKind::Code) {
        tools.push(json!({"type":"function","function":{"name":"execute_command","description":"Run one executable with separate arguments in a Windows AppContainer workspace copy. No shell is invoked implicitly.","parameters":{"type":"object","properties":{"program":{"type":"string","description":"Executable name or absolute path"},"args":{"type":"array","items":{"type":"string"}},"working_directory":{"type":"string","description":"Workspace-relative directory"},"timeout_ms":{"type":"integer","minimum":100,"maximum":600000}},"required":["program"]}}}));
        }
    }
    #[cfg(not(windows))]
    let _ = kind;
    tools.extend(mcp_tools.iter().cloned());
    tools
}

pub fn tool_category(name: &str) -> Option<ApprovalCategory> {
    match name {
        "list_files" | "read_file" | "search_files" => Some(ApprovalCategory::ReadFiles),
        "write_file" | "edit_file" => Some(ApprovalCategory::EditFiles),
        "web_search" => Some(ApprovalCategory::FetchWebContent),
        "execute_command" => Some(ApprovalCategory::ExecuteCommand),
        name if name.starts_with("mcp__") => Some(ApprovalCategory::UseMcpServers),
        _ => None,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub category: ApprovalCategory,
    pub title: String,
    pub detail: String,
    pub preview: Option<Approval>,
}

pub async fn dispatch_tool<F, Fut>(
    root: &Path,
    kind: SessionKind,
    mode: Mode,
    call: &ToolCall,
    approve: F,
) -> Result<String, String>
where
    F: FnOnce(Approval) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    dispatch_tool_with_checkpoint(root, kind, mode, call, approve, |_| Ok(())).await
}

pub async fn dispatch_tool_with_checkpoint<F, Fut, C>(
    root: &Path,
    kind: SessionKind,
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
    dispatch_tool_with_policy(root, kind, mode, &AutoApprovePolicy::prompt_all(), call, move |request| {
        approve(request.preview.unwrap_or(Approval { path: request.detail, before: String::new(), after: String::new() }))
    }, checkpoint).await
}

pub async fn dispatch_tool_with_policy<F, Fut, C>(
    root: &Path,
    kind: SessionKind,
    mode: Mode,
    policy: &AutoApprovePolicy,
    call: &ToolCall,
    approve: F,
    checkpoint: C,
) -> Result<String, String>
where
    F: FnOnce(ApprovalRequest) -> Fut,
    Fut: Future<Output = Option<String>>,
    C: FnOnce(&Approval) -> Result<(), String>,
{
    if matches!(kind, SessionKind::Work) && call.name == "execute_command" {
        return Err("Work tasks cannot execute commands".into());
    }
    if matches!(call.name.as_str(), "write_file" | "edit_file") && matches!(mode, Mode::Plan) {
        return Err("Plan mode blocks file writes".into());
    }
    if call.name == "execute_command" && matches!(mode, Mode::Plan) {
        return Err("Plan mode blocks command execution".into());
    }
    let args: Value =
        serde_json::from_str(&call.arguments).map_err(|_| "Invalid tool arguments")?;
    if call.name == "execute_command" {
        let request: crate::command::CommandRequest = serde_json::from_value(args).map_err(|_| "Invalid command request")?;
        if !policy.allows(ApprovalCategory::ExecuteCommand) {
            let arguments = serde_json::to_string(&request.args).map_err(|error| error.to_string())?;
            approve(ApprovalRequest { category: ApprovalCategory::ExecuteCommand, title: "Execute command".into(), detail: format!("Program: {}\nArguments: {arguments}\nWorking directory: {}", request.program, if request.working_directory.is_empty() { "." } else { &request.working_directory }), preview: None }).await.ok_or("Command execution rejected by user")?;
        }
        checkpoint(&Approval { path: ".".into(), before: String::new(), after: String::new() })?;
        let result = crate::command::execute_sandboxed(root, request).await?;
        return serde_json::to_string(&result).map_err(|error| error.to_string());
    }
    if call.name == "search_files" {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .ok_or("Search query is required")?;
        if !policy.allows(ApprovalCategory::ReadFiles) {
            approve(ApprovalRequest { category: ApprovalCategory::ReadFiles, title: "Read workspace files".into(), detail: format!("Search workspace files for: {query}"), preview: None }).await.ok_or("File search rejected by user")?;
        }
        return Ok(workspace::search_files(root, query)?.join("\n"));
    }
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("Tool path is required")?;
    if path.len() > 4096 {
        return Err("Tool path is too long".into());
    }
    workspace::resolve_path(root, path)?;
    match call.name.as_str() {
        "list_files" => {
            if !policy.allows(ApprovalCategory::ReadFiles) { approve(ApprovalRequest { category: ApprovalCategory::ReadFiles, title: "List workspace files".into(), detail: format!("List folder: {path}"), preview: None }).await.ok_or("File listing rejected by user")?; }
            Ok(workspace::list_files(root, path)?.join("\n"))
        },
        "read_file" => {
            if !policy.allows(ApprovalCategory::ReadFiles) { approve(ApprovalRequest { category: ApprovalCategory::ReadFiles, title: "Read workspace file".into(), detail: format!("Read file: {path}"), preview: None }).await.ok_or("File read rejected by user")?; }
            workspace::read_text(root, path)
        },
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
            let approved_content = if policy.allows(ApprovalCategory::EditFiles) { content.to_owned() } else { approve(ApprovalRequest { category: ApprovalCategory::EditFiles, title: "Write workspace file".into(), detail: format!("Write file: {path}"), preview: Some(preview.clone()) }).await.ok_or("File write rejected by user")? };
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
            let approved_content = if policy.allows(ApprovalCategory::EditFiles) { after.clone() } else { approve(ApprovalRequest { category: ApprovalCategory::EditFiles, title: "Edit workspace file".into(), detail: format!("Edit file: {path}"), preview: Some(preview.clone()) }).await.ok_or("File edit rejected by user")? };
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
    async fn unchecked_read_permission_requests_approval_before_reading() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("secret.txt"), "secret").unwrap();
        let call = ToolCall { id: "r1".into(), name: "read_file".into(), arguments: r#"{"path":"secret.txt"}"#.into() };
        let mut policy = AutoApprovePolicy::for_new_session(SessionKind::Code);
        policy.read_files = false;
        let requested = std::sync::atomic::AtomicBool::new(false);
        let result = dispatch_tool_with_policy(root.path(), SessionKind::Code, Mode::Act, &policy, &call, |_| { requested.store(true, std::sync::atomic::Ordering::Relaxed); async { Some(String::new()) } }, |_| Ok(())).await;
        assert!(result.is_ok());
        assert!(requested.load(std::sync::atomic::Ordering::Relaxed), "unchecked reads must wait for a user decision");
    }

    #[test]
    fn mcp_tools_are_appended_to_the_tool_list() {
        let mcp = vec![json!({"type":"function","function":{"name":"mcp__srv__echo","description":"Echo","parameters":{"type":"object"}}})];
        let tools = tool_definitions_with_mcp(SessionKind::Code, Mode::Act, false, &mcp);
        assert!(tools
            .iter()
            .any(|tool| tool["function"]["name"] == "mcp__srv__echo"));
        assert!(tools
            .iter()
            .any(|tool| tool["function"]["name"] == "read_file"));
    }

    #[test]
    fn web_search_is_advertised_only_when_configured() {
        let has_search = |enabled| {
            tool_definitions(SessionKind::Code, Mode::Plan, enabled)
                .iter()
                .any(|tool| tool["function"]["name"] == "web_search")
        };
        assert!(!has_search(false));
        assert!(has_search(true));
    }

    #[test]
    #[cfg(windows)]
    fn command_tool_is_available_only_in_code_act_mode() {
        let has_command = |kind, mode| tool_definitions(kind, mode, false).iter().any(|tool| tool["function"]["name"] == "execute_command");
        assert!(has_command(SessionKind::Code, Mode::Act));
        assert!(!has_command(SessionKind::Code, Mode::Plan));
        assert!(!has_command(SessionKind::Work, Mode::Act));
    }

    #[tokio::test]
    async fn plan_mode_blocks_command_before_approval() {
        let root = tempfile::tempdir().unwrap();
        let call = ToolCall { id: "c1".into(), name: "execute_command".into(), arguments: r#"{"program":"cmd.exe"}"#.into() };
        let requested = std::sync::atomic::AtomicBool::new(false);
        let result = dispatch_tool_with_policy(root.path(), SessionKind::Code, Mode::Plan, &AutoApprovePolicy::for_new_session(SessionKind::Code), &call, |_| { requested.store(true, std::sync::atomic::Ordering::Relaxed); async { Some("ok".into()) } }, |_| Ok(())).await;
        assert!(result.unwrap_err().contains("Plan mode"));
        assert!(!requested.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn act_dispatch_runs_approved_command_and_checkpoints_first() {
        let root = tempfile::tempdir().unwrap();
        let call = ToolCall { id: "c2".into(), name: "execute_command".into(), arguments: r#"{"program":"cmd.exe","args":["/c","echo done>result.txt"]}"#.into() };
        let policy = AutoApprovePolicy::for_new_session(SessionKind::Code);
        let checkpointed = std::sync::atomic::AtomicBool::new(false);
        let result = dispatch_tool_with_policy(root.path(), SessionKind::Code, Mode::Act, &policy, &call, |_| async { panic!("auto-approved command must not ask") }, |_| { checkpointed.store(true, std::sync::atomic::Ordering::Relaxed); Ok(()) }).await.unwrap();
        assert!(checkpointed.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(fs::read_to_string(root.path().join("result.txt")).unwrap().trim(), "done");
        let result: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["exitCode"], 0);
    }

    #[tokio::test]
    async fn plan_mode_rejects_write_before_approval() {
        let root = tempfile::tempdir().unwrap();
        let call = ToolCall {
            id: "1".into(),
            name: "write_file".into(),
            arguments: r#"{"path":"a.txt","content":"new"}"#.into(),
        };
        let result = dispatch_tool(root.path(), SessionKind::Code, Mode::Plan, &call, |_| async {
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
        let result = dispatch_tool(root.path(), SessionKind::Code, Mode::Act, &call, |preview| async move {
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
        dispatch_tool(root.path(), SessionKind::Code, Mode::Act, &call, |_| async {
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
        dispatch_tool(root.path(), SessionKind::Code, Mode::Act, &call, |_| async {
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
        let result = dispatch_tool(root.path(), SessionKind::Code, Mode::Act, &call, |_| async {
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
        dispatch_tool(root.path(), SessionKind::Code, Mode::Act, &call, |preview| async move {
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
        let result = dispatch_tool(root.path(), SessionKind::Code, Mode::Plan, &call, |_| async {
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
        assert!(dispatch_tool(root.path(), SessionKind::Code, Mode::Act, &call, |_| async {
            Some(String::new())
        })
        .await
        .is_err());
    }

    #[test]
    fn work_tasks_get_document_tools_without_command_execution() {
        let names: Vec<String> = tool_definitions(SessionKind::Work, Mode::Act, true)
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap().to_owned())
            .collect();
        for name in ["read_file", "list_files", "search_files", "write_file", "edit_file", "web_search"] { assert!(names.iter().any(|item| item == name), "{name}"); }
        assert!(!names.iter().any(|item| item == "execute_command"));
    }

    #[tokio::test]
    async fn work_tasks_edit_only_inside_their_folder_and_reject_commands() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.txt"), "hello").unwrap();
        for (name, arguments) in [
            ("read_file", r#"{"path":"a.txt"}"#),
            ("list_files", r#"{"path":"."}"#),
            ("search_files", r#"{"query":"hello"}"#),
            ("write_file", r#"{"path":"b.txt","content":"x"}"#),
            ("edit_file", r#"{"path":"a.txt","old_text":"hello","new_text":"edited"}"#),
        ] {
            let call = ToolCall {
                id: "1".into(),
                name: name.into(),
                arguments: arguments.into(),
            };
            let result = dispatch_tool(root.path(), SessionKind::Work, Mode::Act, &call, |_| async {
                Some("reviewed".into())
            })
            .await;
            assert!(result.is_ok(), "{name}: {result:?}");
        }
        for (name, arguments) in [("read_file", r#"{"path":"../outside.txt"}"#), ("write_file", r#"{"path":"../outside.txt","content":"bad"}"#), ("execute_command", r#"{"program":"cmd.exe"}"#)] {
            let call = ToolCall { id: "escape".into(), name: name.into(), arguments: arguments.into() };
            assert!(dispatch_tool(root.path(), SessionKind::Work, Mode::Act, &call, |_| async { panic!("approval must not bypass the jail") }).await.is_err());
        }
    }
}
