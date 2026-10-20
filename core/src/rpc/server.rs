//! The JSON-RPC server loop: reads lines from the client, dispatches them to a
//! [`Handler`], and lets handlers talk back to the client through a
//! [`ClientLink`].
//!
//! Concurrency: each incoming request runs in its own task, so a slow request
//! never blocks a fast one. Notifications are handled one at a time, in arrival
//! order, by a dedicated task. A single writer task owns the output sink.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use super::framing::{Message, RpcError};

/// How long a server->client request waits for the client's answer. Long,
/// because some requests wait on a human (e.g. approving an edit).
const CLIENT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);

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

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, RpcError>>>>>;

/// The real [`ClientLink`]: writes to the server's output channel and routes
/// the client's responses back by (negative) id.
struct ServerLink {
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: AtomicI64,
}

impl ServerLink {
    /// Queues `msg` for the writer; returns false if the output is closed.
    fn send(&self, msg: &Message) -> bool {
        let sent = self.out.send(msg.encode()).is_ok();
        if !sent {
            tracing::debug!("output closed; dropping outgoing message");
        }
        sent
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
        self.pending.lock().unwrap().insert(id, tx);
        let sent = self.send(&Message::Request {
            id: json!(id),
            method: method.to_string(),
            params,
        });
        if !sent {
            self.pending.lock().unwrap().remove(&id);
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
                self.pending.lock().unwrap().remove(&id);
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
    pub async fn run(self) -> Result<()> {
        let RpcServer {
            mut reader,
            writer,
            handler,
        } = self;

        let (out_tx, out_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(write_loop(writer, out_rx));

        let pending: Pending = Arc::default();
        let link = Arc::new(ServerLink {
            out: out_tx,
            pending: pending.clone(),
            next_id: AtomicI64::new(-1),
        });
        let ctx: Ctx = link.clone();

        let (notif_tx, mut notif_rx) = mpsc::unbounded_channel::<(String, Value)>();
        let notif_task = {
            let handler = handler.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move {
                while let Some((method, params)) = notif_rx.recv().await {
                    handler.notify(&method, params, ctx.clone()).await;
                }
            })
        };

        let mut buf = Vec::new();
        let read_result = loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break Ok(()),
                Ok(_) => {}
                Err(e) => break Err(e).context("reading from client"),
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
            match msg {
                Message::Request { id, method, params } => {
                    let handler = handler.clone();
                    let ctx = ctx.clone();
                    let link = link.clone();
                    tokio::spawn(async move {
                        let outcome = handler.request(&method, params, ctx).await;
                        let (result, error) = match outcome {
                            Ok(value) => (Some(value), None),
                            Err(error) => (None, Some(error)),
                        };
                        link.send(&Message::Response { id, result, error });
                    });
                }
                Message::Notification { method, params } => {
                    // Fails only if the notification task died (handler panic).
                    if let Err(e) = notif_tx.send((method, params)) {
                        let (method, _) = e.0;
                        tracing::error!("notification task is gone; dropping {method}");
                    }
                }
                Message::Response { id, result, error } => {
                    let sender = id
                        .as_i64()
                        .and_then(|id| pending.lock().unwrap().remove(&id));
                    match sender {
                        Some(sender) => {
                            let outcome = match error {
                                Some(error) => Err(error),
                                None => Ok(result.unwrap_or(Value::Null)),
                            };
                            // The requester may have timed out; nothing to do then.
                            let _ = sender.send(outcome);
                        }
                        None => tracing::warn!("ignoring response with unknown id {id}"),
                    }
                }
            }
        };

        // EOF (or read error): finish queued notifications in order, then fail
        // any server->client requests that can no longer be answered.
        drop(notif_tx);
        if let Err(e) = notif_task.await {
            tracing::error!("notification task failed: {e}");
        }
        pending.lock().unwrap().clear();
        read_result
    }
}

/// Owns the output sink: writes each message followed by a newline.
async fn write_loop(
    mut writer: Box<dyn AsyncWrite + Unpin + Send>,
    mut rx: mpsc::UnboundedReceiver<String>,
) {
    while let Some(line) = rx.recv().await {
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
