//! Inline (ghost-text) completions: prompt assembly, caching, stop rules and
//! the engine that drives the fill-in-the-middle model through Ollama.

pub mod cache;
pub mod engine;
pub mod prompt;
pub mod stop;

pub use cache::{CacheHit, CompletionCache};
pub use engine::{CompletionEngine, CompletionTiming};
pub use prompt::FimPrompt;
pub use stop::{StopMode, Trimmer};
