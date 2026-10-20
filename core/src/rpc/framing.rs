//! Newline-delimited JSON-RPC 2.0 message framing.
//!
//! Each message is one JSON object on one line. [`Message::decode`] classifies
//! a line as a request (`method` + `id`), notification (`method`, no `id`) or
//! response (`id` + `result`/`error`); [`Message::encode`] produces a single
//! line with no embedded newlines.

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// A JSON-RPC request id: a number or a string.
pub type Id = Value;

/// A JSON-RPC error object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("rpc error {code}: {message}")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    /// Standard JSON-RPC internal error; used when a server->client request
    /// times out or the connection closes before the client answers.
    pub const INTERNAL_ERROR: i64 = -32603;
    pub const OLLAMA_DOWN: i64 = -32000;
    pub const MODEL_MISSING: i64 = -32001;
    pub const CANCELLED: i64 = -32002;

    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(
            Self::METHOD_NOT_FOUND,
            format!("method not found: {method}"),
        )
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(Self::INVALID_PARAMS, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(Self::INTERNAL_ERROR, message)
    }

    pub fn ollama_down(message: impl Into<String>) -> Self {
        Self::new(Self::OLLAMA_DOWN, message)
    }

    pub fn model_missing(message: impl Into<String>) -> Self {
        Self::new(Self::MODEL_MISSING, message)
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(Self::CANCELLED, message)
    }
}

/// One JSON-RPC 2.0 message.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Request {
        id: Id,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: Id,
        result: Option<Value>,
        error: Option<RpcError>,
    },
}

impl Message {
    /// Parses one line. A missing `params` decodes as `Value::Null`.
    pub fn decode(line: &str) -> Result<Message> {
        let value: Value = serde_json::from_str(line).context("invalid JSON")?;
        let Value::Object(mut obj) = value else {
            bail!("JSON-RPC message must be an object");
        };
        let id = obj.remove("id");
        if let Some(id) = &id {
            if !(id.is_number() || id.is_string() || id.is_null()) {
                bail!("JSON-RPC id must be a number or string, got {id}");
            }
        }

        if let Some(method) = obj.remove("method") {
            let Value::String(method) = method else {
                bail!("JSON-RPC method must be a string");
            };
            let params = obj.remove("params").unwrap_or(Value::Null);
            return Ok(match id {
                Some(id) if !id.is_null() => Message::Request { id, method, params },
                _ => Message::Notification { method, params },
            });
        }

        let id = id.ok_or_else(|| anyhow!("message has neither method nor id"))?;
        let result = obj.remove("result");
        let error = obj
            .remove("error")
            .filter(|e| !e.is_null())
            .map(serde_json::from_value::<RpcError>)
            .transpose()
            .context("invalid error object")?;
        if result.is_none() && error.is_none() {
            bail!("response has neither result nor error");
        }
        Ok(Message::Response { id, result, error })
    }

    /// Serializes to a single line (no trailing newline, no embedded newlines).
    pub fn encode(&self) -> String {
        let mut obj = Map::new();
        obj.insert("jsonrpc".into(), json!("2.0"));
        match self {
            Message::Request { id, method, params } => {
                obj.insert("id".into(), id.clone());
                obj.insert("method".into(), json!(method));
                obj.insert("params".into(), params.clone());
            }
            Message::Notification { method, params } => {
                obj.insert("method".into(), json!(method));
                obj.insert("params".into(), params.clone());
            }
            Message::Response { id, result, error } => {
                obj.insert("id".into(), id.clone());
                match error {
                    Some(error) => {
                        obj.insert("error".into(), json!(error));
                    }
                    None => {
                        obj.insert("result".into(), result.clone().unwrap_or(Value::Null));
                    }
                }
            }
        }
        // serde_json's compact output escapes control characters inside
        // strings, so the result never contains a raw newline.
        Value::Object(obj).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_each_kind() {
        assert_eq!(
            Message::decode(r#"{"jsonrpc":"2.0","id":1,"method":"m","params":{"a":1}}"#).unwrap(),
            Message::Request {
                id: json!(1),
                method: "m".into(),
                params: json!({"a":1})
            }
        );
        assert_eq!(
            Message::decode(r#"{"jsonrpc":"2.0","method":"n"}"#).unwrap(),
            Message::Notification {
                method: "n".into(),
                params: Value::Null
            }
        );
        assert_eq!(
            Message::decode(r#"{"jsonrpc":"2.0","id":"x","error":{"code":-32601,"message":"no"}}"#)
                .unwrap(),
            Message::Response {
                id: json!("x"),
                result: None,
                error: Some(RpcError::new(-32601, "no"))
            }
        );
    }

    #[test]
    fn encode_round_trips_on_one_line() {
        let msg = Message::Request {
            id: json!(-1),
            method: "workspace/applyEdit".into(),
            params: json!({"text": "a\nb"}),
        };
        let line = msg.encode();
        assert!(!line.contains('\n'));
        assert_eq!(Message::decode(&line).unwrap(), msg);
    }

    #[test]
    fn rejects_garbage() {
        assert!(Message::decode("nope").is_err());
        assert!(Message::decode("[1]").is_err());
        assert!(Message::decode(r#"{"jsonrpc":"2.0"}"#).is_err());
        assert!(Message::decode(r#"{"id":{},"method":"m"}"#).is_err());
    }
}
