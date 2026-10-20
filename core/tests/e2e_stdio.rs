//! End-to-end tests: spawn the real `localpilot-core serve` binary and talk
//! newline-delimited JSON-RPC to it over stdio, with the scripted mock Ollama
//! behind it.

#[path = "support/mock_ollama.rs"]
mod mock_ollama;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use localpilot_core::overlay::path_to_uri;
use mock_ollama::{
    MockOllama, Script, chat_done, chat_text, chat_tool_call, generate_chunk, generate_done,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(10);
/// Cursor after `return ` on line 1; the rest of that line is blank.
const DOC: &str = "def add(a, b):\n    return \n\nprint(add(1, 2))\n";

/// The spawned core plus the client side of its stdio.
struct Core {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: mpsc::UnboundedReceiver<Value>,
    /// Messages received but not yet consumed by an `expect_*` call.
    buffered: Vec<Value>,
    next_id: i64,
}

impl Core {
    fn spawn(workspace: &Path) -> Core {
        let mut child = Command::new(env!("CARGO_BIN_EXE_localpilot-core"))
            .arg("serve")
            .arg("--workspace")
            .arg(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Diagnostic only; inherited so it can never block the child.
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn localpilot-core");
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let value: Value = serde_json::from_str(&line)
                    .unwrap_or_else(|e| panic!("core wrote non-JSON to stdout: {line:?}: {e}"));
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        Core {
            stdin: child.stdin.take(),
            child,
            lines: rx,
            buffered: Vec::new(),
            next_id: 1,
        }
    }

    async fn write(&mut self, msg: Value) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        let mut line = msg.to_string();
        line.push('\n');
        stdin.write_all(line.as_bytes()).await.unwrap();
        stdin.flush().await.unwrap();
    }

    async fn notify(&mut self, method: &str, params: Value) {
        self.write(json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .await;
    }

    /// Sends a request and returns its id.
    async fn send(&mut self, method: &str, params: Value) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .await;
        id
    }

    /// Waits for the first message (buffered or new) matching `pred`.
    async fn expect(&mut self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        if let Some(i) = self.buffered.iter().position(&pred) {
            return self.buffered.remove(i);
        }
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let msg = tokio::time::timeout_at(deadline, self.lines.recv())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "timed out waiting for {what}; unconsumed: {:?}",
                        self.buffered
                    )
                })
                .unwrap_or_else(|| panic!("core closed stdout while waiting for {what}"));
            if pred(&msg) {
                return msg;
            }
            self.buffered.push(msg);
        }
    }

    /// The full response object for request `id`.
    async fn response(&mut self, id: i64) -> Value {
        self.expect(&format!("response {id}"), |m| {
            m.get("method").is_none() && m["id"] == json!(id)
        })
        .await
    }

    /// Sends a request and returns its `result`, failing on an error.
    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params).await;
        let response = self.response(id).await;
        assert!(
            response.get("error").is_none(),
            "{method} failed: {response}"
        );
        response["result"].clone()
    }

    /// The next notification named `method`.
    async fn notification(&mut self, method: &str) -> Value {
        self.expect(&format!("notification {method}"), |m| {
            m["method"] == method && m.get("id").is_none()
        })
        .await
    }

    /// The next core→client request named `method`.
    async fn server_request(&mut self, method: &str) -> Value {
        self.expect(&format!("request {method}"), |m| {
            m["method"] == method && m.get("id").is_some()
        })
        .await
    }

    async fn reply(&mut self, id: &Value, result: Value) {
        self.write(json!({"jsonrpc": "2.0", "id": id, "result": result}))
            .await;
    }

    /// Sends `shutdown`, checks the `{}` reply, and asserts the process exits
    /// 0 on its own while stdin is still open.
    async fn shutdown(mut self) {
        let result = self.call("shutdown", Value::Null).await;
        assert_eq!(result, json!({}));
        let status = tokio::time::timeout(WAIT, self.child.wait())
            .await
            .expect("core exits after shutdown")
            .unwrap();
        assert_eq!(status.code(), Some(0));
        // Only now let go of stdin, so EOF cannot be what ended the process.
        drop(self.stdin.take());
    }
}

struct Workspace {
    _dirs: Vec<TempDir>,
    /// The root as the client spells it.
    root: PathBuf,
}

impl Workspace {
    fn new() -> Workspace {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("main.py"), DOC).unwrap();
        Workspace {
            _dirs: vec![dir],
            root,
        }
    }

    /// A workspace the client opened through a symlink (like macOS `/tmp`
    /// or a symlinked `~/projects`): `root` is not canonical.
    fn via_symlink() -> Workspace {
        let real = Workspace::new();
        let links = tempfile::tempdir().unwrap();
        let root = links.path().canonicalize().unwrap().join("ws-link");
        std::os::unix::fs::symlink(&real.root, &root).unwrap();
        assert_ne!(root.canonicalize().unwrap(), root);
        let mut dirs = real._dirs;
        dirs.push(links);
        Workspace { _dirs: dirs, root }
    }

    fn uri(&self, rel: &str) -> String {
        path_to_uri(&self.root.join(rel))
    }
}

fn settings(mock: &MockOllama) -> Value {
    json!({
        "ollamaUrl": mock.url,
        "completionModel": "coder",
        "chatModel": "chat",
    })
}

async fn initialize(core: &mut Core, ws: &Workspace, mock: &MockOllama) -> Value {
    core.call(
        "initialize",
        json!({"workspaceRoot": ws.root, "settings": settings(mock)}),
    )
    .await
}

async fn open_main(core: &mut Core, ws: &Workspace) {
    core.notify(
        "textDocument/didOpen",
        json!({"uri": ws.uri("main.py"), "languageId": "python", "version": 1, "text": DOC}),
    )
    .await;
}

fn complete_params(ws: &Workspace, id: &str) -> Value {
    json!({"uri": ws.uri("main.py"), "position": {"line": 1, "character": 11}, "requestId": id})
}

#[tokio::test]
async fn completion_and_approved_edit_over_stdio() {
    let mock = MockOllama::start(Script {
        models: vec!["coder".to_owned(), "chat".to_owned()],
        generate: vec![vec![
            generate_chunk("a"),
            generate_chunk(" + b"),
            generate_done(),
        ]],
        chat: vec![
            vec![
                chat_tool_call(
                    "call_1",
                    0,
                    "edit_file",
                    json!({"path": "main.py", "old": "print(add(1, 2))", "new": "print(add(3, 4))"}),
                ),
                chat_done(),
            ],
            vec![chat_text("Done."), chat_done()],
        ],
        ..Script::default()
    })
    .await;
    let ws = Workspace::new();
    let mut core = Core::spawn(&ws.root);

    let init = initialize(&mut core, &ws, &mock).await;
    assert_eq!(init["ollamaStatus"]["ollama"], "ok", "{init}");
    // Same `{ ollama, detail }` shape as the `status` notification.
    let keys: Vec<&String> = init["ollamaStatus"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["detail", "ollama"], "{init}");
    assert_eq!(init["indexStatus"], "building");
    // The core's state dir is git-ignored from the start (the log is in it).
    assert_eq!(
        std::fs::read_to_string(ws.root.join(".localpilot/.gitignore")).unwrap(),
        "*\n"
    );
    assert!(ws.root.join(".localpilot/core.log").exists());
    assert_eq!(init["capabilities"]["completion"], true);
    assert_eq!(init["capabilities"]["chat"], true);
    assert_eq!(init["capabilities"]["bench"], false);
    let ready = core.notification("index/ready").await;
    assert_eq!(ready["params"]["files"], 1, "{ready}");

    open_main(&mut core, &ws).await;
    let completion = core
        .call("completion/request", complete_params(&ws, "r1"))
        .await;
    assert_eq!(completion["items"][0]["text"], "a + b", "{completion}");

    let session = core.call("chat/newSession", Value::Null).await;
    let session_id = session["sessionId"].as_str().unwrap().to_owned();
    let sent = core
        .call(
            "chat/send",
            json!({"sessionId": session_id, "message": "use 3 and 4"}),
        )
        .await;
    assert_eq!(sent, json!({}));

    let call = core.notification("chat/toolCall").await;
    assert_eq!(call["params"]["requiresApproval"], true, "{call}");
    let call_id = call["params"]["toolCallId"].clone();
    core.call(
        "chat/approve",
        json!({"sessionId": session_id, "toolCallId": call_id, "decision": "once"}),
    )
    .await;

    let edit = core.server_request("workspace/applyEdit").await;
    assert_eq!(edit["params"]["ops"][0]["uri"], ws.uri("main.py"), "{edit}");
    assert_eq!(edit["params"]["ops"][0]["newText"], "print(add(3, 4))");
    let edit_id = edit["id"].clone();
    core.reply(&edit_id, json!({"applied": true})).await;

    let result = core.notification("chat/toolResult").await;
    assert_eq!(result["params"]["ok"], true, "{result}");
    let done = core.notification("chat/done").await;
    assert_eq!(done["params"]["sessionId"], session_id.as_str());
    assert_eq!(done["params"]["stopReason"], "done", "{done}");

    let history = core
        .call("chat/history", json!({"sessionId": session_id}))
        .await;
    assert!(!history["messages"].as_array().unwrap().is_empty());
    let sessions = core.call("chat/listSessions", Value::Null).await;
    assert_eq!(sessions["sessions"][0]["sessionId"], session_id.as_str());

    core.shutdown().await;
}

#[tokio::test]
async fn ollama_down_reports_down_and_empty_completions() {
    let mock = MockOllama::start(Script {
        refuse_connections: true,
        ..Script::default()
    })
    .await;
    let ws = Workspace::new();
    let mut core = Core::spawn(&ws.root);

    let init = initialize(&mut core, &ws, &mock).await;
    assert_eq!(init["ollamaStatus"]["ollama"], "down", "{init}");

    open_main(&mut core, &ws).await;
    let completion = core
        .call("completion/request", complete_params(&ws, "r1"))
        .await;
    assert_eq!(completion, json!({"items": []}));

    core.shutdown().await;
}

#[tokio::test]
async fn protocol_errors_and_pull_progress() {
    let mock = MockOllama::start(Script {
        models: vec!["coder".to_owned(), "chat".to_owned()],
        pull: vec![
            json!({"status": "pulling manifest"}),
            json!({"status": "downloading", "digest": "sha256:1", "total": 100, "completed": 40}),
            json!({"status": "success"}),
        ],
        ..Script::default()
    })
    .await;
    let ws = Workspace::new();
    let mut core = Core::spawn(&ws.root);

    // Before initialize, requests are refused but the core stays up.
    let early = core.send("ollama/status", Value::Null).await;
    assert!(core.response(early).await.get("error").is_some());

    initialize(&mut core, &ws, &mock).await;

    let again = core
        .send(
            "initialize",
            json!({"workspaceRoot": ws.root, "settings": settings(&mock)}),
        )
        .await;
    assert!(core.response(again).await.get("error").is_some());

    let unknown = core.send("no/such", json!({})).await;
    assert_eq!(core.response(unknown).await["error"]["code"], -32601);

    let bad = core.send("chat/history", json!({"nope": 1})).await;
    assert_eq!(core.response(bad).await["error"]["code"], -32602);

    let status = core.call("ollama/status", Value::Null).await;
    assert_eq!(status["ollama"], "ok", "{status}");
    let keys: Vec<&String> = status.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["detail", "ollama"], "{status}");

    let pull = core.send("ollama/pull", json!({"model": "coder"})).await;
    let progress = core.notification("ollama/pullProgress").await;
    assert_eq!(progress["params"]["model"], "coder");
    assert_eq!(progress["params"]["status"], "pulling manifest");
    let progress = core.notification("ollama/pullProgress").await;
    assert_eq!(progress["params"]["completed"], 40);
    assert_eq!(progress["params"]["total"], 100);
    assert_eq!(core.response(pull).await["result"], json!({}));

    core.shutdown().await;
}

#[tokio::test]
async fn second_send_while_a_turn_runs_is_refused_with_one_done() {
    let mock = MockOllama::start(Script {
        models: vec!["coder".to_owned(), "chat".to_owned()],
        chat: vec![vec![chat_text("Slow"), chat_text(" answer."), chat_done()]],
        // Keeps the first turn running while the second send arrives.
        chunk_delay: Duration::from_millis(150),
        ..Script::default()
    })
    .await;
    let ws = Workspace::new();
    let mut core = Core::spawn(&ws.root);
    initialize(&mut core, &ws, &mock).await;

    let session = core.call("chat/newSession", Value::Null).await;
    let session_id = session["sessionId"].as_str().unwrap().to_owned();
    let params = json!({"sessionId": session_id, "message": "hi"});
    // Both requests are in flight together; the core handles them concurrently.
    let first = core.send("chat/send", params.clone()).await;
    let second = core.send("chat/send", params).await;
    let first = core.response(first).await;
    let second = core.response(second).await;
    let outcomes = [&first, &second];
    let accepted = outcomes.iter().filter(|r| r["result"] == json!({})).count();
    let refused = outcomes.iter().filter(|r| r.get("error").is_some()).count();
    assert_eq!((accepted, refused), (1, 1), "{first} / {second}");

    let done = core.notification("chat/done").await;
    assert_eq!(done["params"]["stopReason"], "done", "{done}");
    // A round trip after the turn: any second chat/done would be buffered by now.
    core.call("chat/listSessions", Value::Null).await;
    let extra = core
        .buffered
        .iter()
        .filter(|m| m["method"] == "chat/done")
        .count();
    assert_eq!(extra, 0, "{:?}", core.buffered);

    core.shutdown().await;
}

#[tokio::test]
async fn stalled_ollama_times_out_as_down() {
    // Accepts connections and never answers.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let stall = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    let ws = Workspace::new();
    let mut core = Core::spawn(&ws.root);

    let init = core
        .call(
            "initialize",
            json!({"workspaceRoot": ws.root, "settings": {"ollamaUrl": url}}),
        )
        .await;
    assert_eq!(init["ollamaStatus"]["ollama"], "down", "{init}");
    let detail = init["ollamaStatus"]["detail"].as_str().unwrap();
    assert!(detail.contains("timed out"), "{detail}");

    let status = core.call("ollama/status", Value::Null).await;
    assert_eq!(status["ollama"], "down", "{status}");

    core.shutdown().await;
    stall.abort();
}

#[tokio::test]
async fn non_canonical_root_reads_open_buffers_and_edits_the_clients_uri() {
    // The open buffer differs from disk; only the buffer has `add(5, 6)`.
    let buffer = DOC.replace("add(1, 2)", "add(5, 6)");
    let mock = MockOllama::start(Script {
        models: vec!["coder".to_owned(), "chat".to_owned()],
        chat: vec![
            vec![
                chat_tool_call("call_1", 0, "read_file", json!({"path": "main.py"})),
                chat_done(),
            ],
            vec![
                chat_tool_call(
                    "call_2",
                    0,
                    "edit_file",
                    json!({"path": "main.py", "old": "print(add(5, 6))", "new": "print(add(7, 8))"}),
                ),
                chat_done(),
            ],
            vec![chat_text("Done."), chat_done()],
        ],
        ..Script::default()
    })
    .await;
    let ws = Workspace::via_symlink();
    let mut core = Core::spawn(&ws.root);
    initialize(&mut core, &ws, &mock).await;
    core.notification("index/ready").await;
    core.notify(
        "textDocument/didOpen",
        json!({"uri": ws.uri("main.py"), "languageId": "python", "version": 1, "text": buffer}),
    )
    .await;

    let session = core.call("chat/newSession", Value::Null).await;
    let session_id = session["sessionId"].as_str().unwrap().to_owned();
    core.call(
        "chat/send",
        json!({"sessionId": session_id, "message": "use 7 and 8"}),
    )
    .await;

    // read_file saw the buffer, not the disk.
    let read = core.notification("chat/toolResult").await;
    assert_eq!(read["params"]["ok"], true, "{read}");
    let call = core.notification("chat/toolCall").await;
    let call = if call["params"]["toolCallId"] == "call_1" {
        core.notification("chat/toolCall").await
    } else {
        call
    };
    assert_eq!(call["params"]["toolCallId"], "call_2", "{call}");
    assert_eq!(call["params"]["requiresApproval"], true, "{call}");
    core.call(
        "chat/approve",
        json!({"sessionId": session_id, "toolCallId": "call_2", "decision": "once"}),
    )
    .await;

    // The edit was resolved against the buffer and targets the URI the
    // client used for it.
    let edit = core.server_request("workspace/applyEdit").await;
    let op = &edit["params"]["ops"][0];
    assert_eq!(op["uri"], ws.uri("main.py"), "{edit}");
    assert_eq!(op["newText"], "print(add(7, 8))", "{edit}");
    assert_eq!(op["range"]["start"]["line"], 3, "{edit}");
    core.reply(&edit["id"].clone(), json!({"applied": true}))
        .await;
    let done = core.notification("chat/done").await;
    assert_eq!(done["params"]["stopReason"], "done", "{done}");

    let bodies: Vec<Value> = mock
        .received_requests()
        .into_iter()
        .filter(|(path, _)| path == "/api/chat")
        .map(|(_, body)| body)
        .collect();
    let tool_result = bodies[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|m| m["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(tool_result.contains("add(5, 6)"), "{tool_result}");
    assert!(!tool_result.contains("add(1, 2)"), "{tool_result}");

    core.shutdown().await;
}

#[tokio::test]
async fn status_recovers_after_a_failed_chat_turn() {
    let mock = MockOllama::start(Script {
        models: vec!["coder".to_owned(), "chat".to_owned()],
        // The chat stream fails mid-way; the server itself is healthy.
        chat: vec![vec![
            json!({"error": "model runner has unexpectedly stopped"}),
        ]],
        ..Script::default()
    })
    .await;
    let ws = Workspace::new();
    let mut core = Core::spawn(&ws.root);
    let init = initialize(&mut core, &ws, &mock).await;
    assert_eq!(init["ollamaStatus"]["ollama"], "ok", "{init}");

    let session = core.call("chat/newSession", Value::Null).await;
    let session_id = session["sessionId"].as_str().unwrap().to_owned();
    core.call(
        "chat/send",
        json!({"sessionId": session_id, "message": "hi"}),
    )
    .await;

    let down = core.notification("status").await;
    assert_eq!(down["params"]["ollama"], "down", "{down}");
    let done = core.notification("chat/done").await;
    assert_eq!(done["params"]["stopReason"], "error", "{done}");
    // Ollama answers the post-turn probe: the client is told it is ok again,
    // although `ok` is also the last status the core itself reported.
    let up = core.notification("status").await;
    assert_eq!(
        up["params"],
        json!({"ollama": "ok", "detail": up["params"]["detail"]}),
        "{up}"
    );

    core.shutdown().await;
}
