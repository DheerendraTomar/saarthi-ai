//! Scripted stand-in for an Ollama server, shared by integration tests via
//! `#[path = "support/mock_ollama.rs"] mod mock_ollama;`.
//!
//! Serves `/api/version`, `/api/tags`, `/api/ps`, `/api/show`, `/api/pull`,
//! `/api/generate` and `/api/chat` over real HTTP on 127.0.0.1. Streaming endpoints answer
//! with NDJSON, one scripted `Value` per line, each preceded by
//! `Script::chunk_delay`. Every request is recorded (before responding) and
//! the mock notices when a client hangs up mid-stream.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

/// What the mock answers.
#[derive(Debug, Clone)]
pub struct Script {
    /// Returned by `/api/version`.
    pub version: String,
    /// Names returned by `/api/tags`.
    pub models: Vec<String>,
    /// Names returned by `/api/ps`.
    pub loaded: Vec<String>,
    /// Per-model details, by name: `size` and `details.family` in the
    /// `/api/tags` entry and the `capabilities` `/api/show` returns. A model
    /// not listed here has size 0 and no details, and `/api/show` answers 404
    /// for it.
    pub model_info: HashMap<String, ModelInfo>,
    /// One response (NDJSON lines) per `/api/generate` request, consumed in
    /// order; the last one repeats once the list is exhausted.
    pub generate: Vec<Vec<Value>>,
    /// One response (NDJSON lines) per `/api/chat` request, consumed in
    /// order; the last one repeats once the list is exhausted.
    pub chat: Vec<Vec<Value>>,
    /// NDJSON lines streamed for every `/api/pull` request.
    pub pull: Vec<Value>,
    /// Sleep before each streamed line.
    pub chunk_delay: Duration,
    /// Sleep before answering each `/api/show`.
    pub show_delay: Duration,
    /// Every endpoint answers this status with `{"error": …}`. For 404 the
    /// message is Ollama's: `model "<model>" not found, try pulling it first`.
    pub fail_with: Option<u16>,
    /// Hand out the URL of a closed port instead of starting a server.
    pub refuse_connections: bool,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            version: "0.40.6".to_owned(),
            models: Vec::new(),
            loaded: Vec::new(),
            model_info: HashMap::new(),
            generate: Vec::new(),
            chat: Vec::new(),
            pull: Vec::new(),
            chunk_delay: Duration::ZERO,
            show_delay: Duration::ZERO,
            fail_with: None,
            refuse_connections: false,
        }
    }
}

/// What the mock reports about one model (see [`Script::model_info`]).
#[derive(Debug, Clone, Default)]
pub struct ModelInfo {
    pub size: u64,
    /// `details.family` (Ollama sends `""` for some models).
    pub family: String,
    /// `/api/show` `capabilities`, e.g. `["completion", "insert"]`.
    pub capabilities: Vec<String>,
}

/// A mid-stream `/api/generate` chunk.
pub fn generate_chunk(text: &str) -> Value {
    json!({"model": "mock", "created_at": "2026-10-20T16:13:03.609255Z", "response": text, "done": false})
}

/// The final `/api/generate` chunk (includes a `context` array, like Ollama).
pub fn generate_done() -> Value {
    json!({
        "model": "mock", "created_at": "2026-10-20T16:13:03.638916Z", "response": "", "done": true,
        "done_reason": "stop", "context": [750, 23811, 3932],
        "total_duration": 49229958, "load_duration": 371875, "prompt_eval_count": 4,
        "prompt_eval_cached_count": 3, "prompt_eval_duration": 6027000,
        "eval_count": 8, "eval_duration": 41815000
    })
}

/// A mid-stream `/api/chat` text delta.
pub fn chat_text(text: &str) -> Value {
    json!({"model": "mock", "created_at": "2026-10-20T16:13:04.740228Z",
           "message": {"role": "assistant", "content": text}, "done": false})
}

/// A `done:false` `/api/chat` chunk carrying one whole tool call.
pub fn chat_tool_call(id: &str, index: u32, name: &str, arguments: Value) -> Value {
    json!({"model": "mock", "created_at": "2026-10-20T16:13:04.33821Z",
           "message": {"role": "assistant", "content": "", "tool_calls": [
               {"id": id, "function": {"index": index, "name": name, "arguments": arguments}}
           ]}, "done": false})
}

/// The final `/api/chat` chunk.
pub fn chat_done() -> Value {
    json!({"model": "mock", "created_at": "2026-10-20T16:13:05.048745Z",
           "message": {"role": "assistant", "content": ""}, "done": true, "done_reason": "stop",
           "total_duration": 698338042, "load_duration": 264917, "prompt_eval_count": 19,
           "prompt_eval_cached_count": 0, "prompt_eval_duration": 264856375,
           "eval_count": 7, "eval_duration": 432776375})
}

struct Shared {
    script: Script,
    requests: Mutex<Vec<(String, Value)>>,
    generate_calls: AtomicUsize,
    chat_calls: AtomicUsize,
    disconnected: AtomicBool,
    shows_running: AtomicUsize,
    max_shows_running: AtomicUsize,
}

pub struct MockOllama {
    /// Base URL, e.g. `http://127.0.0.1:54321`.
    pub url: String,
    shared: Arc<Shared>,
    server: Option<JoinHandle<()>>,
}

impl MockOllama {
    pub async fn start(script: Script) -> MockOllama {
        let refuse = script.refuse_connections;
        let shared = Arc::new(Shared {
            script,
            requests: Mutex::new(Vec::new()),
            generate_calls: AtomicUsize::new(0),
            chat_calls: AtomicUsize::new(0),
            disconnected: AtomicBool::new(false),
            shows_running: AtomicUsize::new(0),
            max_shows_running: AtomicUsize::new(0),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock listener");
        let url = format!("http://{}", listener.local_addr().unwrap());
        if refuse {
            // Nobody listens on this port once the listener is dropped.
            drop(listener);
            return MockOllama {
                url,
                shared,
                server: None,
            };
        }
        let app = Router::new()
            .route("/api/version", get(version))
            .route("/api/tags", get(tags))
            .route("/api/ps", get(ps))
            .route("/api/show", post(show))
            .route("/api/pull", post(pull))
            .route("/api/generate", post(generate))
            .route("/api/chat", post(chat))
            .with_state(shared.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("mock server");
        });
        MockOllama {
            url,
            shared,
            server: Some(server),
        }
    }

    /// `(path, JSON body)` of every request so far; GETs record `Value::Null`.
    pub fn received_requests(&self) -> Vec<(String, Value)> {
        self.shared.requests.lock().unwrap().clone()
    }

    /// The most `/api/show` requests ever being answered at once.
    pub fn max_concurrent_shows(&self) -> usize {
        self.shared.max_shows_running.load(Ordering::SeqCst)
    }

    /// True once a client hung up before a streamed response was complete.
    pub fn client_disconnected(&self) -> bool {
        self.shared.disconnected.load(Ordering::SeqCst)
    }

    /// Polls [`client_disconnected`](Self::client_disconnected) until it is
    /// true or `within` elapses.
    pub async fn wait_client_disconnected(&self, within: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + within;
        while tokio::time::Instant::now() < deadline {
            if self.client_disconnected() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.client_disconnected()
    }
}

impl Drop for MockOllama {
    fn drop(&mut self) {
        if let Some(server) = self.server.take() {
            server.abort();
        }
    }
}

/// Records the request and returns its parsed body.
async fn record(shared: &Shared, req: Request) -> Value {
    let path = req.uri().path().to_owned();
    let bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .unwrap_or_default();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    shared.requests.lock().unwrap().push((path, body.clone()));
    body
}

/// The scripted failure response, if any.
fn failure(shared: &Shared, body: &Value) -> Option<Response> {
    let code = shared.script.fail_with?;
    let status = StatusCode::from_u16(code).expect("valid status code");
    let message = if code == 404 {
        let model = body.get("model").and_then(Value::as_str).unwrap_or("");
        format!("model \"{model}\" not found, try pulling it first")
    } else {
        "mock failure".to_owned()
    };
    Some((status, axum::Json(json!({"error": message}))).into_response())
}

fn names(shared: &Shared, list: &[String]) -> Value {
    let entries: Vec<Value> = list
        .iter()
        .map(|name| match shared.script.model_info.get(name) {
            Some(info) => json!({
                "name": name, "model": name, "size": info.size, "digest": "0",
                "details": {"parent_model": "", "format": "gguf", "family": info.family,
                            "families": null, "parameter_size": "", "quantization_level": ""}
            }),
            None => json!({"name": name, "model": name, "size": 0, "digest": "0"}),
        })
        .collect();
    json!({"models": entries})
}

/// Streams `lines` as NDJSON; flags a disconnect if the client goes away.
fn ndjson(shared: Arc<Shared>, lines: Vec<Value>) -> Response {
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(1);
    let delay = shared.script.chunk_delay;
    tokio::spawn(async move {
        for line in lines {
            if !delay.is_zero() {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = tx.closed() => {
                        // Hyper dropped the body: the connection is gone.
                        shared.disconnected.store(true, Ordering::SeqCst);
                        return;
                    }
                }
            }
            let mut text = serde_json::to_string(&line).unwrap();
            text.push('\n');
            if tx.send(Ok(Bytes::from(text))).await.is_err() {
                // Hyper dropped the body: the connection is gone.
                shared.disconnected.store(true, Ordering::SeqCst);
                return;
            }
        }
    });
    let body = futures::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .body(Body::from_stream(body))
        .unwrap()
}

async fn version(State(shared): State<Arc<Shared>>, req: Request) -> Response {
    let body = record(&shared, req).await;
    failure(&shared, &body)
        .unwrap_or_else(|| axum::Json(json!({"version": shared.script.version})).into_response())
}

async fn tags(State(shared): State<Arc<Shared>>, req: Request) -> Response {
    let body = record(&shared, req).await;
    failure(&shared, &body)
        .unwrap_or_else(|| axum::Json(names(&shared, &shared.script.models)).into_response())
}

async fn ps(State(shared): State<Arc<Shared>>, req: Request) -> Response {
    let body = record(&shared, req).await;
    failure(&shared, &body)
        .unwrap_or_else(|| axum::Json(names(&shared, &shared.script.loaded)).into_response())
}

async fn show(State(shared): State<Arc<Shared>>, req: Request) -> Response {
    let body = record(&shared, req).await;
    if let Some(resp) = failure(&shared, &body) {
        return resp;
    }
    let running = shared.shows_running.fetch_add(1, Ordering::SeqCst) + 1;
    shared
        .max_shows_running
        .fetch_max(running, Ordering::SeqCst);
    if !shared.script.show_delay.is_zero() {
        tokio::time::sleep(shared.script.show_delay).await;
    }
    shared.shows_running.fetch_sub(1, Ordering::SeqCst);
    let model = body.get("model").and_then(Value::as_str).unwrap_or("");
    match shared.script.model_info.get(model) {
        Some(info) => axum::Json(json!({
            "modelfile": "", "parameters": "", "template": "",
            "details": {"family": info.family},
            "capabilities": info.capabilities,
        }))
        .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": format!("model '{model}' not found")})),
        )
            .into_response(),
    }
}

async fn pull(State(shared): State<Arc<Shared>>, req: Request) -> Response {
    let body = record(&shared, req).await;
    if let Some(resp) = failure(&shared, &body) {
        return resp;
    }
    let lines = shared.script.pull.clone();
    ndjson(shared, lines)
}

async fn generate(State(shared): State<Arc<Shared>>, req: Request) -> Response {
    let body = record(&shared, req).await;
    if let Some(resp) = failure(&shared, &body) {
        return resp;
    }
    let call = shared.generate_calls.fetch_add(1, Ordering::SeqCst);
    let lines = nth_or_last(&shared.script.generate, call);
    ndjson(shared, lines)
}

async fn chat(State(shared): State<Arc<Shared>>, req: Request) -> Response {
    let body = record(&shared, req).await;
    if let Some(resp) = failure(&shared, &body) {
        return resp;
    }
    let call = shared.chat_calls.fetch_add(1, Ordering::SeqCst);
    let lines = nth_or_last(&shared.script.chat, call);
    ndjson(shared, lines)
}

/// Response `call` of a per-request script; the last one repeats.
fn nth_or_last(responses: &[Vec<Value>], call: usize) -> Vec<Value> {
    responses
        .get(call)
        .or_else(|| responses.last())
        .cloned()
        .unwrap_or_default()
}
