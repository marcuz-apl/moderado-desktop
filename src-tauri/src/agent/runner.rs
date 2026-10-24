use super::{dispatch_tool_with_checkpoint, tool_definitions, Approval, Mode};
use crate::provider;
use crate::search::{self, SearchConfig};
use serde_json::{json, Value};
use std::future::Future;
use std::path::Path;

pub struct RunConfig<'a> {
    pub workspace: &'a Path,
    pub base_url: &'a str,
    pub model: &'a str,
    pub api_key: &'a str,
    pub mode: Mode,
    pub search: Option<&'a SearchConfig>,
}

#[derive(Debug)]
pub enum AgentEvent {
    Text(String),
    Tool(String),
}

pub async fn run_turn<A, Fut, E>(
    config: RunConfig<'_>,
    history: &mut Vec<Value>,
    prompt: &str,
    approve: A,
    emit: E,
) -> Result<(), String>
where
    A: FnMut(Approval) -> Fut,
    Fut: Future<Output = Option<String>>,
    E: FnMut(AgentEvent),
{
    run_turn_with_hooks(
        config,
        history,
        prompt,
        approve,
        emit,
        |_| Ok(()),
        |_| Ok(()),
    )
    .await
}

pub async fn run_turn_with_hooks<A, Fut, E, C, P>(
    config: RunConfig<'_>,
    history: &mut Vec<Value>,
    prompt: &str,
    mut approve: A,
    mut emit: E,
    mut before_mutation: C,
    mut persist: P,
) -> Result<(), String>
where
    A: FnMut(Approval) -> Fut,
    Fut: Future<Output = Option<String>>,
    E: FnMut(AgentEvent),
    C: FnMut(&Approval) -> Result<(), String>,
    P: FnMut(&[Value]) -> Result<(), String>,
{
    history.push(json!({"role":"user","content":prompt}));
    persist(history)?;
    let tools = tool_definitions(config.mode, config.search.is_some());
    let mode_instruction = match config.mode {
        Mode::Plan => "Plan mode: inspect the workspace and explain a plan. File mutations are unavailable.",
        Mode::Act => "Act mode: complete the user's task using the available tools. File writes require user approval.",
    };
    for _ in 0..8 {
        let mut messages = vec![
            json!({"role":"system","content":format!("You are Moderado, a coding agent. Use relative workspace paths with tools. Report tool errors honestly. {mode_instruction}")}),
        ];
        messages.extend(history.iter().cloned());
        let completion = provider::chat_completion(
            config.base_url,
            config.model,
            config.api_key,
            &messages,
            &tools,
            |text| emit(AgentEvent::Text(text.into())),
        )
        .await?;
        let calls = completion.tool_calls;
        if calls.is_empty() {
            history.push(json!({"role":"assistant","content":completion.content}));
            persist(history)?;
            return Ok(());
        }
        if calls
            .iter()
            .any(|call| call.id.is_empty() || call.name.is_empty())
        {
            return Err("Provider returned an incomplete tool call".into());
        }
        let wire_calls: Vec<Value> = calls.iter().map(|call| json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments}})).collect();
        history
            .push(json!({"role":"assistant","content":completion.content,"tool_calls":wire_calls}));
        persist(history)?;
        for call in calls {
            let result = if call.name == "web_search" {
                match config.search {
                    Some(search) => match serde_json::from_str::<Value>(&call.arguments) {
                        Ok(args) => match args.get("query").and_then(Value::as_str) {
                            Some(query) => search::query(search, query).await,
                            None => Err("Search query is required".into()),
                        },
                        Err(_) => Err("Invalid tool arguments".into()),
                    },
                    None => Err("Web search is unavailable for this session".into()),
                }
            } else {
                dispatch_tool_with_checkpoint(
                    config.workspace,
                    config.mode,
                    &call,
                    &mut approve,
                    |preview| before_mutation(preview),
                )
                .await
            };
            let value = match result {
                Ok(value) => value,
                Err(error) => format!("Error: {error}"),
            };
            emit(AgentEvent::Tool(format!("{}: {}", call.name, value)));
            history.push(json!({"role":"tool","tool_call_id":call.id,"content":value}));
            persist(history)?;
        }
    }
    Err("Agent stopped after 8 tool rounds".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::Mode;
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::Duration;

    fn read_request(socket: &mut TcpStream) -> Value {
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        let header_end = loop {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let length: usize = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                    .and_then(|value| value.trim().parse().ok())
            })
            .unwrap();
        while bytes.len() - header_end < length {
            let count = socket.read(&mut buffer).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
        }
        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap()
    }

    fn respond(socket: &mut TcpStream, body: &str) {
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    }

    #[tokio::test]
    async fn approved_write_completes_end_to_end() {
        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            let request = read_request(&mut first);
            assert_eq!(request["model"], "test-model");
            respond(&mut first, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"hello.txt\\\",\\\"content\\\":\\\"hello\\\"}\"}}]}}]}\n\ndata: [DONE]\n\n");
            let (mut second, _) = listener.accept().unwrap();
            let request = read_request(&mut second);
            assert_eq!(
                request["messages"].as_array().unwrap().last().unwrap()["content"],
                "Wrote hello.txt"
            );
            respond(
                &mut second,
                "data: {\"choices\":[{\"delta\":{\"content\":\"Finished\"}}]}\n\ndata: [DONE]\n\n",
            );
        });
        let mut history = Vec::new();
        let mut events = Vec::new();
        run_turn(
            RunConfig {
                workspace: root.path(),
                base_url: &base,
                model: "test-model",
                api_key: "",
                mode: Mode::Act,
                search: None,
            },
            &mut history,
            "Create hello.txt",
            |preview| async move {
                assert_eq!(preview.path, "hello.txt");
                assert_eq!(preview.after, "hello");
                Some(preview.after)
            },
            |event| events.push(event),
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("hello.txt")).unwrap(),
            "hello"
        );
        assert_eq!(history.last().unwrap()["content"], "Finished");
        assert!(events
            .iter()
            .any(|event| matches!(event, AgentEvent::Text(text) if text == "Finished")));
    }

    #[tokio::test]
    async fn rejected_write_is_reported_to_model_without_changing_file() {
        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            read_request(&mut first);
            respond(&mut first, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"a.txt\\\",\\\"content\\\":\\\"draft\\\"}\"}}]}}]}\n\ndata: [DONE]\n\n");
            let (mut second, _) = listener.accept().unwrap();
            let request = read_request(&mut second);
            assert!(
                request["messages"].as_array().unwrap().last().unwrap()["content"]
                    .as_str()
                    .unwrap()
                    .contains("rejected")
            );
            respond(&mut second, "data: {\"choices\":[{\"delta\":{\"content\":\"No changes made\"}}]}\n\ndata: [DONE]\n\n");
        });
        let mut history = Vec::new();
        run_turn(
            RunConfig {
                workspace: root.path(),
                base_url: &base,
                model: "test-model",
                api_key: "",
                mode: Mode::Act,
                search: None,
            },
            &mut history,
            "Write a.txt",
            |_| async { None },
            |_| {},
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert!(!root.path().join("a.txt").exists());
        assert_eq!(history.last().unwrap()["content"], "No changes made");
    }

    #[tokio::test]
    async fn plan_mode_blocks_unadvertised_write_from_provider() {
        let root = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            let request = read_request(&mut first);
            assert!(!request["tools"].to_string().contains("write_file"));
            respond(&mut first, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"a.txt\\\",\\\"content\\\":\\\"draft\\\"}\"}}]}}]}\n\ndata: [DONE]\n\n");
            let (mut second, _) = listener.accept().unwrap();
            let request = read_request(&mut second);
            assert!(
                request["messages"].as_array().unwrap().last().unwrap()["content"]
                    .as_str()
                    .unwrap()
                    .contains("Plan mode")
            );
            respond(
                &mut second,
                "data: {\"choices\":[{\"delta\":{\"content\":\"Read only\"}}]}\n\ndata: [DONE]\n\n",
            );
        });
        let mut history = Vec::new();
        run_turn(
            RunConfig {
                workspace: root.path(),
                base_url: &base,
                model: "test-model",
                api_key: "",
                mode: Mode::Plan,
                search: None,
            },
            &mut history,
            "Plan a change",
            |_| async { panic!("approval must not be requested") },
            |_| {},
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert!(!root.path().join("a.txt").exists());
    }

    #[tokio::test]
    async fn each_provider_profile_completes_the_same_streamed_tool_task() {
        use crate::provider::ProviderId;
        let fixtures = [
            (
                ProviderId::Moderado,
                include_str!("../../tests/fixtures/gateway.sse"),
            ),
            (
                ProviderId::NvidiaNim,
                include_str!("../../tests/fixtures/nvidia_nim.sse"),
            ),
            (
                ProviderId::OpenRouter,
                include_str!("../../tests/fixtures/open_router.sse"),
            ),
            (
                ProviderId::Ollama,
                include_str!("../../tests/fixtures/ollama.sse"),
            ),
            (
                ProviderId::LmStudio,
                include_str!("../../tests/fixtures/lm_studio.sse"),
            ),
            (
                ProviderId::OpenAiCompatible,
                include_str!("../../tests/fixtures/custom.sse"),
            ),
        ];
        for (provider_id, fixture) in fixtures {
            let root = tempfile::tempdir().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut first, _) = listener.accept().unwrap();
                let request = read_request(&mut first);
                assert_eq!(request["model"], "test-model");
                assert!(request["tools"].to_string().contains("write_file"));
                respond(&mut first, fixture);
                let (mut second, _) = listener.accept().unwrap();
                let request = read_request(&mut second);
                assert_eq!(
                    request["messages"].as_array().unwrap().last().unwrap()["content"],
                    "Wrote m2.txt"
                );
                respond(&mut second, "data: {\"choices\":[{\"delta\":{\"content\":\"Finished\"}}]}\n\ndata: [DONE]\n\n");
            });
            let mut history = Vec::new();
            run_turn(
                RunConfig {
                    workspace: root.path(),
                    base_url: &base,
                    model: "test-model",
                    api_key: "",
                    mode: Mode::Act,
                    search: None,
                },
                &mut history,
                "Create m2.txt",
                |preview| async move { Some(preview.after) },
                |_| {},
            )
            .await
            .unwrap_or_else(|error| panic!("{provider_id:?}: {error}"));
            server.join().unwrap();
            assert_eq!(
                std::fs::read_to_string(root.path().join("m2.txt")).unwrap(),
                "ready",
                "{provider_id:?}"
            );
            assert_eq!(
                history.last().unwrap()["content"],
                "Finished",
                "{provider_id:?}"
            );
        }
    }

    #[tokio::test]
    async fn approved_mutation_creates_a_restart_safe_checkpoint() {
        use crate::checkpoints::CheckpointStore;
        use crate::provider::settings::ProviderSettings;
        use crate::provider::ProviderId;
        use crate::sessions::SessionStore;
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("file.txt"), "before").unwrap();
        let db_path = root.path().join("sessions.sqlite");
        let store = SessionStore::open(db_path.clone()).unwrap();
        let settings = ProviderSettings {
            provider_id: ProviderId::Ollama,
            base_url: "http://localhost:11434/v1".into(),
            plan_model: "test-model".into(),
            act_model: "test-model".into(),
        };
        let session = store
            .create(&workspace, "Checkpoint test", settings.clone())
            .unwrap();
        let checkpoints = CheckpointStore::new(root.path().join("checkpoints")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            read_request(&mut first);
            respond(&mut first, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"file.txt\\\",\\\"content\\\":\\\"after\\\"}\"}}]}}]}\n\ndata: [DONE]\n\n");
            let (mut second, _) = listener.accept().unwrap();
            read_request(&mut second);
            respond(
                &mut second,
                "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"}}]}\n\ndata: [DONE]\n\n",
            );
        });
        let mut history = Vec::new();
        run_turn_with_hooks(
            RunConfig {
                workspace: &workspace,
                base_url: &base,
                model: "test-model",
                api_key: "",
                mode: Mode::Act,
                search: None,
            },
            &mut history,
            "Change file.txt",
            |preview| async move { Some(preview.after) },
            |_| {},
            |preview| {
                assert_eq!(
                    std::fs::read_to_string(workspace.join("file.txt")).unwrap(),
                    "before"
                );
                let checkpoint = checkpoints.create(&workspace, &session.id, &preview.path)?;
                store.add_checkpoint(&checkpoint)
            },
            |history| store.save_state(&session.id, &settings, history),
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(
            std::fs::read_to_string(workspace.join("file.txt")).unwrap(),
            "after"
        );
        drop(store);
        let reopened = SessionStore::open(db_path).unwrap();
        assert_eq!(
            reopened.get(&session.id).unwrap().history.last().unwrap()["content"],
            "Done"
        );
        let checkpoint = reopened.list_checkpoints(&session.id).unwrap().remove(0);
        let preview = checkpoints.preview(&workspace, &checkpoint).unwrap();
        assert_eq!(preview.changes[0].after, "before");
        checkpoints
            .restore(&workspace, &checkpoint, &preview.current_tree)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(workspace.join("file.txt")).unwrap(),
            "before"
        );
    }

    #[tokio::test]
    async fn recurring_auto_approved_run_writes_with_checkpoints() {
        use crate::checkpoints::CheckpointStore;
        use crate::provider::settings::ProviderSettings;
        use crate::provider::ProviderId;
        use crate::schedules::{ApprovalPolicy, ScheduleSpec, ScheduleStore};
        use crate::search::SearchSettings;
        use crate::sessions::SessionStore;
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("file.txt"), "before").unwrap();
        let database = root.path().join("sessions.sqlite");
        let sessions = SessionStore::open(database.clone()).unwrap();
        let settings = ProviderSettings {
            provider_id: ProviderId::Ollama,
            base_url: "http://localhost:11434/v1".into(),
            plan_model: "model".into(),
            act_model: "model".into(),
        };
        let session = sessions
            .create(&workspace, "Recurring", settings.clone())
            .unwrap();
        let schedules = ScheduleStore::open(database).unwrap();
        schedules
            .create(
                &session.id,
                &settings,
                &SearchSettings::default(),
                ScheduleSpec {
                    prompt: "Update file",
                    mode: Mode::Act,
                    approval_policy: ApprovalPolicy::AutoWrite,
                    next_run_at: 100,
                    interval_seconds: Some(60),
                },
            )
            .unwrap();
        let due = schedules.claim_due(100, 8).unwrap();
        assert_eq!(due.len(), 1);
        let checkpoints = CheckpointStore::new(root.path().join("checkpoints")).unwrap();
        let before_run = checkpoints
            .create_before_run(&workspace, &session.id)
            .unwrap();
        sessions.add_checkpoint(&before_run).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            read_request(&mut first);
            respond(&mut first, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"file.txt\\\",\\\"content\\\":\\\"after\\\"}\"}}]}}]}\n\ndata: [DONE]\n\n");
            let (mut second, _) = listener.accept().unwrap();
            read_request(&mut second);
            respond(
                &mut second,
                "data: {\"choices\":[{\"delta\":{\"content\":\"Done\"}}]}\n\ndata: [DONE]\n\n",
            );
        });
        let mut history = Vec::new();
        run_turn_with_hooks(
            RunConfig {
                workspace: &workspace,
                base_url: &base,
                model: "model",
                api_key: "",
                mode: Mode::Act,
                search: None,
            },
            &mut history,
            &due[0].prompt,
            |preview| async move { Some(preview.after) },
            |_| {},
            |preview| {
                let checkpoint = checkpoints.create(&workspace, &session.id, &preview.path)?;
                sessions.add_checkpoint(&checkpoint)
            },
            |history| sessions.save_state(&session.id, &settings, history),
        )
        .await
        .unwrap();
        server.join().unwrap();
        schedules.finish(&due[0].id, None, 100).unwrap();
        assert_eq!(
            std::fs::read_to_string(workspace.join("file.txt")).unwrap(),
            "after"
        );
        assert_eq!(sessions.list_checkpoints(&session.id).unwrap().len(), 2);
        assert_eq!(schedules.list(&session.id).unwrap()[0].next_run_at, 160);
        assert!(schedules.claim_due(100, 8).unwrap().is_empty());
    }
}
