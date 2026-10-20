//! Text search over indexed files (read through the overlay so unsaved edits
//! are seen) and glob-filtered file listing (index only, no I/O).

use std::path::Path;

use globset::{Glob, GlobMatcher};
use regex::Regex;

use super::{RelPath, WorkspaceIndex};
use crate::overlay::DocumentStore;

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

/// Up to `q.max_results` matching lines, in sorted-path then line order.
/// An invalid regex or glob is logged and yields no matches. Files that
/// cannot be read are skipped. Callers hold whatever lock guards `store`.
pub fn search(index: &WorkspaceIndex, store: &DocumentStore, q: SearchQuery) -> Vec<Match> {
    if q.max_results == 0 || q.query.is_empty() {
        return Vec::new();
    }
    let pattern = if q.regex {
        q.query.clone()
    } else {
        regex::escape(&q.query)
    };
    let re = match Regex::new(&pattern) {
        Ok(re) => re,
        Err(err) => {
            tracing::warn!(%err, query = %q.query, "search: invalid regex");
            return Vec::new();
        }
    };
    let Some(glob) = compile_glob(q.glob.as_deref()) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for path in index.iter_files().filter(|p| glob.matches(p)) {
        let text = match store.read(path) {
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
            if re.is_match(line) {
                out.push(Match {
                    path: path.to_path_buf(),
                    line: (i + 1) as u32,
                    text: truncate(line).to_string(),
                });
                if out.len() >= q.max_results {
                    return out;
                }
            }
        }
    }
    out
}

/// Indexed files matching `glob` (all files if `None`), sorted. An invalid
/// glob is logged and yields nothing.
pub fn list_files(index: &WorkspaceIndex, glob: Option<&str>) -> Vec<RelPath> {
    let Some(glob) = compile_glob(glob) else {
        return Vec::new();
    };
    index
        .iter_files()
        .filter(|p| glob.matches(p))
        .map(Path::to_path_buf)
        .collect()
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

fn compile_glob(glob: Option<&str>) -> Option<PathFilter> {
    match glob {
        None => Some(PathFilter::All),
        Some(g) => match Glob::new(g) {
            Ok(g) => Some(PathFilter::Glob(g.compile_matcher())),
            Err(err) => {
                tracing::warn!(%err, glob = g, "search: invalid glob");
                None
            }
        },
    }
}

fn truncate(line: &str) -> &str {
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.len() <= MAX_LINE_BYTES {
        return line;
    }
    let mut end = MAX_LINE_BYTES;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    &line[..end]
}
