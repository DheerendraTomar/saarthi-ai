//! Agent chat (spec §7): a tool-calling loop against the chat model.
//!
//! - [`tools`]: tool schemas, argument parsing, workspace confinement and the
//!   read-only tools (`read_file`, `list_files`, `search`).
//! - [`edit`]: resolving the model's `edit_file { old, new }` to a range.
//! - [`session`]: persisted chat history and history trimming.
//! - [`prompt`]: the system prompt.
//! - [`runner`]: the loop itself — streaming, approvals, client requests.

pub mod edit;
pub mod prompt;
pub mod runner;
pub mod session;
pub mod tools;

pub use runner::AgentRunner;
