//! HTTP client for Ollama with NDJSON streaming and hard cancellation.
//!
//! Streaming responses are read by a spawned task that owns the HTTP body.
//! When the caller's [`CancellationToken`] fires (or the caller drops the
//! stream) that task drops the body at once, closing the connection so Ollama
//! stops generating, whether or not the caller is currently polling.

use std::error::Error as StdError;
use std::time::Duration;

use futures::stream::{self, BoxStream};
use futures::{Stream, StreamExt};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::types::*;
use super::{OllamaError, OllamaState, OllamaStatus, Result};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// Parsed lines buffered between the body reader task and the consumer.
const STREAM_BUFFER: usize = 16;

/// Client for one Ollama server. Cheap to clone.
#[derive(Debug, Clone)]
pub struct OllamaClient {
    http: reqwest::Client,
    base_url: String,
    keep_alive: String,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

#[derive(Deserialize)]
struct VersionBody {
    version: String,
}

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    models: Option<Vec<ModelEntry>>,
}

#[derive(Deserialize)]
struct ModelEntry {
    name: String,
}

impl OllamaClient {
    /// `keep_alive` is sent with every generate/chat request that does not set
    /// its own.
    pub fn new(base_url: String, keep_alive: String) -> Self {
        // No total timeout: generations can legitimately run for minutes.
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .expect("HTTP client configuration is valid");
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_owned(),
            keep_alive,
        }
    }

    /// `GET /api/version`.
    pub async fn version(&self) -> Result<String> {
        let body: VersionBody = self.get_json("/api/version").await?;
        Ok(body.version)
    }

    /// Names of locally available models (`GET /api/tags`).
    pub async fn models(&self) -> Result<Vec<String>> {
        let body: ModelList = self.get_json("/api/tags").await?;
        Ok(body.names())
    }

    /// Names of models currently loaded in memory (`GET /api/ps`).
    pub async fn loaded_models(&self) -> Result<Vec<String>> {
        let body: ModelList = self.get_json("/api/ps").await?;
        Ok(body.names())
    }

    /// `POST /api/pull`, forwarding every progress line to `progress` until
    /// Ollama reports `success`. A closed `progress` receiver does not stop
    /// the pull.
    pub async fn pull(&self, model: &str, progress: mpsc::Sender<PullProgress>) -> Result<()> {
        let request = self
            .http
            .post(self.url("/api/pull"))
            .json(&json!({"model": model, "stream": true}));
        let response = self.send(request, Some(model)).await?;
        let mut lines = ndjson_stream(response, CancellationToken::new(), |p: &PullProgress| {
            p.status == "success"
        });
        while let Some(line) = lines.next().await {
            let _ = progress.send(line?).await;
        }
        Ok(())
    }

    /// Streaming `POST /api/generate`.
    ///
    /// When `cancel` fires the stream yields `Err(Cancelled)` and ends, and
    /// the HTTP body is dropped immediately.
    pub async fn generate_stream(
        &self,
        mut req: GenerateRequest,
        cancel: CancellationToken,
    ) -> Result<impl Stream<Item = Result<GenerateChunk>> + Send + Unpin + 'static> {
        req.keep_alive
            .get_or_insert_with(|| self.keep_alive.clone());
        let request = self.http.post(self.url("/api/generate")).json(&req);
        let response = self.send_cancellable(request, &req.model, &cancel).await?;
        Ok(ndjson_stream(response, cancel, |c: &GenerateChunk| c.done))
    }

    /// Streaming `POST /api/chat`.
    ///
    /// Tool calls are accumulated: every `done:false` chunk is yielded with
    /// `message.tool_calls == None`, and the `done:true` chunk carries all of
    /// the turn's tool calls in arrival order (or `None` if there were none).
    /// Cancellation behaves as for [`generate_stream`](Self::generate_stream).
    pub async fn chat_stream(
        &self,
        mut req: ChatRequest,
        cancel: CancellationToken,
    ) -> Result<impl Stream<Item = Result<ChatChunk>> + Send + Unpin + 'static> {
        req.keep_alive
            .get_or_insert_with(|| self.keep_alive.clone());
        let request = self.http.post(self.url("/api/chat")).json(&req);
        let response = self.send_cancellable(request, &req.model, &cancel).await?;
        let mut calls: Vec<ToolCall> = Vec::new();
        let chunks = ndjson_stream(response, cancel, |c: &ChatChunk| c.done).map(move |item| {
            item.map(|mut chunk| {
                if let Some(new_calls) = chunk.message.tool_calls.take() {
                    calls.extend(new_calls);
                }
                if chunk.done && !calls.is_empty() {
                    chunk.message.tool_calls = Some(std::mem::take(&mut calls));
                }
                chunk
            })
        });
        Ok(chunks)
    }

    /// Health of the server and of the two configured models.
    pub async fn status(&self, completion_model: &str, chat_model: &str) -> OllamaStatus {
        let down = |err: OllamaError| OllamaStatus {
            state: OllamaState::Down,
            detail: err.to_string(),
        };
        let version = match self.version().await {
            Ok(version) => version,
            Err(err) => return down(err),
        };
        let installed = match self.models().await {
            Ok(models) => models,
            Err(err) => return down(err),
        };
        let mut wanted = vec![completion_model];
        if chat_model != completion_model {
            wanted.push(chat_model);
        }
        let missing: Vec<String> = wanted
            .into_iter()
            .filter(|model| !installed.iter().any(|name| same_model(name, model)))
            .map(|model| format!("model \"{model}\" is not installed (run `ollama pull {model}`)"))
            .collect();
        if missing.is_empty() {
            OllamaStatus {
                state: OllamaState::Ok,
                detail: format!("Ollama {version}"),
            }
        } else {
            OllamaStatus {
                state: OllamaState::ModelMissing,
                detail: missing.join("; "),
            }
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let response = self.send(self.http.get(self.url(path)), None).await?;
        let bytes = response
            .bytes()
            .await
            .map_err(|err| OllamaError::Other(describe(&err)))?;
        serde_json::from_slice(&bytes)
            .map_err(|err| OllamaError::Other(format!("unexpected response from {path}: {err}")))
    }

    /// Sends `request`; transport failures and non-2xx statuses become errors.
    /// `model` names the model a 404 "not found" refers to.
    async fn send(
        &self,
        request: reqwest::RequestBuilder,
        model: Option<&str>,
    ) -> Result<reqwest::Response> {
        let response = request.send().await.map_err(|err| {
            if err.is_connect() || err.is_timeout() {
                OllamaError::Down(format!("{}: {}", self.base_url, describe(&err)))
            } else {
                OllamaError::Other(describe(&err))
            }
        })?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let text = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<ErrorBody>(&text)
            .map(|body| body.error)
            .unwrap_or(text);
        if status.as_u16() == 404 && message.to_lowercase().contains("not found") {
            return Err(OllamaError::ModelMissing(
                model.map(str::to_owned).unwrap_or(message),
            ));
        }
        Err(OllamaError::Http(status.as_u16(), message))
    }

    async fn send_cancellable(
        &self,
        request: reqwest::RequestBuilder,
        model: &str,
        cancel: &CancellationToken,
    ) -> Result<reqwest::Response> {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(OllamaError::Cancelled),
            response = self.send(request, Some(model)) => response,
        }
    }
}

impl ModelList {
    fn names(self) -> Vec<String> {
        self.models
            .unwrap_or_default()
            .into_iter()
            .map(|m| m.name)
            .collect()
    }
}

/// `installed` (from `/api/tags`, always tagged) matches `wanted`, where an
/// untagged `wanted` means `:latest`.
fn same_model(installed: &str, wanted: &str) -> bool {
    installed == wanted || (!wanted.contains(':') && installed == format!("{wanted}:latest"))
}

/// The error and its sources, e.g. "error sending request: …: Connection refused".
fn describe(err: &dyn StdError) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// Turns an NDJSON response body into a stream of parsed lines.
///
/// A spawned task owns the body and drops it as soon as `cancel` fires or the
/// returned stream is dropped. The stream yields `Err(Cancelled)` once
/// `cancel` fires (even if parsed lines are still buffered) and then ends. An
/// `{"error": …}` line, an unparsable line, a transport error, or the body
/// ending before a line satisfying `is_last` each yield one `Err` and end the
/// stream.
fn ndjson_stream<T>(
    response: reqwest::Response,
    cancel: CancellationToken,
    is_last: fn(&T) -> bool,
) -> BoxStream<'static, Result<T>>
where
    T: DeserializeOwned + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<Result<T>>(STREAM_BUFFER);
    let reader_cancel = cancel.clone();
    tokio::spawn(async move {
        let mut body = response.bytes_stream();
        let mut lines = LineBuffer::default();
        let mut finished = false;
        loop {
            let next = tokio::select! {
                biased;
                _ = reader_cancel.cancelled() => return,
                _ = tx.closed() => return,
                next = body.next() => next,
            };
            let batch: Vec<Vec<u8>> = match next {
                Some(Ok(bytes)) => {
                    lines.push(&bytes);
                    std::iter::from_fn(|| lines.next_line()).collect()
                }
                Some(Err(err)) => {
                    let err =
                        OllamaError::Other(format!("reading Ollama stream: {}", describe(&err)));
                    forward(&tx, Err(err), &reader_cancel).await;
                    return;
                }
                None => {
                    if let Some(line) = lines.finish() {
                        let item = parse_line(&line);
                        finished |= matches!(&item, Ok(v) if is_last(v));
                        let failed = item.is_err();
                        if !forward(&tx, item, &reader_cancel).await || failed {
                            return;
                        }
                    }
                    if !finished {
                        let err = OllamaError::Other(
                            "Ollama closed the stream before it was done".to_owned(),
                        );
                        forward(&tx, Err(err), &reader_cancel).await;
                    }
                    return;
                }
            };
            for line in batch {
                let item = parse_line(&line);
                finished |= matches!(&item, Ok(v) if is_last(v));
                let failed = item.is_err();
                if !forward(&tx, item, &reader_cancel).await || failed {
                    return;
                }
            }
        }
    });

    stream::unfold(Some((rx, cancel)), |state| async move {
        let (mut rx, cancel) = state?;
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Some((Err(OllamaError::Cancelled), None)),
            item = rx.recv() => match item {
                Some(Ok(value)) => Some((Ok(value), Some((rx, cancel)))),
                Some(Err(err)) => Some((Err(err), None)),
                None => None,
            },
        }
    })
    .boxed()
}

/// Sends `item` unless `cancel` fires first. False if the stream is over.
async fn forward<T>(
    tx: &mpsc::Sender<Result<T>>,
    item: Result<T>,
    cancel: &CancellationToken,
) -> bool {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => false,
        sent = tx.send(item) => sent.is_ok(),
    }
}

fn parse_line<T: DeserializeOwned>(line: &[u8]) -> Result<T> {
    serde_json::from_slice::<T>(line).map_err(|err| {
        match serde_json::from_slice::<ErrorBody>(line) {
            Ok(body) => OllamaError::Other(body.error),
            Err(_) => OllamaError::Other(format!(
                "bad line from Ollama ({err}): {}",
                String::from_utf8_lossy(line)
            )),
        }
    })
}

/// Splits a byte stream into newline-terminated lines, tolerating lines that
/// span reads and a final line without a newline. Blank lines are skipped.
#[derive(Debug, Default)]
struct LineBuffer {
    buf: Vec<u8>,
}

impl LineBuffer {
    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next complete, non-blank line (without its terminator).
    fn next_line(&mut self) -> Option<Vec<u8>> {
        loop {
            let end = self.buf.iter().position(|&b| b == b'\n')?;
            let line: Vec<u8> = self.buf.drain(..=end).collect();
            let trimmed = line.trim_ascii();
            if !trimmed.is_empty() {
                return Some(trimmed.to_vec());
            }
        }
    }

    /// Whatever is left after the body ended, if it is not blank.
    fn finish(&mut self) -> Option<Vec<u8>> {
        let rest = std::mem::take(&mut self.buf);
        let trimmed = rest.trim_ascii();
        (!trimmed.is_empty()).then(|| trimmed.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(buffer: &mut LineBuffer) -> Vec<String> {
        std::iter::from_fn(|| buffer.next_line())
            .map(|l| String::from_utf8(l).unwrap())
            .collect()
    }

    #[test]
    fn line_spanning_two_reads_is_joined() {
        let mut buffer = LineBuffer::default();
        buffer.push(b"{\"response\":\"he");
        assert!(drain(&mut buffer).is_empty());
        buffer.push(b"llo\",\"done\":false}\n{\"resp");
        assert_eq!(
            drain(&mut buffer),
            ["{\"response\":\"hello\",\"done\":false}"]
        );
        buffer.push(b"onse\":\"\",\"done\":true}\n");
        assert_eq!(drain(&mut buffer), ["{\"response\":\"\",\"done\":true}"]);
        assert_eq!(buffer.finish(), None);
    }

    #[test]
    fn several_lines_in_one_read_and_blank_lines_skipped() {
        let mut buffer = LineBuffer::default();
        buffer.push(b"{\"a\":1}\r\n\n  \n{\"b\":2}\n");
        assert_eq!(drain(&mut buffer), ["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn trailing_line_without_newline_is_flushed_at_end() {
        let mut buffer = LineBuffer::default();
        buffer.push(b"{\"a\":1}\n{\"b\":2}");
        assert_eq!(drain(&mut buffer), ["{\"a\":1}"]);
        assert_eq!(buffer.finish(), Some(b"{\"b\":2}".to_vec()));
        assert_eq!(buffer.finish(), None);
    }

    #[test]
    fn error_line_maps_to_its_message() {
        let parsed = parse_line::<GenerateChunk>(br#"{"error":"model runner crashed"}"#);
        assert_eq!(
            parsed,
            Err(OllamaError::Other("model runner crashed".to_owned()))
        );
    }

    #[test]
    fn generate_chunk_ignores_context() {
        let chunk: GenerateChunk = parse_line(
            br#"{"model":"m","created_at":"t","response":"","done":true,"done_reason":"length","context":[1,2,3],"prompt_eval_count":4,"prompt_eval_cached_count":3}"#,
        )
        .unwrap();
        assert!(chunk.done);
        assert_eq!(chunk.prompt_eval_cached_count, Some(3));
    }
}
