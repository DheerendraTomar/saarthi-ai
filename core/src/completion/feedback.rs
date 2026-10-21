//! The completion outcome log: one JSON object per served suggestion in
//! `<workspace>/.localpilot/completions.jsonl`, appended once its outcome is
//! known (or once it expired unanswered as `rejected`).
//!
//! The log is the source of truth for the adaptive policy and for any later
//! fine-tuning dataset, so every [`Record`] is self-contained: it carries the
//! language, a hash of the exact prompt, the text right before the cursor
//! (at most [`CONTEXT_TAIL_CHARS`] characters — nothing else of the file),
//! the suggestion and what the user did with it. When the file grows past
//! [`ROTATE_ABOVE`] lines it is rewritten with only the newest
//! [`ROTATE_KEEP`].

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agent::session::ensure_state_dir;

/// File name of the log inside `<workspace>/.localpilot`.
pub const LOG_FILE: &str = "completions.jsonl";
/// The log is rotated once it has more lines than this…
pub const ROTATE_ABOVE: usize = 10_000;
/// …keeping only this many of the newest.
pub const ROTATE_KEEP: usize = 5_000;
/// Upper bound (in characters) of [`Record::context_tail`].
pub const CONTEXT_TAIL_CHARS: usize = 200;

/// What the user did with a served suggestion (`completion/outcome`).
pub use crate::protocol::CompletionOutcome as Outcome;

/// One line of the log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// When the suggestion was served, in Unix milliseconds.
    pub ts: u64,
    pub request_id: String,
    /// [`Lang`](crate::index::symbols::Lang) of the document, lower case
    /// (`"python"`, `"rust"`, …, `"other"`).
    pub lang: String,
    /// [`prompt_hash`] of the exact prompt and suffix sent to the model.
    pub prompt_hash: String,
    /// At most [`CONTEXT_TAIL_CHARS`] characters right before the cursor.
    pub context_tail: String,
    pub suggestion: String,
    /// Number of lines of `suggestion` (≥ 1).
    pub lines: u32,
    pub outcome: Outcome,
    /// The part the user kept, if the client reported it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_text: Option<String>,
    /// Request start → first streamed token of a generation this request
    /// started; `null` when served from the cache or a joined generation.
    pub ttft_ms: Option<u64>,
    /// Request start → suggestion returned.
    pub total_ms: u64,
}

/// SHA-256 (first 16 hex digits) of the prompt and suffix sent to the model.
pub fn prompt_hash(prompt: &str, suffix: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prompt.as_bytes());
    hasher.update([0u8]);
    hasher.update(suffix.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The last [`CONTEXT_TAIL_CHARS`] characters of `before_cursor`.
pub fn context_tail(before_cursor: &str) -> String {
    let start = before_cursor
        .char_indices()
        .rev()
        .nth(CONTEXT_TAIL_CHARS - 1)
        .map_or(0, |(i, _)| i);
    before_cursor[start..].to_owned()
}

/// Number of lines of a suggestion (an empty one counts as one).
pub fn line_count(text: &str) -> u32 {
    u32::try_from(text.lines().count().max(1)).unwrap_or(u32::MAX)
}

/// Current time in Unix milliseconds.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Append-only JSONL log with rotation. All file access is serialized by an
/// internal lock, so one log can be shared by concurrent appenders.
pub struct FeedbackLog {
    path: PathBuf,
    /// Workspace whose `.localpilot` dir (with its `.gitignore`) is created
    /// before the first write.
    workspace: Option<PathBuf>,
    state: Mutex<LogState>,
}

#[derive(Default)]
struct LogState {
    /// Lines in the file, counted on first use.
    lines: Option<usize>,
    dir_ready: bool,
}

impl FeedbackLog {
    /// A log at `path` (its parent directory is created on first append).
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            workspace: None,
            state: Mutex::new(LogState::default()),
        }
    }

    /// The workspace's log, `<root>/.localpilot/completions.jsonl`.
    pub fn for_workspace(root: &Path) -> Self {
        Self {
            path: root.join(".localpilot").join(LOG_FILE),
            workspace: Some(root.to_owned()),
            state: Mutex::new(LogState::default()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Appends one record, then rotates if the file has more than
    /// [`ROTATE_ABOVE`] lines.
    pub fn append(&self, record: &Record) -> io::Result<()> {
        let mut line = serde_json::to_string(record).map_err(io::Error::other)?;
        line.push('\n');
        let mut state = lock(&self.state);
        if !state.dir_ready {
            match &self.workspace {
                Some(root) => {
                    ensure_state_dir(root)?;
                }
                None => {
                    if let Some(parent) = self.path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                }
            }
            state.dir_ready = true;
        }
        let count = match state.lines {
            Some(n) => n,
            None => count_lines(&self.path)?,
        };
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(line.as_bytes())?;
        let count = count + 1;
        state.lines = Some(if count > ROTATE_ABOVE {
            self.rotate()?
        } else {
            count
        });
        Ok(())
    }

    /// The newest `n` records of `lang`, oldest first. A missing file is
    /// empty; unparsable lines are skipped.
    pub fn recent(&self, lang: &str, n: usize) -> Vec<Record> {
        let mut out: Vec<Record> = self
            .records()
            .into_iter()
            .rev()
            .filter(|r| r.lang == lang)
            .take(n)
            .collect();
        out.reverse();
        out
    }

    /// Every record in the log, oldest first (unparsable lines skipped).
    pub fn records(&self) -> Vec<Record> {
        let _state = lock(&self.state);
        let Ok(file) = File::open(&self.path) else {
            return Vec::new();
        };
        BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str(&line).ok())
            .collect()
    }

    /// Rewrites the file with its newest [`ROTATE_KEEP`] lines (via a temp
    /// file and rename); returns the new line count.
    fn rotate(&self) -> io::Result<usize> {
        let text = fs::read_to_string(&self.path)?;
        let lines: Vec<&str> = text.lines().collect();
        let kept = &lines[lines.len().saturating_sub(ROTATE_KEEP)..];
        let tmp = self.path.with_extension("jsonl.tmp");
        let mut body = kept.join("\n");
        body.push('\n');
        fs::write(&tmp, body)?;
        fs::rename(&tmp, &self.path)?;
        Ok(kept.len())
    }
}

fn count_lines(path: &Path) -> io::Result<usize> {
    match File::open(path) {
        Ok(file) => Ok(BufReader::new(file).lines().count()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(err) => Err(err),
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: usize, lang: &str) -> Record {
        Record {
            ts: 1_000 + id as u64,
            request_id: format!("r{id}"),
            lang: lang.to_owned(),
            prompt_hash: prompt_hash("p", "s"),
            context_tail: "x = ".to_owned(),
            suggestion: "1".to_owned(),
            lines: 1,
            outcome: Outcome::Accepted,
            accepted_text: None,
            ttft_ms: Some(5),
            total_ms: 9,
        }
    }

    fn ids(records: &[Record]) -> Vec<&str> {
        records.iter().map(|r| r.request_id.as_str()).collect()
    }

    #[test]
    fn log_rotates_at_10k_keeping_newest_5k() {
        let dir = tempfile::tempdir().unwrap();
        let log = FeedbackLog::for_workspace(dir.path());
        for i in 0..ROTATE_ABOVE {
            log.append(&record(i, "python")).unwrap();
        }
        let text = fs::read_to_string(log.path()).unwrap();
        assert_eq!(text.lines().count(), ROTATE_ABOVE, "not rotated at 10 000");
        assert_eq!(
            fs::read_to_string(dir.path().join(".localpilot/.gitignore")).unwrap(),
            "*\n"
        );

        log.append(&record(ROTATE_ABOVE, "python")).unwrap();
        let records = log.records();
        assert_eq!(records.len(), ROTATE_KEEP);
        assert_eq!(
            records[0].request_id,
            format!("r{}", ROTATE_ABOVE + 1 - ROTATE_KEEP)
        );
        assert_eq!(
            records.last().unwrap().request_id,
            format!("r{ROTATE_ABOVE}")
        );

        // Counting resumes from the rotated size, also for a fresh handle.
        let reopened = FeedbackLog::for_workspace(dir.path());
        for i in 0..(ROTATE_ABOVE - ROTATE_KEEP) {
            reopened.append(&record(20_000 + i, "python")).unwrap();
        }
        assert_eq!(reopened.records().len(), ROTATE_ABOVE);
        reopened.append(&record(30_000, "python")).unwrap();
        assert_eq!(reopened.records().len(), ROTATE_KEEP);
    }

    #[test]
    fn read_recent_per_language() {
        let dir = tempfile::tempdir().unwrap();
        let log = FeedbackLog::for_workspace(dir.path());
        assert!(log.recent("python", 10).is_empty(), "missing file is empty");
        for i in 0..6 {
            let lang = if i % 2 == 0 { "python" } else { "rust" };
            log.append(&record(i, lang)).unwrap();
        }
        // A corrupt line (e.g. a torn write) is skipped, not fatal.
        OpenOptions::new()
            .append(true)
            .open(log.path())
            .unwrap()
            .write_all(b"{not json\n")
            .unwrap();
        log.append(&record(6, "python")).unwrap();

        assert_eq!(ids(&log.recent("python", 2)), ["r4", "r6"]);
        assert_eq!(ids(&log.recent("python", 50)), ["r0", "r2", "r4", "r6"]);
        assert_eq!(ids(&log.recent("rust", 50)), ["r1", "r3", "r5"]);
        assert!(log.recent("go", 50).is_empty());
        assert_eq!(log.recent("python", 1)[0], record(6, "python"));
    }

    #[test]
    fn record_wire_shape() {
        let mut r = record(1, "python");
        let wire = serde_json::to_value(&r).unwrap();
        let mut keys: Vec<&String> = wire.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "contextTail",
                "lang",
                "lines",
                "outcome",
                "promptHash",
                "requestId",
                "suggestion",
                "totalMs",
                "ts",
                "ttftMs"
            ]
        );
        r.outcome = Outcome::TypedThrough;
        r.accepted_text = Some("1".to_owned());
        let wire = serde_json::to_value(&r).unwrap();
        assert_eq!(wire["outcome"], "typedThrough");
        assert_eq!(wire["acceptedText"], "1");
    }

    #[test]
    fn context_tail_is_bounded_by_chars() {
        assert_eq!(context_tail("abc"), "abc");
        let long: String = "é".repeat(500);
        let tail = context_tail(&long);
        assert_eq!(tail.chars().count(), CONTEXT_TAIL_CHARS);
        assert_eq!(line_count(""), 1);
        assert_eq!(line_count("a\nb"), 2);
        assert_eq!(prompt_hash("a", "b").len(), 16);
        assert_ne!(prompt_hash("a", "b"), prompt_hash("ab", ""));
    }
}
