//! Agent loop tests: scripted mock Ollama over real HTTP plus a fake IDE
//! client that records every notification and request in order.

#[path = "support/mock_ollama.rs"]
mod mock_ollama;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use localpilot_core::agent::AgentRunner;
use localpilot_core::agent::session::Session;
use localpilot_core::completion::CompletionEngine;
use localpilot_core::index::WorkspaceIndex;
use localpilot_core::ollama::OllamaClient;
use localpilot_core::overlay::{DocumentStore, path_to_uri};
use localpilot_core::protocol::{Attachment, ChatSendParams, Decision, Position, Range, methods};
use localpilot_core::rpc::{ClientLink, RpcError};
use localpilot_core::settings::{Settings, Thinking};
use mock_ollama::{MockOllama, Script, chat_done, chat_text, chat_tool_call};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const WAIT: Duration = Duration::from_secs(5);
const SESSION: &str = "s1";
const LIB: &str = "fn a() {\n    old_call();\n}\n";

#[derive(Debug, Clone)]
struct Event {
    /// `true` for a core→client request, `false` for a notification.
    request: bool,
    method: String,
    params: Value,
    /// The completion engine's pause flag when the event was sent.
    paused: bool,
}

/// The IDE side: records traffic, answers `applyEdit` / `runCommand`.
struct FakeCtx {
    log: Mutex<Vec<Event>>,
    tx: mpsc::UnboundedSender<Event>,
    engine: Arc<CompletionEngine>,
    /// While answering a request with this method, stop the session first.
    stop_during: Mutex<Option<(&'static str, Arc<AgentRunner>)>>,
}

impl FakeCtx {
    fn record(&self, request: bool, method: &str, params: Value) {
        let event = Event {
            request,
            method: method.to_owned(),
            params,
            paused: self.engine.is_paused(),
        };
        self.log.lock().unwrap().push(event.clone());
        let _ = self.tx.send(event);
    }

    fn events(&self) -> Vec<Event> {
        self.log.lock().unwrap().clone()
    }

    fn named(&self, method: &str) -> Vec<Event> {
        self.events()
            .into_iter()
            .filter(|e| e.method == method)
            .collect()
    }

    fn requests(&self) -> Vec<Event> {
        self.events().into_iter().filter(|e| e.request).collect()
    }
}

#[async_trait]
impl ClientLink for FakeCtx {
    fn notify(&self, method: &str, params: Value) {
        self.record(false, method, params);
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.record(true, method, params);
        let stop = self.stop_during.lock().unwrap().clone();
        if let Some((stop_method, runner)) = stop
            && stop_method == method
        {
            assert!(runner.stop(SESSION));
            if method == methods::RUN_COMMAND {
                // A long-running command: never finishes on its own.
                std::future::pending::<()>().await;
            }
            // Give a cancellation race every chance to win.
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        match method {
            methods::APPLY_EDIT => Ok(json!({"applied": true})),
            methods::RUN_COMMAND => Ok(json!({"exitCode": 0, "stdout": "all good", "stderr": ""})),
            other => Err(RpcError::method_not_found(other)),
        }
    }
}

struct Env {
    mock: MockOllama,
    runner: Arc<AgentRunner>,
    engine: Arc<CompletionEngine>,
    ctx: Arc<FakeCtx>,
    rx: mpsc::UnboundedReceiver<Event>,
    root: PathBuf,
    _dir: TempDir,
}

impl Env {
    async fn new(script: Script) -> Env {
        Env::with_settings(script, |_| {}).await
    }

    async fn with_settings(script: Script, tweak: impl FnOnce(&mut Settings)) -> Env {
        let mock = MockOllama::start(script).await;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), LIB).unwrap();
        let mut settings = Settings {
            ollama_url: mock.url.clone(),
            chat_model: "chat".to_owned(),
            ..Settings::default()
        };
        tweak(&mut settings);
        let store = Arc::new(RwLock::new(DocumentStore::new(root.clone())));
        let index = Arc::new(RwLock::new(WorkspaceIndex::build(&root)));
        let ollama = OllamaClient::new(mock.url.clone(), settings.keep_alive.clone());
        let engine = Arc::new(CompletionEngine::new(
            ollama.clone(),
            store.clone(),
            index.clone(),
            settings.clone(),
        ));
        let runner = Arc::new(AgentRunner::new(
            ollama,
            store,
            index,
            engine.clone(),
            settings,
            root.clone(),
        ));
        let (tx, rx) = mpsc::unbounded_channel();
        let ctx = Arc::new(FakeCtx {
            log: Mutex::new(Vec::new()),
            tx,
            engine: engine.clone(),
            stop_during: Mutex::new(None),
        });
        Env {
            mock,
            runner,
            engine,
            ctx,
            rx,
            root,
            _dir: dir,
        }
    }

    fn send(&self, message: &str) -> JoinHandle<Result<(), RpcError>> {
        self.send_with(message, Vec::new())
    }

    fn send_with(
        &self,
        message: &str,
        attachments: Vec<Attachment>,
    ) -> JoinHandle<Result<(), RpcError>> {
        let runner = self.runner.clone();
        let ctx = self.ctx.clone();
        let params = ChatSendParams {
            session_id: SESSION.to_owned(),
            message: message.to_owned(),
            attachments,
        };
        tokio::spawn(async move {
            runner
                .send(SESSION, params, ctx, CancellationToken::new())
                .await
        })
    }

    /// Waits for the next event named `method`, skipping others.
    async fn next(&mut self, method: &str) -> Event {
        let wait = async {
            loop {
                let event = self.rx.recv().await.expect("ctx dropped");
                if event.method == method {
                    return event;
                }
            }
        };
        tokio::time::timeout(WAIT, wait)
            .await
            .unwrap_or_else(|_| panic!("no {method} within {WAIT:?}"))
    }

    fn chat_bodies(&self) -> Vec<Value> {
        self.mock
            .received_requests()
            .into_iter()
            .filter(|(path, _)| path == "/api/chat")
            .map(|(_, body)| body)
            .collect()
    }

    fn uri(&self, rel: &str) -> String {
        path_to_uri(&self.root.join(rel))
    }
}

async fn finish(handle: JoinHandle<Result<(), RpcError>>) {
    tokio::time::timeout(WAIT, handle)
        .await
        .expect("send finished")
        .expect("send did not panic")
        .expect("send ok");
}

fn stop_reasons(ctx: &FakeCtx) -> Vec<String> {
    ctx.named(methods::CHAT_DONE)
        .iter()
        .map(|e| e.params["stopReason"].as_str().unwrap().to_owned())
        .collect()
}

fn tool_messages(body: &Value) -> Vec<Value> {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .cloned()
        .collect()
}

fn thinking(text: &str) -> Value {
    json!({"model": "chat", "created_at": "2026-10-20T16:13:04.740228Z",
           "message": {"role": "assistant", "content": "", "thinking": text}, "done": false})
}

fn script(turns: Vec<Vec<Value>>) -> Script {
    Script {
        chat: turns,
        ..Script::default()
    }
}

fn edit_call(id: &str, old: &str, new: &str) -> Value {
    chat_tool_call(
        id,
        0,
        "edit_file",
        json!({"path": "src/lib.rs", "old": old, "new": new}),
    )
}

#[tokio::test]
async fn plain_answer_streams_tokens_then_done() {
    let env = Env::with_settings(
        script(vec![vec![
            thinking("Pondering."),
            chat_text("Hello"),
            chat_text(" world"),
            chat_done(),
        ]]),
        |s| s.chat_thinking = Thinking::On,
    )
    .await;
    finish(env.send("hi")).await;

    let events = env.ctx.events();
    let got: Vec<(String, Value)> = events
        .iter()
        .map(|e| (e.method.clone(), e.params.clone()))
        .collect();
    assert_eq!(
        got,
        vec![
            (
                "chat/token".into(),
                json!({"sessionId": SESSION, "delta": "Pondering.", "kind": "thinking"})
            ),
            (
                "chat/token".into(),
                json!({"sessionId": SESSION, "delta": "Hello", "kind": "text"})
            ),
            (
                "chat/token".into(),
                json!({"sessionId": SESSION, "delta": " world", "kind": "text"})
            ),
            (
                "chat/done".into(),
                json!({"sessionId": SESSION, "stopReason": "done"})
            ),
        ]
    );
    assert!(!env.engine.is_paused());

    let bodies = env.chat_bodies();
    assert_eq!(bodies.len(), 1);
    let body = &bodies[0];
    assert_eq!(body["model"], "chat");
    assert_eq!(body["think"], true);
    assert_eq!(body["stream"], true);
    // The context window fits the history budget plus tool schemas and reply.
    assert_eq!(body["options"]["num_ctx"], 24000 + 8192);
    assert_eq!(body["options"]["num_predict"], 4096);
    assert_eq!(body["tools"].as_array().unwrap().len(), 6);
    assert_eq!(body["messages"][0]["role"], "system");
    assert!(
        body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains(env.root.to_str().unwrap())
    );
    assert_eq!(
        body["messages"][1],
        json!({"role": "user", "content": "hi"})
    );

    // The session is persisted, including the assistant's reply.
    let saved = Session::load(&env.root, SESSION).unwrap();
    let last = saved.messages.last().unwrap();
    assert_eq!(last.content, "Hello world");
    assert_eq!(last.thinking.as_deref(), Some("Pondering."));
}

#[tokio::test]
async fn attachments_are_inlined_as_fenced_blocks() {
    let env = Env::new(script(vec![vec![chat_text("ok"), chat_done()]])).await;
    let attachments = vec![
        Attachment {
            uri: env.uri("src/lib.rs"),
            range: Some(Range {
                start: Position {
                    line: 1,
                    character: 0,
                },
                end: Position {
                    line: 2,
                    character: 1,
                },
            }),
        },
        Attachment {
            uri: env.uri("src/lib.rs"),
            range: None,
        },
    ];
    finish(env.send_with("explain", attachments)).await;

    let body = &env.chat_bodies()[0];
    let user = body["messages"][1]["content"].as_str().unwrap();
    assert!(user.starts_with("explain\n"), "{user}");
    assert!(
        user.contains("```src/lib.rs:2-3\n    old_call();\n}\n```"),
        "{user}"
    );
    assert!(user.contains(&format!("```src/lib.rs\n{LIB}```")), "{user}");
    // The first attachment is the active file in the system prompt.
    let system = body["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("src/lib.rs"), "{system}");
}

#[tokio::test]
async fn read_file_tool_runs_without_approval_and_result_is_sent_back_to_model() {
    let env = Env::new(script(vec![
        vec![
            chat_tool_call("call_1", 0, "read_file", json!({"path": "src/lib.rs"})),
            chat_done(),
        ],
        vec![chat_text("It calls old_call."), chat_done()],
    ]))
    .await;
    finish(env.send("what does a do?")).await;

    let call = &env.ctx.named(methods::CHAT_TOOL_CALL)[0].params;
    assert_eq!(call["toolCallId"], "call_1");
    assert_eq!(call["name"], "read_file");
    assert_eq!(call["args"], json!({"path": "src/lib.rs"}));
    assert_eq!(call["requiresApproval"], false);
    let result = &env.ctx.named(methods::CHAT_TOOL_RESULT)[0].params;
    assert_eq!(result["toolCallId"], "call_1");
    assert_eq!(result["ok"], true);
    assert!(env.ctx.requests().is_empty());
    assert_eq!(stop_reasons(&env.ctx), ["done"]);

    let bodies = env.chat_bodies();
    assert_eq!(bodies.len(), 2);
    let messages = bodies[1]["messages"].as_array().unwrap();
    let assistant = &messages[messages.len() - 2];
    assert_eq!(assistant["role"], "assistant");
    assert_eq!(assistant["tool_calls"][0]["function"]["name"], "read_file");
    let tools = tool_messages(&bodies[1]);
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["tool_name"], "read_file");
    assert!(
        tools[0]["content"].as_str().unwrap().contains(LIB),
        "{}",
        tools[0]["content"]
    );
}

#[tokio::test]
async fn edit_file_waits_for_approval_then_sends_apply_edit_with_diff_preview() {
    let mut env = Env::new(script(vec![
        vec![
            edit_call("call_1", "old_call();", "new_call();"),
            chat_done(),
        ],
        vec![chat_text("Done."), chat_done()],
    ]))
    .await;
    let handle = env.send("rename the call");

    let call = env.next(methods::CHAT_TOOL_CALL).await.params;
    assert_eq!(call["requiresApproval"], true);
    let preview = call["preview"].as_str().unwrap();
    assert!(preview.contains("src/lib.rs"), "{preview}");
    assert!(preview.contains("-    old_call();"), "{preview}");
    assert!(preview.contains("+    new_call();"), "{preview}");
    // Nothing is applied before the user decides.
    assert!(env.ctx.requests().is_empty());
    assert!(env.ctx.named(methods::CHAT_TOOL_RESULT).is_empty());

    env.runner
        .approve(SESSION, "call_1", Decision::Once, None)
        .unwrap();
    finish(handle).await;

    let requests = env.ctx.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "workspace/applyEdit");
    assert_eq!(
        requests[0].params,
        json!({
            "ops": [{
                "kind": "edit",
                "uri": env.uri("src/lib.rs"),
                "range": {"start": {"line": 1, "character": 4}, "end": {"line": 1, "character": 15}},
                "newText": "new_call();"
            }],
            "save": true
        })
    );
    assert_eq!(
        env.ctx.named(methods::CHAT_TOOL_RESULT)[0].params["ok"],
        true
    );
    assert_eq!(stop_reasons(&env.ctx), ["done"]);
    // The core never writes the file itself.
    assert_eq!(
        std::fs::read_to_string(env.root.join("src/lib.rs")).unwrap(),
        LIB
    );
    let tools = tool_messages(&env.chat_bodies()[1]);
    assert!(tools[0]["content"].as_str().unwrap().contains("applied"));
    // Approving an id that is no longer pending is an error.
    assert!(
        env.runner
            .approve(SESSION, "call_1", Decision::Once, None)
            .is_err()
    );
}

#[tokio::test]
async fn deny_sends_denial_to_model_and_continues() {
    let mut env = Env::new(script(vec![
        vec![
            edit_call("call_1", "old_call();", "new_call();"),
            chat_done(),
        ],
        vec![chat_text("Okay, I won't."), chat_done()],
    ]))
    .await;
    let handle = env.send("rename the call");
    env.next(methods::CHAT_TOOL_CALL).await;
    env.runner
        .approve(SESSION, "call_1", Decision::Deny, None)
        .unwrap();
    finish(handle).await;

    assert!(env.ctx.requests().is_empty());
    let result = &env.ctx.named(methods::CHAT_TOOL_RESULT)[0].params;
    assert_eq!(result["ok"], false);
    let bodies = env.chat_bodies();
    assert_eq!(bodies.len(), 2);
    let tools = tool_messages(&bodies[1]);
    assert_eq!(
        tools,
        [json!({"role": "tool", "content": "User denied this action.", "tool_name": "edit_file"})]
    );
    assert_eq!(stop_reasons(&env.ctx), ["done"]);
}

#[tokio::test]
async fn always_skips_second_prompt() {
    let run =
        |id: &str, command: &str| chat_tool_call(id, 0, "run_command", json!({"command": command}));
    let mut env = Env::with_settings(
        script(vec![
            vec![
                edit_call("call_1", "old_call();", "new_call();"),
                chat_done(),
            ],
            vec![edit_call("call_2", "fn a()", "fn b()"), chat_done()],
            vec![run("call_3", "cargo test"), chat_done()],
            vec![run("call_4", "cargo test"), chat_done()],
            vec![run("call_5", "cargo test --release"), chat_done()],
            vec![run("call_6", "make lint"), chat_done()],
            vec![chat_text("All done."), chat_done()],
        ]),
        |s| s.allowed_commands_always = vec!["make lint".to_owned()],
    )
    .await;
    let handle = env.send("do things");

    let call = env.next(methods::CHAT_TOOL_CALL).await.params;
    assert_eq!(
        (&call["toolCallId"], &call["requiresApproval"]),
        (&json!("call_1"), &json!(true))
    );
    env.runner
        .approve(SESSION, "call_1", Decision::Always, None)
        .unwrap();
    // Edits are now allowed for the session: no prompt.
    let call = env.next(methods::CHAT_TOOL_CALL).await.params;
    assert_eq!(
        (&call["toolCallId"], &call["requiresApproval"]),
        (&json!("call_2"), &json!(false))
    );
    // Commands are a separate key.
    let call = env.next(methods::CHAT_TOOL_CALL).await.params;
    assert_eq!(
        (&call["toolCallId"], &call["requiresApproval"]),
        (&json!("call_3"), &json!(true))
    );
    assert_eq!(call["preview"], "cargo test");
    env.runner
        .approve(SESSION, "call_3", Decision::Always, None)
        .unwrap();
    // The exact same command is allowed...
    let call = env.next(methods::CHAT_TOOL_CALL).await.params;
    assert_eq!(
        (&call["toolCallId"], &call["requiresApproval"]),
        (&json!("call_4"), &json!(false))
    );
    // ...a different command string is not.
    let call = env.next(methods::CHAT_TOOL_CALL).await.params;
    assert_eq!(
        (&call["toolCallId"], &call["requiresApproval"]),
        (&json!("call_5"), &json!(true))
    );
    env.runner
        .approve(SESSION, "call_5", Decision::Once, None)
        .unwrap();
    // Commands allowed in settings never prompt.
    let call = env.next(methods::CHAT_TOOL_CALL).await.params;
    assert_eq!(
        (&call["toolCallId"], &call["requiresApproval"]),
        (&json!("call_6"), &json!(false))
    );
    finish(handle).await;

    let methods_sent: Vec<String> = env
        .ctx
        .requests()
        .iter()
        .map(|r| r.method.clone())
        .collect();
    assert_eq!(
        methods_sent,
        [
            "workspace/applyEdit",
            "workspace/applyEdit",
            "workspace/runCommand",
            "workspace/runCommand",
            "workspace/runCommand",
            "workspace/runCommand"
        ]
    );
    let commands: Vec<Value> = env
        .ctx
        .requests()
        .iter()
        .filter(|r| r.method == "workspace/runCommand")
        .map(|r| r.params["command"].clone())
        .collect();
    assert_eq!(
        commands,
        [
            "cargo test",
            "cargo test",
            "cargo test --release",
            "make lint"
        ]
    );
    assert_eq!(stop_reasons(&env.ctx), ["done"]);

    let saved = Session::load(&env.root, SESSION).unwrap();
    assert!(saved.always_allow.contains("edit_file"));
    assert!(saved.always_allow.contains("run_command:cargo test"));
    assert_eq!(saved.always_allow.len(), 2);
}

#[tokio::test]
async fn unknown_tool_and_missing_args_return_tool_errors() {
    let calls = vec![
        chat_tool_call("call_1", 0, "delete_everything", json!({})),
        chat_tool_call("call_2", 1, "read_file", json!({})),
        chat_tool_call(
            "call_3",
            2,
            "edit_file",
            json!({"path": "src/lib.rs", "old": "old_call();", "new": "old_call();"}),
        ),
        chat_tool_call(
            "call_4",
            3,
            "edit_file",
            json!({"path": "src/lib.rs", "old": "", "new": "x"}),
        ),
        chat_tool_call(
            "call_5",
            4,
            "edit_file",
            json!({"path": "src/lib.rs", "old": "missing_call();", "new": "x"}),
        ),
        chat_tool_call(
            "call_6",
            5,
            "create_file",
            json!({"path": "src/lib.rs", "content": "x"}),
        ),
        chat_tool_call("call_7", 6, "search", json!({"query": "(", "regex": true})),
        chat_done(),
    ];
    let env = Env::new(script(vec![
        calls,
        vec![chat_text("Let me try again."), chat_done()],
    ]))
    .await;
    finish(env.send("go")).await;

    // No prompts, nothing sent to the client, every call answered with an error.
    for call in env.ctx.named(methods::CHAT_TOOL_CALL) {
        assert_eq!(call.params["requiresApproval"], false, "{:?}", call.params);
    }
    assert!(env.ctx.requests().is_empty());
    let results = env.ctx.named(methods::CHAT_TOOL_RESULT);
    assert_eq!(results.len(), 7);
    assert!(results.iter().all(|r| r.params["ok"] == false));

    let tools = tool_messages(&env.chat_bodies()[1]);
    let contents: Vec<&str> = tools
        .iter()
        .map(|t| t["content"].as_str().unwrap())
        .collect();
    assert_eq!(contents.len(), 7);
    assert!(
        contents.iter().all(|c| c.starts_with("Error: ")),
        "{contents:#?}"
    );
    assert!(contents[0].contains("unknown tool"), "{}", contents[0]);
    assert!(contents[1].contains("path"), "{}", contents[1]);
    assert!(contents[2].contains("identical"), "{}", contents[2]);
    assert!(contents[3].contains("empty"), "{}", contents[3]);
    assert!(contents[4].contains("not found"), "{}", contents[4]);
    assert!(contents[5].contains("already exists"), "{}", contents[5]);
    assert!(contents[6].contains("invalid regex"), "{}", contents[6]);
    // The loop carried on to the model's next turn.
    assert_eq!(stop_reasons(&env.ctx), ["done"]);
}

#[tokio::test]
async fn path_escape_in_create_file_is_rejected() {
    let outside = tempfile::tempdir().unwrap();
    let outside_path = outside.path().canonicalize().unwrap();
    let env_script = |out: &str| {
        vec![
            chat_tool_call(
                "call_1",
                0,
                "create_file",
                json!({"path": "../evil.txt", "content": "x"}),
            ),
            chat_tool_call(
                "call_2",
                1,
                "create_file",
                json!({"path": format!("{out}/evil.txt"), "content": "x"}),
            ),
            chat_tool_call(
                "call_3",
                2,
                "create_file",
                json!({"path": "link/evil.txt", "content": "x"}),
            ),
            chat_tool_call(
                "call_4",
                3,
                "read_file",
                json!({"path": "../../etc/passwd"}),
            ),
            chat_tool_call(
                "call_5",
                4,
                "edit_file",
                json!({"path": "/etc/hosts", "old": "a", "new": "b"}),
            ),
            chat_tool_call(
                "call_6",
                5,
                "run_command",
                json!({"command": "ls", "cwd": ".."}),
            ),
            chat_done(),
        ]
    };
    let env = Env::new(script(vec![
        env_script(outside_path.to_str().unwrap()),
        vec![chat_text("Understood."), chat_done()],
    ]))
    .await;
    std::os::unix::fs::symlink(&outside_path, env.root.join("link")).unwrap();
    finish(env.send("write outside")).await;

    assert!(env.ctx.requests().is_empty());
    for call in env.ctx.named(methods::CHAT_TOOL_CALL) {
        assert_eq!(call.params["requiresApproval"], false, "{:?}", call.params);
    }
    let results = env.ctx.named(methods::CHAT_TOOL_RESULT);
    assert_eq!(results.len(), 6);
    for result in &results {
        assert_eq!(result.params["ok"], false);
        assert!(
            result.params["summary"]
                .as_str()
                .unwrap()
                .contains("outside the workspace"),
            "{:?}",
            result.params
        );
    }
    assert!(!outside_path.join("evil.txt").exists());
    assert_eq!(stop_reasons(&env.ctx), ["done"]);
}

#[tokio::test]
async fn stop_mid_stream_emits_stopped() {
    let mut chunks: Vec<Value> = (0..200).map(|i| chat_text(&format!("t{i} "))).collect();
    chunks.push(chat_done());
    let mut env = Env::new(Script {
        chat: vec![chunks],
        chunk_delay: Duration::from_millis(20),
        ..Script::default()
    })
    .await;
    let handle = env.send("long answer");
    env.next(methods::CHAT_TOKEN).await;
    assert!(env.runner.stop(SESSION));
    finish(handle).await;

    assert_eq!(stop_reasons(&env.ctx), ["stopped"]);
    assert_eq!(env.ctx.events().last().unwrap().method, "chat/done");
    assert!(env.ctx.named(methods::CHAT_TOKEN).len() < 200);
    assert!(!env.engine.is_paused());
    assert!(!env.runner.stop(SESSION), "nothing left to stop");
}

#[tokio::test]
async fn edited_args_run_and_always_keys_the_edited_command() {
    let run =
        |id: &str, command: &str| chat_tool_call(id, 0, "run_command", json!({"command": command}));
    let mut env = Env::new(script(vec![
        vec![run("call_1", "rm -rf build"), chat_done()],
        vec![run("call_2", "cargo clean"), chat_done()],
        vec![run("call_3", "rm -rf build"), chat_done()],
        vec![chat_text("Done."), chat_done()],
    ]))
    .await;
    let handle = env.send("clean up");

    env.next(methods::CHAT_TOOL_CALL).await;
    env.runner
        .approve(
            SESSION,
            "call_1",
            Decision::Always,
            Some(json!({"command": "cargo clean"})),
        )
        .unwrap();
    // "Always" applies to the command the user approved, not the original.
    let call = env.next(methods::CHAT_TOOL_CALL).await.params;
    assert_eq!(
        (&call["toolCallId"], &call["requiresApproval"]),
        (&json!("call_2"), &json!(false))
    );
    let call = env.next(methods::CHAT_TOOL_CALL).await.params;
    assert_eq!(
        (&call["toolCallId"], &call["requiresApproval"]),
        (&json!("call_3"), &json!(true))
    );
    env.runner
        .approve(SESSION, "call_3", Decision::Deny, None)
        .unwrap();
    finish(handle).await;

    let commands: Vec<Value> = env
        .ctx
        .requests()
        .iter()
        .map(|r| r.params["command"].clone())
        .collect();
    assert_eq!(commands, ["cargo clean", "cargo clean"]);
    let tools = tool_messages(&env.chat_bodies()[1]);
    let content = tools[0]["content"].as_str().unwrap();
    assert!(content.contains("edited the arguments"), "{content}");
    assert!(content.contains("exit code 0"), "{content}");
    let saved = Session::load(&env.root, SESSION).unwrap();
    assert!(saved.always_allow.contains("run_command:cargo clean"));
    assert!(!saved.always_allow.contains("run_command:rm -rf build"));
}

#[tokio::test]
async fn edit_is_re_resolved_if_the_file_changes_during_approval() {
    let mut env = Env::new(script(vec![
        vec![
            edit_call("call_1", "old_call();", "new_call();"),
            chat_done(),
        ],
        vec![edit_call("call_2", "fn a()", "fn b()"), chat_done()],
        vec![chat_text("Done."), chat_done()],
    ]))
    .await;
    let handle = env.send("edit");

    env.next(methods::CHAT_TOOL_CALL).await;
    // The user inserts a line above while the prompt is open.
    std::fs::write(env.root.join("src/lib.rs"), format!("// header\n{LIB}")).unwrap();
    env.runner
        .approve(SESSION, "call_1", Decision::Once, None)
        .unwrap();
    env.next(methods::CHAT_TOOL_CALL).await;
    // ...and then removes the text the second edit targets.
    std::fs::write(env.root.join("src/lib.rs"), "fn c() {}\n").unwrap();
    env.runner
        .approve(SESSION, "call_2", Decision::Once, None)
        .unwrap();
    finish(handle).await;

    let requests = env.ctx.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].params["ops"][0]["range"],
        json!({"start": {"line": 2, "character": 4}, "end": {"line": 2, "character": 15}})
    );
    let results = env.ctx.named(methods::CHAT_TOOL_RESULT);
    assert_eq!(results[0].params["ok"], true);
    assert_eq!(results[1].params["ok"], false);
    assert!(
        results[1].params["summary"]
            .as_str()
            .unwrap()
            .contains("changed while waiting for approval"),
        "{:?}",
        results[1].params
    );
}

#[tokio::test]
async fn stop_while_ide_applies_an_edit_records_the_applied_result() {
    let mut env = Env::new(script(vec![
        vec![
            edit_call("call_1", "old_call();", "new_call();"),
            chat_tool_call("call_2", 1, "read_file", json!({"path": "src/lib.rs"})),
            chat_done(),
        ],
        vec![chat_text("Next."), chat_done()],
    ]))
    .await;
    *env.ctx.stop_during.lock().unwrap() = Some((methods::APPLY_EDIT, env.runner.clone()));
    let handle = env.send("edit");
    env.next(methods::CHAT_TOOL_CALL).await;
    env.runner
        .approve(SESSION, "call_1", Decision::Once, None)
        .unwrap();
    finish(handle).await;

    assert_eq!(stop_reasons(&env.ctx), ["stopped"]);
    // The IDE applied the edit, so that is what the UI and history record.
    let results = env.ctx.named(methods::CHAT_TOOL_RESULT);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].params["toolCallId"], "call_1");
    assert_eq!(results[0].params["ok"], true);
    let saved = Session::load(&env.root, SESSION).unwrap();
    let tools: Vec<&str> = saved
        .messages
        .iter()
        .filter(|m| m.role == localpilot_core::ollama::Role::Tool)
        .map(|m| m.content.as_str())
        .collect();
    assert_eq!(tools.len(), 2);
    assert!(tools[0].contains("applied"), "{tools:?}");
    assert_eq!(tools[1], "Stopped by the user.");
    // No further model call after the stop.
    assert_eq!(env.chat_bodies().len(), 1);
}

#[tokio::test]
async fn stop_while_command_runs_says_it_may_still_be_running() {
    let mut env = Env::new(script(vec![vec![
        chat_tool_call("call_1", 0, "run_command", json!({"command": "sleep 100"})),
        chat_done(),
    ]]))
    .await;
    *env.ctx.stop_during.lock().unwrap() = Some((methods::RUN_COMMAND, env.runner.clone()));
    let handle = env.send("run it");
    env.next(methods::CHAT_TOOL_CALL).await;
    env.runner
        .approve(SESSION, "call_1", Decision::Once, None)
        .unwrap();
    finish(handle).await;

    assert_eq!(stop_reasons(&env.ctx), ["stopped"]);
    let results = env.ctx.named(methods::CHAT_TOOL_RESULT);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].params["ok"], false);
    let saved = Session::load(&env.root, SESSION).unwrap();
    assert_eq!(
        saved.messages.last().unwrap().content,
        "Stopped by the user; the command may still be running."
    );
}

#[tokio::test]
async fn always_allow_from_a_session_file_on_disk_is_not_trusted() {
    let mut env = Env::new(script(vec![
        vec![
            edit_call("call_1", "old_call();", "new_call();"),
            chat_done(),
        ],
        vec![chat_text("Ok."), chat_done()],
    ]))
    .await;
    // A session file this process did not write (e.g. committed or planted).
    let mut planted = Session::with_id(SESSION).unwrap();
    planted.always_allow.insert("edit_file".to_owned());
    planted
        .always_allow
        .insert("run_command:rm -rf ~".to_owned());
    planted.save(&env.root).unwrap();

    let handle = env.send("edit");
    let call = env.next(methods::CHAT_TOOL_CALL).await.params;
    assert_eq!(call["requiresApproval"], true);
    env.runner
        .approve(SESSION, "call_1", Decision::Deny, None)
        .unwrap();
    finish(handle).await;
    assert!(env.ctx.requests().is_empty());
    assert!(
        Session::load(&env.root, SESSION)
            .unwrap()
            .always_allow
            .is_empty()
    );
}

#[tokio::test]
async fn stop_while_awaiting_approval_emits_stopped() {
    let mut env = Env::new(script(vec![vec![
        edit_call("call_1", "old_call();", "new_call();"),
        chat_done(),
    ]]))
    .await;
    let handle = env.send("edit");
    env.next(methods::CHAT_TOOL_CALL).await;
    assert!(env.runner.stop(SESSION));
    finish(handle).await;

    assert_eq!(stop_reasons(&env.ctx), ["stopped"]);
    assert!(env.ctx.requests().is_empty());
    let results = env.ctx.named(methods::CHAT_TOOL_RESULT);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].params["ok"], false);
    let saved = Session::load(&env.root, SESSION).unwrap();
    assert_eq!(
        saved.messages.last().unwrap().content,
        "Stopped by the user."
    );
    assert!(
        env.runner
            .approve(SESSION, "call_1", Decision::Once, None)
            .is_err()
    );
}

#[tokio::test]
async fn ollama_404_emits_error_done_and_status() {
    let env = Env::new(Script {
        fail_with: Some(404),
        ..Script::default()
    })
    .await;
    finish(env.send("hi")).await;

    let events = env.ctx.events();
    let got: Vec<&str> = events.iter().map(|e| e.method.as_str()).collect();
    assert_eq!(got, ["status", "chat/done"]);
    assert_eq!(events[0].params["ollama"], "modelMissing");
    assert!(
        events[0].params["detail"]
            .as_str()
            .unwrap()
            .contains("chat"),
        "{:?}",
        events[0].params
    );
    assert_eq!(stop_reasons(&env.ctx), ["error"]);
    assert!(!env.engine.is_paused());
}

#[tokio::test]
async fn completions_resume_while_awaiting_approval() {
    let mut env = Env::new(script(vec![
        vec![
            chat_text("Let me edit."),
            edit_call("call_1", "old_call();", "new_call();"),
            chat_done(),
        ],
        vec![chat_text("Done."), chat_done()],
    ]))
    .await;
    assert!(!env.engine.is_paused());
    let handle = env.send("edit");

    let token = env.next(methods::CHAT_TOKEN).await;
    assert!(
        token.paused,
        "completions are paused while the model streams"
    );
    let call = env.next(methods::CHAT_TOOL_CALL).await;
    assert!(!call.paused, "completions resume once the stream ends");
    assert!(
        !env.engine.is_paused(),
        "and stay resumed while awaiting approval"
    );
    env.runner
        .approve(SESSION, "call_1", Decision::Once, None)
        .unwrap();
    finish(handle).await;

    let events = env.ctx.events();
    for event in &events {
        match event.method.as_str() {
            "chat/token" => assert!(event.paused, "{event:?}"),
            _ => assert!(!event.paused, "{event:?}"),
        }
    }
    assert_eq!(env.ctx.named(methods::CHAT_TOKEN).len(), 2);
    assert!(!env.engine.is_paused());
}

#[tokio::test]
async fn tool_rounds_are_capped_at_25() {
    let env = Env::new(script(vec![vec![
        chat_tool_call("call_x", 0, "list_files", json!({})),
        chat_done(),
    ]]))
    .await;
    finish(env.send("loop forever")).await;

    assert_eq!(env.chat_bodies().len(), 25);
    assert_eq!(env.ctx.named(methods::CHAT_TOOL_RESULT).len(), 25);
    assert_eq!(stop_reasons(&env.ctx), ["done"]);
    let tokens = env.ctx.named(methods::CHAT_TOKEN);
    let note = tokens.last().unwrap().params["delta"].as_str().unwrap();
    assert!(note.contains("25"), "{note}");
}

#[tokio::test]
async fn context_full_when_history_cannot_fit() {
    let env = Env::with_settings(script(vec![vec![chat_text("x"), chat_done()]]), |s| {
        s.chat_context_tokens = 10
    })
    .await;
    finish(env.send("hello there")).await;

    assert_eq!(stop_reasons(&env.ctx), ["contextFull"]);
    assert!(env.chat_bodies().is_empty());
}

#[tokio::test]
async fn second_send_continues_the_saved_session() {
    let env = Env::new(script(vec![
        vec![chat_text("First."), chat_done()],
        vec![chat_text("Second."), chat_done()],
    ]))
    .await;
    finish(env.send("one")).await;
    finish(env.send("two")).await;

    let bodies = env.chat_bodies();
    let roles: Vec<&str> = bodies[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["system", "user", "assistant", "user"]);
    assert_eq!(bodies[1]["messages"][2]["content"], "First.");
    let history = env.runner.history(SESSION).unwrap();
    assert_eq!(history.messages.len(), 4);
    assert_eq!(history.messages[0].role, "user");
}

#[tokio::test]
async fn reserve_marks_the_session_running_until_dropped() {
    let env = Env::new(script(vec![vec![chat_text("Hi."), chat_done()]])).await;
    assert!(
        env.runner
            .reserve("bad id/..", CancellationToken::new())
            .is_err()
    );

    let turn = env
        .runner
        .reserve(SESSION, CancellationToken::new())
        .unwrap();
    assert_eq!(turn.session_id(), SESSION);
    assert!(env.runner.is_running(SESSION));
    // A second reservation (or a plain send) fails while the first is held.
    assert!(
        env.runner
            .reserve(SESSION, CancellationToken::new())
            .is_err()
    );
    drop(turn);
    assert!(!env.runner.is_running(SESSION));
    assert!(
        env.runner
            .reserve(SESSION, CancellationToken::new())
            .is_ok()
    );
}
