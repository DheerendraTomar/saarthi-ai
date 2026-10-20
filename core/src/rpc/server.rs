//! The JSON-RPC server loop: reads lines from the client, dispatches them to a
//! [`Handler`], and lets handlers talk back to the client through a
//! [`ClientLink`].
//!
//! Ordering and concurrency: one dispatcher task takes requests and
//! notifications in arrival order. It awaits each notification handler before
//! moving on, and it starts each request in its own task. A request therefore
//! sees the effects of every notification that arrived before it, while
//! requests still run concurrently with each other. The reader loop only routes
//! lines and resolves the client's responses, so a handler blocked in
//! `ctx.request` never stalls input. A single writer task owns the output sink.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use futures::FutureExt;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinSet;

use super::framing::{Message, RpcError};

/// How long a server->client request waits for the client's answer. Long,
/// because some requests wait on a human (e.g. approving an edit).
const CLIENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// After EOF, how long in-flight request handlers get to finish before they
/// are aborted.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// The client, as seen by handlers.
pub type Ctx = Arc<dyn ClientLink>;

/// Server-side logic invoked for each incoming message.
#[async_trait]
pub trait Handler: Send + Sync {
    async fn request(&self, method: &str, params: Value, ctx: Ctx) -> Result<Value, RpcError>;
    async fn notify(&self, method: &str, params: Value, ctx: Ctx);
}

/// Outgoing traffic to the client: notifications and requests whose response
/// is awaited.
#[async_trait]
pub trait ClientLink: Send + Sync {
    fn notify(&self, method: &str, params: Value);
    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError>;
}

type Responder = oneshot::Sender<Result<Value, RpcError>>;

/// Server->client requests awaiting the client's answer. Once `closed` is set
/// (the reader hit EOF), nothing can answer, so new requests fail at once.
#[derive(Default)]
struct Pending {
    closed: bool,
    waiting: HashMap<i64, Responder>,
}

/// What the writer task receives. `Close` stops it after everything queued
/// before it has been written.
enum Outgoing {
    Line(String),
    Close,
}

/// What the dispatcher task receives, in arrival order.
enum Incoming {
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

/// The real [`ClientLink`]: writes to the server's output channel and routes
/// the client's responses back by (negative) id.
struct ServerLink {
    out: mpsc::UnboundedSender<Outgoing>,
    pending: Mutex<Pending>,
    next_id: AtomicI64,
}

impl ServerLink {
    /// Queues `msg` for the writer; returns false if the output is closed.
    fn send(&self, msg: &Message) -> bool {
        let sent = self.out.send(Outgoing::Line(msg.encode())).is_ok();
        if !sent {
            tracing::debug!("output closed; dropping outgoing message");
        }
        sent
    }

    /// Hands the client's response to whoever is waiting for `id`.
    fn resolve(&self, id: &Value, outcome: Result<Value, RpcError>) {
        let responder = id
            .as_i64()
            .and_then(|id| self.pending.lock().unwrap().waiting.remove(&id));
        match responder {
            // The requester may have timed out; nothing to do then.
            Some(responder) => drop(responder.send(outcome)),
            None => tracing::warn!("ignoring response with unknown id {id}"),
        }
    }

    /// Marks the connection closed and fails every outstanding request.
    fn close(&self) {
        let mut pending = self.pending.lock().unwrap();
        pending.closed = true;
        pending.waiting.clear();
    }
}

#[async_trait]
impl ClientLink for ServerLink {
    fn notify(&self, method: &str, params: Value) {
        self.send(&Message::Notification {
            method: method.to_string(),
            params,
        });
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_sub(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.closed {
                return Err(RpcError::internal(format!(
                    "connection closed; cannot send {method}"
                )));
            }
            pending.waiting.insert(id, tx);
        }
        let sent = self.send(&Message::Request {
            id: json!(id),
            method: method.to_string(),
            params,
        });
        if !sent {
            self.pending.lock().unwrap().waiting.remove(&id);
            return Err(RpcError::internal(format!(
                "connection closed; cannot send {method}"
            )));
        }
        match tokio::time::timeout(CLIENT_REQUEST_TIMEOUT, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err(RpcError::internal(format!(
                "connection closed before client answered {method}"
            ))),
            Err(_) => {
                self.pending.lock().unwrap().waiting.remove(&id);
                Err(RpcError::internal(format!(
                    "client did not answer {method} in time"
                )))
            }
        }
    }
}

/// A JSON-RPC server over one connection (normally stdio).
pub struct RpcServer {
    reader: Box<dyn AsyncBufRead + Unpin + Send>,
    writer: Box<dyn AsyncWrite + Unpin + Send>,
    handler: Arc<dyn Handler>,
}

impl RpcServer {
    pub fn new(
        reader: impl AsyncBufRead + Unpin + Send + 'static,
        writer: impl AsyncWrite + Unpin + Send + 'static,
        handler: Arc<dyn Handler>,
    ) -> RpcServer {
        RpcServer {
            reader: Box::new(reader),
            writer: Box::new(writer),
            handler,
        }
    }

    /// Serves until the reader hits EOF. Malformed lines are logged and
    /// skipped; only I/O errors on the reader are fatal.
    ///
    /// On EOF: outstanding and later `ctx.request` calls fail at once, queued
    /// notifications are handled, in-flight requests get [`SHUTDOWN_GRACE`] to
    /// finish (then are aborted), and all queued output is flushed before this
    /// returns.
    pub async fn run(self) -> Result<()> {
        let RpcServer {
            mut reader,
            writer,
            handler,
        } = self;

        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let writer_task = tokio::spawn(write_loop(writer, out_rx));

        let link = Arc::new(ServerLink {
            out: out_tx.clone(),
            pending: Mutex::default(),
            next_id: AtomicI64::new(-1),
        });

        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let dispatcher = tokio::spawn(dispatch_loop(in_rx, handler, link.clone()));

        let read_result = read_loop(&mut reader, &in_tx, &link).await;

        link.close();
        drop(in_tx);
        if let Err(e) = dispatcher.await {
            tracing::error!("dispatcher task failed: {e}");
        }
        // Any ctx clones a handler kept are harmless now: writing stops at
        // `Close`, and later sends fail at once.
        drop(link);
        let _ = out_tx.send(Outgoing::Close);
        if let Err(e) = writer_task.await {
            tracing::error!("writer task failed: {e}");
        }
        read_result
    }
}

/// Reads lines until EOF, routing requests and notifications to the
/// dispatcher and client responses to their waiters.
async fn read_loop(
    reader: &mut (dyn AsyncBufRead + Unpin + Send),
    incoming: &mpsc::UnboundedSender<Incoming>,
    link: &ServerLink,
) -> Result<()> {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if reader
            .read_until(b'\n', &mut buf)
            .await
            .context("reading from client")?
            == 0
        {
            return Ok(());
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            tracing::warn!("ignoring non-UTF-8 line from client");
            continue;
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let msg = match Message::decode(line) {
            Ok(msg) => msg,
            Err(e) => {
                tracing::warn!("ignoring malformed message: {e:#}");
                continue;
            }
        };
        let routed = match msg {
            Message::Request { id, method, params } => Incoming::Request { id, method, params },
            Message::Notification { method, params } => Incoming::Notification { method, params },
            Message::Response { id, result, error } => {
                let outcome = match error {
                    Some(error) => Err(error),
                    None => Ok(result.unwrap_or(Value::Null)),
                };
                link.resolve(&id, outcome);
                continue;
            }
        };
        if incoming.send(routed).is_err() {
            // The dispatcher only exits after this sender is dropped.
            tracing::error!("dispatcher is gone; dropping incoming message");
        }
    }
}

/// Handles incoming messages in arrival order: awaits each notification, and
/// starts each request in its own task. Panics in handlers are contained.
async fn dispatch_loop(
    mut incoming: mpsc::UnboundedReceiver<Incoming>,
    handler: Arc<dyn Handler>,
    link: Arc<ServerLink>,
) {
    let ctx: Ctx = link.clone();
    let mut requests = JoinSet::new();
    while let Some(msg) = incoming.recv().await {
        match msg {
            Incoming::Notification { method, params } => {
                let call = handler.notify(&method, params, ctx.clone());
                if AssertUnwindSafe(call).catch_unwind().await.is_err() {
                    tracing::error!("notification handler for {method} panicked");
                }
            }
            Incoming::Request { id, method, params } => {
                let handler = handler.clone();
                let ctx = ctx.clone();
                let link = link.clone();
                requests.spawn(async move {
                    let call = handler.request(&method, params, ctx);
                    let outcome = match AssertUnwindSafe(call).catch_unwind().await {
                        Ok(outcome) => outcome,
                        Err(_) => {
                            tracing::error!("request handler for {method} panicked");
                            Err(RpcError::internal(format!("handler for {method} panicked")))
                        }
                    };
                    let (result, error) = match outcome {
                        Ok(value) => (Some(value), None),
                        Err(error) => (None, Some(error)),
                    };
                    link.send(&Message::Response { id, result, error });
                });
                // Reap finished tasks so the set does not grow without bound.
                while requests.try_join_next().is_some() {}
            }
        }
    }

    // EOF: give in-flight requests a bounded time to finish.
    let drained = tokio::time::timeout(SHUTDOWN_GRACE, async {
        while requests.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        tracing::warn!(
            "aborting {} request(s) still running at shutdown",
            requests.len()
        );
        requests.shutdown().await;
    }
}

/// Owns the output sink: writes each line followed by a newline, until
/// `Close` arrives or every sender is gone.
async fn write_loop(
    mut writer: Box<dyn AsyncWrite + Unpin + Send>,
    mut rx: mpsc::UnboundedReceiver<Outgoing>,
) {
    while let Some(Outgoing::Line(line)) = rx.recv().await {
        let written = async {
            writer.write_all(line.as_bytes()).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await
        }
        .await;
        if let Err(e) = written {
            tracing::warn!("failed to write to client, stopping output: {e}");
            return;
        }
    }
}
