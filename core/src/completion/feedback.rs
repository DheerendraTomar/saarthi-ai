//! The completion outcome log: one JSON object per served suggestion in
//! `<workspace>/.localpilot/completions.jsonl`, appended once its outcome is
//! known (or once it expired unanswered as `rejected`).
//!
//! The log is the source of truth for the adaptive policy and for any later
//! fine-tuning dataset, so every [`Record`] is self-contained: it carries the
//! language, a hash of the exact prompt, the text right before the cursor
//! (at most [`CONTEXT_TAIL_CHARS`] characters — nothing else of the file),
//! the suggestion, the generation limits and what the user did with it. When
//! the file grows past [`ROTATE_ABOVE`] lines it is rewritten with only the
//! newest [`ROTATE_KEEP`].
//!
//! **One writer.** [`FeedbackLog::submit`] only queues the record: a
//! dedicated thread owns the file and appends, rotates and writes the reset
//! sidecar in order, so callers (the completion request path, the
//! notification loop) never do file I/O. [`FeedbackLog::flush`] waits until
//! everything queued so far is written.
//!
//! **Learning view.** The writer also keeps, in memory, the newest
//! [`TAIL_MEMORY`] records and running outcome counters per language: seeded
//! by one scan of the file when the writer starts, updated on every append,
//! unaffected by rotation. [`FeedbackLog::recent`] and
//! [`FeedbackLog::stats`] read only that memory. [`FeedbackLog::reset_learning`]
//! records a timestamp in `completions.meta.json`
//! (`{ "learningResetAt": <ms> }`); records older than it are ignored by the
//! learning view, while the log file itself is never truncated.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use crate::agent::session::ensure_state_dir;

/// What the user did with a served suggestion (`completion/outcome`).
pub use crate::protocol::CompletionOutcome as Outcome;

/// File name of the log inside `<workspace>/.localpilot`.
pub const LOG_FILE: &str = "completions.jsonl";
/// File name of the learning-reset sidecar next to the log.
pub const META_FILE: &str = "completions.meta.json";
/// The log is rotated once it has more lines than this…
pub const ROTATE_ABOVE: usize = 10_000;
/// …keeping only this many of the newest.
pub const ROTATE_KEEP: usize = 5_000;
/// Upper bound (in characters) of [`Record::context_tail`].
pub const CONTEXT_TAIL_CHARS: usize = 200;
/// Newest records kept in memory per language for [`FeedbackLog::recent`].
pub const TAIL_MEMORY: usize = 64;

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
    /// Lower-case extension of the document (no dot), if it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
    /// [`prompt_hash`] of the exact prompt and suffix sent to the model.
    pub prompt_hash: String,
    /// At most [`CONTEXT_TAIL_CHARS`] characters right before the cursor.
    pub context_tail: String,
    pub suggestion: String,
    /// Number of lines of `suggestion` (≥ 1).
    pub lines: u32,
    pub outcome: Outcome,
    /// The part the user kept: only for `accepted` / `partial`, at most as
    /// many characters as the suggestion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_text: Option<String>,
    /// Request start → first streamed token of a generation this request
    /// started; `null` when served from the cache or a joined generation.
    pub ttft_ms: Option<u64>,
    /// Request start → suggestion returned.
    pub total_ms: u64,
    /// Completion model that was asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Line cap of the stop rules in effect (1 or 8 today).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_lines: Option<u32>,
    /// `num_predict` in effect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_predict: Option<u32>,
}

/// Running outcome counters of one language (`served` = all records).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeCounts {
    pub served: u64,
    pub accepted: u64,
    pub partial: u64,
    pub rejected: u64,
    pub typed_through: u64,
}

impl OutcomeCounts {
    fn add(&mut self, outcome: Outcome) {
        self.served += 1;
        match outcome {
            Outcome::Accepted => self.accepted += 1,
            Outcome::Partial => self.partial += 1,
            Outcome::Rejected => self.rejected += 1,
            Outcome::TypedThrough => self.typed_through += 1,
        }
    }
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

/// The learning view: per-language tails and counters since the reset.
#[derive(Default)]
struct Memory {
    /// Records with `ts` below this are ignored.
    reset_at: u64,
    tails: HashMap<String, VecDeque<Record>>,
    counts: HashMap<String, OutcomeCounts>,
}

impl Memory {
    fn apply(&mut self, record: &Record) {
        if record.ts < self.reset_at {
            return;
        }
        self.counts
            .entry(record.lang.clone())
            .or_default()
            .add(record.outcome);
        let tail = self.tails.entry(record.lang.clone()).or_default();
        if tail.len() == TAIL_MEMORY {
            tail.pop_front();
        }
        tail.push_back(record.clone());
    }

    fn reset(&mut self, at: u64) {
        self.reset_at = self.reset_at.max(at);
        self.tails.clear();
        self.counts.clear();
    }
}

enum Cmd {
    Append(Box<Record>),
    WriteMeta(u64),
    Flush(oneshot::Sender<()>),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    learning_reset_at: u64,
}

/// Append-only JSONL log with a single background writer (see the module
/// docs). Dropping the last handle ends the writer once its queue is empty.
pub struct FeedbackLog {
    path: PathBuf,
    tx: std_mpsc::Sender<Cmd>,
    memory: Arc<Mutex<Memory>>,
    /// Test hook: while held, the writer waits before each append.
    #[cfg_attr(not(test), allow(dead_code))]
    write_hold: Arc<WriteHold>,
}

/// A gate the writer waits on before each append (test hook).
#[derive(Default)]
struct WriteHold {
    held: Mutex<bool>,
    released: Condvar,
}

impl WriteHold {
    #[cfg_attr(not(test), allow(dead_code))]
    fn set(&self, held: bool) {
        *lock(&self.held) = held;
        self.released.notify_all();
    }

    fn wait(&self) {
        let mut held = lock(&self.held);
        while *held {
            held = self
                .released
                .wait(held)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

impl FeedbackLog {
    /// A log at `path` (its parent directory is created on first append);
    /// the reset sidecar is [`META_FILE`] in the same directory.
    pub fn new(path: PathBuf) -> Self {
        Self::start(path, None)
    }

    /// The workspace's log, `<root>/.localpilot/completions.jsonl`; the
    /// `.localpilot` dir is created with its `.gitignore` before the first
    /// write.
    pub fn for_workspace(root: &Path) -> Self {
        Self::start(
            root.join(".localpilot").join(LOG_FILE),
            Some(root.to_owned()),
        )
    }

    fn start(path: PathBuf, workspace: Option<PathBuf>) -> Self {
        let (tx, rx) = std_mpsc::channel();
        let memory = Arc::new(Mutex::new(Memory::default()));
        let write_hold = Arc::new(WriteHold::default());
        let writer = Writer {
            meta_path: path.with_file_name(META_FILE),
            path: path.clone(),
            workspace,
            memory: memory.clone(),
            write_hold: write_hold.clone(),
            lines: 0,
            needs_newline: false,
            dir_ready: false,
        };
        let spawned = std::thread::Builder::new()
            .name("completion-log".to_owned())
            .spawn(move || writer.run(rx));
        if let Err(err) = spawned {
            tracing::warn!(%err, "cannot start the completion log writer; nothing will be logged");
        }
        Self {
            path,
            tx,
            memory,
            write_hold,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Queues `record` for appending; never blocks and never fails (a write
    /// error is logged by the writer).
    pub fn submit(&self, record: Record) {
        if self.tx.send(Cmd::Append(Box::new(record))).is_err() {
            tracing::warn!("completion log writer is gone; record dropped");
        }
    }

    /// Resolves once everything queued before this call is written (and the
    /// writer's initial scan of the file is done).
    pub async fn flush(&self) {
        let (ack, done) = oneshot::channel();
        if self.tx.send(Cmd::Flush(ack)).is_ok() {
            let _ = done.await;
        }
    }

    /// The newest `n` (at most [`TAIL_MEMORY`]) records of `lang` since the
    /// last learning reset, oldest first. Memory only, no I/O; reflects the
    /// records written so far (see [`flush`](Self::flush)).
    pub fn recent(&self, lang: &str, n: usize) -> Vec<Record> {
        let memory = lock(&self.memory);
        let Some(tail) = memory.tails.get(lang) else {
            return Vec::new();
        };
        tail.iter()
            .skip(tail.len().saturating_sub(n))
            .cloned()
            .collect()
    }

    /// Outcome counters per language since the last learning reset (memory
    /// only).
    pub fn stats(&self) -> HashMap<String, OutcomeCounts> {
        lock(&self.memory).counts.clone()
    }

    /// Unix ms of the last learning reset (0 if never).
    pub fn learning_reset_at(&self) -> u64 {
        lock(&self.memory).reset_at
    }

    /// Forgets everything learned so far: the learning view is emptied at
    /// once and the reset time is persisted in [`META_FILE`]; the log file
    /// keeps every record. Returns the reset timestamp.
    pub fn reset_learning(&self) -> u64 {
        let at = now_ms();
        lock(&self.memory).reset(at);
        if self.tx.send(Cmd::WriteMeta(at)).is_err() {
            tracing::warn!("completion log writer is gone; reset not persisted");
        }
        at
    }

    /// Every record in the log file, oldest first; unparsable lines
    /// (including non-UTF-8 ones) are skipped. Reads the whole file on the
    /// calling thread: for export and tests, not for the request path.
    pub fn records(&self) -> Vec<Record> {
        fs::read(&self.path)
            .map(|bytes| parse_lines(&bytes).0)
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) fn set_write_hold(&self, held: bool) {
        self.write_hold.set(held);
    }
}

/// The records in `bytes` and its number of non-empty lines.
fn parse_lines(bytes: &[u8]) -> (Vec<Record>, usize) {
    let mut lines = 0;
    let records = bytes
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .inspect(|_| lines += 1)
        .filter_map(|line| serde_json::from_slice(line).ok())
        .collect();
    (records, lines)
}

/// The writer thread's state: it alone touches the log and meta files.
struct Writer {
    path: PathBuf,
    meta_path: PathBuf,
    workspace: Option<PathBuf>,
    memory: Arc<Mutex<Memory>>,
    write_hold: Arc<WriteHold>,
    /// Non-empty lines in the file.
    lines: usize,
    /// The file does not end with a newline (e.g. a torn last write).
    needs_newline: bool,
    dir_ready: bool,
}

impl Writer {
    fn run(mut self, rx: std_mpsc::Receiver<Cmd>) {
        self.load();
        for cmd in rx {
            match cmd {
                Cmd::Append(record) => {
                    if let Err(err) = self.append(&record) {
                        tracing::warn!(path = %self.path.display(), %err, "cannot write the completion log");
                    }
                    lock(&self.memory).apply(&record);
                }
                Cmd::WriteMeta(at) => {
                    if let Err(err) = self.write_meta(at) {
                        tracing::warn!(path = %self.meta_path.display(), %err, "cannot write the learning reset");
                    }
                }
                Cmd::Flush(ack) => {
                    let _ = ack.send(());
                }
            }
        }
    }

    /// Scans the existing file once: line count, trailing newline, and the
    /// learning view since the persisted reset.
    fn load(&mut self) {
        let meta_reset = fs::read(&self.meta_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Meta>(&bytes).ok())
            .map_or(0, |m| m.learning_reset_at);
        let bytes = fs::read(&self.path).unwrap_or_default();
        let (records, lines) = parse_lines(&bytes);
        self.lines = lines;
        self.needs_newline = bytes.last().is_some_and(|b| *b != b'\n');
        let mut memory = lock(&self.memory);
        // A reset made while scanning wins if it is newer.
        let reset_at = memory.reset_at.max(meta_reset);
        *memory = Memory {
            reset_at,
            ..Memory::default()
        };
        for record in &records {
            memory.apply(record);
        }
    }

    fn ensure_dir(&mut self) -> io::Result<()> {
        if self.dir_ready {
            return Ok(());
        }
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
        self.dir_ready = true;
        Ok(())
    }

    fn append(&mut self, record: &Record) -> io::Result<()> {
        self.write_hold.wait();
        self.ensure_dir()?;
        let mut line = Vec::new();
        if self.needs_newline {
            line.push(b'\n');
        }
        serde_json::to_writer(&mut line, record).map_err(io::Error::other)?;
        line.push(b'\n');
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?
            .write_all(&line)?;
        self.needs_newline = false;
        self.lines += 1;
        if self.lines > ROTATE_ABOVE {
            self.rotate()?;
        }
        Ok(())
    }

    /// Rewrites the file with its newest [`ROTATE_KEEP`] lines (via a temp
    /// file and rename).
    fn rotate(&mut self) -> io::Result<()> {
        let bytes = fs::read(&self.path)?;
        let lines: Vec<&[u8]> = bytes
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .collect();
        let kept = &lines[lines.len().saturating_sub(ROTATE_KEEP)..];
        let mut body = Vec::with_capacity(bytes.len() / 2);
        for line in kept {
            body.extend_from_slice(line);
            body.push(b'\n');
        }
        let tmp = self.path.with_extension("jsonl.tmp");
        fs::write(&tmp, body)?;
        fs::rename(&tmp, &self.path)?;
        self.lines = kept.len();
        Ok(())
    }

    fn write_meta(&mut self, at: u64) -> io::Result<()> {
        self.ensure_dir()?;
        let body = serde_json::to_vec(&Meta {
            learning_reset_at: at,
        })
        .map_err(io::Error::other)?;
        let tmp = self.meta_path.with_extension("json.tmp");
        fs::write(&tmp, body)?;
        fs::rename(&tmp, &self.meta_path)
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: usize, lang: &str) -> Record {
        record_at(id, lang, 1_000 + id as u64, Outcome::Accepted)
    }

    fn record_at(id: usize, lang: &str, ts: u64, outcome: Outcome) -> Record {
        Record {
            ts,
            request_id: format!("r{id}"),
            lang: lang.to_owned(),
            ext: Some("py".to_owned()),
            prompt_hash: prompt_hash("p", "s"),
            context_tail: "x = ".to_owned(),
            suggestion: "1".to_owned(),
            lines: 1,
            outcome,
            accepted_text: None,
            ttft_ms: Some(5),
            total_ms: 9,
            model: Some("coder".to_owned()),
            max_lines: Some(1),
            num_predict: Some(32),
        }
    }

    fn ids(records: &[Record]) -> Vec<&str> {
        records.iter().map(|r| r.request_id.as_str()).collect()
    }

    #[tokio::test]
    async fn log_rotates_at_10k_keeping_newest_5k() {
        let dir = tempfile::tempdir().unwrap();
        let log = FeedbackLog::for_workspace(dir.path());
        for i in 0..ROTATE_ABOVE {
            log.submit(record(i, "python"));
        }
        log.flush().await;
        let text = fs::read_to_string(log.path()).unwrap();
        assert_eq!(text.lines().count(), ROTATE_ABOVE, "not rotated at 10 000");
        assert_eq!(
            fs::read_to_string(dir.path().join(".localpilot/.gitignore")).unwrap(),
            "*\n"
        );

        log.submit(record(ROTATE_ABOVE, "python"));
        log.flush().await;
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
        // The learning view is not affected by rotation.
        assert_eq!(log.stats()["python"].served, ROTATE_ABOVE as u64 + 1);
        assert_eq!(
            log.recent("python", 1)[0].request_id,
            format!("r{ROTATE_ABOVE}")
        );
        drop(log);

        // Counting resumes from the rotated size, also for a fresh handle.
        let reopened = FeedbackLog::for_workspace(dir.path());
        for i in 0..(ROTATE_ABOVE - ROTATE_KEEP) {
            reopened.submit(record(20_000 + i, "python"));
        }
        reopened.flush().await;
        assert_eq!(reopened.records().len(), ROTATE_ABOVE);
        reopened.submit(record(30_000, "python"));
        reopened.flush().await;
        assert_eq!(reopened.records().len(), ROTATE_KEEP);
    }

    #[tokio::test]
    async fn read_recent_per_language() {
        let dir = tempfile::tempdir().unwrap();
        let log = FeedbackLog::for_workspace(dir.path());
        log.flush().await;
        assert!(log.recent("python", 10).is_empty(), "missing file is empty");
        for i in 0..6 {
            let lang = if i % 2 == 0 { "python" } else { "rust" };
            log.submit(record(i, lang));
        }
        log.flush().await;
        // A torn write (no trailing newline) and a non-UTF-8 line: skipped,
        // and the next append starts on a fresh line.
        let mut file = OpenOptions::new().append(true).open(log.path()).unwrap();
        file.write_all(b"\xff\xfe junk\n{\"torn\": ").unwrap();
        drop(file);
        drop(log);

        let log = FeedbackLog::for_workspace(dir.path());
        log.submit(record(6, "python"));
        log.flush().await;
        assert_eq!(
            ids(&log.records()),
            ["r0", "r1", "r2", "r3", "r4", "r5", "r6"]
        );

        assert_eq!(ids(&log.recent("python", 2)), ["r4", "r6"]);
        assert_eq!(ids(&log.recent("python", 50)), ["r0", "r2", "r4", "r6"]);
        assert_eq!(ids(&log.recent("rust", 50)), ["r1", "r3", "r5"]);
        assert!(log.recent("go", 50).is_empty());
        assert_eq!(log.recent("python", 1)[0], record(6, "python"));
        assert_eq!(log.stats()["rust"].served, 3);

        // Memory keeps only the newest TAIL_MEMORY per language.
        for i in 100..(100 + TAIL_MEMORY + 5) {
            log.submit(record(i, "rust"));
        }
        log.flush().await;
        let tail = log.recent("rust", 1_000);
        assert_eq!(tail.len(), TAIL_MEMORY);
        assert_eq!(tail[0].request_id, "r105");
        assert_eq!(log.stats()["rust"].served, 3 + TAIL_MEMORY as u64 + 5);
    }

    #[tokio::test]
    async fn reset_learning_hides_older_records_but_keeps_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let log = FeedbackLog::for_workspace(dir.path());
        let now = now_ms();
        log.submit(record_at(1, "python", now - 10, Outcome::Accepted));
        log.submit(record_at(2, "python", now - 5, Outcome::Rejected));
        log.flush().await;
        let before = log.stats()["python"];
        assert_eq!((before.served, before.accepted, before.rejected), (2, 1, 1));

        let at = log.reset_learning();
        assert!(log.recent("python", 10).is_empty());
        assert!(log.stats().is_empty());
        // Served before the reset, answered after: still not learned from.
        log.submit(record_at(3, "python", at - 1, Outcome::Accepted));
        log.submit(record_at(4, "python", at + 1, Outcome::Partial));
        log.submit(record_at(5, "python", at + 2, Outcome::TypedThrough));
        log.flush().await;
        assert_eq!(ids(&log.recent("python", 10)), ["r4", "r5"]);
        let after = log.stats()["python"];
        assert_eq!(
            after,
            OutcomeCounts {
                served: 2,
                accepted: 0,
                partial: 1,
                rejected: 0,
                typed_through: 1
            }
        );
        // The dataset is untouched; the reset is in the sidecar.
        assert_eq!(log.records().len(), 5);
        let meta: serde_json::Value = serde_json::from_slice(
            &fs::read(dir.path().join(".localpilot").join(META_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(meta, serde_json::json!({"learningResetAt": at}));
        drop(log);

        // A restarted core honours the persisted reset.
        let reopened = FeedbackLog::for_workspace(dir.path());
        reopened.flush().await;
        assert_eq!(reopened.learning_reset_at(), at);
        assert_eq!(ids(&reopened.recent("python", 10)), ["r4", "r5"]);
        assert_eq!(reopened.stats()["python"].served, 2);
    }

    #[test]
    fn record_wire_shape() {
        let mut r = record(1, "python");
        r.ext = None;
        r.model = None;
        r.max_lines = None;
        r.num_predict = None;
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
        let mut r = record(1, "python");
        r.outcome = Outcome::TypedThrough;
        r.accepted_text = Some("1".to_owned());
        let wire = serde_json::to_value(&r).unwrap();
        assert_eq!(wire["outcome"], "typedThrough");
        assert_eq!(wire["acceptedText"], "1");
        assert_eq!(wire["ext"], "py");
        assert_eq!(wire["model"], "coder");
        assert_eq!(wire["maxLines"], 1);
        assert_eq!(wire["numPredict"], 32);
        // Older lines without the optional fields still parse.
        let old: Record = serde_json::from_value(serde_json::json!({
            "ts": 1, "requestId": "r", "lang": "go", "promptHash": "h", "contextTail": "",
            "suggestion": "s", "lines": 1, "outcome": "rejected", "ttftMs": null, "totalMs": 2
        }))
        .unwrap();
        assert_eq!(old.ext, None);
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
