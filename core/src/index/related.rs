//! Related-file snippet retrieval for completion prompts.
//!
//! Ranks indexed files by their relation to the current file and the text
//! around the cursor, then excerpts the best ones within a token budget.
//! Called on open / save / periodic refresh, not per keystroke; the output is
//! a pure function of its inputs so the assembled prompt stays cache-stable.

use std::collections::HashSet;
use std::path::Path;

use super::symbols::{self, Lang};
use super::{RelPath, WorkspaceIndex};
use crate::overlay::OverlaySnapshot;
use crate::tokens;

/// Maximum lines in one snippet.
pub const MAX_SNIPPET_LINES: usize = 40;
/// Maximum number of files excerpted (and read) per call.
pub const MAX_FILES: usize = 5;
/// How many of the most recently edited files earn the recency bonus.
pub const RECENT_FILES: usize = 5;

const IMPORT_WEIGHT: f64 = 3.0;
const RECENT_WEIGHT: f64 = 2.0;
const JACCARD_WEIGHT: f64 = 10.0;

/// A raw excerpt of a related file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snippet {
    pub path: RelPath,
    pub text: String,
}

/// Up to [`MAX_FILES`] snippets from the files most related to `current`
/// (root-relative), totalling at most `budget_tokens` by
/// [`tokens::estimate`], ordered by path.
///
/// Score per indexed file (excluding `current`):
/// `3 × (imports or is imported by current) + 2 × (in the first`
/// [`RECENT_FILES`] `of recently_edited) + 10 × jaccard(identifiers(window),
/// file identifiers)`. Files scoring 0 are never used; ties break by path.
///
/// `recently_edited` is root-relative, most recent first (the caller maps
/// `DocumentStore::recently_edited` through `uri_to_path`). Only the chosen
/// files are read, through `overlay`; import resolution stats only files
/// whose import strings name `current`.
pub fn snippets(
    index: &WorkspaceIndex,
    overlay: &OverlaySnapshot,
    recently_edited: &[RelPath],
    current: &Path,
    window: &str,
    budget_tokens: usize,
) -> Vec<Snippet> {
    let window_ids = symbols::identifiers(window);
    let mut out = Vec::new();
    let mut remaining = budget_tokens;
    for (path, _) in rank(index, recently_edited, current, &window_ids) {
        if remaining == 0 || out.len() == MAX_FILES {
            break;
        }
        let Ok(text) = overlay.read(&path) else {
            continue;
        };
        let shared: HashSet<&str> = index
            .symbols(&path)
            .identifiers
            .iter()
            .filter(|id| window_ids.contains(*id))
            .map(String::as_str)
            .collect();
        let excerpt = fit(best_lines(&text, &shared), remaining);
        if excerpt.is_empty() {
            continue;
        }
        remaining -= tokens::estimate(excerpt);
        out.push(Snippet {
            path,
            text: excerpt.to_string(),
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Positive-scoring files, best first, ties by path.
fn rank(
    index: &WorkspaceIndex,
    recently_edited: &[RelPath],
    current: &Path,
    window_ids: &HashSet<String>,
) -> Vec<(RelPath, f64)> {
    let related = import_related(index, current);
    let recent: HashSet<&Path> = recently_edited
        .iter()
        .take(RECENT_FILES)
        .map(RelPath::as_path)
        .collect();
    let mut scored: Vec<(RelPath, f64)> = index
        .iter_files()
        .filter(|p| *p != current)
        .filter_map(|path| {
            let mut score = JACCARD_WEIGHT * jaccard(window_ids, &index.symbols(path).identifiers);
            if related.contains(path) {
                score += IMPORT_WEIGHT;
            }
            if recent.contains(path) {
                score += RECENT_WEIGHT;
            }
            (score > 0.0).then(|| (path.to_path_buf(), score))
        })
        .collect();
    // `iter_files` is path-sorted and the sort is stable, so ties keep path order.
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    let (small, large) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let inter = small.iter().filter(|x| large.contains(*x)).count();
    let union = a.len() + b.len() - inter;
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

/// Indexed files that `current` imports or that import `current`.
fn import_related(index: &WorkspaceIndex, current: &Path) -> HashSet<RelPath> {
    let root = index.root();
    let mut related: HashSet<RelPath> = index
        .symbols(current)
        .imports
        .iter()
        .filter_map(|imp| symbols::resolve_import(root, current, imp))
        .filter(|p| p != current && index.contains(p))
        .collect();
    // Reverse lookup. `resolve_import` stats the disk, so only resolve import
    // strings that textually name `current` (its stem, or its directory for
    // package-style / index-file modules).
    let keys = name_keys(current);
    if keys.is_empty() {
        return related;
    }
    for path in index.iter_files() {
        if path == current || related.contains(path) {
            continue;
        }
        let imports_current = index.symbols(path).imports.iter().any(|imp| {
            keys.iter().any(|k| imp.contains(k.as_str()))
                && symbols::resolve_import(root, path, imp).as_deref() == Some(current)
        });
        if imports_current {
            related.insert(path.to_path_buf());
        }
    }
    related
}

/// Substrings an import of `file` must contain to possibly resolve to it.
fn name_keys(file: &Path) -> Vec<String> {
    let name = |p: Option<&std::ffi::OsStr>| p.and_then(|s| s.to_str()).map(str::to_string);
    let stem = name(file.file_stem());
    let dir = name(file.parent().and_then(Path::file_name));
    let by_dir = matches!(
        stem.as_deref(),
        Some("mod" | "lib" | "main" | "index" | "__init__")
    ) || matches!(Lang::from_path(file), Lang::Go | Lang::Java | Lang::Kotlin);
    let mut keys: Vec<String> = stem.into_iter().collect();
    if by_dir {
        keys.extend(dir);
    }
    keys.retain(|k| !k.is_empty());
    keys
}

/// The first run of at most [`MAX_SNIPPET_LINES`] lines with the most
/// occurrences of `shared` identifiers (distinct per line); the file head if
/// none occur.
fn best_lines<'a>(text: &'a str, shared: &HashSet<&str>) -> &'a str {
    let starts: Vec<usize> = std::iter::once(0)
        .chain(text.match_indices('\n').map(|(i, _)| i + 1))
        .filter(|&i| i < text.len())
        .collect();
    let line = |i: usize| &text[starts[i]..starts.get(i + 1).copied().unwrap_or(text.len())];
    let weights: Vec<usize> = (0..starts.len())
        .map(|i| {
            if shared.is_empty() {
                0
            } else {
                symbols::identifiers(line(i))
                    .iter()
                    .filter(|id| shared.contains(id.as_str()))
                    .count()
            }
        })
        .collect();
    let n = MAX_SNIPPET_LINES.min(weights.len());
    let mut best = (0, 0);
    let mut sum: usize = weights[..n].iter().sum();
    best.1 = sum;
    for start in 1..=weights.len() - n {
        sum = sum + weights[start + n - 1] - weights[start - 1];
        if sum > best.1 {
            best = (start, sum);
        }
    }
    let begin = starts.get(best.0).copied().unwrap_or(0);
    let end = starts.get(best.0 + n).copied().unwrap_or(text.len());
    &text[begin..end]
}

/// The longest whole-line prefix of `text` within `budget` tokens; a
/// char-boundary cut of the first line if not even that fits.
fn fit(text: &str, budget: usize) -> &str {
    if tokens::estimate(text) <= budget {
        return text;
    }
    let mut end = 0;
    for (i, _) in text.match_indices('\n') {
        if tokens::estimate(&text[..=i]) > budget {
            break;
        }
        end = i + 1;
    }
    if end == 0 {
        tokens::take_first(text, budget)
    } else {
        &text[..end]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay::DocumentStore;
    use crate::tokens;
    use std::fs;
    use std::path::PathBuf;

    struct Fixture {
        _dir: tempfile::TempDir,
        index: WorkspaceIndex,
        overlay: OverlaySnapshot,
    }

    fn fixture(files: &[(&str, &str)]) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let abs = dir.path().join(path);
            fs::create_dir_all(abs.parent().unwrap()).unwrap();
            fs::write(abs, text).unwrap();
        }
        let index = WorkspaceIndex::build(dir.path());
        let overlay = DocumentStore::new(index.root().to_path_buf()).overlay_snapshot();
        Fixture {
            _dir: dir,
            index,
            overlay,
        }
    }

    fn paths(out: &[Snippet]) -> Vec<&str> {
        out.iter().map(|s| s.path.to_str().unwrap()).collect()
    }

    const MAIN: &str = "from helpers import parse_config\n\ndef run(settings):\n    return parse_config(settings.path)\n";
    const HELPERS: &str = "def parse_config(path):\n    return open(path).read()\n";
    // Shares more identifiers with the window than `helpers.py`, but has no
    // import relation with `main.py`.
    const LOOKALIKE: &str = "def run(settings):\n    settings.path = parse_config(settings.path)\n    log_event(audit_trail, verbose_flag)\n    return settings\n";

    #[test]
    fn imported_file_ranks_first() {
        let f = fixture(&[
            ("main.py", MAIN),
            ("helpers.py", HELPERS),
            ("lookalike.py", LOOKALIKE),
        ]);
        let window = "def run(settings):\n    return parse_config(settings.path)\n";
        let ids = symbols::identifiers(window);
        let sim = |t: &str| jaccard(&ids, &symbols::identifiers(t));
        assert!(
            sim(LOOKALIKE) > sim(HELPERS),
            "lookalike wins on identifiers alone"
        );

        // Roomy budget: both related files appear, ordered by path.
        let all = snippets(
            &f.index,
            &f.overlay,
            &[],
            Path::new("main.py"),
            window,
            1000,
        );
        assert_eq!(paths(&all), ["helpers.py", "lookalike.py"]);

        // A budget that fits exactly one snippet goes to the imported file.
        let budget = tokens::estimate(HELPERS);
        let top = snippets(
            &f.index,
            &f.overlay,
            &[],
            Path::new("main.py"),
            window,
            budget,
        );
        assert_eq!(paths(&top), ["helpers.py"]);
        assert_eq!(top[0].text, HELPERS);
    }

    #[test]
    fn importer_and_recent_edit_score() {
        let f = fixture(&[
            ("lib/util.py", "def shared_helper():\n    pass\n"),
            (
                "app.py",
                "from lib.util import shared_helper\nshared_helper()\n",
            ),
            ("notes.py", "unrelated_thing = 1\n"),
            ("other.py", "another_unrelated = 2\n"),
        ]);
        let recent = [PathBuf::from("notes.py")];
        let out = snippets(
            &f.index,
            &f.overlay,
            &recent,
            Path::new("lib/util.py"),
            "nothing_in_common",
            1000,
        );
        // `app.py` imports the current file; `notes.py` was recently edited;
        // `other.py` has no relation at all.
        assert_eq!(paths(&out), ["app.py", "notes.py"]);
    }

    #[test]
    fn output_is_deterministic_and_within_budget() {
        let mut files: Vec<(String, String)> = (0..12)
            .map(|i| {
                let body: String = (0..30)
                    .map(|l| format!("value_{l} = compute_total(item_{i}, shared_name)\n"))
                    .collect();
                (format!("mod_{i:02}.py"), body)
            })
            .collect();
        files.push(("main.py".into(), "import mod_03\n".into()));
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(p, t)| (p.as_str(), t.as_str()))
            .collect();
        let f = fixture(&refs);
        let recent = [PathBuf::from("mod_07.py"), PathBuf::from("mod_01.py")];
        let window = "total = compute_total(item_3, shared_name)\n";

        for budget in [0, 1, 7, 50, 120, 400] {
            let call = || {
                snippets(
                    &f.index,
                    &f.overlay,
                    &recent,
                    Path::new("main.py"),
                    window,
                    budget,
                )
            };
            let a = call();
            let b = call();
            assert_eq!(a, b, "budget {budget}");
            let used: usize = a.iter().map(|s| tokens::estimate(&s.text)).sum();
            assert!(used <= budget, "budget {budget}: used {used}");
            let joined: String = a.iter().map(|s| s.text.as_str()).collect();
            assert!(tokens::estimate(&joined) <= budget);
            assert!(
                a.windows(2).all(|w| w[0].path < w[1].path),
                "sorted by path"
            );
            assert!(a.iter().all(|s| !s.text.is_empty()));
            assert!(
                a.iter()
                    .all(|s| s.text.lines().count() <= MAX_SNIPPET_LINES)
            );
        }
        let big = snippets(
            &f.index,
            &f.overlay,
            &recent,
            Path::new("main.py"),
            window,
            400,
        );
        assert!(big.len() > 1);
        assert!(paths(&big).contains(&"mod_03.py"));
    }

    #[test]
    fn current_file_is_excluded() {
        let f = fixture(&[
            ("a.py", "import b\nshared_ident = other_ident\n"),
            ("b.py", "import a\nshared_ident = other_ident\n"),
        ]);
        let recent = [PathBuf::from("a.py")];
        let window = "shared_ident = other_ident";
        let out = snippets(
            &f.index,
            &f.overlay,
            &recent,
            Path::new("a.py"),
            window,
            1000,
        );
        assert_eq!(paths(&out), ["b.py"]);
    }

    #[test]
    fn snippet_is_the_densest_40_line_window() {
        let mut text: String = (0..100).map(|i| format!("filler_line_{i} = 0\n")).collect();
        text.push_str("target_alpha = target_beta(target_gamma)\n");
        let f = fixture(&[("main.py", "import big\n"), ("big.py", &text)]);
        let window = "target_alpha target_beta target_gamma";
        let out = snippets(
            &f.index,
            &f.overlay,
            &[],
            Path::new("main.py"),
            window,
            10_000,
        );
        assert_eq!(out.len(), 1);
        let s = &out[0].text;
        assert_eq!(s.lines().count(), MAX_SNIPPET_LINES);
        assert!(s.contains("target_alpha"));
        assert!(!s.contains("filler_line_0 "));

        // No shared identifiers: the file head.
        let head = snippets(
            &f.index,
            &f.overlay,
            &[],
            Path::new("main.py"),
            "zzz",
            10_000,
        );
        assert!(head[0].text.starts_with("filler_line_0 = 0\n"));
        assert_eq!(head[0].text.lines().count(), MAX_SNIPPET_LINES);
    }
}
