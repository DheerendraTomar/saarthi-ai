//! The core's only Ollama client: health checks, model listing, pulls, and
//! streaming `/api/generate` + `/api/chat` with hard cancellation.

mod client;
pub mod types;

pub use crate::protocol::{OllamaState, OllamaStatus};
pub use client::OllamaClient;
pub use types::*;

/// Errors from talking to Ollama.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OllamaError {
    /// Ollama is not reachable (connection refused / connect timeout).
    #[error("Ollama is not reachable: {0}")]
    Down(String),
    /// The named model is not available locally.
    #[error("model {0:?} is not available in Ollama")]
    ModelMissing(String),
    /// Non-success HTTP status with Ollama's error message.
    #[error("Ollama returned HTTP {0}: {1}")]
    Http(u16, String),
    /// The caller's cancellation token fired.
    #[error("request cancelled")]
    Cancelled,
    #[error("{0}")]
    Other(String),
}

pub type Result<T, E = OllamaError> = std::result::Result<T, E>;
