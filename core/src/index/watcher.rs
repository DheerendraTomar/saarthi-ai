//! Keeps a [`WorkspaceIndex`] current from filesystem events.
//!
//! Events for paths the index can never contain (`target/`, `node_modules/`,
//! `.git/`, hidden, root-gitignored) are dropped in the notify callback, so
//! build/install/git churn neither wakes the task nor delays real edits.
//! Pending paths live in a set (memory bounded by distinct paths). A batch is
//! applied after [`DEBOUNCE`] of quiet, or [`MAX_WAIT`] after its first event
//! if changes keep arriving. Files are read with no lock held; the index write
//! lock is taken only to swap the results in.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::{IndexFilter, WorkspaceIndex};

pub const DEBOUNCE: Duration = Duration::from_millis(300);
pub const MAX_WAIT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Pending {
    paths: Mutex<HashSet<PathBuf>>,
    /// Bumped on every accepted event; unchanged across a debounce window
    /// means "quiet".
    generation: AtomicU64,
    wake: Notify,
}

/// Watches `root` recursively and applies changes to `index`. The watch is
/// registered before this returns, so writes made afterwards are seen.
/// Must be called within a tokio runtime; abort the handle to stop watching.
/// If the watcher cannot be created the error is logged and the task ends.
pub fn spawn(root: &Path, index: Arc<RwLock<WorkspaceIndex>>) -> JoinHandle<()> {
    let filter = match index.read() {
        Ok(idx) => idx.filter().clone(),
        Err(poisoned) => poisoned.into_inner().filter().clone(),
    };
    let pending = Arc::new(Pending::default());

    let cb_filter = filter.clone();
    let cb_pending = pending.clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let event = match res {
            Ok(event) => event,
            Err(err) => {
                tracing::warn!(%err, "workspace watcher error");
                return;
            }
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let mut accepted = false;
        {
            let mut paths = lock(&cb_pending.paths);
            for path in event.paths {
                if !cb_filter.excludes(&path) {
                    paths.insert(path);
                    accepted = true;
                }
            }
        }
        if accepted {
            cb_pending.generation.fetch_add(1, Ordering::Relaxed);
            cb_pending.wake.notify_one();
        }
    })
    .and_then(|mut w| w.watch(root, RecursiveMode::Recursive).map(|()| w));

    let watcher = match watcher {
        Ok(w) => w,
        Err(err) => {
            tracing::warn!(%err, root = %root.display(), "workspace watcher unavailable");
            return tokio::spawn(async {});
        }
    };

    tokio::spawn(async move {
        // Keep the OS watch alive for the life of the task.
        let _watcher = watcher;
        loop {
            pending.wake.notified().await;
            debounce(&pending).await;
            let batch = std::mem::take(&mut *lock(&pending.paths));
            if batch.is_empty() {
                continue;
            }
            let (filter, index) = (filter.clone(), index.clone());
            let applied = tokio::task::spawn_blocking(move || apply(&filter, &index, batch)).await;
            if let Err(err) = applied {
                tracing::warn!(%err, "workspace watcher: applying batch failed");
            }
        }
    })
}

/// Returns after `DEBOUNCE` with no new events, or `MAX_WAIT` after the call.
async fn debounce(pending: &Pending) {
    let deadline = Instant::now() + MAX_WAIT;
    loop {
        let generation = pending.generation.load(Ordering::Relaxed);
        let wait = DEBOUNCE.min(deadline.saturating_duration_since(Instant::now()));
        if wait.is_zero() {
            return;
        }
        tokio::time::sleep(wait).await;
        if pending.generation.load(Ordering::Relaxed) == generation {
            return;
        }
    }
}

fn apply(filter: &IndexFilter, index: &RwLock<WorkspaceIndex>, batch: HashSet<PathBuf>) {
    // Disk I/O and parsing happen here, with no lock held.
    let changes = filter.scan(batch.iter().map(PathBuf::as_path));
    if changes.is_empty() {
        return;
    }
    let mut index = match index.write() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    index.apply(changes);
    tracing::debug!(files = index.stats().files, "workspace index updated");
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}
