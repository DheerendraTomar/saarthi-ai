//! Text search over indexed files (read through an overlay snapshot so unsaved
//! edits are seen) and glob-filtered file listing (index only, no I/O).
//!
//! Locking: `search` needs neither the index nor the document store lock while
//! it reads files. Callers copy what they need under each lock first:
//!
//! ```ignore
//! let files = index.read().unwrap().files();
//! let overlay = store.read().unwrap().overlay_snapshot();
//! let result = search::search(&files, &overlay, query)?;
//! ```

use std::path::Path;

use globset::{Glob, GlobMatcher};
use regex::Regex;

use super::{RelPath, WorkspaceIndex};
use crate::overlay::OverlaySnapshot;

/// Longest line text returned in a [`Match`]; longer lines (minified code)
/// are truncated on a char boundary.
const MAX_LINE_BYTES: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchQuery {
    pub query: String,
    /// `false`: `query` is a literal string.
    pub regex: bool,
    /// Optional glob over root-relative paths (e.g. `*.rs`, `src/**/*.ts`).
    pub glob: Option<String>,
    pub max_results: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub path: RelPath,
    /// 1-based line number.
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchResult {
    pub matches: Vec<Match>,
    /// `true` if more matches existed beyond `max_results`.
    pub truncated: bool,
}

/// A pattern the caller (typically the model, via a tool) can fix and retry.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SearchError {
    #[error("invalid regex: {0}")]
    InvalidRegex(String),
    #[error("invalid glob: {0}")]
    InvalidGlob(String),
}

/// Up to `q.max_results` matching lines from `files`, in the given file order
/// then line order. Files that cannot be read are skipped (logged at debug).
pub fn search(
    files: &[RelPath],
    overlay: &OverlaySnapshot,
    q: SearchQuery,
) -> Result<SearchResult, SearchError> {
    let pattern = if q.regex {
        q.query.clone()
    } else {
        regex::escape(&q.query)
    };
    let re = Regex::new(&pattern).map_err(|e| SearchError::InvalidRegex(e.to_string()))?;
    let glob = compile_glob(q.glob.as_deref())?;

    let mut result = SearchResult::default();
    if q.max_results == 0 || q.query.is_empty() {
        return Ok(result);
    }
    for path in files.iter().filter(|p| glob.matches(p)) {
        let text = match overlay.read(path) {
            Ok(t) => t,
            Err(err) => {
                tracing::debug!(%err, path = %path.display(), "search: skipping unreadable file");
                continue;
            }
        };
        // Cheap whole-file reject before splitting into lines.
        if !re.is_match(&text) {
            continue;
        }
        for (i, line) in text.lines().enumerate() {
            if !re.is_match(line) {
                continue;
            }
            if result.matches.len() == q.max_results {
                result.truncated = true;
                return Ok(result);
            }
            result.matches.push(Match {
                path: path.clone(),
                line: (i + 1) as u32,
                text: truncate(line).to_string(),
            });
        }
    }
    Ok(result)
}

/// Indexed files matching `glob` (all files if `None`), sorted.
pub fn list_files(index: &WorkspaceIndex, glob: Option<&str>) -> Result<Vec<RelPath>, SearchError> {
    let glob = compile_glob(glob)?;
    Ok(index
        .iter_files()
        .filter(|p| glob.matches(p))
        .map(Path::to_path_buf)
        .collect())
}

enum PathFilter {
    All,
    Glob(GlobMatcher),
}

impl PathFilter {
    fn matches(&self, path: &Path) -> bool {
        match self {
            PathFilter::All => true,
            PathFilter::Glob(m) => m.is_match(path),
        }
    }
}

fn compile_glob(glob: Option<&str>) -> Result<PathFilter, SearchError> {
    match glob {
        None => Ok(PathFilter::All),
        Some(g) => Glob::new(g)
            .map(|g| PathFilter::Glob(g.compile_matcher()))
            .map_err(|e| SearchError::InvalidGlob(e.to_string())),
    }
}

fn truncate(line: &str) -> &str {
    if line.len() <= MAX_LINE_BYTES {
        return line;
    }
    let mut end = MAX_LINE_BYTES;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    &line[..end]
}
