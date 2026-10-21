//! Wire types for the newline-delimited JSON-RPC 2.0 protocol spoken over
//! stdio between IDE clients and the core (spec §4.4).
//!
//! Conventions:
//! - All JSON keys are camelCase; enum wire strings are camelCase too
//!   (`"once"`, `"modelMissing"`, `"contextFull"`).
//! - [`Position::character`] is measured in **UTF-16 code units** (LSP
//!   convention), not bytes or `char`s.
//! - Request params/results are named `<Method>Params` / `<Method>Result`;
//!   notifications are named after the method (`ChatToken`, `ChatDone`, ...).
//!
//! Semantics that are not visible in the types:
//! - **`chat/send` responds `{}` as soon as the turn is queued.** The turn then
//!   streams `chat/token` / `chat/toolCall` / `chat/toolResult`
//!   notifications; completion is signalled **only** by `chat/done`.
//! - **`initialize` responds immediately** with `indexStatus: "building"`. The
//!   workspace index is built in the background and the core emits an
//!   `index/ready` notification ([`IndexReady`]) when it is done.
//! - `workspace/applyEdit` and `workspace/runCommand` are requests sent **by
//!   the core to the client**; the client's response becomes the tool result.
//! - `ollama/pull` streams `ollama/pullProgress` notifications
//!   ([`OllamaPullProgress`]) and responds when the pull finishes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::settings::Settings;

/// JSON-RPC method names, exactly as they appear on the wire.
pub mod methods {
    // Client → core requests.
    pub const INITIALIZE: &str = "initialize";
    pub const COMPLETION_REQUEST: &str = "completion/request";
    pub const CHAT_SEND: &str = "chat/send";
    pub const CHAT_STOP: &str = "chat/stop";
    pub const CHAT_APPROVE: &str = "chat/approve";
    pub const CHAT_NEW_SESSION: &str = "chat/newSession";
    pub const CHAT_LIST_SESSIONS: &str = "chat/listSessions";
    pub const CHAT_HISTORY: &str = "chat/history";
    pub const CHAT_DELETE_SESSION: &str = "chat/deleteSession";
    pub const CHAT_CLEAR_SESSIONS: &str = "chat/clearSessions";
    pub const OLLAMA_STATUS: &str = "ollama/status";
    pub const OLLAMA_PULL: &str = "ollama/pull";
    pub const OLLAMA_MODELS: &str = "ollama/models";
    pub const BENCH_RUN: &str = "bench/run";
    pub const SHUTDOWN: &str = "shutdown";

    // Client → core notifications.
    pub const DID_OPEN: &str = "textDocument/didOpen";
    pub const DID_CHANGE: &str = "textDocument/didChange";
    pub const DID_CLOSE: &str = "textDocument/didClose";
    pub const DID_SAVE: &str = "textDocument/didSave";
    pub const COMPLETION_CANCEL: &str = "completion/cancel";
    pub const COMPLETION_ACCEPTED: &str = "completion/accepted";
    pub const COMPLETION_REJECTED: &str = "completion/rejected";
    pub const COMPLETION_OUTCOME: &str = "completion/outcome";

    // Core → client notifications.
    pub const CHAT_TOKEN: &str = "chat/token";
    pub const CHAT_TOOL_CALL: &str = "chat/toolCall";
    pub const CHAT_TOOL_RESULT: &str = "chat/toolResult";
    pub const CHAT_DONE: &str = "chat/done";
    pub const STATUS: &str = "status";
    pub const OLLAMA_PULL_PROGRESS: &str = "ollama/pullProgress";
    pub const INDEX_READY: &str = "index/ready";

    // Core → client requests.
    pub const APPLY_EDIT: &str = "workspace/applyEdit";
    pub const RUN_COMMAND: &str = "workspace/runCommand";
}

// ---------------------------------------------------------------- primitives

/// Zero-based position in a document. `character` is in UTF-16 code units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub line: u32,
    /// Offset within the line in UTF-16 code units.
    pub character: u32,
}

/// Half-open range `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// A replacement of `range` in document `uri` with `new_text`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub uri: String,
    pub range: Range,
    pub new_text: String,
}

// ---------------------------------------------------------------- initialize

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub workspace_root: String,
    #[serde(default)]
    pub settings: Settings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub capabilities: Capabilities,
    pub ollama_status: OllamaStatus,
    pub index_status: IndexStatus,
}

/// Features this core build supports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub completion: bool,
    pub chat: bool,
    pub bench: bool,
}

impl Default for Capabilities {
    /// What this build serves: `bench/run` is not served over RPC (the
    /// benchmark is the `bench` subcommand), so `bench` is `false`.
    fn default() -> Self {
        Self {
            completion: true,
            chat: true,
            bench: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexStatus {
    Building,
    Ready,
}

/// Notification `index/ready`, emitted once the background index build ends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexReady {
    pub files: usize,
    pub build_ms: u64,
}

// ---------------------------------------------------------------- documents

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidOpenParams {
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language_id: Option<String>,
    pub version: i32,
    pub text: String,
}

/// One change in `textDocument/didChange`. `range: None` replaces the whole
/// document with `text`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentChange {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
    pub text: String,
}

/// Changes are applied in order, each against the result of the previous one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidChangeParams {
    pub uri: String,
    pub version: i32,
    pub content_changes: Vec<ContentChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidCloseParams {
    pub uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DidSaveParams {
    pub uri: String,
}

// ---------------------------------------------------------------- completion

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequestParams {
    pub uri: String,
    pub position: Position,
    pub request_id: String,
}

/// An empty `items` list is a valid, common answer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResult {
    pub items: Vec<CompletionItem>,
}

/// `text` replaces `range` (usually an empty range at the cursor).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionItem {
    pub text: String,
    pub range: Range,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionCancelParams {
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionAcceptedParams {
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRejectedParams {
    pub request_id: String,
}

/// What the user did with a served suggestion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionOutcome {
    Accepted,
    Partial,
    Rejected,
    TypedThrough,
}

/// `completion/outcome`: the richer form of `completion/accepted` /
/// `completion/rejected`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionOutcomeParams {
    pub request_id: String,
    pub outcome: CompletionOutcome,
    /// The part of the suggestion the user kept (e.g. for `partial`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_text: Option<String>,
}

// ---------------------------------------------------------------- chat requests

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendParams {
    pub session_id: String,
    pub message: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

/// A file (or a range of it) the user attached to a chat message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<Range>,
}

/// `chat/send` responds `{}` as soon as the turn is queued.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSendResult {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStopParams {
    pub session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Once,
    Always,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatApproveParams {
    pub session_id: String,
    pub tool_call_id: String,
    pub decision: Decision,
    /// Replacement tool arguments if the user edited them before approving.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_args: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatNewSessionResult {
    pub session_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListSessionsResult {
    pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub title: String,
    /// Milliseconds since the Unix epoch.
    pub updated_at_ms: u64,
}

/// `chat/deleteSession` removes the session's file and responds `{}` (also
/// when there is no file). Refused with `-32602` ("turn running …") while a
/// turn runs in that session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDeleteSessionParams {
    pub session_id: String,
}

/// Result of `chat/clearSessions {}`: every saved session is deleted except
/// those with a running turn, which are listed in `skipped`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatClearSessionsResult {
    pub deleted: usize,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryResult {
    pub session_id: String,
    pub messages: Vec<HistoryMessage>,
}

/// One persisted message, for replaying a session in the chat UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    /// `"user" | "assistant" | "tool"`.
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// Present on `"tool"` messages: the call this is the result of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Tool calls made by an `"assistant"` message.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<HistoryToolCall>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryToolCall {
    pub tool_call_id: String,
    pub name: String,
    pub args: Value,
}

// ---------------------------------------------------------------- chat notifications

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenKind {
    Text,
    Thinking,
}

/// Notification `chat/token`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToken {
    pub session_id: String,
    pub delta: String,
    pub kind: TokenKind,
}

/// Notification `chat/toolCall`. `preview` is a unified diff for edits and the
/// command line for commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolCall {
    pub session_id: String,
    pub tool_call_id: String,
    pub name: String,
    pub args: Value,
    pub requires_approval: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// Notification `chat/toolResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolResult {
    pub session_id: String,
    pub tool_call_id: String,
    pub ok: bool,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Done,
    Stopped,
    Error,
    ContextFull,
}

/// Notification `chat/done` — the only signal that a turn has finished.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDone {
    pub session_id: String,
    pub stop_reason: StopReason,
}

// ---------------------------------------------------------------- core → client requests

/// Request `workspace/applyEdit`. The client applies the ops through the IDE's
/// edit API and, if `save`, saves the touched files before responding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEditParams {
    pub ops: Vec<EditOp>,
    pub save: bool,
    /// The chat session whose turn asked for the edit, so a client serving
    /// several sessions (the JupyterLab bridge) can route it to the right UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditOp {
    Edit {
        uri: String,
        range: Range,
        new_text: String,
    },
    Create {
        uri: String,
        content: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEditResult {
    pub applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Request `workspace/runCommand`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommandParams {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// The chat session whose turn asked for the command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

// ---------------------------------------------------------------- ollama / status

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OllamaState {
    Ok,
    Down,
    ModelMissing,
}

/// Ollama health, `{ ollama, detail }` on the wire: the `status`
/// notification, the `ollama/status` result and
/// [`InitializeResult::ollama_status`] all use this one shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusNotification {
    pub ollama: OllamaState,
    pub detail: String,
}

/// Ollama health as probed; the same type (and wire shape) as
/// [`StatusNotification`].
pub type OllamaStatus = StatusNotification;

/// Result of `ollama/status`.
pub type OllamaStatusResult = OllamaStatus;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullParams {
    pub model: String,
}

/// `ollama/pull` responds `{}` once the pull has finished.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OllamaPullResult {}

/// Result of `ollama/models {}`: the models installed in Ollama, in
/// `/api/tags` order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelsResult {
    pub models: Vec<OllamaModel>,
}

/// One installed model. The capabilities come from `/api/show`; if that
/// fails for a model, both are `false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    pub name: String,
    pub size_bytes: u64,
    /// `details.family`; absent when Ollama reports none (or `""`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    /// Fill-in-the-middle (`insert` capability): usable as completion model.
    pub supports_insert: bool,
    /// Tool calling (`tools` capability): usable as agent chat model.
    pub supports_tools: bool,
}

/// Notification `ollama/pullProgress`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaPullProgress {
    pub model: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

// ---------------------------------------------------------------- bench

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BenchRunParams {
    /// Number of synthetic completion requests; `None` = core default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations: Option<u32>,
}

/// Timing report for `bench/run` (spec §5.5). All times in milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchRunResult {
    pub iterations: u32,
    pub ttft_p50_ms: f64,
    pub ttft_p95_ms: f64,
    pub overhead_p50_ms: f64,
    pub overhead_p95_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rss_bytes: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn methods_strings_are_exact() {
        assert_eq!(methods::INITIALIZE, "initialize");
        assert_eq!(methods::DID_OPEN, "textDocument/didOpen");
        assert_eq!(methods::DID_CHANGE, "textDocument/didChange");
        assert_eq!(methods::DID_CLOSE, "textDocument/didClose");
        assert_eq!(methods::DID_SAVE, "textDocument/didSave");
        assert_eq!(methods::COMPLETION_REQUEST, "completion/request");
        assert_eq!(methods::COMPLETION_CANCEL, "completion/cancel");
        assert_eq!(methods::COMPLETION_ACCEPTED, "completion/accepted");
        assert_eq!(methods::COMPLETION_REJECTED, "completion/rejected");
        assert_eq!(methods::COMPLETION_OUTCOME, "completion/outcome");
        assert_eq!(methods::CHAT_SEND, "chat/send");
        assert_eq!(methods::CHAT_STOP, "chat/stop");
        assert_eq!(methods::CHAT_APPROVE, "chat/approve");
        assert_eq!(methods::CHAT_NEW_SESSION, "chat/newSession");
        assert_eq!(methods::CHAT_LIST_SESSIONS, "chat/listSessions");
        assert_eq!(methods::CHAT_HISTORY, "chat/history");
        assert_eq!(methods::OLLAMA_STATUS, "ollama/status");
        assert_eq!(methods::OLLAMA_PULL, "ollama/pull");
        assert_eq!(methods::OLLAMA_MODELS, "ollama/models");
        assert_eq!(methods::CHAT_DELETE_SESSION, "chat/deleteSession");
        assert_eq!(methods::CHAT_CLEAR_SESSIONS, "chat/clearSessions");
        assert_eq!(methods::BENCH_RUN, "bench/run");
        assert_eq!(methods::SHUTDOWN, "shutdown");
        assert_eq!(methods::CHAT_TOKEN, "chat/token");
        assert_eq!(methods::CHAT_TOOL_CALL, "chat/toolCall");
        assert_eq!(methods::CHAT_TOOL_RESULT, "chat/toolResult");
        assert_eq!(methods::CHAT_DONE, "chat/done");
        assert_eq!(methods::APPLY_EDIT, "workspace/applyEdit");
        assert_eq!(methods::RUN_COMMAND, "workspace/runCommand");
        assert_eq!(methods::STATUS, "status");
        assert_eq!(methods::OLLAMA_PULL_PROGRESS, "ollama/pullProgress");
        assert_eq!(methods::INDEX_READY, "index/ready");
    }

    #[test]
    fn apply_edit_ops_serialize_tagged() {
        let params = ApplyEditParams {
            ops: vec![
                EditOp::Edit {
                    uri: "file:///a.rs".into(),
                    range: Range {
                        start: Position {
                            line: 1,
                            character: 2,
                        },
                        end: Position {
                            line: 1,
                            character: 5,
                        },
                    },
                    new_text: "xyz".into(),
                },
                EditOp::Create {
                    uri: "file:///b.rs".into(),
                    content: "fn main() {}".into(),
                },
            ],
            save: true,
            session_id: Some("s1".into()),
        };
        let v = serde_json::to_value(&params).unwrap();
        assert_eq!(
            v,
            json!({
                "ops": [
                    {"kind": "edit", "uri": "file:///a.rs",
                     "range": {"start": {"line": 1, "character": 2}, "end": {"line": 1, "character": 5}},
                     "newText": "xyz"},
                    {"kind": "create", "uri": "file:///b.rs", "content": "fn main() {}"}
                ],
                "save": true,
                "sessionId": "s1"
            })
        );
        let back: ApplyEditParams = serde_json::from_value(v).unwrap();
        assert_eq!(back, params);
    }

    #[test]
    fn decision_serializes_lowercase() {
        assert_eq!(serde_json::to_value(Decision::Once).unwrap(), "once");
        assert_eq!(serde_json::to_value(Decision::Always).unwrap(), "always");
        assert_eq!(serde_json::to_value(Decision::Deny).unwrap(), "deny");
        let p: ChatApproveParams = serde_json::from_value(json!({
            "sessionId": "s", "toolCallId": "t", "decision": "always"
        }))
        .unwrap();
        assert_eq!(p.decision, Decision::Always);
        assert_eq!(p.edited_args, None);
    }

    #[test]
    fn multiword_enum_variants_are_camel_case() {
        assert_eq!(serde_json::to_value(OllamaState::Ok).unwrap(), "ok");
        assert_eq!(serde_json::to_value(OllamaState::Down).unwrap(), "down");
        assert_eq!(
            serde_json::to_value(OllamaState::ModelMissing).unwrap(),
            "modelMissing"
        );
        assert_eq!(serde_json::to_value(StopReason::Done).unwrap(), "done");
        assert_eq!(
            serde_json::to_value(StopReason::Stopped).unwrap(),
            "stopped"
        );
        assert_eq!(serde_json::to_value(StopReason::Error).unwrap(), "error");
        assert_eq!(
            serde_json::to_value(StopReason::ContextFull).unwrap(),
            "contextFull"
        );
        assert_eq!(
            serde_json::to_value(TokenKind::Thinking).unwrap(),
            "thinking"
        );
        assert_eq!(serde_json::to_value(TokenKind::Text).unwrap(), "text");
        assert_eq!(
            serde_json::to_value(IndexStatus::Building).unwrap(),
            "building"
        );
        assert_eq!(serde_json::to_value(IndexStatus::Ready).unwrap(), "ready");
    }

    #[test]
    fn initialize_round_trips_camel_case() {
        let p: InitializeParams = serde_json::from_value(json!({
            "workspaceRoot": "/w", "settings": {"chatModel": "m"}
        }))
        .unwrap();
        assert_eq!(p.workspace_root, "/w");
        assert_eq!(p.settings.chat_model, "m");

        let r = InitializeResult {
            capabilities: Capabilities::default(),
            ollama_status: OllamaStatus {
                ollama: OllamaState::ModelMissing,
                detail: "x".into(),
            },
            index_status: IndexStatus::Building,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(
            v["ollamaStatus"],
            json!({"ollama": "modelMissing", "detail": "x"})
        );
        assert_eq!(v["indexStatus"], "building");
        assert_eq!(
            v["capabilities"],
            json!({"completion": true, "chat": true, "bench": false})
        );
    }

    #[test]
    fn notifications_use_camel_case_keys() {
        let v = serde_json::to_value(ChatToolCall {
            session_id: "s".into(),
            tool_call_id: "t".into(),
            name: "edit_file".into(),
            args: json!({"path": "a"}),
            requires_approval: true,
            preview: Some("--- a".into()),
        })
        .unwrap();
        assert_eq!(v["sessionId"], "s");
        assert_eq!(v["toolCallId"], "t");
        assert_eq!(v["requiresApproval"], true);
        assert_eq!(v["preview"], "--- a");

        let v = serde_json::to_value(ChatDone {
            session_id: "s".into(),
            stop_reason: StopReason::ContextFull,
        })
        .unwrap();
        assert_eq!(v, json!({"sessionId": "s", "stopReason": "contextFull"}));

        let v = serde_json::to_value(IndexReady {
            files: 3,
            build_ms: 12,
        })
        .unwrap();
        assert_eq!(v, json!({"files": 3, "buildMs": 12}));

        let v = serde_json::to_value(StatusNotification {
            ollama: OllamaState::Down,
            detail: "refused".into(),
        })
        .unwrap();
        assert_eq!(v, json!({"ollama": "down", "detail": "refused"}));
    }

    #[test]
    fn requests_from_client_parse() {
        let p: CompletionRequestParams = serde_json::from_value(json!({
            "uri": "file:///a", "position": {"line": 0, "character": 3}, "requestId": "r1"
        }))
        .unwrap();
        assert_eq!(
            p.position,
            Position {
                line: 0,
                character: 3
            }
        );
        assert_eq!(p.request_id, "r1");

        let p: CompletionOutcomeParams = serde_json::from_value(json!({
            "requestId": "r1", "outcome": "partial", "acceptedText": "a +"
        }))
        .unwrap();
        assert_eq!(p.outcome, CompletionOutcome::Partial);
        assert_eq!(p.accepted_text.as_deref(), Some("a +"));
        let p: CompletionOutcomeParams =
            serde_json::from_value(json!({"requestId": "r2", "outcome": "typedThrough"})).unwrap();
        assert_eq!(p.outcome, CompletionOutcome::TypedThrough);
        assert_eq!(p.accepted_text, None);
        assert!(
            serde_json::from_value::<CompletionOutcomeParams>(
                json!({"requestId": "r3", "outcome": "maybe"})
            )
            .is_err()
        );

        let p: ChatSendParams = serde_json::from_value(json!({
            "sessionId": "s", "message": "hi",
            "attachments": [{"uri": "file:///a"},
                            {"uri": "file:///b", "range": {"start": {"line": 0, "character": 0},
                                                           "end": {"line": 2, "character": 0}}}]
        }))
        .unwrap();
        assert_eq!(p.attachments.len(), 2);
        assert_eq!(p.attachments[0].range, None);
        assert!(p.attachments[1].range.is_some());
        // attachments may be omitted
        let p: ChatSendParams =
            serde_json::from_value(json!({"sessionId": "s", "message": "hi"})).unwrap();
        assert!(p.attachments.is_empty());

        let p: DidChangeParams = serde_json::from_value(json!({
            "uri": "file:///a", "version": 2,
            "contentChanges": [{"text": "all"},
                               {"range": {"start": {"line": 0, "character": 0},
                                          "end": {"line": 0, "character": 1}}, "text": "x"}]
        }))
        .unwrap();
        assert_eq!(p.content_changes[0].range, None);
        assert!(p.content_changes[1].range.is_some());
    }

    #[test]
    fn client_responses_parse() {
        let r: ApplyEditResult = serde_json::from_value(json!({"applied": true})).unwrap();
        assert!(r.applied);
        assert_eq!(r.error, None);
        let r: RunCommandResult =
            serde_json::from_value(json!({"exitCode": 1, "stdout": "o", "stderr": "e"})).unwrap();
        assert_eq!(r.exit_code, 1);
        let v = serde_json::to_value(RunCommandParams {
            command: "ls".into(),
            cwd: None,
            session_id: None,
        })
        .unwrap();
        assert_eq!(v, json!({"command": "ls"}));
        let p: RunCommandParams =
            serde_json::from_value(json!({"command": "ls", "sessionId": "s"})).unwrap();
        assert_eq!(p.session_id.as_deref(), Some("s"));
        let p: ApplyEditParams = serde_json::from_value(json!({"ops": [], "save": false})).unwrap();
        assert_eq!(p.session_id, None);
        assert_eq!(serde_json::to_value(ChatSendResult {}).unwrap(), json!({}));
    }
}
