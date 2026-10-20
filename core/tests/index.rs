//! Workspace index: walking, import resolution, search, and the watcher.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use localpilot_core::index::search::{self, SearchError, SearchQuery};
use localpilot_core::index::symbols::{self, Lang};
use localpilot_core::index::{WorkspaceIndex, watcher};
use localpilot_core::overlay::{DocumentStore, path_to_uri};

fn write(root: &Path, rel: &str, contents: impl AsRef<[u8]>) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn rel(s: &str) -> PathBuf {
    PathBuf::from(s)
}

#[test]
fn build_respects_gitignore_and_size_limit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, ".gitignore", "ignored/\n");
    write(root, "src/main.rs", "fn main() { hello_world(); }\n");
    write(root, "ignored/secret.rs", "fn secret() {}\n");
    write(root, "big.txt", vec![b'a'; 2 * 1024 * 1024]);
    write(root, "blob.bin", b"abc\0def");
    write(root, "node_modules/dep/index.js", "module.exports = 1;\n");
    write(root, "target/debug/out.rs", "fn built() {}\n");
    write(root, ".hidden/x.rs", "fn hidden() {}\n");

    let index = WorkspaceIndex::build(root);
    let files = index.files();

    assert!(files.contains(&rel("src/main.rs")), "{files:?}");
    for excluded in [
        "ignored/secret.rs",
        "big.txt",
        "blob.bin",
        "node_modules/dep/index.js",
        "target/debug/out.rs",
        ".hidden/x.rs",
    ] {
        assert!(
            !files.contains(&rel(excluded)),
            "{excluded} indexed: {files:?}"
        );
    }
    assert!(
        index
            .symbols(Path::new("src/main.rs"))
            .identifiers
            .contains("hello_world")
    );
    let stats = index.stats();
    assert_eq!(stats.files, files.len());
    assert!(stats.bytes > 0);

    // Incremental updates apply the same filters.
    write(root, "ignored/later.rs", "fn later() {}\n");
    write(root, "src/lib.rs", "pub fn lib_fn() {}\n");
    let mut index = index;
    index.update(&root.join("ignored/later.rs"));
    // A directory event for a dir-only pattern (`ignored/`) must not walk it.
    index.update(&root.join("ignored"));
    index.update(Path::new("src/lib.rs"));
    assert!(!index.files().contains(&rel("ignored/later.rs")));
    assert!(index.files().contains(&rel("src/lib.rs")));
    index.remove(Path::new("src/lib.rs"));
    assert!(!index.files().contains(&rel("src/lib.rs")));
}

#[test]
fn python_imports_resolve_to_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "pkg/__init__.py", "");
    write(root, "pkg/util.py", "def x(): pass\n");
    write(root, "app/y.py", "Y = 1\n");
    let main = "from pkg.util import x\nfrom . import y\nimport os, pkg\n";
    write(root, "app/main.py", main);

    let imports = symbols::imports(Lang::Python, main);
    assert!(imports.contains(&"pkg.util".to_string()), "{imports:?}");
    assert!(imports.contains(&".y".to_string()), "{imports:?}");
    assert!(imports.contains(&"os".to_string()), "{imports:?}");

    let from = Path::new("app/main.py");
    assert_eq!(
        symbols::resolve_import(root, from, "pkg.util"),
        Some(rel("pkg/util.py"))
    );
    assert_eq!(
        symbols::resolve_import(root, from, ".y"),
        Some(rel("app/y.py"))
    );
    assert_eq!(
        symbols::resolve_import(root, from, "pkg"),
        Some(rel("pkg/__init__.py"))
    );
    assert_eq!(symbols::resolve_import(root, from, "os"), None);

    let index = WorkspaceIndex::build(root);
    assert_eq!(index.symbols(from).imports, imports);
}

#[test]
fn ts_relative_import_resolves_index_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "src/components/index.tsx",
        "export const Button = 1;\n",
    );
    write(root, "src/util.ts", "export const u = 1;\n");
    let app = "import { Button } from './components';\nimport * as u from \"./util\";\nimport React from 'react';\n";
    write(root, "src/app.ts", app);

    assert_eq!(Lang::from_path(Path::new("src/app.ts")), Lang::TypeScript);
    let imports = symbols::imports(Lang::TypeScript, app);
    assert_eq!(imports, vec!["./components", "./util", "react"]);

    let from = Path::new("src/app.ts");
    assert_eq!(
        symbols::resolve_import(root, from, "./components"),
        Some(rel("src/components/index.tsx"))
    );
    assert_eq!(
        symbols::resolve_import(root, from, "./util"),
        Some(rel("src/util.ts"))
    );
    assert_eq!(symbols::resolve_import(root, from, "react"), None);
}

#[test]
fn rust_and_go_imports_resolve() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(
        root,
        "src/lib.rs",
        "mod net;\nuse crate::net::http::Client;\n",
    );
    write(root, "src/net/mod.rs", "pub mod http;\n");
    write(root, "src/net/http.rs", "pub struct Client;\n");
    write(root, "pkg/store/store.go", "package store\n");
    let go = "package main\n\nimport (\n\t\"fmt\"\n\t\"example.com/app/pkg/store\"\n)\n";
    write(root, "cmd/main.go", go);

    let rs = symbols::imports(Lang::Rust, "mod net;\nuse crate::net::http::Client;\n");
    assert_eq!(rs, vec!["net", "crate::net::http::Client"]);
    let lib = Path::new("src/lib.rs");
    assert_eq!(
        symbols::resolve_import(root, lib, "net"),
        Some(rel("src/net/mod.rs"))
    );
    assert_eq!(
        symbols::resolve_import(root, lib, "crate::net::http::Client"),
        Some(rel("src/net/http.rs"))
    );
    assert_eq!(
        symbols::resolve_import(root, Path::new("src/net/mod.rs"), "http"),
        Some(rel("src/net/http.rs"))
    );

    let imports = symbols::imports(Lang::Go, go);
    assert_eq!(imports, vec!["fmt", "example.com/app/pkg/store"]);
    assert_eq!(
        symbols::resolve_import(root, Path::new("cmd/main.go"), "example.com/app/pkg/store"),
        Some(rel("pkg/store/store.go"))
    );
}

fn query(q: &str, regex: bool, glob: Option<&str>, max_results: usize) -> SearchQuery {
    SearchQuery {
        query: q.into(),
        regex,
        glob: glob.map(Into::into),
        max_results,
    }
}

#[test]
fn search_literal_and_regex_with_glob_and_limit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "a.rs", "fn alpha() {}\nlet x = a.b;\nfn beta() {}\n");
    write(root, "b.py", "def alpha():\n    pass\n");
    write(root, "c.rs", "fn alpha2() {}\n");
    let index = WorkspaceIndex::build(root);
    let files = index.files();
    let overlay = DocumentStore::new(root.to_path_buf()).overlay_snapshot();

    // Literal: '.' is not a wildcard.
    let res = search::search(&files, &overlay, query("a.b", false, None, 10)).unwrap();
    assert!(!res.truncated);
    assert_eq!(res.matches.len(), 1, "{res:?}");
    let m = &res.matches[0];
    assert_eq!((m.path.as_path(), m.line), (Path::new("a.rs"), 2));
    assert_eq!(m.text, "let x = a.b;");

    // Regex restricted by glob.
    let res = search::search(&files, &overlay, query(r"fn \w+\(", true, Some("*.rs"), 10)).unwrap();
    let got: Vec<_> = res
        .matches
        .iter()
        .map(|m| (m.path.clone(), m.line))
        .collect();
    assert_eq!(
        got,
        vec![(rel("a.rs"), 1), (rel("a.rs"), 3), (rel("c.rs"), 1)]
    );
    assert!(!res.truncated);

    // Limit: 3 matches exist, 2 returned and flagged truncated.
    let res = search::search(&files, &overlay, query("alpha", false, None, 2)).unwrap();
    assert_eq!(res.matches.len(), 2);
    assert!(res.truncated);
    // Exactly at the limit is not truncated.
    let res = search::search(&files, &overlay, query("alpha", false, None, 3)).unwrap();
    assert_eq!(res.matches.len(), 3);
    assert!(!res.truncated);

    // Bad patterns are descriptive errors, not empty results.
    assert!(matches!(
        search::search(&files, &overlay, query("(", true, None, 10)),
        Err(SearchError::InvalidRegex(msg)) if !msg.is_empty()
    ));
    assert!(matches!(
        search::search(&files, &overlay, query("x", false, Some("a[b"), 10)),
        Err(SearchError::InvalidGlob(_))
    ));
    assert!(matches!(
        search::list_files(&index, Some("a[b")),
        Err(SearchError::InvalidGlob(_))
    ));

    assert_eq!(
        search::list_files(&index, Some("*.rs")).unwrap(),
        vec![rel("a.rs"), rel("c.rs")]
    );
    assert_eq!(search::list_files(&index, None).unwrap().len(), 3);
}

#[test]
fn search_anchors_match_line_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "lib.rs", "//! doc\nuse std::io;\nfn foo\n");
    write(root, "win.rs", "// x\r\nuse std::fs;\r\nlet foo\r\n");
    let index = WorkspaceIndex::build(root);
    let files = index.files();
    let overlay = DocumentStore::new(root.to_path_buf()).overlay_snapshot();

    // `^` anchors to each line, not just the file's first line.
    let res = search::search(&files, &overlay, query("^use ", true, None, 10)).unwrap();
    let got: Vec<_> = res
        .matches
        .iter()
        .map(|m| (m.path.clone(), m.line))
        .collect();
    assert_eq!(got, vec![(rel("lib.rs"), 2), (rel("win.rs"), 2)]);

    // `$` anchors to line ends, including in files that end with a newline
    // and files with CRLF line endings.
    let res = search::search(&files, &overlay, query("foo$", true, None, 10)).unwrap();
    let got: Vec<_> = res
        .matches
        .iter()
        .map(|m| (m.path.clone(), m.line))
        .collect();
    assert_eq!(got, vec![(rel("lib.rs"), 3), (rel("win.rs"), 3)]);
}

#[test]
fn search_sees_overlay_content() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "src/note.txt", "on_disk_marker\n");
    let index = WorkspaceIndex::build(root);
    let mut store = DocumentStore::new(root.to_path_buf());
    store.did_open(
        &path_to_uri(&root.join("src/note.txt")),
        "first\nunsaved_marker\n".into(),
        1,
    );
    // The store is only needed to take the snapshot; search runs without it.
    let overlay = store.overlay_snapshot();
    drop(store);
    let files = index.files();

    let res = search::search(&files, &overlay, query("unsaved_marker", false, None, 10)).unwrap();
    assert_eq!(res.matches.len(), 1, "{res:?}");
    assert_eq!(res.matches[0].line, 2);
    let res = search::search(&files, &overlay, query("on_disk_marker", false, None, 10)).unwrap();
    assert!(res.matches.is_empty());
}

#[tokio::test]
async fn watcher_picks_up_new_file() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    write(&root, "existing.rs", "fn existing() {}\n");
    let index = Arc::new(RwLock::new(WorkspaceIndex::build(&root)));
    let handle = watcher::spawn(&root, index.clone());

    write(&root, "src/fresh.rs", "fn fresh_symbol() {}\n");
    fs::remove_file(root.join("existing.rs")).unwrap();

    let target = rel("src/fresh.rs");
    let seen = tokio::time::timeout(Duration::from_millis(1500), async {
        loop {
            {
                let idx = index.read().unwrap();
                if idx.files().contains(&target) && !idx.files().contains(&rel("existing.rs")) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    assert!(seen.is_ok(), "files: {:?}", index.read().unwrap().files());
    assert!(
        index
            .read()
            .unwrap()
            .symbols(&target)
            .identifiers
            .contains("fresh_symbol")
    );
    handle.abort();
}

/// Changes the watcher applies while a background build runs are replayed
/// onto the built index before it replaces the current one.
#[tokio::test]
async fn install_build_replays_changes_made_during_the_build() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    write(&root, "existing.rs", "fn existing() {}\n");
    write(&root, "edited.rs", "fn old_name() {}\n");
    // What a build walker read before the changes below: stale once they land.
    let stale = WorkspaceIndex::build(&root);

    let index = Arc::new(RwLock::new(WorkspaceIndex::empty(&root)));
    let log = watcher::build_log();
    let handle = watcher::spawn_logging(&root, index.clone(), log.clone());

    write(&root, "src/fresh.rs", "fn fresh_symbol() {}\n");
    write(&root, "edited.rs", "fn new_name() {}\n");
    fs::remove_file(root.join("existing.rs")).unwrap();
    // Wait until the watcher has applied them to the (pre-build) index.
    let applied = wait_for(&index, Duration::from_secs(5), |idx| {
        idx.files().contains(&rel("src/fresh.rs"))
            && idx
                .symbols(Path::new("edited.rs"))
                .identifiers
                .contains("new_name")
    })
    .await;
    assert!(applied, "files: {:?}", index.read().unwrap().files());

    watcher::install_build(&index, stale, &log);
    {
        let idx = index.read().unwrap();
        let files = idx.files();
        assert!(files.contains(&rel("src/fresh.rs")), "{files:?}");
        assert!(!files.contains(&rel("existing.rs")), "ghost: {files:?}");
        let edited = &idx.symbols(Path::new("edited.rs")).identifiers;
        assert!(edited.contains("new_name") && !edited.contains("old_name"));
    }
    assert!(log.lock().unwrap().is_none(), "the log ends with the build");

    // Afterwards, changes go straight to the installed index.
    write(&root, "later.rs", "fn later() {}\n");
    let later = wait_for(&index, Duration::from_secs(5), |idx| {
        idx.files().contains(&rel("later.rs"))
    })
    .await;
    assert!(later, "files: {:?}", index.read().unwrap().files());
    handle.abort();
}

/// Rewrites `rels` under `root` every 20 ms until `stop` is set.
fn churn(
    root: PathBuf,
    rels: &'static [&'static str],
    stop: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut i = 0u64;
        while !stop.load(Ordering::Relaxed) {
            for r in rels {
                write(&root, r, format!("// churn {i}\n"));
            }
            i += 1;
            std::thread::sleep(Duration::from_millis(20));
        }
    })
}

/// Polls `index` every 25 ms until `done` holds or `limit` passes.
async fn wait_for(
    index: &Arc<RwLock<WorkspaceIndex>>,
    limit: Duration,
    done: impl Fn(&WorkspaceIndex) -> bool,
) -> bool {
    tokio::time::timeout(limit, async {
        while !done(&index.read().unwrap()) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn watcher_ignored_churn_does_not_delay_real_edit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    write(&root, ".gitignore", "logs/\n");
    write(&root, "main.rs", "fn main() {}\n");
    let index = Arc::new(RwLock::new(WorkspaceIndex::build(&root)));
    let handle = watcher::spawn(&root, index.clone());

    let stop = Arc::new(AtomicBool::new(false));
    let churner = churn(
        root.clone(),
        &[
            "target/debug/out.rs",
            "node_modules/dep/index.js",
            ".git/index",
            "logs/app.log",
        ],
        stop.clone(),
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    write(&root, "real.rs", "fn real_edit() {}\n");

    // Well under MAX_WAIT: only filtering (not the cap) can make this pass
    // while the churn continues.
    assert!(watcher::MAX_WAIT > Duration::from_millis(1500));
    let seen = wait_for(&index, Duration::from_millis(1500), |i| {
        i.contains(Path::new("real.rs"))
    })
    .await;
    stop.store(true, Ordering::Relaxed);
    churner.join().unwrap();
    assert!(seen, "files: {:?}", index.read().unwrap().files());
    assert_eq!(
        index.read().unwrap().files(),
        vec![rel("main.rs"), rel("real.rs")]
    );
    handle.abort();
}

#[tokio::test]
async fn watcher_flushes_within_max_wait_under_constant_churn() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let index = Arc::new(RwLock::new(WorkspaceIndex::build(&root)));
    let handle = watcher::spawn(&root, index.clone());

    // A non-ignored file rewritten every 20 ms never lets the debounce go quiet.
    let stop = Arc::new(AtomicBool::new(false));
    let churner = churn(root.clone(), &["hot.rs"], stop.clone());
    tokio::time::sleep(Duration::from_millis(100)).await;
    write(&root, "real.rs", "fn real_edit() {}\n");

    let limit = watcher::MAX_WAIT + Duration::from_millis(1000);
    let seen = wait_for(&index, limit, |i| i.contains(Path::new("real.rs"))).await;
    stop.store(true, Ordering::Relaxed);
    churner.join().unwrap();
    assert!(seen, "files: {:?}", index.read().unwrap().files());
    handle.abort();
}
