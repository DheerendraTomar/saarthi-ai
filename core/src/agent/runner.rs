//! The agent loop (spec §7): stream the chat model, run its tool calls —
//! reads automatically, edits/creates/commands after the user approves them
//! — feed the results back, and repeat until the model answers without
//! calling a tool.
//!
//! Edits and commands are executed by the IDE client
//! (`workspace/applyEdit`, `workspace/runCommand`); the core never writes
//! workspace files. Everything streams to the client as notifications and a
//! turn always ends with exactly one `chat/done`.
//!
//! Locking: the store/index `std` locks are only taken to copy data out
//! (overlay snapshot, file list) and are never held across an `.await`.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use futures::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::edit::{self, Resolved};
use super::prompt;
use super::session::{self, Session};
use super::tools::{self, Tool, ToolError, ToolOutput};
use crate::completion::CompletionEngine;
use crate::index::WorkspaceIndex;
use crate::ollama::{ChatMessage, ChatRequest, OllamaClient, OllamaError, Options, Role, ToolCall};
use crate::overlay::{DocumentStore, offset_of, path_to_uri, uri_to_path};
use crate::protocol::{
    ApplyEditParams, ApplyEditResult, ChatDone, ChatHistoryResult, ChatSendParams, ChatToken,
    ChatToolCall, ChatToolResult, Decision, EditOp, HistoryMessage, HistoryToolCall, OllamaState,
    RunCommandParams, RunCommandResult, SessionSummary, StatusNotification, StopReason, TokenKind,
    methods,
};
use crate::rpc::{Ctx, RpcError};
use crate::settings::{Settings, Thinking};

/// Tool-call rounds per `send` before the loop stops.
pub const MAX_TOOL_ROUNDS: usize = 25;
/// Tool result sent to the model when the user denies a call.
pub const DENIED: &str = "User denied this action.";
/// Tool result for calls cut short by `chat/stop`.
const STOPPED: &str = "Stopped by the user.";
const NUM_PREDICT: u32 = 8192;
const TEMPERATURE: f32 = 0.2;

/// The user's answer to an approval prompt.
struct Approval {
    decision: Decision,
    edited_args: Option<Value>,
}

type ApprovalKey = (String, String);

/// Runs chat turns. One turn at a time per session; sessions are independent.
pub struct AgentRunner {
    ollama: OllamaClient,
    store: Arc<RwLock<DocumentStore>>,
    index: Arc<RwLock<WorkspaceIndex>>,
    completion: Arc<CompletionEngine>,
    settings: RwLock<Settings>,
    /// Workspace root as the client spelled it: URIs sent to the client and
    /// session files use it.
    root: PathBuf,
    /// Canonicalized root, for confinement and relative paths.
    canonical_root: PathBuf,
    /// Approval prompts awaiting `chat/approve`, by (session, tool call id).
    approvals: Mutex<HashMap<ApprovalKey, oneshot::Sender<Approval>>>,
    /// Cancellation token of the running turn, by session.
    running: Mutex<HashMap<String, CancellationToken>>,
    /// Latest state of every session touched by this process.
    sessions: Mutex<HashMap<String, Session>>,
    /// Number of chat streams in flight; completions are paused while > 0.
    streams: Mutex<usize>,
    next_call_id: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn to_json(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("protocol types serialize")
}

impl AgentRunner {
    /// `settings` is a snapshot; push changes with
    /// [`set_settings`](Self::set_settings).
    pub fn new(
        ollama: OllamaClient,
        store: Arc<RwLock<DocumentStore>>,
        index: Arc<RwLock<WorkspaceIndex>>,
        completion: Arc<CompletionEngine>,
        settings: Settings,
        root: PathBuf,
    ) -> Self {
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        Self {
            ollama,
            store,
            index,
            completion,
            settings: RwLock::new(settings),
            root,
            canonical_root,
            approvals: Mutex::new(HashMap::new()),
            running: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            streams: Mutex::new(0),
            next_call_id: AtomicU64::new(0),
        }
    }

    /// Replaces the settings used by turns started afterwards.
    pub fn set_settings(&self, settings: Settings) {
        *self
            .settings
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = settings;
    }

    /// Runs one whole turn of `session_id`: appends the user message, loops
    /// model ↔ tools, and emits `chat/done`. Returns once `chat/done` was
    /// sent.
    ///
    /// Errors (no `chat/done` is sent for these): an invalid session id, or a
    /// turn already running in the session.
    pub async fn send(
        &self,
        session_id: &str,
        params: ChatSendParams,
        ctx: Ctx,
        cancel: CancellationToken,
    ) -> Result<(), RpcError> {
        if !session::valid_id(session_id) {
            return Err(RpcError::invalid_params(format!(
                "invalid session id {session_id:?}"
            )));
        }
        let cancel = cancel.child_token();
        let running = RunningGuard::register(self, session_id, cancel.clone())?;
        let session = self.load_session(session_id).await;
        let settings = read(&self.settings).clone();
        let mut turn = Turn {
            runner: self,
            ctx: ctx.clone(),
            cancel,
            settings,
            session,
        };
        let stop_reason = turn.run(params).await;
        turn.save().await;
        // Unregister first, so a client reacting to `chat/done` can send again.
        drop(running);
        ctx.notify(
            methods::CHAT_DONE,
            to_json(ChatDone {
                session_id: session_id.to_owned(),
                stop_reason,
            }),
        );
        Ok(())
    }

    /// Answers a pending approval prompt (`chat/approve`).
    pub fn approve(
        &self,
        session_id: &str,
        tool_call_id: &str,
        decision: Decision,
        edited_args: Option<Value>,
    ) -> Result<(), RpcError> {
        let key = (session_id.to_owned(), tool_call_id.to_owned());
        let not_pending = || {
            RpcError::invalid_params(format!(
                "tool call {tool_call_id:?} in session {session_id:?} is not awaiting approval"
            ))
        };
        let sender = lock(&self.approvals).remove(&key).ok_or_else(not_pending)?;
        sender
            .send(Approval {
                decision,
                edited_args,
            })
            .map_err(|_| not_pending())
    }

    /// Cancels the running turn of `session_id` (`chat/stop`); the turn then
    /// ends with `chat/done { stopped }`. Returns `false` if none was running.
    pub fn stop(&self, session_id: &str) -> bool {
        match lock(&self.running).get(session_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Whether a turn is running in `session_id`.
    pub fn is_running(&self, session_id: &str) -> bool {
        lock(&self.running).contains_key(session_id)
    }

    /// A fresh session id (`chat/newSession`); the session is saved on its
    /// first turn.
    pub fn new_session(&self) -> String {
        Session::new().id
    }

    /// Saved sessions, most recent first (`chat/listSessions`).
    pub fn list_sessions(&self) -> Vec<SessionSummary> {
        Session::list(&self.root)
    }

    /// The session's messages for replay in the UI (`chat/history`), without
    /// the system prompt. Unknown sessions have no messages.
    pub fn history(&self, session_id: &str) -> Result<ChatHistoryResult, RpcError> {
        if !session::valid_id(session_id) {
            return Err(RpcError::invalid_params(format!(
                "invalid session id {session_id:?}"
            )));
        }
        let cached = lock(&self.sessions).get(session_id).cloned();
        let messages = match cached
            .map(Ok)
            .unwrap_or_else(|| Session::load(&self.root, session_id))
        {
            Ok(session) => history_messages(&session.messages),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(err) => return Err(RpcError::internal(format!("cannot read session: {err}"))),
        };
        Ok(ChatHistoryResult {
            session_id: session_id.to_owned(),
            messages,
        })
    }

    async fn load_session(&self, id: &str) -> Session {
        if let Some(session) = lock(&self.sessions).get(id).cloned() {
            return session;
        }
        let root = self.root.clone();
        let owned = id.to_owned();
        let loaded = tokio::task::spawn_blocking(move || Session::load(&root, &owned))
            .await
            .unwrap_or_else(|err| Err(io::Error::other(err)));
        match loaded {
            Ok(session) => session,
            Err(err) => {
                if err.kind() != io::ErrorKind::NotFound {
                    tracing::warn!(%err, session = id, "cannot load session; starting a new one");
                }
                Session::with_id(id).expect("id validated by send")
            }
        }
    }

    fn relative(&self, abs: &Path) -> PathBuf {
        abs.strip_prefix(&self.canonical_root)
            .unwrap_or(abs)
            .to_path_buf()
    }

    fn uri(&self, rel: &Path) -> String {
        path_to_uri(&self.root.join(rel))
    }

    /// Current text of `rel`: the overlay if open, else disk. The store lock
    /// is only held to snapshot the overlay.
    async fn read_text(&self, rel: PathBuf) -> io::Result<String> {
        let overlay = read(&self.store).overlay_snapshot();
        tokio::task::spawn_blocking(move || overlay.read(&rel).map(|text| text.into_owned()))
            .await
            .unwrap_or_else(|err| Err(io::Error::other(err)))
    }

    /// Text of an attachment: the overlay if open, else disk.
    async fn read_uri(&self, uri: &str) -> io::Result<String> {
        let open = read(&self.store).text(uri);
        match open {
            Some(text) => Ok(text),
            None => tokio::fs::read_to_string(uri_to_path(uri)).await,
        }
    }

    /// The user's message with attachments inlined as fenced blocks headed
    /// by `path[:startLine-endLine]`, and the first attachment's path.
    async fn user_message(&self, params: &ChatSendParams) -> (String, Option<String>) {
        let mut text = params.message.clone();
        let mut active = None;
        for attachment in &params.attachments {
            let path = uri_to_path(&attachment.uri);
            let name = path
                .strip_prefix(&self.root)
                .or_else(|_| path.strip_prefix(&self.canonical_root))
                .map(tools::display)
                .unwrap_or_else(|_| tools::display(&path));
            active.get_or_insert_with(|| name.clone());
            text.push_str("\n\n");
            match self.read_uri(&attachment.uri).await {
                Ok(content) => {
                    let (label, body) = match attachment.range {
                        Some(range) => {
                            let start = offset_of(&content, range.start);
                            let end = offset_of(&content, range.end).max(start);
                            let label =
                                format!("{name}:{}-{}", range.start.line + 1, range.end.line + 1);
                            (label, &content[start..end])
                        }
                        None => (name, content.as_str()),
                    };
                    let fence = fence_for(body);
                    text.push_str(&format!("{fence}{label}\n{body}"));
                    if !body.ends_with('\n') {
                        text.push('\n');
                    }
                    text.push_str(&fence);
                }
                Err(err) => text.push_str(&format!("[could not read attachment {name}: {err}]")),
            }
        }
        (text, active)
    }

    fn pause_completions(&self) -> PauseGuard<'_> {
        let mut streams = lock(&self.streams);
        *streams += 1;
        self.completion.set_paused(true);
        PauseGuard { runner: self }
    }
}

/// A backtick fence longer than any backtick run inside `body`.
fn fence_for(body: &str) -> String {
    let longest = body.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    "`".repeat(longest.max(2) + 1)
}

/// Converts stored messages to the `chat/history` shape, pairing each tool
/// result with the id of the call it answers (calls are answered in order).
fn history_messages(messages: &[ChatMessage]) -> Vec<HistoryMessage> {
    let mut pending_ids: std::collections::VecDeque<String> = Default::default();
    messages
        .iter()
        .filter(|m| m.role != Role::System)
        .map(|m| {
            let calls = m.tool_calls.as_deref().unwrap_or_default();
            if m.role == Role::Assistant {
                pending_ids = calls.iter().filter_map(|c| c.id.clone()).collect();
            }
            HistoryMessage {
                role: match m.role {
                    Role::User => "user",
                    Role::Assistant => "assistant",
                    _ => "tool",
                }
                .to_owned(),
                content: m.content.clone(),
                thinking: m.thinking.clone(),
                tool_call_id: (m.role == Role::Tool)
                    .then(|| pending_ids.pop_front())
                    .flatten(),
                tool_calls: calls
                    .iter()
                    .map(|c| HistoryToolCall {
                        tool_call_id: c.id.clone().unwrap_or_default(),
                        name: c.function.name.clone(),
                        args: c.function.arguments.clone(),
                    })
                    .collect(),
            }
        })
        .collect()
}

/// Marks a session's turn as running; unregisters on drop.
struct RunningGuard<'a> {
    runner: &'a AgentRunner,
    session_id: String,
}

impl<'a> RunningGuard<'a> {
    fn register(
        runner: &'a AgentRunner,
        session_id: &str,
        cancel: CancellationToken,
    ) -> Result<Self, RpcError> {
        let mut running = lock(&runner.running);
        if running.contains_key(session_id) {
            return Err(RpcError::invalid_params(format!(
                "a turn is already running in session {session_id:?}"
            )));
        }
        running.insert(session_id.to_owned(), cancel);
        Ok(Self {
            runner,
            session_id: session_id.to_owned(),
        })
    }
}

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        lock(&self.runner.running).remove(&self.session_id);
    }
}

/// Completions stay paused while at least one chat stream is in flight.
struct PauseGuard<'a> {
    runner: &'a AgentRunner,
}

impl Drop for PauseGuard<'_> {
    fn drop(&mut self) {
        let mut streams = lock(&self.runner.streams);
        *streams -= 1;
        if *streams == 0 {
            self.runner.completion.set_paused(false);
        }
    }
}

/// An approval prompt registered for `chat/approve`; unregisters on drop.
struct PendingApproval<'a> {
    runner: &'a AgentRunner,
    key: ApprovalKey,
}

impl Drop for PendingApproval<'_> {
    fn drop(&mut self) {
        lock(&self.runner.approvals).remove(&self.key);
    }
}

/// What a tool call produced, for the model (`content`) and the UI.
struct Outcome {
    ok: bool,
    content: String,
    summary: String,
}

impl Outcome {
    fn success(output: ToolOutput) -> Self {
        Self {
            ok: true,
            content: output.content,
            summary: output.summary,
        }
    }

    fn error(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            ok: false,
            content: format!("Error: {message}"),
            summary: message,
        }
    }

    fn denied() -> Self {
        Self {
            ok: false,
            content: DENIED.to_owned(),
            summary: "Denied".to_owned(),
        }
    }
}

impl From<Result<ToolOutput, ToolError>> for Outcome {
    fn from(result: Result<ToolOutput, ToolError>) -> Self {
        match result {
            Ok(output) => Outcome::success(output),
            Err(err) => Outcome::error(err.to_string()),
        }
    }
}

/// A validated tool call, ready to run (after approval, if it needs one).
enum Action {
    /// `read_file`, `list_files`, `search`: run directly.
    Read(Tool),
    Edit {
        rel: PathBuf,
        /// Document text the edit was resolved against.
        doc: String,
        old: String,
        new: String,
        resolved: Resolved,
    },
    Create {
        rel: PathBuf,
        content: String,
        diff: String,
    },
    Command {
        command: String,
        cwd: PathBuf,
    },
}

impl Action {
    fn preview(&self) -> Option<String> {
        match self {
            Action::Read(_) => None,
            Action::Edit { resolved, .. } => Some(resolved.diff.clone()),
            Action::Create { diff, .. } => Some(diff.clone()),
            Action::Command { command, .. } => Some(command.clone()),
        }
    }

    /// Key for "always" approvals; `None` for tools that never ask.
    fn allow_key(&self) -> Option<String> {
        match self {
            Action::Read(_) => None,
            Action::Edit { .. } => Some(session::always_allow_key(tools::EDIT_FILE, None)),
            Action::Create { .. } => Some(session::always_allow_key(tools::CREATE_FILE, None)),
            Action::Command { command, .. } => {
                Some(session::always_allow_key(tools::RUN_COMMAND, Some(command)))
            }
        }
    }
}

/// One running `send`.
struct Turn<'a> {
    runner: &'a AgentRunner,
    ctx: Ctx,
    cancel: CancellationToken,
    settings: Settings,
    session: Session,
}

impl Turn<'_> {
    fn session_id(&self) -> String {
        self.session.id.clone()
    }

    async fn save(&self) {
        lock(&self.runner.sessions).insert(self.session.id.clone(), self.session.clone());
        let session = self.session.clone();
        let root = self.runner.root.clone();
        let saved = tokio::task::spawn_blocking(move || session.save(&root))
            .await
            .unwrap_or_else(|err| Err(io::Error::other(err)));
        if let Err(err) = saved {
            tracing::warn!(%err, session = %self.session.id, "cannot save session");
        }
    }

    async fn run(&mut self, params: ChatSendParams) -> StopReason {
        let (message, active_file) = self.runner.user_message(&params).await;
        self.session
            .set_system_prompt(prompt::system(&self.runner.root, active_file.as_deref()));
        self.session.messages.push(ChatMessage::user(message));

        let budget = self.settings.chat_context_tokens;
        let mut rounds = 0;
        loop {
            let messages = self.session.trimmed_messages(budget);
            let needed: usize = messages.iter().map(session::message_tokens).sum();
            if needed > budget {
                tracing::info!(
                    needed,
                    budget,
                    "chat history does not fit the context budget"
                );
                return StopReason::ContextFull;
            }

            let (mut reply, error) = self.stream(messages).await;
            if let Some(err) = error {
                // Keep what the user already saw, minus unfinished tool calls.
                reply.tool_calls = None;
                if !reply.content.is_empty() || reply.thinking.is_some() {
                    self.session.messages.push(reply);
                }
                return match err {
                    OllamaError::Cancelled => StopReason::Stopped,
                    err => {
                        self.report(&err);
                        StopReason::Error
                    }
                };
            }

            let calls = self.assign_call_ids(&mut reply);
            self.session.messages.push(reply);
            if calls.is_empty() {
                return StopReason::Done;
            }
            for (i, (id, call)) in calls.iter().enumerate() {
                let outcome = match self.handle(id, call).await {
                    Some(outcome) => outcome,
                    None => {
                        // Answer this call (the client saw it) and the
                        // remaining ones so the history stays well-formed.
                        let stopped = Outcome {
                            ok: false,
                            content: STOPPED.to_owned(),
                            summary: "Stopped".to_owned(),
                        };
                        self.finish_call(id, &call.function.name, stopped);
                        for (_, call) in &calls[i + 1..] {
                            self.session
                                .messages
                                .push(ChatMessage::tool(&call.function.name, STOPPED));
                        }
                        return StopReason::Stopped;
                    }
                };
                self.finish_call(id, &call.function.name, outcome);
            }
            rounds += 1;
            if rounds == MAX_TOOL_ROUNDS {
                let note = format!(
                    "\n\n_Stopped after {MAX_TOOL_ROUNDS} tool-call rounds. Send a message to continue._"
                );
                self.token(&note, TokenKind::Text);
                self.session.messages.push(ChatMessage::assistant(note));
                return StopReason::Done;
            }
            self.save().await;
        }
    }

    /// Streams one model turn, forwarding deltas as `chat/token`. Returns the
    /// assistant message (partial if an error interrupted it). Completions
    /// are paused only while the stream is open.
    async fn stream(&self, messages: Vec<ChatMessage>) -> (ChatMessage, Option<OllamaError>) {
        let request = ChatRequest {
            model: self.settings.chat_model.clone(),
            messages,
            tools: tools::specs(),
            stream: true,
            think: self.settings.chat_thinking == Thinking::On,
            options: Options {
                num_predict: NUM_PREDICT,
                temperature: TEMPERATURE,
                stop: Vec::new(),
            },
            keep_alive: Some(self.settings.keep_alive.clone()),
        };
        let mut reply = ChatMessage::assistant("");
        let mut thinking = String::new();
        let _paused = self.runner.pause_completions();
        let error = match self
            .runner
            .ollama
            .chat_stream(request, self.cancel.clone())
            .await
        {
            Err(err) => Some(err),
            Ok(mut chunks) => loop {
                match chunks.next().await {
                    None => break None,
                    Some(Err(err)) => break Some(err),
                    Some(Ok(chunk)) => {
                        if let Some(delta) = chunk.message.thinking.as_deref()
                            && !delta.is_empty()
                        {
                            self.token(delta, TokenKind::Thinking);
                            thinking.push_str(delta);
                        }
                        if !chunk.message.content.is_empty() {
                            self.token(&chunk.message.content, TokenKind::Text);
                            reply.content.push_str(&chunk.message.content);
                        }
                        if chunk.done {
                            reply.tool_calls = chunk.message.tool_calls;
                            break None;
                        }
                    }
                }
            },
        };
        if !thinking.is_empty() {
            reply.thinking = Some(thinking);
        }
        (reply, error)
    }

    /// Gives every tool call an id (Ollama's, or a generated one), stored
    /// back into `reply` so the history matches what the client saw.
    fn assign_call_ids(&self, reply: &mut ChatMessage) -> Vec<(String, ToolCall)> {
        let Some(calls) = reply.tool_calls.as_mut() else {
            return Vec::new();
        };
        calls
            .iter_mut()
            .map(|call| {
                let id = call.id.get_or_insert_with(|| {
                    let n = self.runner.next_call_id.fetch_add(1, Ordering::Relaxed);
                    format!("call_lp{n}")
                });
                (id.clone(), call.clone())
            })
            .collect()
    }

    fn token(&self, delta: &str, kind: TokenKind) {
        self.ctx.notify(
            methods::CHAT_TOKEN,
            to_json(ChatToken {
                session_id: self.session_id(),
                delta: delta.to_owned(),
                kind,
            }),
        );
    }

    fn report(&self, err: &OllamaError) {
        let ollama = match err {
            OllamaError::ModelMissing(_) => OllamaState::ModelMissing,
            _ => OllamaState::Down,
        };
        tracing::warn!(%err, "chat request failed");
        self.ctx.notify(
            methods::STATUS,
            to_json(StatusNotification {
                ollama,
                detail: err.to_string(),
            }),
        );
    }

    fn notify_call(
        &self,
        id: &str,
        call: &ToolCall,
        requires_approval: bool,
        preview: Option<String>,
    ) {
        self.ctx.notify(
            methods::CHAT_TOOL_CALL,
            to_json(ChatToolCall {
                session_id: self.session_id(),
                tool_call_id: id.to_owned(),
                name: call.function.name.clone(),
                args: call.function.arguments.clone(),
                requires_approval,
                preview,
            }),
        );
    }

    fn finish_call(&mut self, id: &str, name: &str, outcome: Outcome) {
        self.session
            .messages
            .push(ChatMessage::tool(name, outcome.content));
        self.ctx.notify(
            methods::CHAT_TOOL_RESULT,
            to_json(ChatToolResult {
                session_id: self.session_id(),
                tool_call_id: id.to_owned(),
                ok: outcome.ok,
                summary: outcome.summary,
            }),
        );
    }

    /// Announces, approves (if needed) and runs one tool call. `None` if the
    /// turn was stopped meanwhile.
    async fn handle(&mut self, id: &str, call: &ToolCall) -> Option<Outcome> {
        let name = call.function.name.as_str();
        let mut action = match self.prepare(name, &call.function.arguments).await {
            Ok(action) => action,
            Err(err) => {
                self.notify_call(id, call, false, None);
                return Some(Outcome::error(err.to_string()));
            }
        };
        let mut note = None;
        if action
            .allow_key()
            .is_some_and(|key| !self.allowed(&key, &action))
        {
            let approval = self.await_approval(id, call, action.preview()).await?;
            if approval.decision == Decision::Deny {
                return Some(Outcome::denied());
            }
            if let Some(args) = approval.edited_args {
                action = match self.prepare(name, &args).await {
                    Ok(action) => action,
                    Err(err) => return Some(Outcome::error(err.to_string())),
                };
                note = Some(format!(
                    "Note: the user edited the arguments before approving: {args}\n"
                ));
            }
            // Keyed on what actually runs (the edited command, if edited).
            if approval.decision == Decision::Always
                && let Some(key) = action.allow_key()
            {
                self.session.always_allow.insert(key);
            }
        } else {
            self.notify_call(id, call, false, action.preview());
        }
        let mut outcome = self.execute(action).await?;
        if let Some(note) = note {
            outcome.content.insert_str(0, &note);
        }
        Some(outcome)
    }

    fn allowed(&self, key: &str, action: &Action) -> bool {
        self.session.always_allow.contains(key)
            || matches!(action, Action::Command { command, .. }
                if self.settings.allowed_commands_always.contains(command))
    }

    /// Registers the prompt, announces the call, and waits for the user.
    /// `None` if the turn is stopped first.
    async fn await_approval(
        &self,
        id: &str,
        call: &ToolCall,
        preview: Option<String>,
    ) -> Option<Approval> {
        let (sender, receiver) = oneshot::channel();
        let key = (self.session_id(), id.to_owned());
        lock(&self.runner.approvals).insert(key.clone(), sender);
        let _pending = PendingApproval {
            runner: self.runner,
            key,
        };
        // Registered before the client can see the prompt and answer it.
        self.notify_call(id, call, true, preview);
        tokio::select! {
            _ = self.cancel.cancelled() => None,
            approval = receiver => approval.ok(),
        }
    }

    /// Parses and validates a call; for edits and creates also computes the
    /// diff preview. Nothing is executed.
    async fn prepare(&self, name: &str, args: &Value) -> Result<Action, ToolError> {
        let root = &self.runner.canonical_root;
        Ok(match Tool::parse(name, args)? {
            Tool::EditFile { path, old, new } => {
                let rel = self.runner.relative(&tools::confine(root, &path)?);
                let doc = self
                    .runner
                    .read_text(rel.clone())
                    .await
                    .map_err(|err| ToolError::Failed(format!("cannot read {path}: {err}")))?;
                let resolved = edit::resolve(&tools::display(&rel), &doc, &old, &new)
                    .map_err(|err| ToolError::Failed(err.to_string()))?;
                Action::Edit {
                    rel,
                    doc,
                    old,
                    new,
                    resolved,
                }
            }
            Tool::CreateFile { path, content } => {
                let abs = tools::confine(root, &path)?;
                let rel = self.runner.relative(&abs);
                if abs.exists() || self.runner.read_text(rel.clone()).await.is_ok() {
                    return Err(ToolError::Failed(format!(
                        "{path} already exists; use edit_file to change it"
                    )));
                }
                let name = tools::display(&rel);
                let diff = similar::TextDiff::from_lines("", content.as_str())
                    .unified_diff()
                    .header("/dev/null", &name)
                    .to_string();
                Action::Create { rel, content, diff }
            }
            Tool::RunCommand { command, cwd } => {
                if command.trim().is_empty() {
                    return Err(ToolError::InvalidArg("command", "must not be empty".into()));
                }
                let cwd = match cwd.as_deref() {
                    None | Some("") | Some(".") => root.clone(),
                    Some(cwd) => tools::confine(root, cwd)?,
                };
                Action::Command { command, cwd }
            }
            read_only => Action::Read(read_only),
        })
    }

    /// Runs an approved action. `None` if the turn is stopped meanwhile.
    async fn execute(&self, action: Action) -> Option<Outcome> {
        let runner = self.runner;
        let root = runner.canonical_root.clone();
        let outcome = match action {
            Action::Read(Tool::ReadFile {
                path,
                start_line,
                end_line,
            }) => {
                let overlay = read(&runner.store).overlay_snapshot();
                blocking(move || tools::read_file(&overlay, &root, &path, start_line, end_line))
                    .await
                    .into()
            }
            Action::Read(Tool::ListFiles { glob }) => {
                tools::list_files(&read(&runner.index), glob.as_deref()).into()
            }
            Action::Read(Tool::Search {
                query,
                glob,
                max_results,
                regex,
            }) => {
                let files = read(&runner.index).files();
                let overlay = read(&runner.store).overlay_snapshot();
                blocking(move || {
                    tools::search(
                        &files,
                        &overlay,
                        &query,
                        glob.as_deref(),
                        max_results,
                        regex,
                    )
                })
                .await
                .into()
            }
            Action::Read(other) => unreachable!("{other:?} is not a read-only tool"),
            Action::Edit {
                rel,
                doc,
                old,
                new,
                resolved,
            } => {
                // The document may have changed while the user decided.
                let resolved = match runner.read_text(rel.clone()).await {
                    Ok(current) if current == doc => resolved,
                    Ok(current) => match edit::resolve(&tools::display(&rel), &current, &old, &new)
                    {
                        Ok(resolved) => resolved,
                        Err(err) => {
                            return Some(Outcome::error(format!(
                                "the file changed while waiting for approval: {err}"
                            )));
                        }
                    },
                    Err(err) => {
                        return Some(Outcome::error(format!(
                            "cannot read {}: {err}",
                            tools::display(&rel)
                        )));
                    }
                };
                let op = EditOp::Edit {
                    uri: runner.uri(&rel),
                    range: resolved.range,
                    new_text: resolved.new_text,
                };
                let what = format!("edited {}", tools::display(&rel));
                self.apply(op, what).await?
            }
            Action::Create { rel, content, .. } => {
                let op = EditOp::Create {
                    uri: runner.uri(&rel),
                    content,
                };
                let what = format!("created {}", tools::display(&rel));
                self.apply(op, what).await?
            }
            Action::Command { command, cwd } => {
                let params = RunCommandParams {
                    command,
                    cwd: Some(cwd.to_string_lossy().into_owned()),
                };
                match self.request(methods::RUN_COMMAND, to_json(params)).await? {
                    Err(err) => Outcome::error(format!(
                        "the IDE could not run the command: {}",
                        err.message
                    )),
                    Ok(value) => match serde_json::from_value::<RunCommandResult>(value) {
                        Ok(result) => Outcome {
                            ok: result.exit_code == 0,
                            ..Outcome::success(tools::command_output(&result))
                        },
                        Err(err) => Outcome::error(format!("invalid runCommand response: {err}")),
                    },
                }
            }
        };
        Some(outcome)
    }

    /// Sends one `workspace/applyEdit` op (applied and saved by the IDE).
    async fn apply(&self, op: EditOp, what: String) -> Option<Outcome> {
        let params = ApplyEditParams {
            ops: vec![op],
            save: true,
        };
        Some(
            match self.request(methods::APPLY_EDIT, to_json(params)).await? {
                Err(err) => {
                    Outcome::error(format!("the IDE could not apply the edit: {}", err.message))
                }
                Ok(value) => match serde_json::from_value::<ApplyEditResult>(value) {
                    Ok(ApplyEditResult { applied: true, .. }) => Outcome {
                        ok: true,
                        content: format!("The edit was applied and saved: {what}."),
                        summary: what,
                    },
                    Ok(ApplyEditResult { error, .. }) => Outcome::error(format!(
                        "the IDE did not apply the edit: {}",
                        error.unwrap_or_else(|| "no reason given".into())
                    )),
                    Err(err) => Outcome::error(format!("invalid applyEdit response: {err}")),
                },
            },
        )
    }

    /// A core→client request; `None` if the turn is stopped first.
    async fn request(&self, method: &str, params: Value) -> Option<Result<Value, RpcError>> {
        tokio::select! {
            _ = self.cancel.cancelled() => None,
            result = self.ctx.request(method, params) => Some(result),
        }
    }
}

/// Runs a blocking tool on the blocking pool.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, ToolError> + Send + 'static,
) -> Result<T, ToolError> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|err| Err(ToolError::Failed(format!("tool panicked: {err}"))))
}
