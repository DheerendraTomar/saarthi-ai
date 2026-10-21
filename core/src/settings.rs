//! User settings, forwarded by the IDE client in `initialize`.
//!
//! Every field has a default, so a client may send `{}` or any subset.

use serde::{Deserialize, Serialize};

/// Whether the chat model is asked to emit `<think>` reasoning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Thinking {
    #[default]
    Off,
    On,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Base URL of the Ollama server. The core never talks to anything else.
    pub ollama_url: String,
    /// Small FIM model used for inline completions.
    pub completion_model: String,
    /// Tool-calling model used for agent chat.
    pub chat_model: String,
    pub completions_enabled: bool,
    /// Client-side debounce before sending `completion/request`.
    pub completion_debounce_ms: u64,
    /// `num_predict` for completion requests.
    pub completion_max_tokens: u32,
    pub chat_thinking: Thinking,
    /// Overrides the bundled core binary (client-side; carried for completeness).
    pub core_binary_path: Option<String>,
    /// Commands the user approved with "always"; these skip the approval prompt.
    pub allowed_commands_always: Vec<String>,
    /// Total completion prompt budget (prefix + suffix + related snippets).
    pub completion_context_tokens: usize,
    /// Chat history budget before older turns are dropped.
    pub chat_context_tokens: usize,
    /// `keep_alive` sent with every Ollama request so models stay resident.
    pub keep_alive: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ollama_url: "http://localhost:11434".to_string(),
            completion_model: "qwen2.5-coder:0.5b-base".to_string(),
            chat_model: "qwen3.8:27b-mlx".to_string(),
            completions_enabled: true,
            completion_debounce_ms: 120,
            completion_max_tokens: 32,
            chat_thinking: Thinking::Off,
            core_binary_path: None,
            allowed_commands_always: Vec::new(),
            completion_context_tokens: 3584,
            chat_context_tokens: 24000,
            keep_alive: "30m".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_defaults_match_spec() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.ollama_url, "http://localhost:11434");
        assert_eq!(s.completion_model, "qwen2.5-coder:0.5b-base");
        assert_eq!(s.chat_model, "qwen3.8:27b-mlx");
        assert!(s.completions_enabled);
        assert_eq!(s.completion_debounce_ms, 120);
        assert_eq!(s.completion_max_tokens, 32);
        assert_eq!(s.chat_thinking, Thinking::Off);
        assert_eq!(s.core_binary_path, None);
        assert!(s.allowed_commands_always.is_empty());
        assert_eq!(s.completion_context_tokens, 3584);
        assert_eq!(s.chat_context_tokens, 24000);
        assert_eq!(s.keep_alive, "30m");
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn settings_accept_camel_case() {
        let s: Settings = serde_json::from_str(
            r#"{"ollamaUrl":"http://x:1","chatThinking":"on","completionDebounceMs":50,
                "allowedCommandsAlways":["cargo test"],"coreBinaryPath":"/bin/x"}"#,
        )
        .unwrap();
        assert_eq!(s.ollama_url, "http://x:1");
        assert_eq!(s.chat_thinking, Thinking::On);
        assert_eq!(s.completion_debounce_ms, 50);
        assert_eq!(s.allowed_commands_always, vec!["cargo test".to_string()]);
        assert_eq!(s.core_binary_path.as_deref(), Some("/bin/x"));
        // Unspecified fields keep their defaults.
        assert_eq!(s.chat_model, "qwen3.8:27b-mlx");

        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["ollamaUrl"], "http://x:1");
        assert_eq!(v["chatThinking"], "on");
        assert_eq!(v["completionContextTokens"], 3584);
        assert_eq!(v["keepAlive"], "30m");
    }
}
