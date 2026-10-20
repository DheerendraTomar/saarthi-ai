//! Workspace index: walking, import resolution, search, and the watcher.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use localpilot_core::index::search::{self, SearchQuery};
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

#[test]
fn search_literal_and_regex_with_glob_and_limit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "a.rs", "fn alpha() {}\nlet x = a.b;\nfn beta() {}\n");
    write(root, "b.py", "def alpha():\n    pass\n");
    write(root, "c.rs", "fn alpha2() {}\n");
    let index = WorkspaceIndex::build(root);
    let store = DocumentStore::new(root.to_path_buf());

    // Literal: '.' is not a wildcard.
    let hits = search::search(
        &index,
        &store,
        SearchQuery {
            query: "a.b".into(),
            regex: false,
            glob: None,
            max_results: 10,
        },
    );
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(
        (hits[0].path.as_path(), hits[0].line),
        (Path::new("a.rs"), 2)
    );
    assert_eq!(hits[0].text, "let x = a.b;");

    // Regex restricted by glob.
    let hits = search::search(
        &index,
        &store,
        SearchQuery {
            query: r"fn \w+\(".into(),
            regex: true,
            glob: Some("*.rs".into()),
            max_results: 10,
        },
    );
    let got: Vec<_> = hits.iter().map(|m| (m.path.clone(), m.line)).collect();
    assert_eq!(
        got,
        vec![(rel("a.rs"), 1), (rel("a.rs"), 3), (rel("c.rs"), 1)]
    );

    // Limit.
    let hits = search::search(
        &index,
        &store,
        SearchQuery {
            query: "alpha".into(),
            regex: false,
            glob: None,
            max_results: 2,
        },
    );
    assert_eq!(hits.len(), 2);

    // Invalid regex yields no matches rather than panicking.
    let hits = search::search(
        &index,
        &store,
        SearchQuery {
            query: "(".into(),
            regex: true,
            glob: None,
            max_results: 10,
        },
    );
    assert!(hits.is_empty());

    assert_eq!(
        search::list_files(&index, Some("*.rs")),
        vec![rel("a.rs"), rel("c.rs")]
    );
    assert_eq!(search::list_files(&index, None).len(), 3);
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

    let query = |q: &str| SearchQuery {
        query: q.into(),
        regex: false,
        glob: None,
        max_results: 10,
    };
    let hits = search::search(&index, &store, query("unsaved_marker"));
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0].line, 2);
    assert!(search::search(&index, &store, query("on_disk_marker")).is_empty());
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
