//! Lightweight, regex-free symbol extraction: identifiers and import strings
//! per file, plus best-effort resolution of an import to a workspace file.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use super::RelPath;

/// Per-file symbol summary.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileSymbols {
    pub identifiers: HashSet<String>,
    /// Module/path strings as written (Python `from . import y` is recorded
    /// as `.y`).
    pub imports: Vec<String>,
}

impl FileSymbols {
    pub fn extract(path: &Path, text: &str) -> Self {
        Self {
            identifiers: identifiers(text),
            imports: imports(Lang::from_path(path), text),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lang {
    Python,
    JavaScript,
    TypeScript,
    Rust,
    Go,
    Java,
    Kotlin,
    Other,
}

impl Lang {
    pub fn from_path(path: &Path) -> Lang {
        match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
            "py" | "pyi" => Lang::Python,
            "js" | "jsx" | "mjs" | "cjs" => Lang::JavaScript,
            "ts" | "tsx" | "mts" | "cts" => Lang::TypeScript,
            "rs" => Lang::Rust,
            "go" => Lang::Go,
            "java" => Lang::Java,
            "kt" | "kts" => Lang::Kotlin,
            _ => Lang::Other,
        }
    }
}

/// Common keywords across the supported languages; never reported as
/// identifiers.
const KEYWORDS: &[&str] = &[
    "and",
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "def",
    "default",
    "del",
    "do",
    "elif",
    "else",
    "enum",
    "except",
    "export",
    "extends",
    "false",
    "final",
    "finally",
    "for",
    "from",
    "func",
    "function",
    "if",
    "impl",
    "import",
    "in",
    "interface",
    "let",
    "match",
    "mod",
    "mut",
    "new",
    "nil",
    "none",
    "not",
    "null",
    "or",
    "package",
    "pass",
    "private",
    "pub",
    "public",
    "return",
    "self",
    "static",
    "struct",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "type",
    "use",
    "var",
    "void",
    "where",
    "while",
    "with",
    "yield",
    "None",
    "True",
    "False",
    "Self",
    "fn",
    "fun",
    "val",
];

/// Every `[A-Za-z_][A-Za-z0-9_]{2,}` run in `text` that is not a keyword.
/// Single linear pass over the bytes.
pub fn identifiers(text: &str) -> HashSet<String> {
    let bytes = text.as_bytes();
    let mut out = HashSet::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_alphabetic() || b == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let word = &text[start..i];
            if word.len() >= 3 && !KEYWORDS.contains(&word) && !out.contains(word) {
                out.insert(word.to_string());
            }
        } else if b.is_ascii_digit() {
            // Skip the rest of a number-like token (`0x1f`, `1e10`, `123abc`).
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    out
}

static JS_IMPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?m)(?:\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?|\bexport\s+[\w*{}\s,$]+?\s+from\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"'\n]+)["']"#,
    )
    .expect("valid regex")
});
static GO_QUOTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""([^"\n]+)""#).expect("valid regex"));

/// Import strings in `text`, in order of appearance.
pub fn imports(lang: Lang, text: &str) -> Vec<String> {
    match lang {
        Lang::Python => python_imports(text),
        Lang::JavaScript | Lang::TypeScript => JS_IMPORT
            .captures_iter(text)
            .map(|c| c[1].to_string())
            .collect(),
        Lang::Rust => rust_imports(text),
        Lang::Go => go_imports(text),
        Lang::Java | Lang::Kotlin => jvm_imports(text),
        Lang::Other => Vec::new(),
    }
}

fn python_imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("import ") {
            for part in rest.split(',') {
                if let Some(module) = part.split_whitespace().next() {
                    out.push(module.to_string());
                }
            }
        } else if let Some(rest) = line.strip_prefix("from ") {
            let mut words = rest.split_whitespace();
            let (Some(module), Some("import")) = (words.next(), words.next()) else {
                continue;
            };
            if module.chars().all(|c| c == '.') {
                // `from . import a, b` names sibling modules.
                let names = words.collect::<Vec<_>>().join(" ");
                for name in names.trim_matches(|c| c == '(' || c == ')').split(',') {
                    if let Some(name) = name.split_whitespace().next()
                        && name != "*"
                        && name != "("
                    {
                        out.push(format!("{module}{name}"));
                    }
                }
            } else {
                out.push(module.to_string());
            }
        }
    }
    out
}

fn rust_imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let line = line
            .strip_prefix("pub ")
            .or_else(|| line.strip_prefix("pub(crate) "))
            .unwrap_or(line);
        if let Some(rest) = line.strip_prefix("mod ") {
            if let Some(name) = rest.strip_suffix(';') {
                out.push(name.trim().to_string());
            }
        } else if let Some(rest) = line.strip_prefix("use ") {
            out.push(rest.trim_end_matches(';').trim().to_string());
        }
    }
    out
}

fn go_imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_block = false;
    for line in text.lines() {
        let line = line.trim();
        if in_block {
            if line.starts_with(')') {
                in_block = false;
            } else if let Some(c) = GO_QUOTED.captures(line) {
                out.push(c[1].to_string());
            }
        } else if let Some(rest) = line.strip_prefix("import") {
            let rest = rest.trim_start();
            if rest.starts_with('(') {
                in_block = true;
            } else if let Some(c) = GO_QUOTED.captures(rest) {
                out.push(c[1].to_string());
            }
        }
    }
    out
}

fn jvm_imports(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("import ")?;
            let rest = rest.strip_prefix("static ").unwrap_or(rest);
            let path = rest.split([';', ' ']).next()?.trim();
            (!path.is_empty()).then(|| path.to_string())
        })
        .collect()
}

/// Best-effort resolution of `import` (as written in `from_file`, a
/// root-relative path) to a root-relative workspace file that exists on disk.
pub fn resolve_import(root: &Path, from_file: &Path, import: &str) -> Option<RelPath> {
    let dir = from_file.parent().unwrap_or(Path::new(""));
    let found = match Lang::from_path(from_file) {
        Lang::Python => resolve_python(root, dir, import),
        Lang::JavaScript | Lang::TypeScript => resolve_js(root, dir, import),
        Lang::Rust => resolve_rust(root, from_file, import),
        Lang::Go => resolve_package_dir(root, import.split('/'), &["go"]),
        Lang::Java | Lang::Kotlin => resolve_jvm(root, import),
        Lang::Other => None,
    }?;
    // Never escape the workspace.
    match found.components().next() {
        Some(Component::Normal(_)) => Some(found),
        _ => None,
    }
}

/// First candidate (root-relative, lexically normalized) that is a file.
fn first_file(root: &Path, candidates: impl IntoIterator<Item = PathBuf>) -> Option<RelPath> {
    candidates
        .into_iter()
        .map(|c| normalize(&c))
        .find(|c| !c.as_os_str().is_empty() && root.join(c).is_file())
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn resolve_python(root: &Path, dir: &Path, import: &str) -> Option<RelPath> {
    let dots = import.chars().take_while(|&c| c == '.').count();
    let rest = &import[dots..];
    let base = if dots == 0 {
        PathBuf::new()
    } else {
        let mut base = dir.to_path_buf();
        for _ in 1..dots {
            base.push("..");
        }
        base
    };
    let module = rest
        .split('.')
        .filter(|s| !s.is_empty())
        .fold(base, |p, s| p.join(s));
    first_file(
        root,
        [module.with_extension("py"), module.join("__init__.py")],
    )
}

const JS_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx"];

fn resolve_js(root: &Path, dir: &Path, import: &str) -> Option<RelPath> {
    if !(import.starts_with("./") || import.starts_with("../")) {
        return None;
    }
    let base = dir.join(import);
    let mut candidates = vec![base.clone()];
    for ext in JS_EXTENSIONS {
        let mut with_ext = base.clone().into_os_string();
        with_ext.push(".");
        with_ext.push(ext);
        candidates.push(with_ext.into());
    }
    for ext in JS_EXTENSIONS {
        candidates.push(base.join(format!("index.{ext}")));
    }
    first_file(root, candidates)
}

fn resolve_rust(root: &Path, from_file: &Path, import: &str) -> Option<RelPath> {
    let dir = from_file.parent().unwrap_or(Path::new(""));
    let segments: Vec<&str> = import
        .split("::")
        .map(|s| s.trim())
        .take_while(|s| !s.is_empty() && !s.starts_with('{') && *s != "*")
        .collect();
    let (base, rest) = match segments.first().copied() {
        Some("crate") => (crate_src_dir(root, dir), &segments[1..]),
        Some("self") => (module_dir(from_file), &segments[1..]),
        Some("super") => {
            let mut base = module_dir(from_file);
            let mut rest = &segments[..];
            while let Some((&"super", tail)) = rest.split_first() {
                base.pop();
                rest = tail;
            }
            (base, rest)
        }
        // `mod x;` (a bare name) lives next to / under the declaring file.
        Some(_) if segments.len() == 1 => (module_dir(from_file), &segments[..]),
        _ => return None,
    };
    // Longest prefix first: `a::b::Item` → a/b/Item.rs, a/b.rs, a.rs.
    (1..=rest.len()).rev().find_map(|n| {
        let path = rest[..n].iter().fold(base.clone(), |p, s| p.join(s));
        first_file(root, [path.with_extension("rs"), path.join("mod.rs")])
    })
}

/// Directory holding the submodules declared by `file`.
fn module_dir(file: &Path) -> PathBuf {
    let dir = file.parent().unwrap_or(Path::new("")).to_path_buf();
    match file.file_name().and_then(|n| n.to_str()) {
        Some("lib.rs" | "main.rs" | "mod.rs") => dir,
        _ => match file.file_stem() {
            Some(stem) => dir.join(stem),
            None => dir,
        },
    }
}

/// Nearest ancestor of `dir` (inclusive) containing `lib.rs` or `main.rs`;
/// falls back to `src`.
fn crate_src_dir(root: &Path, dir: &Path) -> PathBuf {
    dir.ancestors()
        .find(|d| root.join(d).join("lib.rs").is_file() || root.join(d).join("main.rs").is_file())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("src"))
}

fn resolve_jvm(root: &Path, import: &str) -> Option<RelPath> {
    let parts: Vec<&str> = import.split('.').filter(|s| *s != "*").collect();
    let class_path: PathBuf = parts.iter().collect();
    let candidates = [
        "",
        "src/main/java",
        "src/main/kotlin",
        "src/test/java",
        "src",
    ]
    .iter()
    .flat_map(|prefix| {
        ["java", "kt"].map(|ext| Path::new(prefix).join(&class_path).with_extension(ext))
    });
    first_file(root, candidates)
        .or_else(|| resolve_package_dir(root, parts.iter().copied(), &["java", "kt"]))
}

/// Package-directory heuristic: the longest trailing run of `segments` that
/// names a directory under `root` (also trying with the last segment dropped,
/// for class imports), resolved to its first source file in sorted order.
fn resolve_package_dir<'a>(
    root: &Path,
    segments: impl Iterator<Item = &'a str>,
    exts: &[&str],
) -> Option<RelPath> {
    let segments: Vec<&str> = segments.filter(|s| !s.is_empty()).collect();
    let prefixes = [segments.len(), segments.len().saturating_sub(1)];
    for end in prefixes {
        for start in 0..end {
            let rel: PathBuf = segments[start..end].iter().collect();
            if let Some(file) = first_source_file(root, &rel, exts) {
                return Some(file);
            }
        }
    }
    None
}

fn first_source_file(root: &Path, rel_dir: &Path, exts: &[&str]) -> Option<RelPath> {
    let entries = std::fs::read_dir(root.join(rel_dir)).ok()?;
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| {
            let ext = Path::new(n).extension().and_then(|e| e.to_str());
            ext.is_some_and(|e| exts.contains(&e)) && !n.ends_with("_test.go")
        })
        .collect();
    names.sort();
    names.into_iter().next().map(|n| rel_dir.join(n))
}
