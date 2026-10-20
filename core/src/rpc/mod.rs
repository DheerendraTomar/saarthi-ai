//! JSON-RPC 2.0 transport over newline-delimited stdio.

pub mod framing;
pub mod server;

pub use framing::{Id, Message, RpcError};
pub use server::{ClientLink, Ctx, Handler, RpcServer};
