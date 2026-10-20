//! Keeps a [`WorkspaceIndex`] current from filesystem events: changes are
//! debounced (300 ms of quiet) and applied as `update` / `remove` in one
//! blocking batch.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::WorkspaceIndex;

pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// Watches `root` recursively and applies changes to `index`. The watch is
/// registered before this returns, so writes made afterwards are seen.
/// Must be called within a tokio runtime; abort the handle to stop watching.
/// If the watcher cannot be created the error is logged and the task ends.
pub fn spawn(root: &Path, index: Arc<RwLock<WorkspaceIndex>>) -> JoinHandle<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<PathBuf>();
    let watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(event) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                for path in event.paths {
                    let _ = tx.send(path);
                }
            }
            Err(err) => tracing::warn!(%err, "workspace watcher error"),
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
        while let Some(first) = rx.recv().await {
            let mut batch = BTreeSet::from([first]);
            while let Ok(Some(path)) = tokio::time::timeout(DEBOUNCE, rx.recv()).await {
                batch.insert(path);
            }
            let index = index.clone();
            let applied = tokio::task::spawn_blocking(move || apply(&index, batch)).await;
            if let Err(err) = applied {
                tracing::warn!(%err, "workspace watcher: applying batch failed");
            }
        }
    })
}

fn apply(index: &RwLock<WorkspaceIndex>, batch: BTreeSet<PathBuf>) {
    let mut index = match index.write() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for path in batch {
        // `symlink_metadata` so a dangling symlink counts as gone.
        if path.symlink_metadata().is_ok() {
            index.update(&path);
        } else {
            index.remove(&path);
        }
    }
    tracing::debug!(files = index.stats().files, "workspace index updated");
}
