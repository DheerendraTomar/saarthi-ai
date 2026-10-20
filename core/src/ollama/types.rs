//! Request and response shapes for the Ollama HTTP API.
//!
//! Field names follow the live probes recorded in
//! `docs/superpowers/notes/2026-10-20-ollama-assumptions.md` (Ollama 0.40.6).
//! Fields that only some chunks carry are `Option`s; unknown fields (such as
//! the `context` token array on the final `/api/generate` chunk) are skipped
//! by serde without being stored.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Sampling options shared by `/api/generate` and `/api/chat`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Options {
    pub num_predict: u32,
    pub temperature: f32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stop: Vec<String>,
    /// Context window in tokens; `None` uses the model's default (and is
    /// not sent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_ctx: Option<u32>,
}

/// Body of `POST /api/generate` (fill-in-the-middle via `prompt` + `suffix`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GenerateRequest {
    pub model: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suffix: Option<String>,
    pub raw: bool,
    pub stream: bool,
    pub options: Options,
    /// `None` means "use the client's configured keep-alive".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_alive: Option<String>,
}

/// One NDJSON line of a streaming `/api/generate` response.
///
/// Mid-stream chunks carry only `response` and `done:false`; the final chunk
/// has `response:""`, `done_reason`, and the counts/durations (nanoseconds).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerateChunk {
    #[serde(default)]
    pub response: String,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_eval_count: Option<u64>,
    /// Prompt tokens served from the KV cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_eval_cached_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_eval_duration: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eval_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eval_duration: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_duration: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_duration: Option<u64>,
}

/// Body of `POST /api/chat`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolSpec>,
    pub stream: bool,
    pub think: bool,
    pub options: Options,
    /// `None` means "use the client's configured keep-alive".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_alive: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

/// A chat message, both as sent and as received.
///
/// A tool result is `{"role":"tool","content":…,"tool_name":…}`; an assistant
/// message that called tools is sent back with its `tool_calls` as received.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    #[serde(default)]
    pub content: String,
    /// Absent when the request had `think:false`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

impl ChatMessage {
    fn plain(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            thinking: None,
            tool_calls: None,
            tool_name: None,
        }
    }

    pub fn system(content: impl Into<String>) -> Self {
        Self::plain(Role::System, content)
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self::plain(Role::User, content)
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self::plain(Role::Assistant, content)
    }

    /// The result of running tool `tool_name`.
    pub fn tool(tool_name: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            tool_name: Some(tool_name.into()),
            ..Self::plain(Role::Tool, content)
        }
    }
}

/// A tool call emitted by the model. There is no `type` field in responses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    /// Opaque id (observed as `call_` + 8 alphanumerics).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunctionCall {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    pub name: String,
    /// A JSON object, not a JSON-encoded string.
    pub arguments: Value,
}

/// A tool offered to the model: `{"type":"function","function":{…}}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub r#type: String,
    pub function: FunctionSpec,
}

impl ToolSpec {
    pub fn function(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: Value,
    ) -> Self {
        Self {
            r#type: "function".to_owned(),
            function: FunctionSpec {
                name: name.into(),
                description: description.into(),
                parameters,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunctionSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments object.
    pub parameters: Value,
}

/// One NDJSON line of a streaming `/api/chat` response.
///
/// `message.content` (and `message.thinking`) are deltas. As yielded by
/// [`OllamaClient::chat_stream`](super::OllamaClient::chat_stream),
/// `message.tool_calls` is `None` on every `done:false` chunk and the
/// `done:true` chunk carries every tool call of the turn, in arrival order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatChunk {
    pub message: ChatMessage,
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done_reason: Option<String>,
}

/// One NDJSON line of a streaming `/api/pull` response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullProgress {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
}
