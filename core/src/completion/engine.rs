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
//! older than [`SNIPPET_TTL`] at request time. Between refreshes every request
//! reuses the identical snippet block, so consecutive prompts differ only in
//! the typed tail and Ollama reuses its KV cache for the shared prefix.
//!
//! **Generations** are owned by an in-flight entry, not by a requester: an
//! identical `(uri, prefix, suffix)` request joins the running generation.
//! The HTTP stream is dropped when the [`Trimmer`] stops, when the last
//! waiting requester is cancelled (or dropped), or when completions pause.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant};

use futures::StreamExt;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::cache::{self, CompletionCache};
use super::prompt::{self, FimPrompt, PREFIX_TOKENS, SUFFIX_TOKENS};
use super::stop::{self, StopMode, Trimmer};
use crate::index::related::{self, Snippet};
use crate::index::{RelPath, WorkspaceIndex};
use crate::ollama::{
    GenerateRequest, OllamaClient, OllamaError, OllamaState, OllamaStatus, Options,
};
use crate::overlay::{CursorWindow, DocumentStore, uri_to_path};
use crate::protocol::{CompletionItem, CompletionRequestParams, CompletionResult, Position, Range};
use crate::rpc::RpcError;
use crate::settings::Settings;

/// A uri's snippets are recomputed at request time once they are this old.
pub const SNIPPET_TTL: Duration = Duration::from_secs(60);
/// Documents larger than this are never completed.
pub const MAX_DOCUMENT_BYTES: usize = 1 << 20;
/// Lines around the cursor used as the retrieval window at refresh time.
pub const SNIPPET_WINDOW_LINES: usize = 40;
/// Served request ids remembered for `completion/accepted|rejected`.
const SERVED_MEMORY: usize = 64;

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
    settings: RwLock<Settings>,
    paused: AtomicBool,
    cache_enabled: AtomicBool,
    cache: Mutex<CompletionCache>,
    snippets_by_uri: Mutex<HashMap<String, SnippetEntry>>,
    /// Last requested cursor per uri: the retrieval window for refreshes.
    cursors: Mutex<HashMap<String, Position>>,
    inflight: Mutex<HashMap<Key, Flight>>,
    /// Cancellation token of every request currently being answered.
    requests: Mutex<HashMap<String, CancellationToken>>,
    /// Recently served request ids and their cache keys, oldest first.
    served: Mutex<VecDeque<(String, Key)>>,
    last_status: Mutex<Option<OllamaStatus>>,
    snippet_refreshes: AtomicUsize,
    next_flight: AtomicU64,
}

struct SnippetEntry {
    snippets: Arc<Vec<Snippet>>,
    computed_at: Instant,
}

/// A running generation that requesters wait on.
struct Flight {
    id: u64,
    waiters: usize,
    http_cancel: CancellationToken,
    result: watch::Receiver<Option<Outcome>>,
}

/// Everything a request needs before the HTTP call (the "core overhead").
pub(crate) struct Prepared {
    pub key: Key,
    pub prompt: FimPrompt,
    pub mode: StopMode,
    pub crlf: bool,
}

#[cfg(test)]
impl Prepared {
    /// The snippet block at the start of the prompt.
    fn snippet_block(&self) -> &str {
        &self.prompt.prompt[..self.prompt.prompt.len() - self.key.1.len()]
    }
}

impl CompletionEngine {
    /// `settings` is a snapshot; push later changes with
    /// [`set_settings`](Self::set_settings).
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
                settings: RwLock::new(settings),
                paused: AtomicBool::new(false),
                cache_enabled: AtomicBool::new(true),
                cache: Mutex::new(CompletionCache::new(cache::DEFAULT_CAPACITY)),
                snippets_by_uri: Mutex::new(HashMap::new()),
                cursors: Mutex::new(HashMap::new()),
                inflight: Mutex::new(HashMap::new()),
                requests: Mutex::new(HashMap::new()),
                served: Mutex::new(VecDeque::new()),
                last_status: Mutex::new(None),
                snippet_refreshes: AtomicUsize::new(0),
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
        let inner = &self.inner;
        let settings = read(&inner.settings).clone();
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
        // Chat may have started while the snippets were refreshed.
        if self.is_paused() {
            return Ok(CompletionResult::default());
        }
        let key = prepared.key.clone();

        let cached = self
            .cache_enabled()
            .then(|| lock(&inner.cache).get(&key.0, &key.1, &key.2))
            .flatten();
        let text = match cached {
            Some(text) => text,
            None => {
                let mut waiter = join_or_start(inner, prepared, &settings);
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
        remember_served(inner, &params.request_id, key);
        let at = params.position;
        Ok(CompletionResult {
            items: vec![CompletionItem {
                text,
                range: Range { start: at, end: at },
            }],
        })
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

    /// Replaces the settings snapshot used by later requests.
    pub fn set_settings(&self, settings: Settings) {
        *self
            .inner
            .settings
            .write()
            .unwrap_or_else(PoisonError::into_inner) = settings;
    }

    /// Ollama health as last observed by a completion: `Ok` after a
    /// successful generation, `Down` / `ModelMissing` after those errors;
    /// `None` before the first model call.
    pub fn last_status(&self) -> Option<OllamaStatus> {
        lock(&self.inner.last_status).clone()
    }

    /// The suggestion served for `request_id` was accepted.
    pub fn on_accepted(&self, request_id: &str) {
        take_served(&self.inner, request_id);
    }

    /// The suggestion served for `request_id` was dismissed: forget it so it
    /// is not offered again from the cache.
    pub fn on_rejected(&self, request_id: &str) {
        if let Some((uri, prefix, suffix)) = take_served(&self.inner, request_id) {
            lock(&self.inner.cache).remove(&uri, &prefix, &suffix);
        }
    }

    /// Recomputes the related snippets for `uri` (call on didOpen, didSave
    /// and watcher changes to that file). Uses the 40 lines around the last
    /// requested cursor in `uri` (the top of the file if none). No-op if the
    /// document is not open.
    pub async fn refresh_snippets(&self, uri: &str) {
        let pos = lock(&self.inner.cursors)
            .get(uri)
            .copied()
            .unwrap_or(Position {
                line: 0,
                character: 0,
            });
        let window = read(&self.inner.store).cursor_window(uri, pos, PREFIX_TOKENS, SUFFIX_TOKENS);
        let Some(window) = window else {
            return;
        };
        let budget = prompt::snippet_budget(&read(&self.inner.settings));
        refresh(&self.inner, uri, &window, budget).await;
    }

    /// Drops the cached snippets for `uri` (e.g. on didClose); the next
    /// request recomputes them.
    pub fn invalidate_snippets(&self, uri: &str) {
        lock(&self.inner.snippets_by_uri).remove(uri);
    }

    /// How many times [`related::snippets`] has run.
    pub fn snippet_refresh_count(&self) -> usize {
        self.inner.snippet_refreshes.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) async fn prepare(&self, uri: &str, position: Position) -> Option<Prepared> {
        let settings = read(&self.inner.settings).clone();
        self.prepare_with(uri, position, &settings).await
    }

    #[cfg(test)]
    fn age_snippets(&self, uri: &str, by: Duration) {
        if let Some(entry) = lock(&self.inner.snippets_by_uri).get_mut(uri) {
            entry.computed_at -= by;
        }
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
        let window =
            read(&inner.store).cursor_window(uri, position, PREFIX_TOKENS, SUFFIX_TOKENS)?;
        if window.doc_len > MAX_DOCUMENT_BYTES {
            return None;
        }
        if window
            .next_char
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return None;
        }
        lock(&inner.cursors).insert(uri.to_owned(), position);

        let budget = prompt::snippet_budget(settings);
        let fresh = lock(&inner.snippets_by_uri)
            .get(uri)
            .filter(|e| e.computed_at.elapsed() <= SNIPPET_TTL)
            .map(|e| e.snippets.clone());
        let snippets = match fresh {
            Some(snippets) => snippets,
            None => refresh(inner, uri, &window, budget).await,
        };

        let prompt = prompt::build(&snippets, &window.prefix, &window.suffix, settings);
        let mode = stop::mode_for(&window.prefix, &prompt.suffix);
        let key = (uri.to_owned(), window.prefix, prompt.suffix.clone());
        Some(Prepared {
            key,
            prompt,
            mode,
            crlf: window.crlf,
        })
    }
}

/// Computes and stores the snippets for `uri` from `window` (off the async
/// threads: it reads files). Returns the new snippets.
async fn refresh(
    inner: &Arc<Inner>,
    uri: &str,
    window: &CursorWindow,
    budget: usize,
) -> Arc<Vec<Snippet>> {
    let around = window_lines(&window.prefix, &window.suffix);
    let task_inner = inner.clone();
    let task_uri = uri.to_owned();
    let computed = tokio::task::spawn_blocking(move || {
        compute_snippets(&task_inner, &task_uri, &around, budget)
    })
    .await
    .unwrap_or_default();
    let snippets = Arc::new(computed);
    lock(&inner.snippets_by_uri).insert(
        uri.to_owned(),
        SnippetEntry {
            snippets: snippets.clone(),
            computed_at: Instant::now(),
        },
    );
    snippets
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
/// `prefix` (including the cursor line) and the first half from `suffix`.
fn window_lines(prefix: &str, suffix: &str) -> String {
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
/// starting one if there is none.
fn join_or_start(inner: &Arc<Inner>, prepared: Prepared, settings: &Settings) -> Waiter {
    let mut inflight = lock(&inner.inflight);
    if let Some(flight) = inflight.get_mut(&prepared.key) {
        flight.waiters += 1;
        return Waiter {
            inner: inner.clone(),
            key: prepared.key,
            flight: flight.id,
            result: flight.result.clone(),
        };
    }
    let id = inner.next_flight.fetch_add(1, Ordering::Relaxed);
    let http_cancel = CancellationToken::new();
    let (tx, rx) = watch::channel(None);
    inflight.insert(
        prepared.key.clone(),
        Flight {
            id,
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
            num_predict: settings.completion_max_tokens,
            temperature: 0.0,
            stop: Vec::new(),
        },
        keep_alive: Some(settings.keep_alive.clone()),
    };
    let trimmer = Trimmer::new(prepared.mode, &request.suffix.clone().unwrap_or_default())
        .with_crlf(prepared.crlf);
    let task_inner = inner.clone();
    let key = prepared.key.clone();
    tokio::spawn(async move {
        let outcome = generate(&task_inner.ollama, request, trimmer, &http_cancel).await;
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
    Waiter {
        inner: inner.clone(),
        key: prepared.key,
        flight: id,
        result: rx,
    }
}

/// Streams one generation through `trimmer`, dropping the HTTP stream as
/// soon as a stop rule fires.
async fn generate(
    ollama: &OllamaClient,
    request: GenerateRequest,
    mut trimmer: Trimmer,
    http_cancel: &CancellationToken,
) -> Outcome {
    let mut stream = ollama.generate_stream(request, http_cancel.clone()).await?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
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
            state: OllamaState::Ok,
            detail: "completion model responded".to_owned(),
        },
        Err(err @ OllamaError::Down(_)) => OllamaStatus {
            state: OllamaState::Down,
            detail: err.to_string(),
        },
        Err(err @ OllamaError::ModelMissing(_)) => OllamaStatus {
            state: OllamaState::ModelMissing,
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

fn remember_served(inner: &Inner, request_id: &str, key: Key) {
    let mut served = lock(&inner.served);
    if served.len() == SERVED_MEMORY {
        served.pop_front();
    }
    served.push_back((request_id.to_owned(), key));
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

    use super::*;
    use crate::overlay::path_to_uri;
    use crate::protocol::ContentChange;

    const UTIL: &str = "def helper_value(x):\n    return x * 2\n\n\ndef other_thing():\n    pass\n";
    const MAIN: &str = "from util import helper_value\n\nresult = helper_value(3)\nprint(resul\n";

    fn engine_over(
        root: &std::path::Path,
    ) -> (CompletionEngine, Arc<RwLock<DocumentStore>>, String) {
        std::fs::write(root.join("util.py"), UTIL).unwrap();
        std::fs::write(root.join("main.py"), MAIN).unwrap();
        let uri = path_to_uri(&root.join("main.py"));
        let mut store = DocumentStore::new(root.to_path_buf());
        store.did_open(&uri, MAIN.to_owned(), 1);
        let store = Arc::new(RwLock::new(store));
        let index = Arc::new(RwLock::new(WorkspaceIndex::build(root)));
        let ollama = OllamaClient::new("http://127.0.0.1:9".to_owned(), "30m".to_owned());
        let engine = CompletionEngine::new(ollama, store.clone(), index, Settings::default());
        (engine, store, uri)
    }

    #[tokio::test]
    async fn prompt_prefix_unchanged_across_consecutive_keystrokes() {
        let dir = tempfile::tempdir().unwrap();
        let root: PathBuf = dir.path().canonicalize().unwrap();
        let (engine, store, uri) = engine_over(&root);
        engine.refresh_snippets(&uri).await; // didOpen
        assert_eq!(engine.snippet_refresh_count(), 1);

        let at = |character| Position { line: 3, character };
        let first = engine.prepare(&uri, at(11)).await.expect("not skipped");

        // The user types `t`.
        let change = ContentChange {
            range: Some(crate::protocol::Range {
                start: at(11),
                end: at(11),
            }),
            text: "t".to_owned(),
        };
        store.write().unwrap().did_change(&uri, 2, vec![change]);
        let second = engine.prepare(&uri, at(12)).await.expect("not skipped");

        let block = first.snippet_block();
        assert!(
            block.contains("# Path: util.py\n"),
            "snippet block: {block:?}"
        );
        assert!(block.contains("def helper_value"));
        assert_eq!(block, second.snippet_block());
        assert_eq!(second.prompt.prompt, format!("{}t", first.prompt.prompt));
        assert_eq!(
            engine.snippet_refresh_count(),
            1,
            "no per-keystroke retrieval"
        );
    }

    #[tokio::test]
    async fn stale_or_missing_snippets_are_computed_at_request_time() {
        let dir = tempfile::tempdir().unwrap();
        let root: PathBuf = dir.path().canonicalize().unwrap();
        let (engine, _store, uri) = engine_over(&root);
        let pos = Position {
            line: 3,
            character: 11,
        };

        engine.prepare(&uri, pos).await.unwrap();
        assert_eq!(engine.snippet_refresh_count(), 1);
        engine.prepare(&uri, pos).await.unwrap();
        assert_eq!(engine.snippet_refresh_count(), 1);

        engine.age_snippets(&uri, SNIPPET_TTL + Duration::from_secs(1));
        engine.prepare(&uri, pos).await.unwrap();
        assert_eq!(engine.snippet_refresh_count(), 2);

        engine.invalidate_snippets(&uri);
        engine.prepare(&uri, pos).await.unwrap();
        assert_eq!(engine.snippet_refresh_count(), 3);
    }

    #[tokio::test]
    async fn odd_cursor_positions_never_panic() {
        let dir = tempfile::tempdir().unwrap();
        let root: PathBuf = dir.path().canonicalize().unwrap();
        let (engine, _store, uri) = engine_over(&root);
        for (line, character) in [(0, 0), (3, 999), (99, 0), (u32::MAX, u32::MAX)] {
            let _ = engine.prepare(&uri, Position { line, character }).await;
        }
    }
}
