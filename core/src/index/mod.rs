//! In-memory workspace index: the set of indexable files and a per-file
//! symbol summary. Built once (sync; run it in `spawn_blocking`), then kept
//! current by [`watcher`]. Shared as `Arc<std::sync::RwLock<_>>`.
//!
//! Incremental changes are two-phase so the write lock never covers disk I/O:
//! [`IndexFilter::scan`] reads and parses files with no lock held, then
//! [`WorkspaceIndex::apply`] swaps the results in.

pub mod search;
pub mod symbols;
pub mod walker;
pub mod watcher;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use ignore::gitignore::Gitignore;

pub use symbols::FileSymbols;

/// A path relative to the workspace root.
pub type RelPath = PathBuf;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IndexStats {
    pub files: usize,
    pub bytes: u64,
    pub build_ms: u64,
}

#[derive(Debug)]
struct Entry {
    bytes: u64,
    symbols: FileSymbols,
}

/// Which paths belong in the index, decided without touching the index
/// itself: canonical root plus the root `.gitignore` / `.ignore` rules.
#[derive(Debug, Clone)]
pub struct IndexFilter {
    root: PathBuf,
    ignore: Gitignore,
}

/// File changes read from disk by [`IndexFilter::scan`], ready to be applied
/// under the index write lock.
#[derive(Debug, Default)]
pub struct Changes {
    /// Files, or directories whose every file is removed.
    removed: Vec<RelPath>,
    upserted: Vec<(RelPath, Entry)>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.removed.is_empty() && self.upserted.is_empty()
    }
}

impl IndexFilter {
    pub fn new(root: &Path) -> Self {
        let root = canonical(root);
        let ignore = walker::root_ignore(&root);
        Self { root, ignore }
    }

    /// Canonicalized workspace root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Root-relative form of `path` (absolute or already relative); `None` if
    /// it lies outside the root or is the root itself.
    pub fn relativize(&self, path: &Path) -> Option<RelPath> {
        let rel = if path.is_absolute() {
            match path.strip_prefix(&self.root) {
                Ok(r) => r.to_path_buf(),
                Err(_) => canonical(path).strip_prefix(&self.root).ok()?.to_path_buf(),
            }
        } else {
            path.to_path_buf()
        };
        (!rel.as_os_str().is_empty()).then_some(rel)
    }

    /// True if `path` can never be indexed: outside the root, hidden, under an
    /// always-ignored directory, or matched by the root ignore files. No file
    /// reads; cheap enough for the watcher's event callback.
    pub fn excludes(&self, path: &Path) -> bool {
        match self.relativize(path) {
            // Treated as a file: a directory matched only by a dir-only
            // pattern (`logs/`) passes here and is rejected by `scan`.
            Some(rel) => walker::excluded_by_path(&rel, false, &self.ignore),
            None => true,
        }
    }

    /// Reads the current on-disk state of `paths` (files or directories,
    /// absolute or root-relative). Does I/O; hold no index lock while calling.
    pub fn scan<'a>(&self, paths: impl IntoIterator<Item = &'a Path>) -> Changes {
        let mut changes = Changes::default();
        for path in paths {
            let Some(rel) = self.relativize(path) else {
                continue;
            };
            let abs = self.root.join(&rel);
            let meta = abs.symlink_metadata();
            let is_dir = meta.as_ref().is_ok_and(|m| m.is_dir());
            if walker::excluded_by_path(&rel, is_dir, &self.ignore) {
                changes.removed.push(rel);
                continue;
            }
            match meta {
                Err(_) => changes.removed.push(rel),
                Ok(_) if is_dir => {
                    for file in walker::walk_from(&self.root, &abs) {
                        if let Some(rel) = self.relativize(&file)
                            && let Some(entry) = load(&rel, &file)
                        {
                            changes.upserted.push((rel, entry));
                        }
                    }
                }
                Ok(_) => match load(&rel, &abs) {
                    Some(entry) => changes.upserted.push((rel, entry)),
                    None => changes.removed.push(rel),
                },
            }
        }
        changes
    }
}

#[derive(Debug)]
pub struct WorkspaceIndex {
    filter: IndexFilter,
    entries: BTreeMap<RelPath, Entry>,
    bytes: u64,
    build_ms: u64,
    empty: FileSymbols,
}

impl WorkspaceIndex {
    /// An index with no files, for use while [`WorkspaceIndex::build`] runs.
    pub fn empty(root: &Path) -> Self {
        Self {
            filter: IndexFilter::new(root),
            entries: BTreeMap::new(),
            bytes: 0,
            build_ms: 0,
            empty: FileSymbols::default(),
        }
    }

    /// Walks `root` (gitignore-aware) and extracts symbols from every file.
    pub fn build(root: &Path) -> Self {
        let started = Instant::now();
        let mut index = Self::empty(root);
        for abs in walker::walk(&index.filter.root) {
            if let Some(rel) = index.filter.relativize(&abs)
                && let Some(entry) = load(&rel, &abs)
            {
                index.insert(rel, entry);
            }
        }
        index.build_ms = started.elapsed().as_millis() as u64;
        tracing::info!(
            files = index.entries.len(),
            bytes = index.bytes,
            ms = index.build_ms,
            "workspace index built"
        );
        index
    }

    /// Canonicalized workspace root.
    pub fn root(&self) -> &Path {
        &self.filter.root
    }

    /// The path filter, cloneable for use outside the index lock.
    pub fn filter(&self) -> &IndexFilter {
        &self.filter
    }

    /// Indexed files, sorted.
    pub fn files(&self) -> Vec<RelPath> {
        self.entries.keys().cloned().collect()
    }

    /// Iterates indexed files in sorted order without allocating.
    pub fn iter_files(&self) -> impl Iterator<Item = &Path> {
        self.entries.keys().map(PathBuf::as_path)
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.entries.contains_key(path)
    }

    /// Symbols for `path` (root-relative); empty if the file is not indexed.
    pub fn symbols(&self, path: &Path) -> &FileSymbols {
        self.entries
            .get(path)
            .map(|e| &e.symbols)
            .unwrap_or(&self.empty)
    }

    /// (Re)indexes one file or every file under a directory, given as an
    /// absolute or root-relative path. Removes it if it no longer qualifies
    /// (ignored, too large, binary, unreadable, or gone). Reads from disk
    /// while `&mut self` is held; shared callers should use
    /// [`IndexFilter::scan`] + [`WorkspaceIndex::apply`] instead.
    pub fn update(&mut self, path: &Path) {
        let changes = self.filter.scan([path]);
        self.apply(changes);
    }

    /// Removes a file, or every file under a directory.
    pub fn remove(&mut self, path: &Path) {
        if let Some(rel) = self.filter.relativize(path) {
            self.remove_rel(&rel);
        }
    }

    /// Applies changes from [`IndexFilter::scan`]. No I/O.
    pub fn apply(&mut self, changes: Changes) {
        for rel in &changes.removed {
            self.remove_rel(rel);
        }
        for (rel, entry) in changes.upserted {
            self.insert(rel, entry);
        }
    }

    pub fn stats(&self) -> IndexStats {
        IndexStats {
            files: self.entries.len(),
            bytes: self.bytes,
            build_ms: self.build_ms,
        }
    }

    fn insert(&mut self, rel: RelPath, entry: Entry) {
        self.bytes += entry.bytes;
        if let Some(old) = self.entries.insert(rel, entry) {
            self.bytes -= old.bytes;
        }
    }

    fn remove_rel(&mut self, rel: &Path) {
        if let Some(e) = self.entries.remove(rel) {
            self.bytes -= e.bytes;
            return;
        }
        let under: Vec<RelPath> = self
            .entries
            .range(rel.to_path_buf()..)
            .map(|(k, _)| k)
            .take_while(|k| k.starts_with(rel))
            .cloned()
            .collect();
        for k in under {
            if let Some(e) = self.entries.remove(&k) {
                self.bytes -= e.bytes;
            }
        }
    }
}

/// Reads and parses one file; `None` if it does not qualify.
fn load(rel: &Path, abs: &Path) -> Option<Entry> {
    let text = walker::read_text(abs)?;
    Some(Entry {
        bytes: text.len() as u64,
        symbols: FileSymbols::extract(rel, &text),
    })
}

/// Canonical form of `path`; for a path that no longer exists, its nearest
/// existing ancestor is canonicalized and the rest re-appended.
fn canonical(path: &Path) -> PathBuf {
    if let Ok(p) = path.canonicalize() {
        return p;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => canonical(parent).join(name),
        _ => path.to_path_buf(),
    }
}
