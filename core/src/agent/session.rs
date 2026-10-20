//! Chat sessions persisted under `<workspace>/.localpilot/sessions/<id>.json`
//! (spec §7.4), and history trimming to the chat context budget.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::tools::RUN_COMMAND;
use crate::ollama::{ChatMessage, Role};
use crate::protocol::SessionSummary;
use crate::tokens;

/// One chat: its full history (`messages[0]` is the system prompt once a
/// turn has run) and the "always" approvals granted in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub created: u64,
    pub messages: Vec<ChatMessage>,
    /// Keys from [`always_allow_key`].
    #[serde(default)]
    pub always_allow: HashSet<String>,
}

/// Key under which an "always" approval is remembered: the tool name, or
/// `"run_command:<exact command>"` so approving one command line never
/// approves another.
pub fn always_allow_key(tool: &str, command: Option<&str>) -> String {
    match command {
        Some(command) if tool == RUN_COMMAND => format!("{RUN_COMMAND}:{command}"),
        _ => tool.to_owned(),
    }
}

/// Session ids name files, so they are restricted to `[A-Za-z0-9_-]{1,128}`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Estimated prompt tokens of one message as sent (thinking excluded).
pub fn message_tokens(message: &ChatMessage) -> usize {
    const PER_MESSAGE: usize = 4;
    let calls = message.tool_calls.as_ref().map_or(0, |calls| {
        tokens::estimate(&serde_json::to_string(calls).unwrap_or_default())
    });
    PER_MESSAGE + tokens::estimate(&message.content) + calls
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn invalid_id(id: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("invalid session id {id:?}"),
    )
}

/// `<root>/.localpilot`.
fn state_dir(root: &Path) -> PathBuf {
    root.join(".localpilot")
}

/// Creates `<root>/.localpilot` and its `.gitignore` (`*`, so nothing the
/// core writes there — log, sessions — is ever committed), and returns the
/// directory. Idempotent; used by the log setup and by session saves, so the
/// `.gitignore` exists as soon as anything is written there.
pub fn ensure_state_dir(root: &Path) -> io::Result<PathBuf> {
    let dir = state_dir(root);
    fs::create_dir_all(&dir)?;
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        fs::write(&gitignore, "*\n")?;
    }
    Ok(dir)
}

fn sessions_dir(root: &Path) -> PathBuf {
    state_dir(root).join("sessions")
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    /// An empty session with a fresh, unique id.
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let seq = NEXT.fetch_add(1, Ordering::Relaxed);
        Self::empty(format!("{nanos:x}-{}-{seq}", std::process::id()))
    }

    /// An empty session with a client-chosen id (validated, see [`valid_id`]).
    pub fn with_id(id: &str) -> io::Result<Self> {
        if !valid_id(id) {
            return Err(invalid_id(id));
        }
        Ok(Self::empty(id.to_owned()))
    }

    fn empty(id: String) -> Self {
        Self {
            id,
            created: now_ms(),
            messages: Vec::new(),
            always_allow: HashSet::new(),
        }
    }

    /// Writes `<root>/.localpilot/sessions/<id>.json` (atomically, via a temp
    /// file); see [`write_encoded`](Self::write_encoded).
    pub fn save(&self, root: &Path) -> io::Result<()> {
        Self::write_encoded(root, &self.id, self.encode()?)
    }

    /// The session file's contents, so a caller can serialize while it holds
    /// the session and write later (e.g. on the blocking pool) without
    /// cloning it.
    pub fn encode(&self) -> io::Result<Vec<u8>> {
        serde_json::to_vec_pretty(self).map_err(io::Error::other)
    }

    /// Writes `json` (from [`encode`](Self::encode)) as session `id`,
    /// atomically via a temp file, creating `<root>/.localpilot/.gitignore`
    /// ([`ensure_state_dir`]) if missing.
    pub fn write_encoded(root: &Path, id: &str, json: Vec<u8>) -> io::Result<()> {
        if !valid_id(id) {
            return Err(invalid_id(id));
        }
        ensure_state_dir(root)?;
        let dir = sessions_dir(root);
        fs::create_dir_all(&dir)?;
        let tmp = dir.join(format!("{id}.json.tmp"));
        fs::write(&tmp, json)?;
        fs::rename(&tmp, dir.join(format!("{id}.json")))
    }

    /// Reads a saved session. `NotFound` if it was never saved.
    pub fn load(root: &Path, id: &str) -> io::Result<Session> {
        if !valid_id(id) {
            return Err(invalid_id(id));
        }
        let bytes = fs::read(sessions_dir(root).join(format!("{id}.json")))?;
        serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    /// Summaries of the saved sessions, most recently updated first.
    /// Unreadable files are skipped.
    pub fn list(root: &Path) -> Vec<SessionSummary> {
        let Ok(entries) = fs::read_dir(sessions_dir(root)) else {
            return Vec::new();
        };
        let mut sessions: Vec<SessionSummary> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let id = path
                    .file_name()?
                    .to_str()?
                    .strip_suffix(".json")?
                    .to_owned();
                let session = Session::load(root, &id).ok()?;
                let updated_at_ms = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(session.created, |d| d.as_millis() as u64);
                Some(SessionSummary {
                    session_id: id,
                    title: session.title(),
                    updated_at_ms,
                })
            })
            .collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at_ms));
        sessions
    }

    /// First line of the first user message (≤ 80 chars), or "New chat".
    pub fn title(&self) -> String {
        const MAX_CHARS: usize = 80;
        self.messages
            .iter()
            .find(|m| m.role == Role::User)
            .and_then(|m| m.content.lines().find(|l| !l.trim().is_empty()))
            .map(|line| line.trim().chars().take(MAX_CHARS).collect())
            .unwrap_or_else(|| "New chat".to_owned())
    }

    /// Sets the system prompt, which is always `messages[0]`.
    pub fn set_system_prompt(&mut self, prompt: String) {
        match self.messages.first_mut() {
            Some(first) if first.role == Role::System => first.content = prompt,
            _ => self.messages.insert(0, ChatMessage::system(prompt)),
        }
    }

    /// The history to send to the model within `chat_context_tokens`.
    ///
    /// Messages are grouped into turns (a user message; an assistant message
    /// together with the tool results that follow it). Oldest turns are
    /// dropped first, but never the system prompt, the latest user message,
    /// or the last turn (the last tool-call/tool-result pair). If even those
    /// do not fit they are returned anyway; the caller compares the estimate
    /// with the budget. Thinking is not sent back.
    pub fn trimmed_messages(&self, chat_context_tokens: usize) -> Vec<ChatMessage> {
        let (system, rest) = match self.messages.split_first() {
            Some((first, rest)) if first.role == Role::System => (Some(first), rest),
            _ => (None, &self.messages[..]),
        };
        let mut turns: Vec<Range<usize>> = Vec::new();
        for (i, message) in rest.iter().enumerate() {
            match turns.last_mut() {
                Some(turn) if message.role == Role::Tool => turn.end = i + 1,
                _ => turns.push(i..i + 1),
            }
        }
        let cost =
            |turn: &Range<usize>| rest[turn.clone()].iter().map(message_tokens).sum::<usize>();
        let last_user = turns.iter().rposition(|t| rest[t.start].role == Role::User);
        let mut total = system.map_or(0, message_tokens) + turns.iter().map(cost).sum::<usize>();
        let mut keep = vec![true; turns.len()];
        for (i, turn) in turns.iter().enumerate() {
            if total <= chat_context_tokens {
                break;
            }
            if i + 1 == turns.len() || Some(i) == last_user {
                continue;
            }
            keep[i] = false;
            total -= cost(turn);
        }
        system
            .into_iter()
            .chain(
                turns
                    .iter()
                    .zip(&keep)
                    .filter(|(_, keep)| **keep)
                    .flat_map(|(turn, _)| &rest[turn.clone()]),
            )
            .map(|m| ChatMessage {
                thinking: None,
                ..m.clone()
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ollama::{FunctionCall, ToolCall};
    use serde_json::json;

    fn call(name: &str) -> ChatMessage {
        ChatMessage {
            tool_calls: Some(vec![ToolCall {
                id: Some(format!("call_{name}")),
                function: FunctionCall {
                    index: Some(0),
                    name: name.into(),
                    arguments: json!({"path": "a.rs"}),
                },
            }]),
            ..ChatMessage::assistant("")
        }
    }

    #[test]
    fn session_roundtrip_and_gitignore_created() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut s = Session::new();
        assert!(!s.id.is_empty());
        assert_ne!(s.id, Session::new().id, "ids are unique");
        s.messages.push(ChatMessage::system("sys"));
        s.messages
            .push(ChatMessage::user("Fix the bug\n\nattached: x"));
        s.messages.push(call("read_file"));
        s.messages.push(ChatMessage::tool("read_file", "contents"));
        s.always_allow
            .insert(always_allow_key("run_command", Some("cargo test")));
        s.save(root).unwrap();

        let file = root
            .join(".localpilot/sessions")
            .join(format!("{}.json", s.id));
        assert!(file.is_file());
        assert_eq!(
            std::fs::read_to_string(root.join(".localpilot/.gitignore")).unwrap(),
            "*\n"
        );
        assert_eq!(Session::load(root, &s.id).unwrap(), s);

        // A second session; list reports both, titled by the first user line.
        let other = Session::new();
        other.save(root).unwrap();
        let list = Session::list(root);
        assert_eq!(list.len(), 2);
        let summary = list.iter().find(|x| x.session_id == s.id).unwrap();
        assert_eq!(summary.title, "Fix the bug");
        assert!(summary.updated_at_ms > 0);

        // Ids from the client cannot escape the sessions directory.
        assert!(Session::load(root, "../../etc/passwd").is_err());
        assert!(Session::with_id("a/b").is_err());
        assert!(Session::with_id("").is_err());
        assert_eq!(Session::with_id("abc-123_X").unwrap().id, "abc-123_X");
        assert_eq!(
            Session::load(root, "nope").unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }

    #[test]
    fn trim_keeps_system_and_last_tool_pair() {
        let big = "x".repeat(4000); // ~1000 tokens
        let mut s = Session::with_id("t").unwrap();
        s.messages = vec![
            ChatMessage::system("system prompt"),
            ChatMessage::user(big.clone()),
            ChatMessage::assistant(big.clone()),
            ChatMessage::user("now fix it"),
            call("read_file"),
            ChatMessage::tool("read_file", big.clone()),
            call("search"),
            ChatMessage {
                thinking: Some(big.clone()),
                ..ChatMessage::tool("search", "found it")
            },
        ];

        // Everything fits: unchanged except that thinking is not sent back.
        let all = s.trimmed_messages(100_000);
        assert_eq!(all.len(), 8);
        assert!(all.iter().all(|m| m.thinking.is_none()));

        // Tight budget: oldest turns go first, never orphaning a tool result.
        let kept = s.trimmed_messages(1500);
        let roles: Vec<Role> = kept.iter().map(|m| m.role).collect();
        assert_eq!(
            roles,
            [
                Role::System,
                Role::User,
                Role::Assistant,
                Role::Tool,
                Role::Assistant,
                Role::Tool
            ]
        );
        assert_eq!(kept[1].content, "now fix it");

        // Tighter: the older tool pair goes too; the system prompt, the
        // current request and the last tool pair stay.
        let kept = s.trimmed_messages(300);
        assert_eq!(kept.len(), 4);
        assert_eq!(kept[0].content, "system prompt");
        assert_eq!(kept[1].content, "now fix it");
        assert_eq!(
            kept[2].tool_calls.as_ref().unwrap()[0].function.name,
            "search"
        );
        assert_eq!(kept[3].content, "found it");

        // Budget too small even for that: the protected messages are still
        // returned (the runner reports ContextFull).
        assert_eq!(s.trimmed_messages(1).len(), 4);
    }

    #[test]
    fn always_allow_key_for_command_is_exact_string() {
        assert_eq!(always_allow_key("edit_file", None), "edit_file");
        assert_eq!(always_allow_key("create_file", None), "create_file");
        assert_eq!(
            always_allow_key("run_command", Some("cargo test")),
            "run_command:cargo test"
        );
        // No normalisation: a different spelling is a different command.
        assert_ne!(
            always_allow_key("run_command", Some("cargo test")),
            always_allow_key("run_command", Some("cargo  test"))
        );
        assert_ne!(
            always_allow_key("run_command", Some("cargo test")),
            always_allow_key("run_command", Some("cargo test && rm -rf ~"))
        );
    }
}
