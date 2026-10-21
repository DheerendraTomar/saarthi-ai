//! The inline completion engine.
//!
//! Per request: skip rules → bounded cursor window (no whole-document copy)
//! → cached snippet block → FIM prompt → completion cache → join or start a
//! streaming generation whose chunks go through the [`Trimmer`]. Every lock
//! is held only to copy data out; none is held across an `.await`.
//!
//! **KV-cache reuse.** Related-file snippets are computed by
//! [`related::snippets`] only on [`refresh_snippets`](CompletionEngine::refresh_snippets)
//! (didOpen / didSave / watcher change) or when a uri's entry is missing or
//! older than [`SNIPPET_TTL`] at request time; that refresh runs in the
//! background (one at a time per uri) while the request is served with the
//! stale block (or none). Between refreshes every request reuses the
//! identical snippet block, and the prefix window is line-aligned with
//! hysteresis (see [`DocumentStore::cursor_window`]), so consecutive prompts
//! differ only in the typed tail and Ollama reuses its KV cache.
//!
//! **Generations** are owned by an in-flight entry, not by a requester: an
//! identical `(uri, prefix, suffix)` request joins the running generation.
//! The HTTP stream is dropped when the [`Trimmer`] stops, when the last
//! waiting requester is cancelled (or dropped), or when completions pause.
//!
//! **Outcome log.** With a [`FeedbackLog`] set, every served suggestion
//! (except a typed-prefix cache hit: that is the rest of a suggestion
//! already served, whose own record carries the outcome) is kept as a
//! pending [`Record`] until `completion/outcome` (or
//! `completion/accepted|rejected`) names it, then appended with that
//! outcome. A typed-prefix hit's request id becomes an alias of the
//! original pending record (and restarts its timeout): an outcome reported
//! under the alias resolves the original, with the text typed into the
//! suggestion put back in front of a `partial` / `accepted` `acceptedText`.
//! A pending record with no outcome after [`OUTCOME_TIMEOUT`] (or
//! pushed out by [`PENDING_MEMORY`] newer ones) is appended as `rejected`;
//! expiry is checked lazily whenever a suggestion is served or an outcome
//! arrives. Log I/O happens after every engine lock is released.
//!
//! **Adaptive limits and style examples.** With `adaptiveCompletions` on and
//! a log set, every snippet refresh also computes, from the log's in-memory
//! view of the uri's language, the learned multi-line cap and `num_predict`
//! ([`Policy::from_outcomes`]) and up to 3 style examples
//! ([`adaptive::examples`]), and stores them with the snippets. Requests
//! only read them, so they change exactly when the snippet block does and
//! the prompt stays byte-stable while typing.
//!
//! **Exploration.** Learned limits only ever move towards what was accepted,
//! so a longer bucket that lost would never be sampled again. Every
//! [`adaptive::EXPLORE_EVERY`]-th served multi-line suggestion of a language
//! is therefore generated with the configured limits (ignoring an exact
//! cache hit; a typed-prefix hit is still served), and its record carries
//! those limits. Nothing is explored when the learned limits are the
//! configured ones.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant};

use futures::StreamExt;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::adaptive::{self, Configured, Learned, Policy};
use super::cache::{self, CompletionCache};
use super::feedback::{self, FeedbackLog, Outcome as LogOutcome, Record};
use super::prompt::{self, FimPrompt, WINDOW_BUDGET};
use super::stop::{self, StopMode, Trimmer};
use crate::index::related::{self, Snippet};
use crate::index::symbols::Lang;
use crate::index::{RelPath, WorkspaceIndex};
use crate::ollama::{
    GenerateRequest, OllamaClient, OllamaError, OllamaState, OllamaStatus, Options,
};
use crate::overlay::{CursorWindow, DocumentStore, uri_to_path};
use crate::protocol::{
    CompletionItem, CompletionLanguageStats, CompletionRequestParams, CompletionResult,
    CompletionStatsResult, Position, Range,
};
use crate::rpc::RpcError;
use crate::settings::Settings;
use crate::tokens;

/// A uri's snippets are recomputed at request time once they are this old.
pub const SNIPPET_TTL: Duration = Duration::from_secs(60);
/// Documents larger than this are never completed.
pub const MAX_DOCUMENT_BYTES: usize = 1 << 20;
/// Lines around the cursor used as the retrieval window at refresh time.
pub const SNIPPET_WINDOW_LINES: usize = 40;
/// Served request ids remembered for `completion/accepted|rejected`.
const SERVED_MEMORY: usize = 64;
/// A served suggestion with no outcome after this long is logged `rejected`.
pub const OUTCOME_TIMEOUT: Duration = Duration::from_secs(60);
/// At most this many suggestions await an outcome; older ones are logged
/// `rejected`.
pub const PENDING_MEMORY: usize = 64;
/// At most this many typed-prefix request ids alias one pending
/// suggestion; older ones are forgotten.
pub const ALIAS_MEMORY: usize = 256;

/// `(uri, prefix, suffix)` exactly as sent to the model.
type Key = (String, String, String);

/// Result of one generation: the cleaned-up suggestion, or why there is none.
type Outcome = Result<String, OllamaError>;

/// Drives inline completions; share it as `Arc<CompletionEngine>`.
pub struct CompletionEngine {
    inner: Arc<Inner>,
}

struct Inner {
    ollama: OllamaClient,
    store: Arc<RwLock<DocumentStore>>,
    index: Arc<RwLock<WorkspaceIndex>>,
    settings: Settings,
    paused: AtomicBool,
    cache_enabled: AtomicBool,
    cache: Mutex<CompletionCache>,
    snippets_by_uri: Mutex<HashMap<String, SnippetSlot>>,
    /// Last requested cursor and prefix-window start per uri.
    cursors: Mutex<HashMap<String, CursorState>>,
    inflight: Mutex<HashMap<Key, Flight>>,
    /// Cancellation token of every request currently being answered.
    requests: Mutex<HashMap<String, CancellationToken>>,
    /// Recently served request ids and their cache keys, oldest first.
    served: Mutex<VecDeque<(String, Key)>>,
    /// Where outcomes are logged; `None` logs nothing.
    feedback: Mutex<Option<Arc<FeedbackLog>>>,
    /// Served suggestions awaiting their outcome, oldest first.
    pending: Mutex<VecDeque<Pending>>,
    last_status: Mutex<Option<OllamaStatus>>,
    /// Served multi-line suggestions per language while learned limits were
    /// in effect (drives exploration).
    explore_counts: Mutex<HashMap<&'static str, u64>>,
    snippet_refreshes: AtomicUsize,
    next_refresh: AtomicU64,
    next_flight: AtomicU64,
}

/// A logged-to-be suggestion; `record.outcome` is filled in on outcome.
struct Pending {
    /// When served, or when a typed-prefix hit on it was last served.
    served_at: Instant,
    /// The cache key it was served under (what a typed-prefix hit matches).
    key: Key,
    /// Typed-prefix hits served from it, oldest first: `(request id, text
    /// typed into the suggestion before that hit)`.
    aliases: VecDeque<(String, String)>,
    record: Record,
}

#[derive(Debug, Clone, Copy)]
struct CursorState {
    position: Position,
    /// `CursorWindow::prefix_start` of the last request: kept while typing.
    prefix_start: usize,
}

/// Snippets for one uri plus the bookkeeping of their refresh.
#[derive(Default)]
struct SnippetSlot {
    entry: Option<SnippetEntry>,
    /// Id of the newest refresh started; only its result is stored.
    refresh: Option<u64>,
}

struct SnippetEntry {
    snippets: Arc<Vec<Snippet>>,
    /// Rendered style examples; they lead the snippet block.
    examples: Arc<str>,
    /// Learned limits for the uri's language; `None`: the configured ones.
    learned: Option<Learned>,
    computed_at: Instant,
}

/// A running generation that requesters wait on.
struct Flight {
    id: u64,
    /// `(max_lines, num_predict)` the generation runs with.
    limits: (u32, u32),
    waiters: usize,
    http_cancel: CancellationToken,
    result: watch::Receiver<Option<Outcome>>,
}

/// Timestamps of one [`CompletionEngine::request_timed`] call, for the
/// latency bench. A stamp is `None` if that point was never reached (skip,
/// cache hit, joined generation, error before the stream).
#[derive(Debug, Clone, Copy)]
pub struct CompletionTiming {
    /// The request entered the engine.
    pub started_at: Instant,
    /// The request body is serialized and the HTTP send starts (end of core
    /// overhead).
    pub prepared_at: Option<Instant>,
    /// The first streamed chunk arrived.
    pub first_token_at: Option<Instant>,
    /// The request returned its result.
    pub done_at: Instant,
}

/// Where a started generation records its HTTP-send and first-chunk times.
#[derive(Default)]
struct TimingSink {
    prepared_at: Mutex<Option<Instant>>,
    first_token_at: Mutex<Option<Instant>>,
}

/// Everything a request needs before the HTTP call (the "core overhead").
pub(crate) struct Prepared {
    pub key: Key,
    pub prompt: FimPrompt,
    pub mode: StopMode,
    pub crlf: bool,
    /// Line cap in effect: 1 in single-line mode, else the learned (or
    /// configured) multi-line cap.
    pub max_lines: u32,
    /// `num_predict` in effect.
    pub num_predict: u32,
    /// The document's language.
    pub lang: Lang,
    /// Multi-line mode with learned limits available: a served suggestion
    /// counts towards exploration.
    pub adapted: bool,
    /// This request explores: the configured limits replace the learned
    /// ones and an exact completion-cache hit is ignored.
    pub explore: bool,
}

#[cfg(test)]
impl Prepared {
    /// The snippet block at the start of the prompt.
    fn snippet_block(&self) -> &str {
        &self.prompt.prompt[..self.prompt.prompt.len() - self.key.1.len()]
    }
}

impl CompletionEngine {
    /// `settings` are fixed for the engine's lifetime (the core takes them
    /// only at `initialize`).
    pub fn new(
        ollama: OllamaClient,
        store: Arc<RwLock<DocumentStore>>,
        index: Arc<RwLock<WorkspaceIndex>>,
        settings: Settings,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                ollama,
                store,
                index,
                settings,
                paused: AtomicBool::new(false),
                cache_enabled: AtomicBool::new(true),
                cache: Mutex::new(CompletionCache::new(cache::DEFAULT_CAPACITY)),
                snippets_by_uri: Mutex::new(HashMap::new()),
                cursors: Mutex::new(HashMap::new()),
                inflight: Mutex::new(HashMap::new()),
                requests: Mutex::new(HashMap::new()),
                served: Mutex::new(VecDeque::new()),
                feedback: Mutex::new(None),
                pending: Mutex::new(VecDeque::new()),
                last_status: Mutex::new(None),
                explore_counts: Mutex::new(HashMap::new()),
                snippet_refreshes: AtomicUsize::new(0),
                next_refresh: AtomicU64::new(0),
                next_flight: AtomicU64::new(0),
            }),
        }
    }

    /// Answers `completion/request`. Never fails: skips, cancellation and
    /// Ollama errors all produce an empty `items` list (Ollama Down /
    /// ModelMissing are reported through [`last_status`](Self::last_status)).
    pub async fn request(
        &self,
        params: CompletionRequestParams,
        cancel: CancellationToken,
    ) -> Result<CompletionResult, RpcError> {
        self.request_with(params, cancel, None).await
    }

    /// [`request`](Self::request) plus timestamps, for the latency bench.
    /// Behaves exactly like `request`.
    pub async fn request_timed(
        &self,
        params: CompletionRequestParams,
        cancel: CancellationToken,
    ) -> (Result<CompletionResult, RpcError>, CompletionTiming) {
        let started_at = Instant::now();
        let sink = Arc::new(TimingSink::default());
        let result = self.request_with(params, cancel, Some(sink.clone())).await;
        let done_at = Instant::now();
        let timing = CompletionTiming {
            started_at,
            prepared_at: *lock(&sink.prepared_at),
            first_token_at: *lock(&sink.first_token_at),
            done_at,
        };
        (result, timing)
    }

    async fn request_with(
        &self,
        params: CompletionRequestParams,
        cancel: CancellationToken,
        timing: Option<Arc<TimingSink>>,
    ) -> Result<CompletionResult, RpcError> {
        let started_at = Instant::now();
        let timing = timing.unwrap_or_default();
        let inner = &self.inner;
        let settings = inner.settings.clone();
        if !settings.completions_enabled || self.is_paused() {
            return Ok(CompletionResult::default());
        }
        let _registration = Registration::new(inner, &params.request_id, &cancel);
        let Some(prepared) = self
            .prepare_with(&params.uri, params.position, &settings)
            .await
        else {
            return Ok(CompletionResult::default());
        };
        let key = prepared.key.clone();
        let (lang, adapted, explore) = (prepared.lang, prepared.adapted, prepared.explore);
        // Captured before `prepared` moves into the generation.
        let draft = self.feedback_log().is_some().then(|| {
            let path = uri_to_path(&params.uri);
            Draft {
                lang: lang.as_str(),
                ext: path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(str::to_lowercase),
                prompt_hash: feedback::prompt_hash(
                    &prepared.prompt.prompt,
                    &prepared.prompt.suffix,
                ),
                context_tail: feedback::context_tail(&key.1),
                max_lines: prepared.max_lines,
                num_predict: prepared.num_predict,
            }
        });

        let mut served_key = key.clone();
        // An exploring request wants a fresh generation with its own limits,
        // so it ignores an exact hit; a typed-prefix hit (the user is typing
        // through a suggestion already shown) is still served as usual.
        let cached = self
            .cache_enabled()
            .then(|| lock(&inner.cache).lookup(&key.0, &key.1, &key.2))
            .flatten()
            .filter(|hit| !explore || hit.entry_prefix != key.1);
        let mut typed_prefix_hit = false;
        let mut limits = None;
        let text = match cached {
            Some(hit) => {
                // A typed-prefix hit is stored under the shorter prefix.
                typed_prefix_hit = hit.entry_prefix != key.1;
                served_key.1 = hit.entry_prefix;
                hit.text
            }
            None => {
                let Some(mut waiter) =
                    join_or_start(inner, prepared, &settings, Some(timing.clone()))
                else {
                    return Ok(CompletionResult::default());
                };
                // A joined generation may run with other limits than ours.
                limits = Some(waiter.limits);
                let outcome = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => None,
                    outcome = waiter.result.wait_for(Option::is_some) => {
                        outcome.ok().and_then(|o| o.clone())
                    }
                };
                drop(waiter);
                match outcome {
                    Some(Ok(text)) => text,
                    _ => String::new(),
                }
            }
        };
        if text.is_empty() || cancel.is_cancelled() {
            return Ok(CompletionResult::default());
        }
        // Kept for a typed-prefix hit too, so rejecting it evicts the entry.
        remember_served(inner, &params.request_id, served_key.clone());
        // The rest of a suggestion already served is not a new suggestion:
        // the original's record carries the outcome, so no record (and no
        // exploration count) here; its id only aliases the original.
        if typed_prefix_hit {
            let typed = key.1.strip_prefix(&served_key.1).unwrap_or_default();
            self.add_alias(&served_key, &params.request_id, typed);
            return Ok(served(text, params.position));
        }
        if adapted {
            *lock(&inner.explore_counts)
                .entry(lang.as_str())
                .or_default() += 1;
        }
        if let Some(draft) = draft {
            let (max_lines, num_predict) = limits.unwrap_or((draft.max_lines, draft.num_predict));
            let ms = |d: Duration| u64::try_from(d.as_millis()).unwrap_or(u64::MAX);
            let first_token_at = *lock(&timing.first_token_at);
            let record = Record {
                ts: feedback::now_ms(),
                request_id: params.request_id.clone(),
                lang: draft.lang.to_owned(),
                ext: draft.ext,
                prompt_hash: draft.prompt_hash,
                context_tail: draft.context_tail,
                lines: feedback::line_count(&text),
                suggestion: text.clone(),
                outcome: LogOutcome::Rejected,
                accepted_text: None,
                ttft_ms: first_token_at.map(|t| ms(t.saturating_duration_since(started_at))),
                total_ms: ms(started_at.elapsed()),
                model: Some(settings.completion_model.clone()),
                max_lines: Some(max_lines),
                num_predict: Some(num_predict),
            };
            self.add_pending(record, served_key);
        }
        Ok(served(text, params.position))
    }

    /// Cancels the request `request_id` if it is still being answered; its
    /// generation is aborted unless another request is waiting on it.
    pub fn cancel(&self, request_id: &str) {
        if let Some(token) = lock(&self.inner.requests).get(request_id) {
            token.cancel();
        }
    }

    /// Chat gate: while paused every request returns empty at once, and
    /// pausing aborts running generations so the GPU is free for chat.
    pub fn set_paused(&self, paused: bool) {
        self.inner.paused.store(paused, Ordering::SeqCst);
        if paused {
            for flight in lock(&self.inner.inflight).values() {
                flight.http_cancel.cancel();
            }
        }
    }

    pub fn is_paused(&self) -> bool {
        self.inner.paused.load(Ordering::SeqCst)
    }

    /// Turns the completion cache off (lookups and stores), e.g. for the
    /// latency bench. In-flight joining stays on.
    pub fn set_cache_enabled(&self, enabled: bool) {
        self.inner.cache_enabled.store(enabled, Ordering::SeqCst);
    }

    /// Ollama health as last observed by a completion: `Ok` after a
    /// successful generation, `Down` / `ModelMissing` after those errors;
    /// `None` before the first model call.
    pub fn last_status(&self) -> Option<OllamaStatus> {
        lock(&self.inner.last_status).clone()
    }

    /// The suggestion served for `request_id` was accepted
    /// (`completion/accepted`).
    pub fn on_accepted(&self, request_id: &str) {
        self.on_outcome(request_id, LogOutcome::Accepted, None);
    }

    /// The suggestion served for `request_id` was dismissed
    /// (`completion/rejected`).
    pub fn on_rejected(&self, request_id: &str) {
        self.on_outcome(request_id, LogOutcome::Rejected, None);
    }

    /// `completion/outcome`: logs the pending suggestion of `request_id`
    /// with `outcome` (no-op if it is unknown, already logged or expired).
    /// For a typed-prefix hit's id that is the original suggestion's record,
    /// with the text typed before that hit prepended to `accepted_text`.
    /// A rejected suggestion is also dropped from the cache so it is not
    /// offered again.
    pub fn on_outcome(&self, request_id: &str, outcome: LogOutcome, accepted_text: Option<String>) {
        let taken = take_served(&self.inner, request_id);
        if outcome == LogOutcome::Rejected
            && let Some((uri, prefix, suffix)) = taken
        {
            lock(&self.inner.cache).remove(&uri, &prefix, &suffix);
        }
        let mut done = Vec::new();
        {
            let mut pending = lock(&self.inner.pending);
            // The named one first, so a late answer is not expired away.
            let named = take_named(&mut pending, request_id);
            expire(&mut pending, Instant::now(), &mut done);
            if let Some((mut p, typed)) = named {
                let accepted_text = accepted_text.map(|text| typed + &text);
                p.record.outcome = outcome;
                p.record.accepted_text = kept_text(outcome, accepted_text, &p.record.suggestion);
                done.push(p.record);
            }
        }
        self.write_log(done);
    }

    /// Logs outcomes to `log` from now on.
    pub fn set_feedback_log(&self, log: Arc<FeedbackLog>) {
        *lock(&self.inner.feedback) = Some(log);
    }

    /// The outcome log, if one is set.
    pub fn feedback_log(&self) -> Option<Arc<FeedbackLog>> {
        lock(&self.inner.feedback).clone()
    }

    /// `completion/stats`: outcome counts per language since the last
    /// learning reset, with the limits and example count the policy yields
    /// now (what the next snippet refresh applies). Waits for queued
    /// outcomes to be written first.
    pub async fn stats(&self) -> CompletionStatsResult {
        let settings = &self.inner.settings;
        let adaptive = settings.adaptive_completions;
        let Some(log) = self.feedback_log() else {
            return CompletionStatsResult {
                adaptive,
                ..CompletionStatsResult::default()
            };
        };
        log.flush().await;
        let configured = configured(settings);
        let languages = log
            .stats()
            .into_iter()
            .map(|(name, c)| {
                let (learned, examples) = if adaptive {
                    let lang = Lang::from_name(&name);
                    let recent = log.recent(&name, adaptive::WINDOW);
                    let budget = examples_budget(settings);
                    (
                        Policy::learned_from(lang, &recent, configured),
                        adaptive::examples(lang, &recent, budget).len(),
                    )
                } else {
                    (None, 0)
                };
                let is_learned = learned.is_some();
                let learned = learned.unwrap_or_else(|| configured.as_learned());
                #[allow(clippy::cast_precision_loss)]
                let accept_rate = if c.served == 0 {
                    0.0
                } else {
                    (c.accepted + c.partial) as f64 / c.served as f64
                };
                let stats = CompletionLanguageStats {
                    served: c.served,
                    accepted: c.accepted,
                    partial: c.partial,
                    rejected: c.rejected,
                    typed_through: c.typed_through,
                    accept_rate,
                    learned_max_lines: learned.max_lines,
                    learned_num_predict: learned.num_predict,
                    learned: is_learned,
                    examples: u32::try_from(examples).unwrap_or(u32::MAX),
                };
                (name, stats)
            })
            .collect();
        CompletionStatsResult {
            languages,
            log_path: Some(log.path().to_string_lossy().into_owned()),
            adaptive,
        }
    }

    /// `completion/resetLearning`: forgets what the log taught (the log
    /// file keeps every record) and drops the learned limits and examples
    /// of every uri at once. Refreshes already running are discarded so
    /// they cannot store values computed before the reset.
    pub fn reset_learning(&self) {
        if let Some(log) = self.feedback_log() {
            log.reset_learning();
        }
        lock(&self.inner.explore_counts).clear();
        for slot in lock(&self.inner.snippets_by_uri).values_mut() {
            slot.refresh = None;
            if let Some(entry) = slot.entry.as_mut() {
                entry.examples = Arc::from("");
                entry.learned = None;
            }
        }
    }

    /// Queues `record` (served under `key`) until its outcome arrives,
    /// logging expired ones.
    fn add_pending(&self, record: Record, key: Key) {
        let mut done = Vec::new();
        {
            let mut pending = lock(&self.inner.pending);
            let now = Instant::now();
            expire(&mut pending, now, &mut done);
            if pending.len() == PENDING_MEMORY
                && let Some(oldest) = pending.pop_front()
            {
                done.push(oldest.record);
            }
            pending.push_back(Pending {
                served_at: now,
                key,
                aliases: VecDeque::new(),
                record,
            });
        }
        self.write_log(done);
    }

    /// A typed-prefix hit `request_id` was served from the suggestion
    /// cached under `key` after `typed` was typed into it: makes the id an
    /// alias of the newest pending record served under `key` and restarts
    /// that record's timeout (the user is still typing through it).
    fn add_alias(&self, key: &Key, request_id: &str, typed: &str) {
        let mut done = Vec::new();
        {
            let mut pending = lock(&self.inner.pending);
            let now = Instant::now();
            // Refreshed before expiry runs, so the hit keeps it alive.
            if let Some(mut p) = pending
                .iter()
                .rposition(|p| &p.key == key)
                .and_then(|at| pending.remove(at))
            {
                p.served_at = now;
                if p.aliases.len() == ALIAS_MEMORY {
                    p.aliases.pop_front();
                }
                p.aliases
                    .push_back((request_id.to_owned(), typed.to_owned()));
                pending.push_back(p);
            }
            expire(&mut pending, now, &mut done);
        }
        self.write_log(done);
    }

    /// Hands `records` to the log's writer (never blocks on file I/O).
    fn write_log(&self, records: Vec<Record>) {
        if records.is_empty() {
            return;
        }
        if let Some(log) = self.feedback_log() {
            for record in records {
                log.submit(record);
            }
        }
    }

    /// Logs every suggestion still awaiting an outcome as `rejected` and
    /// waits until the log has written everything (call on shutdown).
    pub async fn flush_pending(&self) {
        let done: Vec<Record> = lock(&self.inner.pending)
            .drain(..)
            .map(|p| p.record)
            .collect();
        self.write_log(done);
        if let Some(log) = self.feedback_log() {
            log.flush().await;
        }
    }

    /// Makes every pending suggestion `by` older.
    #[cfg(test)]
    fn age_pending(&self, by: Duration) {
        for p in lock(&self.inner.pending).iter_mut() {
            p.served_at -= by;
        }
    }

    /// Recomputes the related snippets for `uri` (call on didOpen, didSave
    /// and watcher changes to that file) and returns when they are stored.
    /// Uses the 40 lines around the last requested cursor in `uri` (the top
    /// of the file if none). No-op if the document is not open.
    pub async fn refresh_snippets(&self, uri: &str) {
        let last = lock(&self.inner.cursors).get(uri).copied();
        let pos = last.map_or(
            Position {
                line: 0,
                character: 0,
            },
            |c| c.position,
        );
        let prev_start = last.map(|c| c.prefix_start);
        let window = read(&self.inner.store).cursor_window(uri, pos, WINDOW_BUDGET, prev_start);
        let Some(window) = window else {
            return;
        };
        let budget = prompt::snippet_budget(&self.inner.settings);
        let mark = start_refresh(&self.inner, uri);
        refresh(mark, window_lines(&window), budget).await;
    }

    /// Drops the cached snippets and remembered cursor for `uri` (e.g. on
    /// didClose); the next request recomputes the snippets.
    pub fn invalidate_snippets(&self, uri: &str) {
        lock(&self.inner.snippets_by_uri).remove(uri);
        lock(&self.inner.cursors).remove(uri);
    }

    /// How many times [`related::snippets`] has run.
    pub fn snippet_refresh_count(&self) -> usize {
        self.inner.snippet_refreshes.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) async fn prepare(&self, uri: &str, position: Position) -> Option<Prepared> {
        let settings = self.inner.settings.clone();
        self.prepare_with(uri, position, &settings).await
    }

    #[cfg(test)]
    fn age_snippets(&self, uri: &str, by: Duration) {
        if let Some(entry) = lock(&self.inner.snippets_by_uri)
            .get_mut(uri)
            .and_then(|slot| slot.entry.as_mut())
        {
            entry.computed_at -= by;
        }
    }

    #[cfg(test)]
    fn refresh_running(&self, uri: &str) -> bool {
        lock(&self.inner.snippets_by_uri)
            .get(uri)
            .is_some_and(|slot| slot.refresh.is_some())
    }

    /// Waits until no snippet refresh for `uri` is running.
    #[cfg(test)]
    async fn wait_snippets_settled(&self, uri: &str) {
        for _ in 0..500 {
            if !self.refresh_running(uri) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("snippet refresh for {uri} did not finish");
    }

    fn cache_enabled(&self) -> bool {
        self.inner.cache_enabled.load(Ordering::SeqCst)
    }

    /// Skip rules, cursor window, snippets and prompt: everything before the
    /// model call. `None` means "skip; answer empty".
    async fn prepare_with(
        &self,
        uri: &str,
        position: Position,
        settings: &Settings,
    ) -> Option<Prepared> {
        let inner = &self.inner;
        let prev_start = lock(&inner.cursors).get(uri).map(|c| c.prefix_start);
        let window = read(&inner.store).cursor_window(uri, position, WINDOW_BUDGET, prev_start)?;
        if window.doc_len > MAX_DOCUMENT_BYTES {
            return None;
        }
        lock(&inner.cursors).insert(
            uri.to_owned(),
            CursorState {
                position,
                prefix_start: window.prefix_start,
            },
        );
        if window
            .next_char
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return None;
        }

        // Serve what is cached, even if stale; refresh in the background.
        let (snippets, examples, learned, mark) = {
            let mut map = lock(&inner.snippets_by_uri);
            let slot = map.entry(uri.to_owned()).or_default();
            let fresh = slot
                .entry
                .as_ref()
                .is_some_and(|e| e.computed_at.elapsed() <= SNIPPET_TTL);
            let entry = slot.entry.as_ref();
            let snippets = entry.map(|e| e.snippets.clone()).unwrap_or_default();
            let examples = entry.map_or_else(|| Arc::from(""), |e| e.examples.clone());
            let learned = entry.and_then(|e| e.learned);
            // Claimed under the same lock as the check: one refresh per uri.
            let mark = (!fresh && slot.refresh.is_none()).then(|| claim_refresh(inner, slot, uri));
            (snippets, examples, learned, mark)
        };
        if let Some(mark) = mark {
            let budget = prompt::snippet_budget(settings);
            tokio::spawn(refresh(mark, window_lines(&window), budget));
        }

        let lang = Lang::from_path(&uri_to_path(uri));
        let (examples, learned) = if settings.adaptive_completions {
            (&*examples, learned)
        } else {
            ("", None)
        };
        let prompt = prompt::build(
            examples,
            &snippets,
            &window.prefix,
            &window.suffix,
            lang,
            settings,
        );
        let mode = stop::mode_for(&window.prefix, &prompt.suffix);
        let adapted = mode == StopMode::MultiLine && learned.is_some();
        // Nothing to explore when what was learned is the configured limits.
        let explore = adapted && learned != Some(configured(settings).as_learned()) && {
            let served = lock(&inner.explore_counts)
                .get(lang.as_str())
                .copied()
                .unwrap_or(0);
            served % adaptive::EXPLORE_EVERY == adaptive::EXPLORE_EVERY - 1
        };
        let limits = match learned {
            Some(learned) if !explore => learned,
            _ => configured(settings).as_learned(),
        };
        let key = (uri.to_owned(), window.prefix, prompt.suffix.clone());
        Some(Prepared {
            key,
            prompt,
            mode,
            crlf: window.crlf,
            max_lines: match mode {
                StopMode::SingleLine => 1,
                StopMode::MultiLine => limits.max_lines,
            },
            num_predict: limits.num_predict,
            lang,
            adapted,
            explore,
        })
    }
}

/// Marks a new refresh of `uri` as the newest one.
fn start_refresh(inner: &Arc<Inner>, uri: &str) -> RefreshMark {
    let mut map = lock(&inner.snippets_by_uri);
    claim_refresh(inner, map.entry(uri.to_owned()).or_default(), uri)
}

/// Marks a new refresh as the newest for `slot` (whose map lock the caller
/// holds; the returned mark must outlive that lock guard).
fn claim_refresh(inner: &Arc<Inner>, slot: &mut SnippetSlot, uri: &str) -> RefreshMark {
    let id = inner.next_refresh.fetch_add(1, Ordering::Relaxed);
    slot.refresh = Some(id);
    RefreshMark {
        inner: inner.clone(),
        uri: uri.to_owned(),
        id,
    }
}

/// Ownership of a slot's "refresh `id` running" mark. Dropping it clears the
/// mark if it is still this refresh's, so a refresh whose future is dropped
/// (or whose task fails) never blocks later refreshes of the uri.
struct RefreshMark {
    inner: Arc<Inner>,
    uri: String,
    id: u64,
}

impl Drop for RefreshMark {
    fn drop(&mut self) {
        let mut map = lock(&self.inner.snippets_by_uri);
        if let Some(slot) = map.get_mut(&self.uri)
            && slot.refresh == Some(self.id)
        {
            slot.refresh = None;
        }
    }
}

/// Computes the snippets for the marked uri from the lines `around` the
/// cursor (off the async threads: it reads files) and stores them if this
/// refresh is still the newest for a uri that was not invalidated meanwhile.
/// A failed computation keeps the previous snippets.
///
/// The adaptive values (learned limits and style examples) are computed here
/// too, from the log's memory; examples take their tokens out of `budget`.
async fn refresh(mark: RefreshMark, around: String, budget: usize) {
    let (examples, learned) = adaptive_view(&mark.inner, &mark.uri, budget);
    let budget = budget.saturating_sub(tokens::estimate(&examples));
    let task_inner = mark.inner.clone();
    let task_uri = mark.uri.clone();
    let computed = tokio::task::spawn_blocking(move || {
        compute_snippets(&task_inner, &task_uri, &around, budget)
    })
    .await;
    let Ok(snippets) = computed else {
        return; // `mark` clears the running flag
    };
    let mut map = lock(&mark.inner.snippets_by_uri);
    if let Some(slot) = map.get_mut(&mark.uri)
        && slot.refresh == Some(mark.id)
    {
        slot.refresh = None;
        slot.entry = Some(SnippetEntry {
            snippets: Arc::new(snippets),
            examples: Arc::from(examples),
            learned,
            computed_at: Instant::now(),
        });
    }
}

/// The rendered style examples and learned limits for `uri`'s language
/// (`""`, `None` with adaptive completions off or no log; `None` limits with
/// too few outcomes). Memory only.
fn adaptive_view(inner: &Inner, uri: &str, budget: usize) -> (String, Option<Learned>) {
    let settings = &inner.settings;
    if !settings.adaptive_completions {
        return (String::new(), None);
    }
    let Some(log) = lock(&inner.feedback).clone() else {
        return (String::new(), None);
    };
    let lang = Lang::from_path(&uri_to_path(uri));
    let recent = log.recent(lang.as_str(), adaptive::WINDOW);
    // `None` with too few outcomes: the configured limits, no exploration.
    let learned = Policy::learned_from(lang, &recent, configured(settings));
    let examples = adaptive::examples(lang, &recent, budget.min(examples_budget(settings)));
    (adaptive::render_examples(lang, &examples), learned)
}

/// The user's limits, as the adaptive policy starts from them.
fn configured(settings: &Settings) -> Configured {
    Configured {
        max_tokens: settings.completion_max_tokens,
        max_lines: u32::try_from(stop::MAX_LINES).unwrap_or(u32::MAX),
    }
}

/// Token budget of the style examples: at most 300, never more than the
/// snippet block's budget.
fn examples_budget(settings: &Settings) -> usize {
    prompt::snippet_budget(settings).min(adaptive::EXAMPLES_TOKENS)
}

fn compute_snippets(inner: &Inner, uri: &str, window: &str, budget: usize) -> Vec<Snippet> {
    inner.snippet_refreshes.fetch_add(1, Ordering::SeqCst);
    let (overlay, recent_uris) = {
        let store = read(&inner.store);
        (
            store.overlay_snapshot(),
            store.recently_edited(related::RECENT_FILES),
        )
    };
    let index = read(&inner.index);
    let filter = index.filter();
    let Some(current) = filter.relativize(&uri_to_path(uri)) else {
        return Vec::new();
    };
    let recent: Vec<RelPath> = recent_uris
        .iter()
        .filter_map(|u| filter.relativize(&uri_to_path(u)))
        .collect();
    related::snippets(
        &index,
        &overlay,
        &recent,
        Path::new(&current),
        window,
        budget,
    )
}

/// The [`SNIPPET_WINDOW_LINES`] lines around the cursor: the last half from
/// the prefix (including the cursor line) and the first half from the suffix.
fn window_lines(window: &CursorWindow) -> String {
    let (prefix, suffix) = (window.prefix.as_str(), window.suffix.as_str());
    let half = SNIPPET_WINDOW_LINES / 2;
    let start = prefix
        .rmatch_indices('\n')
        .nth(half - 1)
        .map_or(0, |(i, _)| i + 1);
    let end = suffix
        .match_indices('\n')
        .nth(half - 1)
        .map_or(suffix.len(), |(i, _)| i);
    format!("{}{}", &prefix[start..], &suffix[..end])
}

/// Registers the requester on the in-flight generation for `prepared.key`,
/// starting one if there is none. `None` if completions are paused: checked
/// under the `inflight` lock, so a flight started here is always seen (and
/// cancelled) by a concurrent [`CompletionEngine::set_paused`].
/// `timing`, if given, receives the HTTP-send and first-chunk times of a
/// generation started here (not of one joined).
fn join_or_start(
    inner: &Arc<Inner>,
    prepared: Prepared,
    settings: &Settings,
    timing: Option<Arc<TimingSink>>,
) -> Option<Waiter> {
    let mut inflight = lock(&inner.inflight);
    if inner.paused.load(Ordering::SeqCst) {
        return None;
    }
    if let Some(flight) = inflight.get_mut(&prepared.key) {
        flight.waiters += 1;
        return Some(Waiter {
            inner: inner.clone(),
            key: prepared.key,
            flight: flight.id,
            limits: flight.limits,
            result: flight.result.clone(),
        });
    }
    let id = inner.next_flight.fetch_add(1, Ordering::Relaxed);
    let http_cancel = CancellationToken::new();
    let (tx, rx) = watch::channel(None);
    let limits = (prepared.max_lines, prepared.num_predict);
    inflight.insert(
        prepared.key.clone(),
        Flight {
            id,
            limits,
            waiters: 1,
            http_cancel: http_cancel.clone(),
            result: rx.clone(),
        },
    );
    drop(inflight);

    let request = GenerateRequest {
        model: settings.completion_model.clone(),
        prompt: prepared.prompt.prompt,
        suffix: Some(prepared.prompt.suffix),
        raw: false,
        stream: true,
        options: Options {
            num_predict: prepared.num_predict,
            temperature: 0.0,
            stop: Vec::new(),
            num_ctx: None,
        },
        keep_alive: Some(settings.keep_alive.clone()),
    };
    let trimmer = Trimmer::new(prepared.mode, &request.suffix.clone().unwrap_or_default())
        .with_crlf(prepared.crlf)
        .with_max_lines(usize::try_from(prepared.max_lines).unwrap_or(stop::MAX_LINES));
    let task_inner = inner.clone();
    let key = prepared.key.clone();
    tokio::spawn(async move {
        let outcome = generate(
            &task_inner.ollama,
            request,
            trimmer,
            &http_cancel,
            timing.as_deref(),
        )
        .await;
        record_status(&task_inner, &outcome);
        if let Ok(text) = &outcome
            && !text.is_empty()
            && task_inner.cache_enabled.load(Ordering::SeqCst)
        {
            lock(&task_inner.cache).put(&key.0, &key.1, &key.2, text);
        }
        remove_flight(&task_inner, &key, id);
        let _ = tx.send(Some(outcome));
    });
    Some(Waiter {
        inner: inner.clone(),
        key: prepared.key,
        flight: id,
        limits,
        result: rx,
    })
}

/// Streams one generation through `trimmer`, dropping the HTTP stream as
/// soon as a stop rule fires.
async fn generate(
    ollama: &OllamaClient,
    request: GenerateRequest,
    mut trimmer: Trimmer,
    http_cancel: &CancellationToken,
    timing: Option<&TimingSink>,
) -> Outcome {
    let on_send = || {
        if let Some(t) = timing {
            *lock(&t.prepared_at) = Some(Instant::now());
        }
    };
    let mut stream = ollama
        .generate_stream_on_send(request, http_cancel.clone(), on_send)
        .await?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if let Some(t) = timing {
            lock(&t.first_token_at).get_or_insert_with(Instant::now);
        }
        if let Some(text) = trimmer.push(&chunk.response) {
            http_cancel.cancel();
            return Ok(text);
        }
        if chunk.done {
            break;
        }
    }
    Ok(trimmer.finish())
}

fn record_status(inner: &Inner, outcome: &Outcome) {
    let status = match outcome {
        Ok(_) => OllamaStatus {
            ollama: OllamaState::Ok,
            detail: "completion model responded".to_owned(),
        },
        Err(err @ OllamaError::Down(_)) => OllamaStatus {
            ollama: OllamaState::Down,
            detail: err.to_string(),
        },
        Err(err @ OllamaError::ModelMissing(_)) => OllamaStatus {
            ollama: OllamaState::ModelMissing,
            detail: err.to_string(),
        },
        Err(_) => return,
    };
    *lock(&inner.last_status) = Some(status);
}

fn remove_flight(inner: &Inner, key: &Key, id: u64) {
    let mut inflight = lock(&inner.inflight);
    if inflight.get(key).is_some_and(|f| f.id == id) {
        inflight.remove(key);
    }
}

/// One requester's interest in a generation. Dropping the last waiter of a
/// still-running generation cancels its HTTP stream.
struct Waiter {
    inner: Arc<Inner>,
    key: Key,
    flight: u64,
    /// The flight's `(max_lines, num_predict)`.
    limits: (u32, u32),
    result: watch::Receiver<Option<Outcome>>,
}

impl Drop for Waiter {
    fn drop(&mut self) {
        let mut inflight = lock(&self.inner.inflight);
        let Some(flight) = inflight.get_mut(&self.key) else {
            return;
        };
        if flight.id != self.flight {
            return;
        }
        flight.waiters -= 1;
        if flight.waiters == 0 {
            flight.http_cancel.cancel();
            inflight.remove(&self.key);
        }
    }
}

/// Keeps `request_id → token` registered for [`CompletionEngine::cancel`]
/// while the request is being answered (also if its future is dropped).
struct Registration<'a> {
    inner: &'a Inner,
    request_id: &'a str,
}

impl<'a> Registration<'a> {
    fn new(inner: &'a Inner, request_id: &'a str, token: &CancellationToken) -> Self {
        lock(&inner.requests).insert(request_id.to_owned(), token.clone());
        Self { inner, request_id }
    }
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        lock(&self.inner.requests).remove(self.request_id);
    }
}

/// The one-item answer serving `text` at `at`.
fn served(text: String, at: Position) -> CompletionResult {
    CompletionResult {
        items: vec![CompletionItem {
            text,
            range: Range { start: at, end: at },
        }],
    }
}

fn remember_served(inner: &Inner, request_id: &str, key: Key) {
    let mut served = lock(&inner.served);
    if served.len() == SERVED_MEMORY {
        served.pop_front();
    }
    served.push_back((request_id.to_owned(), key));
}

/// What a pending [`Record`] needs from the prompt, taken before the
/// prompt is handed to the generation.
struct Draft {
    lang: &'static str,
    ext: Option<String>,
    prompt_hash: String,
    context_tail: String,
    max_lines: u32,
    num_predict: u32,
}

/// `acceptedText` as logged: only for `accepted` / `partial`, and at most as
/// many characters as the suggestion.
fn kept_text(outcome: LogOutcome, text: Option<String>, suggestion: &str) -> Option<String> {
    if !matches!(outcome, LogOutcome::Accepted | LogOutcome::Partial) {
        return None;
    }
    let mut text = text?;
    let cap = suggestion.chars().count();
    if let Some((cut, _)) = text.char_indices().nth(cap) {
        text.truncate(cut);
    }
    Some(text)
}

/// Moves the pending suggestions older than [`OUTCOME_TIMEOUT`] (the
/// oldest are at the front) to `done`, as `rejected`.
fn expire(pending: &mut VecDeque<Pending>, now: Instant, done: &mut Vec<Record>) {
    while pending
        .front()
        .is_some_and(|p| now.saturating_duration_since(p.served_at) >= OUTCOME_TIMEOUT)
    {
        if let Some(p) = pending.pop_front() {
            done.push(p.record); // already `Rejected`
        }
    }
}

/// Removes the pending record named `request_id`, directly (typed text
/// `""`) or through an alias (the text typed before that hit).
fn take_named(pending: &mut VecDeque<Pending>, request_id: &str) -> Option<(Pending, String)> {
    let (at, typed) = pending
        .iter()
        .position(|p| p.record.request_id == request_id)
        .map(|at| (at, String::new()))
        .or_else(|| {
            pending.iter().enumerate().find_map(|(at, p)| {
                p.aliases
                    .iter()
                    .find(|(id, _)| id == request_id)
                    .map(|(_, typed)| (at, typed.clone()))
            })
        })?;
    pending.remove(at).map(|p| (p, typed))
}

fn take_served(inner: &Inner, request_id: &str) -> Option<Key> {
    let mut served = lock(&inner.served);
    let at = served.iter().position(|(id, _)| id == request_id)?;
    served.remove(at).map(|(_, key)| key)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read<T>(l: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::super::feedback::FeedbackLog;
    use super::*;
    use crate::overlay::path_to_uri;
    use crate::protocol::ContentChange;

    const UTIL: &str = "def helper_value(x):\n    return x * 2\n\n\ndef other_thing():\n    pass\n";
    const MAIN: &str = "from util import helper_value\n\nresult = helper_value(3)\nprint(resul\n";

    struct Fixture {
        engine: CompletionEngine,
        store: Arc<RwLock<DocumentStore>>,
        uri: String,
        _dir: tempfile::TempDir,
    }

    fn fixture(main: &str) -> Fixture {
        fixture_with(main, |_| {})
    }

    fn fixture_with(main: &str, tweak: impl FnOnce(&mut Settings)) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root: PathBuf = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("util.py"), UTIL).unwrap();
        std::fs::write(root.join("main.py"), main).unwrap();
        let uri = path_to_uri(&root.join("main.py"));
        let mut store = DocumentStore::new(root.clone());
        store.did_open(&uri, main.to_owned(), 1);
        let store = Arc::new(RwLock::new(store));
        let index = Arc::new(RwLock::new(WorkspaceIndex::build(&root)));
        let ollama = OllamaClient::new("http://127.0.0.1:9".to_owned(), "30m".to_owned());
        let mut settings = Settings::default();
        tweak(&mut settings);
        let engine = CompletionEngine::new(ollama, store.clone(), index, settings);
        Fixture {
            engine,
            store,
            uri,
            _dir: dir,
        }
    }

    fn type_char(f: &Fixture, at: Position, version: i32) {
        let change = ContentChange {
            range: Some(Range { start: at, end: at }),
            text: "t".to_owned(),
        };
        f.store
            .write()
            .unwrap()
            .did_change(&f.uri, version, vec![change]);
    }

    #[tokio::test]
    async fn prompt_prefix_unchanged_across_consecutive_keystrokes() {
        let f = fixture(MAIN);
        f.engine.refresh_snippets(&f.uri).await; // didOpen
        assert_eq!(f.engine.snippet_refresh_count(), 1);

        let at = |character| Position { line: 3, character };
        let first = f.engine.prepare(&f.uri, at(11)).await.expect("not skipped");
        type_char(&f, at(11), 2);
        let second = f.engine.prepare(&f.uri, at(12)).await.expect("not skipped");

        let block = first.snippet_block();
        assert!(
            block.contains("# Path: util.py\n"),
            "snippet block: {block:?}"
        );
        assert!(block.contains("def helper_value"));
        assert_eq!(block, second.snippet_block());
        assert_eq!(second.prompt.prompt, format!("{}t", first.prompt.prompt));
        assert_eq!(
            f.engine.snippet_refresh_count(),
            1,
            "no per-keystroke retrieval"
        );
    }

    #[tokio::test]
    async fn prompt_prefix_stable_on_large_file() {
        // ~30 KB of code before the cursor: far over the 8 KB prefix budget.
        let main = large_main();
        assert!(main.len() > 3 * PREFIX_BYTES);
        let f = fixture(&main);
        f.engine.refresh_snippets(&f.uri).await;
        let line = 801;

        let mut prev = f
            .engine
            .prepare(
                &f.uri,
                Position {
                    line,
                    character: 11,
                },
            )
            .await
            .unwrap();
        assert!(prev.key.1.len() <= PREFIX_BYTES);
        assert!(
            prev.key.1.starts_with("value_"),
            "line-aligned window start"
        );
        // Many keystrokes: each prompt extends the previous one byte-for-byte.
        for n in 0..40u32 {
            let at = Position {
                line,
                character: 11 + n,
            };
            type_char(&f, at, 2 + n as i32);
            let next = f
                .engine
                .prepare(
                    &f.uri,
                    Position {
                        line,
                        character: 12 + n,
                    },
                )
                .await
                .unwrap();
            assert_eq!(next.prompt.prompt, format!("{}t", prev.prompt.prompt));
            prev = next;
        }
    }

    const PREFIX_BYTES: usize = prompt::PREFIX_TOKENS * 4;
    const MIN_PREFIX_BYTES: usize = (prompt::PREFIX_TOKENS - prompt::PREFIX_SLACK_TOKENS) * 4;

    fn large_main() -> String {
        let body: String = (0..800)
            .map(|i| format!("value_{i} = helper_value({i})  # pad\n"))
            .collect();
        format!("from util import helper_value\n{body}print(resul\n")
    }

    /// The prefix window is long enough and starts at a line boundary.
    fn assert_full_window(p: &Prepared, text_before: &str) {
        let prefix = &p.key.1;
        assert!(
            (MIN_PREFIX_BYTES..=PREFIX_BYTES + prompt::PREFIX_SLACK_TOKENS * 4)
                .contains(&prefix.len()),
            "prefix of {} bytes",
            prefix.len()
        );
        assert!(text_before.ends_with(prefix.as_str()));
        assert!(text_before[..text_before.len() - prefix.len()].ends_with('\n'));
    }

    #[tokio::test]
    async fn prefix_stays_full_after_moving_up_or_deleting_above() {
        let main = large_main();
        let f = fixture(&main);
        f.engine.refresh_snippets(&f.uri).await;
        let end = Position {
            line: 801,
            character: 11,
        };
        f.engine.prepare(&f.uri, end).await.unwrap();

        // Move the cursor up, to the end of a line well above the old window.
        let line_599 = main.lines().nth(599).unwrap();
        let up = Position {
            line: 599,
            character: line_599.len() as u32,
        };
        let before_up = &main[..crate::overlay::offset_of(&main, up)];
        assert!(before_up.ends_with(line_599));
        let p = f.engine.prepare(&f.uri, up).await.unwrap();
        assert_full_window(&p, before_up);

        // Typing there keeps the prompt stable.
        type_char(&f, up, 2);
        let next = Position {
            character: up.character + 1,
            ..up
        };
        let typed = f.engine.prepare(&f.uri, next).await.unwrap();
        assert_eq!(typed.prompt.prompt, format!("{}t", p.prompt.prompt));

        // Delete a large block above the window, back at the end.
        f.engine.prepare(&f.uri, end).await.unwrap();
        let cut = ContentChange {
            range: Some(Range {
                start: Position {
                    line: 300,
                    character: 0,
                },
                end: Position {
                    line: 790,
                    character: 0,
                },
            }),
            text: String::new(),
        };
        f.store.write().unwrap().did_change(&f.uri, 3, vec![cut]);
        let text = f.store.read().unwrap().text(&f.uri).unwrap();
        let at = Position {
            line: 311,
            character: 11,
        };
        let before = &text[..crate::overlay::offset_of(&text, at)];
        assert!(before.ends_with("print(resul"));
        let p = f.engine.prepare(&f.uri, at).await.unwrap();
        assert_full_window(&p, before);
    }

    #[tokio::test]
    async fn dropped_refresh_does_not_leave_the_running_mark() {
        use futures::FutureExt;
        let f = fixture(MAIN);
        // Polled once (the blocking computation is still running), then dropped.
        let _ = f.engine.refresh_snippets(&f.uri).now_or_never();
        assert!(!f.engine.refresh_running(&f.uri));
        // A later request can still start a background refresh.
        let pos = Position {
            line: 3,
            character: 11,
        };
        f.engine.invalidate_snippets(&f.uri);
        f.engine.prepare(&f.uri, pos).await.unwrap();
        f.engine.wait_snippets_settled(&f.uri).await;
        assert!(
            f.engine
                .prepare(&f.uri, pos)
                .await
                .unwrap()
                .snippet_block()
                .contains("helper_value")
        );
    }

    #[tokio::test]
    async fn stale_or_missing_snippets_refresh_in_background() {
        let f = fixture(MAIN);
        let pos = Position {
            line: 3,
            character: 11,
        };

        // Never refreshed: served without snippets, refreshed in background.
        let first = f.engine.prepare(&f.uri, pos).await.unwrap();
        assert_eq!(first.snippet_block(), "");
        f.engine.wait_snippets_settled(&f.uri).await;
        assert_eq!(f.engine.snippet_refresh_count(), 1);
        let warm = f.engine.prepare(&f.uri, pos).await.unwrap();
        assert!(warm.snippet_block().contains("def helper_value"));

        // Stale: the request is served the stale block; a burst of requests
        // starts only one refresh.
        f.engine
            .age_snippets(&f.uri, SNIPPET_TTL + Duration::from_secs(1));
        for _ in 0..5 {
            let stale = f.engine.prepare(&f.uri, pos).await.unwrap();
            assert_eq!(stale.snippet_block(), warm.snippet_block());
        }
        f.engine.wait_snippets_settled(&f.uri).await;
        assert_eq!(f.engine.snippet_refresh_count(), 2);
        f.engine.prepare(&f.uri, pos).await.unwrap();
        assert_eq!(f.engine.snippet_refresh_count(), 2, "fresh again");

        f.engine.invalidate_snippets(&f.uri);
        let cold = f.engine.prepare(&f.uri, pos).await.unwrap();
        assert_eq!(cold.snippet_block(), "");
        f.engine.wait_snippets_settled(&f.uri).await;
        assert_eq!(f.engine.snippet_refresh_count(), 3);
    }

    /// Serves `request_id` from a primed cache entry (no model call).
    async fn serve_cached(f: &Fixture, request_id: &str, at: Position) {
        let p = f.engine.prepare(&f.uri, at).await.unwrap();
        lock(&f.engine.inner.cache).put(&p.key.0, &p.key.1, &p.key.2, "t)");
        let params = CompletionRequestParams {
            uri: f.uri.clone(),
            position: at,
            request_id: request_id.to_owned(),
        };
        let served = f
            .engine
            .request(params, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(served.items[0].text, "t)");
    }

    /// `(requestId, outcome)` of everything logged so far.
    async fn logged(log: &FeedbackLog) -> Vec<(String, LogOutcome)> {
        log.flush().await;
        log.records()
            .into_iter()
            .map(|r| (r.request_id, r.outcome))
            .collect()
    }

    fn workspace_log(f: &Fixture) -> Arc<FeedbackLog> {
        let log = Arc::new(FeedbackLog::for_workspace(f._dir.path()));
        f.engine.set_feedback_log(log.clone());
        log
    }

    const AT: Position = Position {
        line: 3,
        character: 11,
    };

    #[tokio::test]
    async fn unanswered_outcome_expires_as_rejected() {
        let f = fixture(MAIN);
        let log = workspace_log(&f);
        let r = |id: &str, o| (id.to_owned(), o);

        serve_cached(&f, "r1", AT).await;
        f.engine
            .age_pending(OUTCOME_TIMEOUT - Duration::from_secs(1));
        serve_cached(&f, "r2", AT).await;
        assert!(logged(&log).await.is_empty(), "r1 has 1 s left");

        f.engine.age_pending(Duration::from_secs(2));
        // r1 is now 61 s old, r2 2 s: the next outcome expires r1 first.
        f.engine.on_outcome("r2", LogOutcome::Accepted, None);
        assert_eq!(
            logged(&log).await,
            [r("r1", LogOutcome::Rejected), r("r2", LogOutcome::Accepted)]
        );
        let expired = &log.records()[0];
        assert_eq!(expired.accepted_text, None);
        assert_eq!(expired.suggestion, "t)");
        assert_eq!(expired.lang, "python");
        assert_eq!(expired.ext.as_deref(), Some("py"));
        assert_eq!(
            expired.model.as_deref(),
            Some(Settings::default().completion_model.as_str())
        );
        assert_eq!(expired.max_lines, Some(8), "blank rest of line: multi-line");
        assert_eq!(
            expired.num_predict,
            Some(Settings::default().completion_max_tokens)
        );

        // A late outcome for the expired request adds nothing.
        f.engine.on_outcome("r1", LogOutcome::Accepted, None);
        assert_eq!(logged(&log).await.len(), 2);

        // Expiry also runs when the next suggestion is served.
        serve_cached(&f, "r3", AT).await;
        f.engine.age_pending(OUTCOME_TIMEOUT);
        serve_cached(&f, "r4", AT).await;
        assert_eq!(logged(&log).await[2..], [r("r3", LogOutcome::Rejected)]);

        // More unanswered suggestions than are remembered: the oldest are
        // logged as rejected rather than dropped.
        for i in 0..PENDING_MEMORY {
            serve_cached(&f, &format!("burst{i}"), AT).await;
        }
        let records = logged(&log).await;
        assert_eq!(records.len(), 4);
        assert_eq!(records[3], r("r4", LogOutcome::Rejected));
    }

    #[tokio::test]
    async fn accepted_text_is_capped_and_only_kept_when_accepted() {
        let f = fixture(MAIN);
        let log = workspace_log(&f);
        for (id, outcome, text) in [
            ("a", LogOutcome::Partial, "t)"),
            ("b", LogOutcome::Accepted, "t) and much more"),
            ("c", LogOutcome::Rejected, "t)"),
            ("d", LogOutcome::TypedThrough, "t)"),
        ] {
            serve_cached(&f, id, AT).await;
            f.engine.on_outcome(id, outcome, Some(text.to_owned()));
        }
        log.flush().await;
        let kept: Vec<Option<String>> =
            log.records().into_iter().map(|r| r.accepted_text).collect();
        assert_eq!(
            kept,
            [Some("t)".to_owned()), Some("t)".to_owned()), None, None]
        );
    }

    #[tokio::test]
    async fn logging_never_blocks_serving_and_shutdown_flushes_pending() {
        let f = fixture(MAIN);
        let log = workspace_log(&f);
        log.flush().await; // initial scan done
        // The writer is held (not slowed): if serving or an outcome waited
        // on it, they would never return. The bound only catches that, with
        // a wide margin for loaded machines.
        log.set_write_hold(true);
        let quick = Duration::from_secs(5);

        serve_cached(&f, "r1", AT).await;
        let t = Instant::now();
        f.engine.on_outcome("r1", LogOutcome::Accepted, None);
        assert!(t.elapsed() < quick, "outcome waited {:?}", t.elapsed());

        // A serve that expires an older suggestion does not wait either.
        serve_cached(&f, "r2", AT).await;
        f.engine.age_pending(OUTCOME_TIMEOUT);
        let served = tokio::time::timeout(quick, serve_cached(&f, "r3", AT)).await;
        assert!(served.is_ok(), "serve waited on the held writer");
        assert!(log.records().is_empty(), "the writer is still held");

        // Shutdown: r3 never got an outcome; it is logged and written.
        log.set_write_hold(false);
        f.engine.flush_pending().await;
        assert_eq!(
            logged(&log).await,
            [
                ("r1".to_owned(), LogOutcome::Accepted),
                ("r2".to_owned(), LogOutcome::Rejected),
                ("r3".to_owned(), LogOutcome::Rejected)
            ]
        );
    }

    #[tokio::test]
    async fn no_log_when_none_is_set() {
        let f = fixture(MAIN);
        serve_cached(&f, "r1", AT).await;
        f.engine.on_accepted("r1");
        assert!(!f._dir.path().join(".localpilot").exists());
    }

    /// A logged python outcome as the adaptive policy sees it.
    fn outcome_record(id: &str, suggestion: &str, outcome: LogOutcome) -> Record {
        Record {
            ts: feedback::now_ms(),
            request_id: id.to_owned(),
            lang: "python".to_owned(),
            ext: Some("py".to_owned()),
            prompt_hash: "0".repeat(16),
            context_tail: format!("# ctx {id}\n"),
            suggestion: suggestion.to_owned(),
            lines: feedback::line_count(suggestion),
            outcome,
            accepted_text: None,
            ttft_ms: None,
            total_ms: 1,
            model: None,
            max_lines: Some(8),
            num_predict: Some(32),
        }
    }

    /// 20 rejected 6-line suggestions and 10 accepted 2-line ones: the
    /// policy learns a 4-line cap and 16 tokens, with 3 examples.
    async fn seed_learning(log: &FeedbackLog) {
        let long = "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6";
        for i in 0..20 {
            log.submit(outcome_record(
                &format!("long{i}"),
                long,
                LogOutcome::Rejected,
            ));
        }
        for i in 0..10 {
            let two = format!("ex{i} = 1\nex{i} += 1");
            log.submit(outcome_record(
                &format!("two{i}"),
                &two,
                LogOutcome::Accepted,
            ));
        }
        log.flush().await;
    }

    const LEARNED: adaptive::Learned = adaptive::Learned {
        max_lines: 4,
        num_predict: adaptive::MIN_NUM_PREDICT,
    };

    #[tokio::test]
    async fn prompt_with_examples_is_byte_stable_across_keystrokes() {
        let f = fixture(MAIN);
        let log = workspace_log(&f);
        seed_learning(&log).await;
        f.engine.refresh_snippets(&f.uri).await;

        let at = |character| Position { line: 3, character };
        let first = f.engine.prepare(&f.uri, at(11)).await.unwrap();
        let block = first.snippet_block().to_owned();
        assert!(
            block.starts_with("# Example\n# ctx two9\nex9 = 1\nex9 += 1\n\n"),
            "{block:?}"
        );
        assert_eq!(block.matches("# Example\n").count(), 3);
        assert!(block.contains("# Path: util.py\n"), "snippets still follow");
        assert!(tokens::estimate(&block) <= prompt::snippet_budget(&Settings::default()));
        assert_eq!(
            (first.max_lines, first.num_predict),
            (LEARNED.max_lines, LEARNED.num_predict)
        );

        // New outcomes arrive between keystrokes (a fresh accepted example
        // and a served-and-accepted suggestion): the prompt only grows by
        // the typed character.
        log.submit(outcome_record(
            "fresh",
            "NEW = 1\nNEW += 1",
            LogOutcome::Accepted,
        ));
        log.flush().await;
        let mut prev = first;
        for n in 0..5u32 {
            type_char(&f, at(11 + n), 2 + n as i32);
            let next = f.engine.prepare(&f.uri, at(12 + n)).await.unwrap();
            assert_eq!(next.prompt.prompt, format!("{}t", prev.prompt.prompt));
            assert_eq!(next.snippet_block(), block);
            prev = next;
        }
        assert_eq!(f.engine.snippet_refresh_count(), 1);

        // Only a snippet refresh picks up the new example.
        f.engine.refresh_snippets(&f.uri).await;
        let after = f.engine.prepare(&f.uri, at(16)).await.unwrap();
        assert!(
            after
                .snippet_block()
                .starts_with("# Example\n# ctx fresh\nNEW = 1\n")
        );
        assert_ne!(after.snippet_block(), block);
    }

    #[tokio::test]
    async fn adaptive_off_ignores_learned_but_still_logs() {
        for adaptive in [true, false] {
            let f = fixture_with(MAIN, |s| s.adaptive_completions = adaptive);
            let log = workspace_log(&f);
            seed_learning(&log).await;
            f.engine.refresh_snippets(&f.uri).await;
            let p = f.engine.prepare(&f.uri, AT).await.unwrap();
            let configured = (8, Settings::default().completion_max_tokens);
            let want = if adaptive {
                (LEARNED.max_lines, LEARNED.num_predict)
            } else {
                configured
            };
            assert_eq!((p.max_lines, p.num_predict), want, "adaptive {adaptive}");
            assert_eq!(p.snippet_block().contains("# Example"), adaptive);
            assert!(p.snippet_block().contains("# Path: util.py"));

            // Logged either way, with the limits that were in effect.
            serve_cached(&f, "r1", AT).await;
            f.engine.on_outcome("r1", LogOutcome::Accepted, None);
            log.flush().await;
            let last = log.records().pop().unwrap();
            assert_eq!(last.request_id, "r1");
            assert_eq!(
                (last.max_lines, last.num_predict),
                (Some(want.0), Some(want.1))
            );

            let stats = f.engine.stats().await;
            assert_eq!(stats.adaptive, adaptive);
            let py = &stats.languages["python"];
            assert_eq!(py.served, 31);
            assert_eq!(
                (py.learned_max_lines, py.learned_num_predict, py.examples),
                if adaptive { (4, 16, 3) } else { (8, 32, 0) }
            );
            assert_eq!(py.learned, adaptive, "off: the values are the defaults");
        }
    }

    #[tokio::test]
    async fn single_line_mode_keeps_one_line_and_logs_it() {
        let f = fixture("x = foo()\n");
        let log = workspace_log(&f);
        seed_learning(&log).await;
        f.engine.refresh_snippets(&f.uri).await;
        // Inside `()`: code follows the cursor on its line.
        let p = f
            .engine
            .prepare(
                &f.uri,
                Position {
                    line: 0,
                    character: 8,
                },
            )
            .await
            .unwrap();
        assert_eq!(p.mode, StopMode::SingleLine);
        assert_eq!((p.max_lines, p.num_predict), (1, LEARNED.num_predict));
    }

    #[tokio::test]
    async fn stats_and_reset_roundtrip() {
        let f = fixture(MAIN);
        // No log: nothing to report.
        let empty = f.engine.stats().await;
        assert!(empty.languages.is_empty() && empty.log_path.is_none() && empty.adaptive);

        let log = workspace_log(&f);
        seed_learning(&log).await;
        let mut rust = outcome_record("rs", "x", LogOutcome::Partial);
        rust.lang = "rust".to_owned();
        rust.accepted_text = Some("x".to_owned());
        log.submit(rust);
        f.engine.refresh_snippets(&f.uri).await;
        serve_cached(&f, "r1", AT).await;
        // `stats` waits for outcomes still queued for the writer.
        f.engine.on_outcome("r1", LogOutcome::TypedThrough, None);

        let stats = f.engine.stats().await;
        assert_eq!(
            stats.log_path.as_deref(),
            Some(log.path().to_string_lossy().as_ref())
        );
        let py = &stats.languages["python"];
        assert_eq!(
            (
                py.served,
                py.accepted,
                py.partial,
                py.rejected,
                py.typed_through
            ),
            (31, 10, 0, 20, 1)
        );
        assert!((py.accept_rate - 10.0 / 31.0).abs() < 1e-9);
        assert_eq!(
            (py.learned_max_lines, py.learned_num_predict, py.examples),
            (4, 16, 3)
        );
        assert!(py.learned);
        let rs = &stats.languages["rust"];
        assert!(!rs.learned, "1 outcome: the configured defaults");
        assert_eq!((rs.served, rs.partial), (1, 1));
        assert!((rs.accept_rate - 1.0).abs() < 1e-9);
        assert_eq!(
            (rs.learned_max_lines, rs.learned_num_predict, rs.examples),
            (8, 32, 0)
        );
        let wire = serde_json::to_value(&stats).unwrap();
        assert_eq!(wire["languages"]["python"]["typedThrough"], 1);
        assert_eq!(wire["languages"]["python"]["learnedMaxLines"], 4);
        assert_eq!(wire["languages"]["python"]["learnedNumPredict"], 16);
        assert_eq!(wire["languages"]["python"]["examples"], 3);
        assert_eq!(wire["languages"]["python"]["learned"], true);
        assert_eq!(wire["languages"]["rust"]["learned"], false);
        assert!(wire["languages"]["python"]["acceptRate"].is_f64());
        assert!(wire["logPath"].is_string());
        assert_eq!(wire["adaptive"], true);

        // Reset: the learning view and the engine's learned cache are
        // cleared at once; the log file keeps every record.
        f.engine.reset_learning();
        let p = f.engine.prepare(&f.uri, AT).await.unwrap();
        assert!(!p.snippet_block().contains("# Example"));
        assert_eq!((p.max_lines, p.num_predict), (8, 32));
        let stats = f.engine.stats().await;
        assert!(stats.languages.is_empty(), "{:?}", stats.languages);
        assert_eq!(log.records().len(), 32);
        f.engine.refresh_snippets(&f.uri).await;
        let p = f.engine.prepare(&f.uri, AT).await.unwrap();
        assert!(!p.snippet_block().contains("# Example"));
        assert_eq!((p.max_lines, p.num_predict), (8, 32));
    }

    #[tokio::test]
    async fn every_tenth_multi_line_request_explores_the_configured_limits() {
        let f = fixture("x = foo()\nresult = \n");
        let log = workspace_log(&f);
        seed_learning(&log).await;
        f.engine.refresh_snippets(&f.uri).await;
        let multi = Position {
            line: 1,
            character: 9,
        };
        let single = Position {
            line: 0,
            character: 8,
        };
        let limits = |p: &Prepared| (p.max_lines, p.num_predict);
        let learned = (LEARNED.max_lines, LEARNED.num_predict);
        let configured = (8, Settings::default().completion_max_tokens);

        // Served multi-line requests 1–9 run with the learned cap 4.
        for i in 0..9 {
            let p = f.engine.prepare(&f.uri, multi).await.unwrap();
            assert_eq!((limits(&p), p.explore), (learned, false), "request {i}");
            serve_cached(&f, &format!("m{i}"), multi).await;
            // Single-line requests neither count nor explore.
            let p = f.engine.prepare(&f.uri, single).await.unwrap();
            assert_eq!((p.mode, p.explore), (StopMode::SingleLine, false));
        }
        // The 10th uses the configured limits (until one is served).
        for _ in 0..2 {
            let p = f.engine.prepare(&f.uri, multi).await.unwrap();
            assert_eq!((limits(&p), p.explore), (configured, true));
        }
        // A reset forgets the count along with what was learned.
        f.engine.reset_learning();
        let p = f.engine.prepare(&f.uri, multi).await.unwrap();
        assert_eq!((limits(&p), p.explore), (configured, false));
    }

    /// Serves `request_id` from a primed cache entry holding `text`.
    async fn serve_cached_text(f: &Fixture, request_id: &str, at: Position, text: &str) {
        let p = f.engine.prepare(&f.uri, at).await.unwrap();
        lock(&f.engine.inner.cache).put(&p.key.0, &p.key.1, &p.key.2, text);
        assert_eq!(serve(f, request_id, at).await, text);
    }

    /// Requests `request_id` at `at` and returns the served text.
    async fn serve(f: &Fixture, request_id: &str, at: Position) -> String {
        let params = CompletionRequestParams {
            uri: f.uri.clone(),
            position: at,
            request_id: request_id.to_owned(),
        };
        let served = f
            .engine
            .request(params, CancellationToken::new())
            .await
            .unwrap();
        served.items.into_iter().map(|i| i.text).collect()
    }

    /// The user types "t" at [`AT`] (into a suggestion starting with "t").
    const TYPED_AT: Position = Position {
        line: 3,
        character: 12,
    };

    #[tokio::test]
    async fn typed_prefix_hit_outcome_resolves_original_record() {
        for outcome in [
            LogOutcome::Accepted,
            LogOutcome::Rejected,
            LogOutcome::TypedThrough,
        ] {
            let f = fixture(MAIN);
            let log = workspace_log(&f);
            serve_cached_text(&f, "r1", AT, "t) + 1").await;
            type_char(&f, AT, 2);
            assert_eq!(serve(&f, "t1", TYPED_AT).await, ") + 1");

            // The host reports under the typed-prefix id: r1 carries it.
            f.engine.on_outcome("t1", outcome, Some(") + 1".to_owned()));
            assert_eq!(logged(&log).await, [("r1".to_owned(), outcome)]);
            let record = &log.records()[0];
            assert_eq!(record.suggestion, "t) + 1");
            let kept = (outcome == LogOutcome::Accepted).then(|| "t) + 1".to_owned());
            assert_eq!(record.accepted_text, kept, "{outcome:?}");

            // r1 is resolved: later outcomes under either id are no-ops.
            f.engine.on_outcome("t1", LogOutcome::Accepted, None);
            f.engine.on_outcome("r1", LogOutcome::Accepted, None);
            f.engine.flush_pending().await;
            assert_eq!(logged(&log).await.len(), 1, "{outcome:?}");
        }
    }

    #[tokio::test]
    async fn alias_partial_prepends_typed_prefix() {
        let f = fixture(MAIN);
        let log = workspace_log(&f);
        serve_cached_text(&f, "r1", AT, "t) + 1").await;
        type_char(&f, AT, 2);
        assert_eq!(serve(&f, "t1", TYPED_AT).await, ") + 1");
        f.engine
            .on_outcome("t1", LogOutcome::Partial, Some(")".to_owned()));
        assert_eq!(logged(&log).await, [("r1".to_owned(), LogOutcome::Partial)]);
        assert_eq!(log.records()[0].accepted_text.as_deref(), Some("t)"));
    }

    #[tokio::test]
    async fn alias_refreshes_expiry() {
        let f = fixture(MAIN);
        let log = workspace_log(&f);
        serve_cached_text(&f, "r1", AT, "t) + 1").await;
        f.engine
            .age_pending(OUTCOME_TIMEOUT - Duration::from_secs(1));
        type_char(&f, AT, 2);
        assert_eq!(serve(&f, "t1", TYPED_AT).await, ") + 1");
        f.engine.age_pending(Duration::from_secs(2));
        // 61 s after r1 was served but 2 s after the hit: still pending.
        f.engine.on_outcome("unknown", LogOutcome::Accepted, None);
        assert!(logged(&log).await.is_empty());

        f.engine.on_outcome("t1", LogOutcome::Accepted, None);
        assert_eq!(
            logged(&log).await,
            [("r1".to_owned(), LogOutcome::Accepted)]
        );
    }

    #[tokio::test]
    async fn alias_hit_revives_a_record_past_its_timeout() {
        let f = fixture(MAIN);
        let log = workspace_log(&f);
        serve_cached_text(&f, "r1", AT, "t) + 1").await;
        f.engine
            .age_pending(OUTCOME_TIMEOUT + Duration::from_secs(1));
        type_char(&f, AT, 2);
        assert_eq!(serve(&f, "t1", TYPED_AT).await, ") + 1");
        f.engine.on_outcome("t1", LogOutcome::Accepted, None);
        assert_eq!(
            logged(&log).await,
            [("r1".to_owned(), LogOutcome::Accepted)]
        );
    }

    #[tokio::test]
    async fn aliases_cleared_when_original_resolves() {
        let f = fixture(MAIN);
        let log = workspace_log(&f);
        serve_cached_text(&f, "r1", AT, "t) + 1").await;
        type_char(&f, AT, 2);
        assert_eq!(serve(&f, "t1", TYPED_AT).await, ") + 1");
        f.engine.on_outcome("r1", LogOutcome::TypedThrough, None);

        // t1 no longer resolves anything, not even a newer suggestion.
        serve_cached_text(&f, "r2", TYPED_AT, "t + 2").await;
        f.engine.on_outcome("t1", LogOutcome::Accepted, None);
        assert_eq!(
            logged(&log).await,
            [("r1".to_owned(), LogOutcome::TypedThrough)]
        );

        // Expiry clears them too: a late outcome for t2 is a no-op.
        type_char(&f, TYPED_AT, 3);
        let typed_twice = Position {
            line: 3,
            character: 13,
        };
        assert_eq!(serve(&f, "t2", typed_twice).await, " + 2");
        assert_eq!(lock(&f.engine.inner.pending)[0].aliases.len(), 1);
        f.engine.age_pending(OUTCOME_TIMEOUT);
        f.engine.on_outcome("unknown", LogOutcome::Accepted, None);
        assert!(lock(&f.engine.inner.pending).is_empty());
        f.engine.on_outcome("t2", LogOutcome::Accepted, None);
        f.engine.flush_pending().await;
        assert_eq!(
            logged(&log).await,
            [
                ("r1".to_owned(), LogOutcome::TypedThrough),
                ("r2".to_owned(), LogOutcome::Rejected)
            ]
        );
    }

    #[tokio::test]
    async fn no_exploration_when_learned_equals_configured() {
        let f = fixture("x = foo()\nresult = \n");
        let log = workspace_log(&f);
        seed_learning(&log).await;
        f.engine.refresh_snippets(&f.uri).await;
        let configured = configured(&Settings::default()).as_learned();
        for slot in lock(&f.engine.inner.snippets_by_uri).values_mut() {
            if let Some(entry) = slot.entry.as_mut() {
                entry.learned = Some(configured);
            }
        }
        let multi = Position {
            line: 1,
            character: 9,
        };
        for i in 0..adaptive::EXPLORE_EVERY + 1 {
            let p = f.engine.prepare(&f.uri, multi).await.unwrap();
            assert!(!p.explore, "request {i}");
            assert_eq!(
                (p.max_lines, p.num_predict),
                (configured.max_lines, configured.num_predict)
            );
            serve_cached(&f, &format!("m{i}"), multi).await;
        }
    }

    #[tokio::test]
    async fn odd_cursor_positions_never_panic() {
        let f = fixture(MAIN);
        for (line, character) in [(0, 0), (3, 999), (99, 0), (u32::MAX, u32::MAX)] {
            let _ = f.engine.prepare(&f.uri, Position { line, character }).await;
        }
    }
}
