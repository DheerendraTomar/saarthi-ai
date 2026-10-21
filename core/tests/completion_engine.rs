//! Integration tests for the completion engine against the scripted mock
//! Ollama over real HTTP.

#[path = "support/mock_ollama.rs"]
mod mock_ollama;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use localpilot_core::completion::CompletionEngine;
use localpilot_core::completion::feedback::{self, FeedbackLog, Outcome};
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
    root: PathBuf,
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
    let root_out = root.clone();
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
        root: root_out,
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
    assert_eq!(
        body["options"]["num_predict"],
        Settings::default().completion_max_tokens
    );
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

#[tokio::test]
async fn served_suggestion_logged_on_outcome_with_bounded_context_tail() {
    // Far more than 200 characters before the cursor, with sentinels both
    // far above the cursor and after it: neither may reach the log.
    let text = format!(
        "# FAR_SENTINEL {}\ndef add(a, b):\n    return \n\nprint(add(1, 2))  # SUFFIX_SENTINEL\n",
        "x".repeat(300)
    );
    let env = setup_with(add_script(), &text).await;
    let log = Arc::new(FeedbackLog::for_workspace(&env.root));
    env.engine.set_feedback_log(log.clone());
    let at = Position {
        line: 2,
        character: 11,
    };
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    assert_eq!(texts(&complete(&env, "r1", at).await), ["a + b"]);
    log.flush().await;
    assert!(
        log.records().is_empty(),
        "logged only once the outcome is known"
    );

    env.engine
        .on_outcome("r1", Outcome::Partial, Some("a".to_owned()));
    log.flush().await;
    let raw = std::fs::read_to_string(log.path()).unwrap();
    assert_eq!(raw.lines().count(), 1, "{raw}");
    for leaked in ["FAR_SENTINEL", "SUFFIX_SENTINEL", "print(add", "# "] {
        assert!(!raw.contains(leaked), "{leaked:?} leaked into {raw}");
    }
    let record: Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
    let mut keys: Vec<&String> = record.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "acceptedText",
            "contextTail",
            "ext",
            "lang",
            "lines",
            "maxLines",
            "model",
            "numPredict",
            "outcome",
            "promptHash",
            "requestId",
            "suggestion",
            "totalMs",
            "ts",
            "ttftMs"
        ],
        "{record}"
    );
    let tail = record["contextTail"].as_str().unwrap();
    assert!(tail.chars().count() <= feedback::CONTEXT_TAIL_CHARS);
    assert_eq!(tail.chars().count(), feedback::CONTEXT_TAIL_CHARS);
    assert!(tail.ends_with("x\ndef add(a, b):\n    return "), "{tail:?}");
    assert_eq!(record["requestId"], "r1");
    assert_eq!(record["lang"], "python");
    assert_eq!(record["ext"], "py");
    assert_eq!(record["model"], "coder");
    assert_eq!(record["maxLines"], 8, "rest of the line is blank");
    assert_eq!(
        record["numPredict"],
        Settings::default().completion_max_tokens
    );
    assert_eq!(record["suggestion"], "a + b");
    assert_eq!(record["lines"], 1);
    assert_eq!(record["outcome"], "partial");
    assert_eq!(record["acceptedText"], "a");
    let body = &generate_bodies(&env.mock)[0];
    assert_eq!(
        record["promptHash"],
        feedback::prompt_hash(
            body["prompt"].as_str().unwrap(),
            body["suffix"].as_str().unwrap()
        )
    );
    let ttft = record["ttftMs"].as_u64().expect("generation started here");
    assert!(ttft <= record["totalMs"].as_u64().unwrap());
    assert!(record["ts"].as_u64().unwrap() >= before);

    // Nothing else is written to the state dir.
    let mut files: Vec<String> = std::fs::read_dir(env.root.join(".localpilot"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    assert_eq!(files, [".gitignore", "completions.jsonl"]);

    // A second outcome for the same request is ignored.
    env.engine.on_outcome("r1", Outcome::Rejected, None);
    log.flush().await;
    assert_eq!(log.records().len(), 1);

    // A cache hit is logged with no time to first token.
    assert_eq!(texts(&complete(&env, "r2", at).await), ["a + b"]);
    env.engine.on_accepted("r2");
    log.flush().await;
    let hit = &log.records()[1];
    assert_eq!(hit.outcome, Outcome::Accepted);
    assert_eq!(hit.ttft_ms, None);
    assert_eq!(hit.accepted_text, None);
}

/// A python outcome record for seeding the learning view.
fn seed(id: &str, suggestion: &str, outcome: Outcome) -> feedback::Record {
    feedback::Record {
        ts: feedback::now_ms(),
        request_id: id.to_owned(),
        lang: "python".to_owned(),
        ext: Some("py".to_owned()),
        prompt_hash: "0".repeat(16),
        context_tail: format!("# ctx {id}\n"),
        suggestion: suggestion.to_owned(),
        lines: feedback::line_count(suggestion),
        outcome,
        accepted_text: None,
        ttft_ms: None,
        total_ms: 1,
        model: None,
        max_lines: Some(8),
        num_predict: Some(32),
    }
}

#[tokio::test]
async fn learned_limits_reach_the_model_request() {
    // The model streams a 6-line block; the learned cap is 4 lines.
    let block: Vec<String> = (0..6).map(|i| format!("v{i} = {i}\n    ")).collect();
    let mut chunks: Vec<Value> = block.iter().map(|l| generate_chunk(l)).collect();
    chunks.push(generate_done());
    let env = setup(Script {
        generate: vec![chunks],
        ..Script::default()
    })
    .await;
    let log = Arc::new(FeedbackLog::for_workspace(&env.root));
    env.engine.set_feedback_log(log.clone());
    for i in 0..20 {
        log.submit(seed(
            &format!("long{i}"),
            "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6",
            Outcome::Rejected,
        ));
    }
    for i in 0..10 {
        log.submit(seed(
            &format!("two{i}"),
            &format!("ex{i} = 1\nex{i} += 1"),
            Outcome::Accepted,
        ));
    }
    log.flush().await;
    env.engine.refresh_snippets(&env.uri).await;

    let result = complete(&env, "r1", CURSOR).await;
    let text = texts(&result)[0];
    assert_eq!(text.lines().count(), 4, "{text:?}");
    let body = &generate_bodies(&env.mock)[0];
    assert_eq!(body["options"]["num_predict"], 16, "{body}");
    let prompt = body["prompt"].as_str().unwrap();
    assert!(
        prompt.starts_with("# Example\n# ctx two9\nex9 = 1\nex9 += 1\n\n"),
        "{prompt:?}"
    );

    env.engine.on_outcome("r1", Outcome::Accepted, None);
    log.flush().await;
    let record = log.records().pop().unwrap();
    assert_eq!((record.max_lines, record.num_predict), (Some(4), Some(16)));
}

#[tokio::test]
async fn typed_prefix_hit_creates_no_new_log_record() {
    let env = setup(add_script()).await;
    let log = Arc::new(FeedbackLog::for_workspace(&env.root));
    env.engine.set_feedback_log(log.clone());
    assert_eq!(texts(&complete(&env, "r1", CURSOR).await), ["a + b"]);

    // The user types into the suggestion: the rest is served from the
    // cache, twice, without a model call.
    for (n, (typed, rest)) in [("a", " + b"), ("a ", "+ b")].into_iter().enumerate() {
        let doc = DOC.replacen("return \n", &format!("return {typed}\n"), 1);
        env.store
            .write()
            .unwrap()
            .did_open(&env.uri, doc, 2 + n as i32);
        let at = Position {
            line: 1,
            character: 11 + typed.len() as u32,
        };
        assert_eq!(texts(&complete(&env, &format!("t{n}"), at).await), [rest]);
    }
    assert_eq!(generate_bodies(&env.mock).len(), 1);

    // Outcomes for the typed-prefix hits are ignored; the original record
    // carries the outcome of the whole typing run.
    env.engine
        .on_outcome("t0", Outcome::Partial, Some(" ".to_owned()));
    env.engine.on_outcome("t1", Outcome::Accepted, None);
    env.engine.on_outcome("r1", Outcome::Accepted, None);
    env.engine.flush_pending().await;
    let records = log.records();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0].request_id, "r1");
    assert_eq!(records[0].suggestion, "a + b");
    assert_eq!(records[0].outcome, Outcome::Accepted);
    let stats = env.engine.stats().await;
    assert_eq!(stats.languages["python"].served, 1);
}

#[tokio::test]
async fn tenth_multi_line_request_is_generated_with_the_configured_limits() {
    let block: Vec<String> = (0..6).map(|i| format!("v{i} = {i}\n    ")).collect();
    let mut chunks: Vec<Value> = block.iter().map(|l| generate_chunk(l)).collect();
    chunks.push(generate_done());
    let env = setup(Script {
        generate: vec![chunks],
        ..Script::default()
    })
    .await;
    let log = Arc::new(FeedbackLog::for_workspace(&env.root));
    env.engine.set_feedback_log(log.clone());
    for i in 0..20 {
        log.submit(seed(
            &format!("long{i}"),
            "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6",
            Outcome::Rejected,
        ));
    }
    for i in 0..10 {
        log.submit(seed(
            &format!("two{i}"),
            &format!("ex{i} = 1\nex{i} += 1"),
            Outcome::Accepted,
        ));
    }
    log.flush().await;
    env.engine.refresh_snippets(&env.uri).await;

    // 1–9: learned cap 4 (generated once, then exact cache hits).
    for i in 1..=9 {
        let result = complete(&env, &format!("r{i}"), CURSOR).await;
        assert_eq!(texts(&result)[0].lines().count(), 4, "request {i}");
        env.engine
            .on_outcome(&format!("r{i}"), Outcome::Rejected, None);
    }
    // 10th: configured limits, a fresh generation despite the cache.
    let before = generate_bodies(&env.mock).len();
    let result = complete(&env, "r10", CURSOR).await;
    assert_eq!(texts(&result)[0].lines().count(), 6);
    let bodies = generate_bodies(&env.mock);
    assert_eq!(bodies.len(), before + 1);
    assert_eq!(bodies[before]["options"]["num_predict"], 32);
    assert_eq!(bodies[0]["options"]["num_predict"], 16);
    env.engine.on_outcome("r10", Outcome::Accepted, None);
    log.flush().await;
    let record = log.records().pop().unwrap();
    assert_eq!(record.request_id, "r10");
    assert_eq!((record.max_lines, record.num_predict), (Some(8), Some(32)));

    // 11th: back to the learned limits.
    env.store
        .write()
        .unwrap()
        .did_open(&env.uri, DOC.replacen("return \n", "return  \n", 1), 2);
    let result = complete(&env, "r11", CURSOR).await;
    env.engine.on_outcome("r11", Outcome::Rejected, None);
    log.flush().await;
    let record = log.records().pop().unwrap();
    assert_eq!(record.request_id, "r11", "{result:?}");
    assert_eq!((record.max_lines, record.num_predict), (Some(4), Some(16)));
}
