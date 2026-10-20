//! In-memory workspace index: the set of indexable files and a per-file
//! symbol summary. Built once (sync; run it in `spawn_blocking`), then kept
//! current by [`watcher`] through [`WorkspaceIndex::update`] /
//! [`WorkspaceIndex::remove`]. Shared as `Arc<std::sync::RwLock<_>>`.

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

#[derive(Debug)]
pub struct WorkspaceIndex {
    /// Canonicalized workspace root (so watcher event paths strip cleanly).
    root: PathBuf,
    entries: BTreeMap<RelPath, Entry>,
    ignore: Gitignore,
    bytes: u64,
    build_ms: u64,
    empty: FileSymbols,
}

impl WorkspaceIndex {
    /// An index with no files, for use while [`WorkspaceIndex::build`] runs.
    pub fn empty(root: &Path) -> Self {
        Self {
            root: canonical(root),
            entries: BTreeMap::new(),
            ignore: Gitignore::empty(),
            bytes: 0,
            build_ms: 0,
            empty: FileSymbols::default(),
        }
    }

    /// Walks `root` (gitignore-aware) and extracts symbols from every file.
    pub fn build(root: &Path) -> Self {
        let started = Instant::now();
        let mut index = Self::empty(root);
        index.ignore = walker::root_ignore(&index.root);
        for abs in walker::walk(&index.root) {
            if let Some(rel) = index.relativize(&abs) {
                index.load(rel, &abs);
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

    pub fn root(&self) -> &Path {
        &self.root
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

    /// (Re)indexes one file, given as an absolute or root-relative path.
    /// Removes it if it no longer qualifies (ignored, too large, binary,
    /// unreadable, or gone). A directory has every file under it (re)indexed.
    pub fn update(&mut self, path: &Path) {
        let Some(rel) = self.relativize(path) else {
            return;
        };
        self.drop_entry(&rel);
        if walker::excluded_by_path(&rel, &self.ignore) {
            return;
        }
        let abs = self.root.join(&rel);
        if abs.is_dir() {
            for file in walker::walk_from(&self.root, &abs) {
                if let Some(rel) = self.relativize(&file) {
                    self.drop_entry(&rel);
                    self.load(rel, &file);
                }
            }
        } else {
            self.load(rel, &abs);
        }
    }

    /// Removes a file, or every file under a directory.
    pub fn remove(&mut self, path: &Path) {
        let Some(rel) = self.relativize(path) else {
            return;
        };
        if self.drop_entry(&rel) {
            return;
        }
        let under: Vec<RelPath> = self
            .entries
            .range(rel.clone()..)
            .map(|(k, _)| k)
            .take_while(|k| k.starts_with(&rel))
            .cloned()
            .collect();
        for k in under {
            self.drop_entry(&k);
        }
    }

    pub fn stats(&self) -> IndexStats {
        IndexStats {
            files: self.entries.len(),
            bytes: self.bytes,
            build_ms: self.build_ms,
        }
    }

    /// Root-relative form of `path`; `None` if it lies outside the root.
    fn relativize(&self, path: &Path) -> Option<RelPath> {
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

    fn load(&mut self, rel: RelPath, abs: &Path) {
        if let Some(text) = walker::read_text(abs) {
            let symbols = FileSymbols::extract(&rel, &text);
            let bytes = text.len() as u64;
            self.bytes += bytes;
            self.entries.insert(rel, Entry { bytes, symbols });
        }
    }

    fn drop_entry(&mut self, rel: &Path) -> bool {
        match self.entries.remove(rel) {
            Some(e) => {
                self.bytes -= e.bytes;
                true
            }
            None => false,
        }
    }
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
