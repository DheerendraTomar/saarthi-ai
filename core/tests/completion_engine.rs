//! Integration tests for the completion engine against the scripted mock
//! Ollama over real HTTP.

#[path = "support/mock_ollama.rs"]
mod mock_ollama;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use localpilot_core::completion::CompletionEngine;
use localpilot_core::index::WorkspaceIndex;
use localpilot_core::ollama::{OllamaClient, OllamaState};
use localpilot_core::overlay::{DocumentStore, path_to_uri};
use localpilot_core::protocol::{CompletionRequestParams, CompletionResult, Position, Range};
use localpilot_core::settings::Settings;
use mock_ollama::{MockOllama, Script, generate_chunk, generate_done};
use serde_json::Value;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

const WAIT: Duration = Duration::from_secs(5);
/// Cursor after `return ` on line 1; the rest of that line is blank.
const DOC: &str = "def add(a, b):\n    return \n\nprint(add(1, 2))\n";
const CURSOR: Position = Position {
    line: 1,
    character: 11,
};

struct Env {
    mock: MockOllama,
    engine: Arc<CompletionEngine>,
    store: Arc<RwLock<DocumentStore>>,
    uri: String,
    _dir: TempDir,
}

async fn setup(script: Script) -> Env {
    setup_with(script, DOC).await
}

async fn setup_with(script: Script, text: &str) -> Env {
    setup_full(script, text, |_| {}).await
}

/// Settings are fixed at construction (the core takes them only at
/// `initialize`); `tweak` adjusts them.
async fn setup_full(script: Script, text: &str, tweak: impl FnOnce(&mut Settings)) -> Env {
    let mock = MockOllama::start(script).await;
    let dir = tempfile::tempdir().unwrap();
    let root: PathBuf = dir.path().canonicalize().unwrap();
    let path = root.join("main.py");
    std::fs::write(&path, text).unwrap();
    let uri = path_to_uri(&path);
    let mut store = DocumentStore::new(root.clone());
    store.did_open(&uri, text.to_owned(), 1);
    let store = Arc::new(RwLock::new(store));
    let index = Arc::new(RwLock::new(WorkspaceIndex::build(&root)));
    let mut settings = Settings {
        ollama_url: mock.url.clone(),
        completion_model: "coder".to_owned(),
        ..Settings::default()
    };
    tweak(&mut settings);
    let ollama = OllamaClient::new(mock.url.clone(), settings.keep_alive.clone());
    let engine = Arc::new(CompletionEngine::new(
        ollama,
        store.clone(),
        index,
        settings,
    ));
    Env {
        mock,
        engine,
        store,
        uri,
        _dir: dir,
    }
}

fn params(env: &Env, id: &str, position: Position) -> CompletionRequestParams {
    CompletionRequestParams {
        uri: env.uri.clone(),
        position,
        request_id: id.to_owned(),
    }
}

async fn complete(env: &Env, id: &str, position: Position) -> CompletionResult {
    let request = env
        .engine
        .request(params(env, id, position), CancellationToken::new());
    tokio::time::timeout(WAIT, request)
        .await
        .expect("request finishes")
        .expect("completion never fails")
}

fn generate_bodies(mock: &MockOllama) -> Vec<Value> {
    mock.received_requests()
        .into_iter()
        .filter(|(path, _)| path == "/api/generate")
        .map(|(_, body)| body)
        .collect()
}

async fn wait_for_generate(mock: &MockOllama) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while generate_bodies(mock).is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "no /api/generate request"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn texts(result: &CompletionResult) -> Vec<&str> {
    result.items.iter().map(|i| i.text.as_str()).collect()
}

fn add_script() -> Script {
    Script {
        generate: vec![vec![
            generate_chunk("a"),
            generate_chunk(" + b"),
            generate_done(),
        ]],
        ..Script::default()
    }
}

#[tokio::test]
async fn returns_streamed_completion_and_caches() {
    let env = setup(add_script()).await;

    let first = complete(&env, "r1", CURSOR).await;
    assert_eq!(texts(&first), ["a + b"]);
    assert_eq!(
        first.items[0].range,
        Range {
            start: CURSOR,
            end: CURSOR
        }
    );

    let second = complete(&env, "r2", CURSOR).await;
    assert_eq!(texts(&second), ["a + b"]);

    let bodies = generate_bodies(&env.mock);
    assert_eq!(bodies.len(), 1, "second request is served from the cache");
    let body = &bodies[0];
    assert_eq!(body["model"], "coder");
    assert_eq!(body["prompt"], "def add(a, b):\n    return ");
    assert_eq!(body["suffix"], "\n\nprint(add(1, 2))\n");
    assert_eq!(body["raw"], false);
    assert_eq!(body["stream"], true);
    assert_eq!(body["keep_alive"], "30m");
    assert_eq!(body["options"]["num_predict"], 64);
    assert_eq!(body["options"]["temperature"], 0.0);
    assert!(body["options"].get("stop").is_none(), "stop = []");
    assert_eq!(
        env.engine.last_status().map(|s| s.ollama),
        Some(OllamaState::Ok)
    );
}

#[tokio::test]
async fn typed_prefix_is_served_from_cache() {
    let env = setup(add_script()).await;
    assert_eq!(texts(&complete(&env, "r1", CURSOR).await), ["a + b"]);

    // The user types the first character of the suggestion.
    let typed = DOC.replacen("return \n", "return a\n", 1);
    env.store.write().unwrap().did_open(&env.uri, typed, 2);
    let next = Position {
        line: 1,
        character: 12,
    };
    assert_eq!(texts(&complete(&env, "r2", next).await), [" + b"]);
    assert_eq!(generate_bodies(&env.mock).len(), 1);
}

#[tokio::test]
async fn concurrent_identical_requests_join_one_generation() {
    let env = setup(Script {
        chunk_delay: Duration::from_millis(30),
        ..add_script()
    })
    .await;
    // With the cache off, only in-flight joining can avoid a second call.
    env.engine.set_cache_enabled(false);

    let (a, b) = tokio::join!(complete(&env, "r1", CURSOR), complete(&env, "r2", CURSOR));
    assert_eq!(texts(&a), ["a + b"]);
    assert_eq!(texts(&b), ["a + b"]);
    assert_eq!(generate_bodies(&env.mock).len(), 1);

    // Cache disabled: a later identical request calls the model again.
    complete(&env, "r3", CURSOR).await;
    assert_eq!(generate_bodies(&env.mock).len(), 2);
}

#[tokio::test]
async fn cancel_aborts_http() {
    let env = setup(Script {
        generate: vec![vec![generate_chunk("x"); 200]],
        chunk_delay: Duration::from_millis(20),
        ..Script::default()
    })
    .await;

    let engine = env.engine.clone();
    let p = params(&env, "r1", CURSOR);
    let request = tokio::spawn(async move { engine.request(p, CancellationToken::new()).await });
    wait_for_generate(&env.mock).await;
    env.engine.cancel("r1");

    let result = tokio::time::timeout(WAIT, request)
        .await
        .expect("cancelled request returns promptly")
        .unwrap()
        .expect("cancel is not an error");
    assert!(result.items.is_empty());
    assert!(
        env.mock.wait_client_disconnected(WAIT).await,
        "HTTP stream was dropped"
    );
}

#[tokio::test]
async fn caller_token_cancels_too() {
    let env = setup(Script {
        generate: vec![vec![generate_chunk("x"); 200]],
        chunk_delay: Duration::from_millis(20),
        ..Script::default()
    })
    .await;

    let cancel = CancellationToken::new();
    let engine = env.engine.clone();
    let p = params(&env, "r1", CURSOR);
    let token = cancel.clone();
    let request = tokio::spawn(async move { engine.request(p, token).await });
    wait_for_generate(&env.mock).await;
    cancel.cancel();

    let result = tokio::time::timeout(WAIT, request)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.items.is_empty());
    assert!(env.mock.wait_client_disconnected(WAIT).await);
}

#[tokio::test]
async fn paused_returns_empty_without_request() {
    let env = setup(add_script()).await;
    env.engine.set_paused(true);
    assert!(env.engine.is_paused());

    assert!(complete(&env, "r1", CURSOR).await.items.is_empty());
    assert!(generate_bodies(&env.mock).is_empty());

    env.engine.set_paused(false);
    assert_eq!(texts(&complete(&env, "r2", CURSOR).await), ["a + b"]);
}

#[tokio::test]
async fn skips_when_next_char_is_identifier() {
    let env = setup(add_script()).await;
    // Cursor right before `add` on the last line.
    let before_ident = Position {
        line: 3,
        character: 6,
    };
    assert!(complete(&env, "r1", before_ident).await.items.is_empty());
    // Unknown document.
    let mut p = params(&env, "r2", CURSOR);
    p.uri = "file:///nowhere/else.py".to_owned();
    let unknown = env
        .engine
        .request(p, CancellationToken::new())
        .await
        .unwrap();
    assert!(unknown.items.is_empty());
    assert!(generate_bodies(&env.mock).is_empty());
}

#[tokio::test]
async fn skips_when_disabled_or_document_too_large() {
    let disabled = setup_full(add_script(), DOC, |s| s.completions_enabled = false).await;
    assert!(complete(&disabled, "r1", CURSOR).await.items.is_empty());
    assert!(generate_bodies(&disabled.mock).is_empty());

    let env = setup(add_script()).await;
    let huge = format!("{DOC}{}", "#".repeat(1 << 20));
    env.store.write().unwrap().did_open(&env.uri, huge, 2);
    assert!(complete(&env, "r2", CURSOR).await.items.is_empty());
    assert!(generate_bodies(&env.mock).is_empty());
}

#[tokio::test]
async fn ollama_down_returns_empty_and_sets_status() {
    let env = setup(Script {
        refuse_connections: true,
        ..Script::default()
    })
    .await;
    assert_eq!(env.engine.last_status(), None);

    let result = complete(&env, "r1", CURSOR).await;
    assert!(result.items.is_empty());
    assert_eq!(
        env.engine.last_status().map(|s| s.ollama),
        Some(OllamaState::Down)
    );
}

#[tokio::test]
async fn missing_model_returns_empty_and_sets_status() {
    let env = setup(Script {
        fail_with: Some(404),
        ..Script::default()
    })
    .await;

    assert!(complete(&env, "r1", CURSOR).await.items.is_empty());
    assert_eq!(
        env.engine.last_status().map(|s| s.ollama),
        Some(OllamaState::ModelMissing)
    );
}

#[tokio::test]
async fn stop_rule_cancels_stream_and_crlf_is_kept() {
    let doc = "x = foo(\r\n\r\ny = 2\r\n";
    let mut lines = vec![generate_chunk("a,\nb)\n"), generate_chunk("\n")];
    lines.extend(std::iter::repeat_n(generate_chunk("zzz\n"), 200));
    let env = setup_with(
        Script {
            generate: vec![lines],
            chunk_delay: Duration::from_millis(10),
            ..Script::default()
        },
        doc,
    )
    .await;
    let end_of_line = Position {
        line: 0,
        character: 8,
    };
    // The block closes the `(` from the prefix, then a blank line: stop there
    // and drop the HTTP stream instead of reading the remaining lines.
    let result = complete(&env, "r1", end_of_line).await;
    assert_eq!(texts(&result), ["a,\r\nb)"]);
    assert!(env.mock.wait_client_disconnected(WAIT).await);
}

#[tokio::test]
async fn rejected_suggestion_is_evicted_from_cache() {
    let env = setup(add_script()).await;
    complete(&env, "r1", CURSOR).await;
    env.engine.on_rejected("r1");
    complete(&env, "r2", CURSOR).await;
    assert_eq!(generate_bodies(&env.mock).len(), 2);

    env.engine.on_accepted("r2");
    complete(&env, "r3", CURSOR).await;
    assert_eq!(generate_bodies(&env.mock).len(), 2);
}

#[tokio::test]
async fn rejecting_a_typed_prefix_hit_evicts_the_cached_suggestion() {
    let env = setup(add_script()).await;
    assert_eq!(texts(&complete(&env, "r1", CURSOR).await), ["a + b"]);

    let typed = DOC.replacen("return \n", "return a\n", 1);
    env.store.write().unwrap().did_open(&env.uri, typed, 2);
    let next = Position {
        line: 1,
        character: 12,
    };
    assert_eq!(texts(&complete(&env, "r2", next).await), [" + b"]);
    env.engine.on_rejected("r2");

    // Not offered again from the cache: the model is asked.
    complete(&env, "r3", next).await;
    assert_eq!(generate_bodies(&env.mock).len(), 2);
}

#[tokio::test]
async fn typed_prefix_hit_on_large_file() {
    let body: String = (0..800)
        .map(|i| format!("value_{i} = add({i}, {i})  # padding\n"))
        .collect();
    let doc = format!("{body}def add(a, b):\n    return \n");
    let env = setup_with(add_script(), &doc).await;
    let cursor = Position {
        line: 801,
        character: 11,
    };
    assert_eq!(texts(&complete(&env, "r1", cursor).await), ["a + b"]);
    let prompt = generate_bodies(&env.mock)[0]["prompt"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(prompt.len() <= 2048 * 4 && prompt.starts_with("value_"));

    let typed = doc.replacen("    return \n", "    return a\n", 1);
    env.store.write().unwrap().did_open(&env.uri, typed, 2);
    let next = Position {
        line: 801,
        character: 12,
    };
    assert_eq!(texts(&complete(&env, "r2", next).await), [" + b"]);
    assert_eq!(generate_bodies(&env.mock).len(), 1);
}

#[tokio::test]
async fn pausing_aborts_a_running_generation() {
    let env = setup(Script {
        generate: vec![vec![generate_chunk("x"); 200]],
        chunk_delay: Duration::from_millis(20),
        ..Script::default()
    })
    .await;

    let engine = env.engine.clone();
    let p = params(&env, "r1", CURSOR);
    let request = tokio::spawn(async move { engine.request(p, CancellationToken::new()).await });
    wait_for_generate(&env.mock).await;
    env.engine.set_paused(true);

    let result = tokio::time::timeout(WAIT, request)
        .await
        .expect("paused request returns promptly")
        .unwrap()
        .unwrap();
    assert!(result.items.is_empty());
    assert!(env.mock.wait_client_disconnected(WAIT).await);
    assert_eq!(generate_bodies(&env.mock).len(), 1);
}

#[tokio::test]
async fn request_timed_stamps_send_first_chunk_and_done_in_order() {
    let env = setup(add_script()).await;
    let (result, t) = tokio::time::timeout(
        WAIT,
        env.engine
            .request_timed(params(&env, "t1", CURSOR), CancellationToken::new()),
    )
    .await
    .expect("request finishes");
    assert_eq!(texts(&result.expect("completion never fails")), ["a + b"]);
    let sent = t.prepared_at.expect("HTTP send stamped");
    let first = t.first_token_at.expect("first chunk stamped");
    assert!(t.started_at <= sent && sent <= first && first <= t.done_at);

    // A cache hit makes no HTTP call, so it has no send or chunk stamps.
    let (_, hit) = env
        .engine
        .request_timed(params(&env, "t2", CURSOR), CancellationToken::new())
        .await;
    assert!(hit.prepared_at.is_none() && hit.first_token_at.is_none());
    assert!(hit.started_at <= hit.done_at);
}
