//! Which files belong in the index: the gitignore-aware walk used by `build`,
//! and the equivalent per-path filter used for incremental updates.

use std::path::{Component, Path, PathBuf};

use ignore::WalkBuilder;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

/// Directory names skipped everywhere, with or without a `.gitignore`.
pub const ALWAYS_IGNORED: &[&str] = &[
    ".git",
    ".localpilot",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
];

/// Files larger than this are not indexed.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// A file is binary if a NUL byte appears in its first `BINARY_SNIFF_BYTES`.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// Absolute paths of every candidate file under `root` (ignore rules and size
/// applied; the binary check happens in [`read_text`]).
pub fn walk(root: &Path) -> Vec<PathBuf> {
    walk_from(root, root)
}

/// Like [`walk`] but starting at `start` (a directory inside `root`); used
/// when the watcher sees a new directory.
pub fn walk_from(root: &Path, start: &Path) -> Vec<PathBuf> {
    let root = root.to_path_buf();
    let walker = WalkBuilder::new(start)
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .require_git(false)
        .follow_links(false)
        .max_filesize(Some(MAX_FILE_BYTES))
        .filter_entry(move |e| {
            // Never filter the walk root itself, even if it is named e.g. `build`.
            e.depth() == 0 || e.path() == root || !is_always_ignored(e.file_name())
        })
        .build();
    let mut out = Vec::new();
    for entry in walker {
        match entry {
            Ok(e) if e.file_type().is_some_and(|t| t.is_file()) => out.push(e.into_path()),
            Ok(_) => {}
            Err(err) => tracing::debug!(%err, "index walk: skipping entry"),
        }
    }
    out
}

fn is_always_ignored(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|n| ALWAYS_IGNORED.contains(&n))
}

/// Root-level `.gitignore` + `.ignore` matcher for incremental updates.
/// Nested ignore files are honored by the full walk only.
pub fn root_ignore(root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    for name in [".gitignore", ".ignore"] {
        let path = root.join(name);
        if path.is_file()
            && let Some(err) = builder.add(&path)
        {
            tracing::debug!(%err, path = %path.display(), "index: bad ignore file");
        }
    }
    builder.build().unwrap_or_else(|err| {
        tracing::debug!(%err, "index: ignoring root ignore files");
        Gitignore::empty()
    })
}

/// Cheap, I/O-free checks on a root-relative path: hidden or always-ignored
/// components, or a match in the root ignore files (for the path or any parent
/// directory).
pub fn excluded_by_path(rel: &Path, ignore: &Gitignore) -> bool {
    let hidden_or_ignored = rel.components().any(|c| match c {
        Component::Normal(name) => {
            is_always_ignored(name) || name.to_str().is_some_and(|n| n.starts_with('.'))
        }
        _ => true,
    });
    hidden_or_ignored || ignore.matched_path_or_any_parents(rel, false).is_ignore()
}

/// Reads `path` for indexing: `None` if it is unreadable, larger than
/// [`MAX_FILE_BYTES`], or binary (NUL byte in the first 8 KB). Invalid UTF-8 is
/// replaced lossily.
pub fn read_text(path: &Path) -> Option<String> {
    let bytes = match std::fs::metadata(path) {
        Ok(m) if m.is_file() && m.len() <= MAX_FILE_BYTES => std::fs::read(path),
        Ok(_) => return None,
        Err(err) => Err(err),
    };
    let bytes = match bytes {
        Ok(b) => b,
        Err(err) => {
            tracing::debug!(%err, path = %path.display(), "index: unreadable file");
            return None;
        }
    };
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return None;
    }
    Some(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}
