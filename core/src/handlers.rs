//! Wires every subsystem to the JSON-RPC server: one [`AppHandler`] maps each
//! `protocol::methods::*` name to the document store, index, completion
//! engine, agent runner or Ollama client.
//!
//! The subsystems need the Ollama URL and workspace root, which only arrive
//! with `initialize`, so they are built there ([`AppState`]). Before that,
//! requests other than `initialize` / `shutdown` fail and notifications are
//! dropped. A second `initialize` is refused: the Ollama client and the
//! workspace cannot be swapped under running subsystems.
//!
//! No `std` lock is held across an `.await`: every guard is taken in a
//! statement or block that ends before the next await.

use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::agent::{AgentRunner, TurnReservation};
use crate::completion::CompletionEngine;
use crate::index::{WorkspaceIndex, watcher};
use crate::ollama::{OllamaClient, OllamaError, OllamaState, OllamaStatus, PullProgress};
use crate::overlay::{DocumentStore, uri_to_path};
use crate::protocol::{
    Capabilities, ChatApproveParams, ChatDone, ChatHistoryParams, ChatListSessionsResult,
    ChatNewSessionResult, ChatSendParams, ChatSendResult, ChatStopParams, CompletionAcceptedParams,
    CompletionCancelParams, CompletionRejectedParams, CompletionRequestParams, DidChangeParams,
    DidCloseParams, DidOpenParams, DidSaveParams, IndexReady, IndexStatus, InitializeParams,
    InitializeResult, OllamaPullParams, OllamaPullProgress, OllamaPullResult, StatusNotification,
    StopReason, methods,
};
use crate::rpc::{Ctx, Handler, RpcError};
use crate::settings::Settings;

/// How often the idle status check re-probes Ollama.
pub const STATUS_INTERVAL: Duration = Duration::from_secs(30);

/// Upper bound on one status probe.
pub const STATUS_TIMEOUT: Duration = Duration::from_secs(3);

/// JSON-RPC "Invalid Request": used for calls made in the wrong state.
const INVALID_REQUEST: i64 = -32600;

/// Buffered `ollama/pull` progress lines.
const PULL_BUFFER: usize = 32;

/// Everything built by `initialize`.
pub struct AppState {
    pub settings: RwLock<Settings>,
    pub store: Arc<RwLock<DocumentStore>>,
    pub index: Arc<RwLock<WorkspaceIndex>>,
    pub ollama: Arc<OllamaClient>,
    pub completion: Arc<CompletionEngine>,
    pub agent: Arc<AgentRunner>,
    /// Last Ollama status reported to the client (in `initialize` or `status`).
    last_status: Mutex<OllamaStatus>,
    /// Set while a status probe runs, so probes never pile up.
    probing: AtomicBool,
    /// Parent of every chat turn's token; cancelled on shutdown.
    turns: CancellationToken,
    /// Watcher and status-loop tasks, aborted on drop.
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Drop for AppState {
    fn drop(&mut self) {
        self.turns.cancel();
        for task in lock(&self.tasks).drain(..) {
            task.abort();
        }
    }
}

impl AppState {
    /// Probes Ollama and emits `status` if the state or detail changed since
    /// the last report. Skipped if a probe is already running.
    async fn refresh_status(&self, ctx: &Ctx) {
        /// Clears the flag even if the probe is dropped mid-flight.
        struct Probing<'a>(&'a AtomicBool);
        impl Drop for Probing<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }

        if self.probing.swap(true, Ordering::SeqCst) {
            return;
        }
        let _probing = Probing(&self.probing);
        let status = self.probe().await;
        self.report_status(status, ctx);
    }

    /// Asks Ollama for its health and that of the configured models.
    async fn probe(&self) -> OllamaStatus {
        let (completion_model, chat_model) = {
            let s = read(&self.settings);
            (s.completion_model.clone(), s.chat_model.clone())
        };
        probe(&self.ollama, &completion_model, &chat_model).await
    }

    /// Records `status` and notifies the client if it differs from the last
    /// one reported.
    fn report_status(&self, status: OllamaStatus, ctx: &Ctx) {
        let changed = {
            let mut last = lock(&self.last_status);
            let changed = *last != status;
            *last = status.clone();
            changed
        };
        if changed {
            tracing::info!(state = ?status.state, detail = %status.detail, "ollama status changed");
            ctx.notify(
                methods::STATUS,
                to_json(StatusNotification {
                    ollama: status.state,
                    detail: status.detail,
                }),
            );
        }
    }

    fn last_status(&self) -> OllamaStatus {
        lock(&self.last_status).clone()
    }
}

/// The server's [`Handler`]: dispatches on method name.
pub struct AppHandler {
    state: RwLock<Option<Arc<AppState>>>,
    /// Serializes `initialize` so two concurrent calls cannot both build.
    initializing: tokio::sync::Mutex<()>,
    /// Fired once by `shutdown`; the serve loop then ends (see `main.rs`).
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl AppHandler {
    /// `shutdown` is fired when the client sends `shutdown`.
    pub fn new(shutdown: oneshot::Sender<()>) -> Self {
        Self {
            state: RwLock::new(None),
            initializing: tokio::sync::Mutex::new(()),
            shutdown: Mutex::new(Some(shutdown)),
        }
    }

    fn state(&self) -> Option<Arc<AppState>> {
        read(&self.state).clone()
    }

    fn require_state(&self, method: &str) -> Result<Arc<AppState>, RpcError> {
        self.state().ok_or_else(|| {
            RpcError::new(
                INVALID_REQUEST,
                format!("{method} received before initialize"),
            )
        })
    }

    async fn initialize(&self, params: Value, ctx: Ctx) -> Result<Value, RpcError> {
        let params: InitializeParams = parse(params)?;
        let _guard = self.initializing.lock().await;
        if self.state().is_some() {
            return Err(RpcError::new(
                INVALID_REQUEST,
                "already initialized; restart the core to change workspace or settings",
            ));
        }
        let root = workspace_root(&params.workspace_root)?;
        let settings = params.settings;
        tracing::info!(root = %root.display(), ollama = %settings.ollama_url, "initializing");

        let ollama = OllamaClient::new(settings.ollama_url.clone(), settings.keep_alive.clone());
        let ollama_status = probe(&ollama, &settings.completion_model, &settings.chat_model).await;

        let store = Arc::new(RwLock::new(DocumentStore::new(root.clone())));
        let index = Arc::new(RwLock::new(WorkspaceIndex::empty(&root)));
        let completion = Arc::new(CompletionEngine::new(
            ollama.clone(),
            store.clone(),
            index.clone(),
            settings.clone(),
        ));
        let agent = Arc::new(AgentRunner::new(
            ollama.clone(),
            store.clone(),
            index.clone(),
            completion.clone(),
            settings.clone(),
            root.clone(),
        ));
        let state = Arc::new(AppState {
            settings: RwLock::new(settings),
            store,
            index: index.clone(),
            ollama: Arc::new(ollama),
            completion,
            agent,
            last_status: Mutex::new(ollama_status.clone()),
            probing: AtomicBool::new(false),
            turns: CancellationToken::new(),
            tasks: Mutex::new(Vec::new()),
        });

        // The watcher starts before the build so no change made during the
        // build is missed: it updates the current (empty) index and logs what
        // it applied, and the log is replayed onto the built index before
        // the swap.
        let log = watcher::build_log();
        let watcher = watcher::spawn_logging(&root, index.clone(), log.clone());
        let status_loop = tokio::spawn(status_loop(Arc::downgrade(&state), ctx.clone()));
        lock(&state.tasks).extend([watcher, status_loop]);
        tokio::spawn(build_index(root, index, log, ctx));

        *write(&self.state) = Some(state);
        Ok(to_json(InitializeResult {
            capabilities: Capabilities::default(),
            ollama_status,
            index_status: IndexStatus::Building,
        }))
    }

    fn shutdown(&self) -> Value {
        tracing::info!("shutdown requested");
        if let Some(state) = self.state() {
            state.turns.cancel();
        }
        if let Some(tx) = lock(&self.shutdown).take() {
            let _ = tx.send(());
        }
        json!({})
    }

    async fn dispatch(
        &self,
        state: Arc<AppState>,
        method: &str,
        params: Value,
        ctx: Ctx,
    ) -> Result<Value, RpcError> {
        match method {
            methods::COMPLETION_REQUEST => {
                let params: CompletionRequestParams = parse(params)?;
                let result = state
                    .completion
                    .request(params, CancellationToken::new())
                    .await?;
                // A completion that hit (or recovered from) an Ollama error
                // updates the reported status, off the latency-critical path.
                if let Some(seen) = state.completion.last_status()
                    && seen.state != state.last_status().state
                {
                    let state = state.clone();
                    tokio::spawn(async move { state.refresh_status(&ctx).await });
                }
                Ok(to_json(result))
            }
            methods::CHAT_SEND => {
                let params: ChatSendParams = parse(params)?;
                // Reserved before answering, so a concurrent send for the same
                // session gets an error instead of a `{}` with no turn.
                let turn = state
                    .agent
                    .reserve(&params.session_id, state.turns.clone())?;
                tokio::spawn(run_turn(state, turn, params, ctx));
                Ok(to_json(ChatSendResult {}))
            }
            methods::CHAT_STOP => {
                let params: ChatStopParams = parse(params)?;
                state.agent.stop(&params.session_id);
                Ok(json!({}))
            }
            methods::CHAT_APPROVE => {
                let p: ChatApproveParams = parse(params)?;
                state
                    .agent
                    .approve(&p.session_id, &p.tool_call_id, p.decision, p.edited_args)?;
                Ok(json!({}))
            }
            methods::CHAT_NEW_SESSION => {
                parse::<Value>(params)?;
                Ok(to_json(ChatNewSessionResult {
                    session_id: state.agent.new_session(),
                }))
            }
            methods::CHAT_LIST_SESSIONS => {
                parse::<Value>(params)?;
                Ok(to_json(ChatListSessionsResult {
                    sessions: state.agent.list_sessions(),
                }))
            }
            methods::CHAT_HISTORY => {
                let params: ChatHistoryParams = parse(params)?;
                Ok(to_json(state.agent.history(&params.session_id)?))
            }
            methods::OLLAMA_STATUS => {
                parse::<Value>(params)?;
                let status = state.probe().await;
                state.report_status(status.clone(), &ctx);
                Ok(to_json(status))
            }
            methods::OLLAMA_PULL => {
                let params: OllamaPullParams = parse(params)?;
                pull(&state, params.model, &ctx).await?;
                state.refresh_status(&ctx).await;
                Ok(to_json(OllamaPullResult {}))
            }
            methods::BENCH_RUN => Err(RpcError::method_not_found(
                "bench/run (not available in this build)",
            )),
            _ => Err(RpcError::method_not_found(method)),
        }
    }

    async fn on_notification(&self, state: &AppState, method: &str, params: Value) {
        let parsed = match method {
            methods::DID_OPEN => parse::<DidOpenParams>(params).map(|p| {
                write(&state.store).did_open(&p.uri, p.text, p.version);
                refresh_snippets(state, p.uri);
            }),
            methods::DID_CHANGE => parse::<DidChangeParams>(params).map(|p| {
                write(&state.store).did_change(&p.uri, p.version, p.content_changes);
            }),
            methods::DID_SAVE => parse::<DidSaveParams>(params).map(|p| {
                refresh_snippets(state, p.uri);
            }),
            methods::DID_CLOSE => parse::<DidCloseParams>(params).map(|p| {
                write(&state.store).did_close(&p.uri);
                state.completion.invalidate_snippets(&p.uri);
            }),
            methods::COMPLETION_CANCEL => parse::<CompletionCancelParams>(params)
                .map(|p| state.completion.cancel(&p.request_id)),
            methods::COMPLETION_ACCEPTED => parse::<CompletionAcceptedParams>(params)
                .map(|p| state.completion.on_accepted(&p.request_id)),
            methods::COMPLETION_REJECTED => parse::<CompletionRejectedParams>(params)
                .map(|p| state.completion.on_rejected(&p.request_id)),
            _ => {
                tracing::warn!(method, "ignoring unknown notification");
                return;
            }
        };
        if let Err(err) = parsed {
            tracing::warn!(method, %err, "ignoring notification with invalid params");
        }
    }
}

#[async_trait]
impl Handler for AppHandler {
    async fn request(&self, method: &str, params: Value, ctx: Ctx) -> Result<Value, RpcError> {
        tracing::debug!(method, "request");
        match method {
            methods::INITIALIZE => self.initialize(params, ctx).await,
            methods::SHUTDOWN => {
                parse::<Value>(params)?;
                Ok(self.shutdown())
            }
            _ => {
                let state = self.require_state(method)?;
                self.dispatch(state, method, params, ctx).await
            }
        }
    }

    async fn notify(&self, method: &str, params: Value, _ctx: Ctx) {
        tracing::debug!(method, "notification");
        match self.state() {
            Some(state) => self.on_notification(&state, method, params).await,
            None => tracing::warn!(method, "dropping notification received before initialize"),
        }
    }
}

/// Recomputes `uri`'s related snippets in the background, so a large
/// workspace never stalls the in-order notification queue.
fn refresh_snippets(state: &AppState, uri: String) {
    let completion = state.completion.clone();
    tokio::spawn(async move { completion.refresh_snippets(&uri).await });
}

/// Runs a reserved chat turn. The client always gets a `chat/done`: if the
/// turn panics, one with `stopReason: "error"` is sent here.
async fn run_turn(state: Arc<AppState>, turn: TurnReservation, params: ChatSendParams, ctx: Ctx) {
    let session_id = turn.session_id().to_owned();
    let send = state.agent.send_reserved(turn, params, ctx.clone());
    if AssertUnwindSafe(send).catch_unwind().await.is_err() {
        tracing::error!(session_id, "chat turn panicked");
        ctx.notify(
            methods::CHAT_DONE,
            to_json(ChatDone {
                session_id,
                stop_reason: StopReason::Error,
            }),
        );
    }
    // The runner reports Ollama errors itself; re-probe so the client's
    // status reflects the server's real state.
    state.refresh_status(&ctx).await;
}

/// Builds the index off the async runtime, replays the watcher's changes
/// made meanwhile, swaps it in, and emits `index/ready`. If the build fails
/// the watcher-maintained index stays and `index/ready` is still sent, so the
/// client never waits on "building" forever.
async fn build_index(
    root: PathBuf,
    index: Arc<RwLock<WorkspaceIndex>>,
    log: watcher::BuildLog,
    ctx: Ctx,
) {
    let (target, build_log) = (index.clone(), log.clone());
    let built = tokio::task::spawn_blocking(move || {
        let built = WorkspaceIndex::build(&root);
        let build_ms = built.stats().build_ms;
        watcher::install_build(&target, built, &build_log);
        build_ms
    })
    .await;
    let build_ms = match built {
        Ok(build_ms) => build_ms,
        Err(err) => {
            tracing::error!(%err, "workspace index build failed; keeping the incremental index");
            watcher::abandon_build(&log);
            0
        }
    };
    let files = read(&index).stats().files;
    ctx.notify(
        methods::INDEX_READY,
        to_json(IndexReady { files, build_ms }),
    );
}

/// [`OllamaClient::status`], bounded by [`STATUS_TIMEOUT`]: a server that
/// accepts connections but never answers counts as down.
async fn probe(ollama: &OllamaClient, completion_model: &str, chat_model: &str) -> OllamaStatus {
    match tokio::time::timeout(STATUS_TIMEOUT, ollama.status(completion_model, chat_model)).await {
        Ok(status) => status,
        Err(_) => OllamaStatus {
            state: OllamaState::Down,
            detail: format!(
                "Ollama did not answer within {} s (timed out)",
                STATUS_TIMEOUT.as_secs()
            ),
        },
    }
}

/// Re-probes Ollama every [`STATUS_INTERVAL`] while no chat turn is running
/// (a turn reports its own failures). Ends when the state is dropped.
async fn status_loop(state: std::sync::Weak<AppState>, ctx: Ctx) {
    let mut ticks = tokio::time::interval(STATUS_INTERVAL);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticks.tick().await; // The first tick is immediate; initialize just probed.
    loop {
        ticks.tick().await;
        let Some(state) = state.upgrade() else {
            return;
        };
        if !state.completion.is_paused() {
            state.refresh_status(&ctx).await;
        }
    }
}

/// Runs `ollama/pull`, forwarding progress as `ollama/pullProgress`.
async fn pull(state: &AppState, model: String, ctx: &Ctx) -> Result<(), RpcError> {
    let (tx, mut rx) = mpsc::channel::<PullProgress>(PULL_BUFFER);
    let forward = {
        let ctx = ctx.clone();
        let model = model.clone();
        tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                ctx.notify(
                    methods::OLLAMA_PULL_PROGRESS,
                    to_json(OllamaPullProgress {
                        model: model.clone(),
                        status: p.status,
                        completed: p.completed,
                        total: p.total,
                    }),
                );
            }
        })
    };
    let outcome = state.ollama.pull(&model, tx).await;
    // `tx` was moved into `pull` and is dropped now, so the forwarder ends
    // after sending everything; the response then follows the progress.
    let _ = forward.await;
    outcome.map_err(ollama_error)
}

fn ollama_error(err: OllamaError) -> RpcError {
    match err {
        OllamaError::Down(_) => RpcError::ollama_down(err.to_string()),
        OllamaError::ModelMissing(_) => RpcError::model_missing(err.to_string()),
        OllamaError::Cancelled => RpcError::cancelled(err.to_string()),
        OllamaError::Http(..) | OllamaError::Other(_) => RpcError::internal(err.to_string()),
    }
}

/// Canonical workspace root from `initialize` (a path or `file://` URI).
fn workspace_root(raw: &str) -> Result<PathBuf, RpcError> {
    let path = uri_to_path(raw);
    let canonical = path.canonicalize().map_err(|err| {
        RpcError::invalid_params(format!(
            "workspace root {}: {err}",
            Path::new(raw).display()
        ))
    })?;
    if !canonical.is_dir() {
        return Err(RpcError::invalid_params(format!(
            "workspace root {} is not a directory",
            canonical.display()
        )));
    }
    Ok(canonical)
}

/// Deserializes request params; absent/null params count as `{}`, so methods
/// whose params are all optional accept them.
fn parse<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params).map_err(|err| RpcError::invalid_params(err.to_string()))
}

fn to_json(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("protocol types serialize")
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read<T>(l: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(PoisonError::into_inner)
}

fn write<T>(l: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(PoisonError::into_inner)
}
