//! Integration tests for the Ollama client, run against the scripted mock
//! server over real HTTP.

#[path = "support/mock_ollama.rs"]
mod mock_ollama;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use futures::StreamExt;
use localpilot_core::ollama::{
    ChatMessage, ChatRequest, GenerateRequest, OllamaClient, OllamaError, OllamaState, Options,
    PullProgress, Role, ToolSpec,
};
use mock_ollama::{
    MockOllama, ModelInfo, Script, chat_done, chat_text, chat_tool_call, generate_chunk,
    generate_done,
};
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const KEEP_ALIVE: &str = "30m";
const WAIT: Duration = Duration::from_secs(5);

fn client(mock: &MockOllama) -> OllamaClient {
    OllamaClient::new(mock.url.clone(), KEEP_ALIVE.to_owned())
}

fn options() -> Options {
    Options {
        num_predict: 32,
        temperature: 0.0,
        stop: vec!["\n\n".to_owned()],
        num_ctx: None,
    }
}

fn fim_request(model: &str) -> GenerateRequest {
    GenerateRequest {
        model: model.to_owned(),
        prompt: "def add(a, b):\n    ".to_owned(),
        suffix: Some("\n\ndef sub(a, b):\n    return a - b\n".to_owned()),
        raw: false,
        stream: true,
        options: options(),
        keep_alive: None,
    }
}

fn weather_tool() -> ToolSpec {
    ToolSpec::function(
        "get_weather",
        "Get the current weather for a city",
        json!({"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}),
    )
}

#[tokio::test]
async fn generate_stream_yields_chunks_in_order() {
    let mock = MockOllama::start(Script {
        generate: vec![vec![
            generate_chunk("return"),
            generate_chunk(" a"),
            generate_chunk(" + b"),
            generate_done(),
        ]],
        ..Script::default()
    })
    .await;

    let stream = client(&mock)
        .generate_stream(fim_request("coder"), CancellationToken::new())
        .await
        .expect("stream starts");
    let chunks: Vec<_> = tokio::time::timeout(WAIT, stream.collect::<Vec<_>>())
        .await
        .expect("stream finishes");
    let chunks: Vec<_> = chunks.into_iter().map(|c| c.expect("chunk ok")).collect();

    let texts: Vec<&str> = chunks.iter().map(|c| c.response.as_str()).collect();
    assert_eq!(texts, ["return", " a", " + b", ""]);
    assert!(chunks[..3].iter().all(|c| !c.done));
    let last = chunks.last().unwrap();
    assert!(last.done);
    assert_eq!(last.done_reason.as_deref(), Some("stop"));
    assert_eq!(last.prompt_eval_count, Some(4));
    assert_eq!(last.prompt_eval_cached_count, Some(3));
    assert_eq!(last.prompt_eval_duration, Some(6027000));
    assert_eq!(last.eval_count, Some(8));
    assert_eq!(last.eval_duration, Some(41815000));
    assert_eq!(last.total_duration, Some(49229958));
    assert_eq!(last.load_duration, Some(371875));

    let requests = mock.received_requests();
    assert_eq!(requests.len(), 1);
    let (path, body) = &requests[0];
    assert_eq!(path, "/api/generate");
    assert_eq!(body["keep_alive"], KEEP_ALIVE);
    assert_eq!(body["suffix"], "\n\ndef sub(a, b):\n    return a - b\n");
    assert_eq!(body["model"], "coder");
    assert_eq!(body["stream"], true);
    assert_eq!(body["options"]["num_predict"], 32);
    assert_eq!(body["options"]["stop"], json!(["\n\n"]));
}

#[tokio::test]
async fn chat_stream_parses_tool_calls() {
    // Two tool calls arriving in separate done:false chunks (§8b observed one
    // whole call per chunk), then the done:true chunk that does not repeat them.
    let mock = MockOllama::start(Script {
        chat: vec![vec![
            chat_text("Checking"),
            chat_tool_call("call_cg2x9d3s", 0, "get_weather", json!({"city": "Paris"})),
            chat_tool_call("call_q1w2e3r4", 1, "get_weather", json!({"city": "Oslo"})),
            chat_done(),
        ]],
        ..Script::default()
    })
    .await;

    let request = ChatRequest {
        model: "chat".to_owned(),
        messages: vec![
            ChatMessage::user("What is the weather in Paris and Oslo?"),
            ChatMessage::tool("get_weather", "22C sunny"),
        ],
        tools: vec![weather_tool()],
        stream: true,
        think: false,
        options: options(),
        keep_alive: None,
    };
    let stream = client(&mock)
        .chat_stream(request, CancellationToken::new())
        .await
        .expect("stream starts");
    let chunks: Vec<_> = tokio::time::timeout(WAIT, stream.collect::<Vec<_>>())
        .await
        .expect("stream finishes");
    let chunks: Vec<_> = chunks.into_iter().map(|c| c.expect("chunk ok")).collect();

    assert_eq!(chunks.len(), 4);
    assert_eq!(chunks[0].message.content, "Checking");
    assert!(chunks[..3].iter().all(|c| !c.done));
    assert!(
        chunks[..3].iter().all(|c| c.message.tool_calls.is_none()),
        "tool calls are delivered only on the final chunk"
    );
    let last = chunks.last().unwrap();
    assert!(last.done);
    assert_eq!(last.done_reason.as_deref(), Some("stop"));
    assert_eq!(last.message.role, Role::Assistant);
    assert_eq!(last.message.thinking, None);
    let calls = last.message.tool_calls.as_ref().expect("accumulated calls");
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].id.as_deref(), Some("call_cg2x9d3s"));
    assert_eq!(calls[0].function.index, Some(0));
    assert_eq!(calls[0].function.name, "get_weather");
    assert_eq!(calls[0].function.arguments, json!({"city": "Paris"}));
    assert_eq!(calls[1].id.as_deref(), Some("call_q1w2e3r4"));
    assert_eq!(calls[1].function.arguments, json!({"city": "Oslo"}));

    let requests = mock.received_requests();
    let (path, body) = &requests[0];
    assert_eq!(path, "/api/chat");
    assert_eq!(body["keep_alive"], KEEP_ALIVE);
    assert_eq!(body["think"], false);
    assert_eq!(
        body["messages"][1],
        json!({"role": "tool", "content": "22C sunny", "tool_name": "get_weather"})
    );
    assert_eq!(body["tools"][0]["type"], "function");
    assert_eq!(body["tools"][0]["function"]["name"], "get_weather");
}

#[tokio::test]
async fn cancel_token_stops_stream_promptly() {
    let mock = MockOllama::start(Script {
        generate: vec![(0..50).map(|i| generate_chunk(&format!("t{i} "))).collect()],
        chunk_delay: Duration::from_millis(50),
        ..Script::default()
    })
    .await;
    let cancel = CancellationToken::new();
    let started = Instant::now();
    let mut stream = client(&mock)
        .generate_stream(fim_request("coder"), cancel.clone())
        .await
        .expect("stream starts");
    let canceller = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        canceller.cancel();
    });

    let mut received = 0;
    let mut outcome = None;
    while let Some(item) = tokio::time::timeout(WAIT, stream.next())
        .await
        .expect("stream keeps moving")
    {
        match item {
            Ok(_) => received += 1,
            Err(err) => {
                outcome = Some(err);
                break;
            }
        }
    }
    let elapsed = started.elapsed();

    assert_eq!(outcome, Some(OllamaError::Cancelled));
    assert!(
        elapsed < Duration::from_millis(300),
        "stream ended after {elapsed:?}"
    );
    assert!(received < 50, "got all {received} chunks despite cancel");
    assert!(
        tokio::time::timeout(WAIT, stream.next())
            .await
            .expect("stream ends")
            .is_none(),
        "nothing after Cancelled"
    );
    assert!(
        mock.wait_client_disconnected(Duration::from_secs(2)).await,
        "mock never saw the connection close"
    );
}

#[tokio::test]
async fn cancel_drops_connection_while_stream_is_not_polled() {
    // Chunks are 2 s apart, so nothing arrives between cancel and the
    // deadline: only the reader's reaction to the token itself can close the
    // connection in time.
    let mock = MockOllama::start(Script {
        generate: vec![(0..5).map(|i| generate_chunk(&format!("t{i} "))).collect()],
        chunk_delay: Duration::from_secs(2),
        ..Script::default()
    })
    .await;
    let cancel = CancellationToken::new();
    // Held but never polled: the body must still be dropped on cancel.
    let stream = client(&mock)
        .generate_stream(fim_request("coder"), cancel.clone())
        .await
        .expect("stream starts");

    tokio::time::sleep(Duration::from_millis(100)).await;
    cancel.cancel();

    assert!(
        mock.wait_client_disconnected(Duration::from_millis(500))
            .await,
        "connection still open after cancel while the stream was not polled"
    );
    drop(stream);
}

#[tokio::test]
async fn generate_script_advances_per_request() {
    let mock = MockOllama::start(Script {
        generate: vec![
            vec![generate_chunk("first"), generate_done()],
            vec![generate_chunk("second"), generate_done()],
        ],
        ..Script::default()
    })
    .await;
    let client = client(&mock);

    let mut texts = Vec::new();
    for _ in 0..3 {
        let stream = client
            .generate_stream(fim_request("coder"), CancellationToken::new())
            .await
            .expect("stream starts");
        let chunks: Vec<_> = tokio::time::timeout(WAIT, stream.collect::<Vec<_>>())
            .await
            .expect("stream finishes");
        texts.push(chunks[0].as_ref().expect("chunk ok").response.clone());
    }
    // The last response repeats once the script is exhausted.
    assert_eq!(texts, ["first", "second", "second"]);
}

#[tokio::test]
async fn connection_refused_maps_to_down() {
    let mock = MockOllama::start(Script {
        refuse_connections: true,
        ..Script::default()
    })
    .await;
    let client = client(&mock);

    assert!(matches!(client.version().await, Err(OllamaError::Down(_))));
    assert!(matches!(client.models().await, Err(OllamaError::Down(_))));
    let started = client
        .generate_stream(fim_request("coder"), CancellationToken::new())
        .await;
    assert!(matches!(started, Err(OllamaError::Down(_))));

    let status = client.status("coder", "chat").await;
    assert_eq!(status.ollama, OllamaState::Down);
}

#[tokio::test]
async fn http_404_model_maps_to_model_missing() {
    let mock = MockOllama::start(Script {
        fail_with: Some(404),
        ..Script::default()
    })
    .await;
    let client = client(&mock);

    let generate = client
        .generate_stream(fim_request("nope:1b"), CancellationToken::new())
        .await;
    assert!(
        matches!(&generate, Err(OllamaError::ModelMissing(m)) if m == "nope:1b"),
        "generate gave {:?}",
        generate.err()
    );

    let chat = client
        .chat_stream(
            ChatRequest {
                model: "nope:27b".to_owned(),
                messages: vec![ChatMessage::user("hi")],
                tools: Vec::new(),
                stream: true,
                think: false,
                options: options(),
                keep_alive: None,
            },
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(&chat, Err(OllamaError::ModelMissing(m)) if m == "nope:27b"),
        "chat gave {:?}",
        chat.err()
    );
}

#[tokio::test]
async fn status_reports_missing_model_by_name() {
    let mock = MockOllama::start(Script {
        models: vec![
            "qwen2.5-coder:1.5b-base".to_owned(),
            "llama3:latest".to_owned(),
        ],
        ..Script::default()
    })
    .await;
    let client = client(&mock);

    let missing = client
        .status("qwen2.5-coder:1.5b-base", "qwen3.8:27b-mlx")
        .await;
    assert_eq!(missing.ollama, OllamaState::ModelMissing);
    assert!(
        missing.detail.contains("qwen3.8:27b-mlx"),
        "detail: {}",
        missing.detail
    );
    assert!(!missing.detail.contains("qwen2.5-coder"));

    // An untagged name means `:latest`.
    let ok = client.status("qwen2.5-coder:1.5b-base", "llama3").await;
    assert_eq!(ok.ollama, OllamaState::Ok, "detail: {}", ok.detail);
}

#[tokio::test]
async fn pull_forwards_progress() {
    let mock = MockOllama::start(Script {
        pull: vec![
            json!({"status": "pulling manifest"}),
            json!({"status": "pulling 2bada8a74506", "digest": "sha256:2bada8a74506", "total": 100, "completed": 40}),
            json!({"status": "pulling 2bada8a74506", "digest": "sha256:2bada8a74506", "total": 100, "completed": 100}),
            json!({"status": "success"}),
        ],
        ..Script::default()
    })
    .await;
    let (tx, mut rx) = mpsc::channel(16);

    tokio::time::timeout(WAIT, client(&mock).pull("qwen3.8:27b-mlx", tx))
        .await
        .expect("pull finishes")
        .expect("pull ok");

    let mut progress: Vec<PullProgress> = Vec::new();
    while let Some(p) = rx.recv().await {
        progress.push(p);
    }
    let statuses: Vec<&str> = progress.iter().map(|p| p.status.as_str()).collect();
    assert_eq!(
        statuses,
        [
            "pulling manifest",
            "pulling 2bada8a74506",
            "pulling 2bada8a74506",
            "success"
        ]
    );
    assert_eq!(progress[1].completed, Some(40));
    assert_eq!(progress[2].total, Some(100));
    assert_eq!(progress[1].digest.as_deref(), Some("sha256:2bada8a74506"));

    let requests = mock.received_requests();
    assert_eq!(requests[0].0, "/api/pull");
    assert_eq!(requests[0].1["model"], "qwen3.8:27b-mlx");
}

fn info(size: u64, family: &str, capabilities: &[&str]) -> ModelInfo {
    ModelInfo {
        size,
        family: family.to_owned(),
        capabilities: capabilities.iter().map(|c| (*c).to_owned()).collect(),
    }
}

#[tokio::test]
async fn models_lists_installed_with_capabilities() {
    let mock = MockOllama::start(Script {
        models: vec![
            "qwen2.5-coder:1.5b-base".to_owned(),
            "qwen3:8b".to_owned(),
            "mlx-model:latest".to_owned(),
            "broken:latest".to_owned(),
        ],
        model_info: HashMap::from([
            (
                "qwen2.5-coder:1.5b-base".to_owned(),
                info(2_122_024_222, "qwen2", &["completion", "insert"]),
            ),
            (
                "qwen3:8b".to_owned(),
                info(5_225_388_164, "qwen3", &["completion", "tools", "thinking"]),
            ),
            // Ollama sends `family: ""` for some models (e.g. MLX ones).
            (
                "mlx-model:latest".to_owned(),
                info(20_062_412_916, "", &["completion", "insert", "tools"]),
            ),
            // "broken" has no entry: `/api/show` answers 404 for it.
        ]),
        ..Script::default()
    })
    .await;

    let models = client(&mock).list_models().await.unwrap();
    let wire = serde_json::to_value(&models).unwrap();
    assert_eq!(
        wire,
        json!([
            {"name": "qwen2.5-coder:1.5b-base", "sizeBytes": 2_122_024_222u64, "family": "qwen2",
             "supportsInsert": true, "supportsTools": false},
            {"name": "qwen3:8b", "sizeBytes": 5_225_388_164u64, "family": "qwen3",
             "supportsInsert": false, "supportsTools": true},
            {"name": "mlx-model:latest", "sizeBytes": 20_062_412_916u64,
             "supportsInsert": true, "supportsTools": true},
            {"name": "broken:latest", "sizeBytes": 0,
             "supportsInsert": false, "supportsTools": false},
        ])
    );

    // One `/api/show` per installed model per call, asking by name.
    let shows: Vec<_> = mock
        .received_requests()
        .into_iter()
        .filter(|(path, _)| path == "/api/show")
        .map(|(_, body)| body["model"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(shows.len(), 4, "{shows:?}");
    assert!(shows.contains(&"qwen3:8b".to_owned()));

    // Ollama down: the listing fails with `Down`, not an empty list.
    let down = MockOllama::start(Script {
        refuse_connections: true,
        ..Script::default()
    })
    .await;
    assert!(matches!(
        client(&down).list_models().await,
        Err(OllamaError::Down(_))
    ));
}
