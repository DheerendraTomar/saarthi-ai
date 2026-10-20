//! The agent's tools (spec §7.2): schemas offered to the model, argument
//! parsing, workspace confinement, and the read-only tools.
//!
//! The read-only tools are synchronous and take what they need by value or
//! reference (an [`OverlaySnapshot`], a file list), so callers copy it out
//! from under the store/index locks first and run them lock-free.

use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::index::search::{self, SearchQuery};
use crate::index::walker::MAX_FILE_BYTES;
use crate::index::{RelPath, WorkspaceIndex};
use crate::ollama::ToolSpec;
use crate::overlay::OverlaySnapshot;
use crate::protocol::RunCommandResult;

pub const READ_FILE: &str = "read_file";
pub const LIST_FILES: &str = "list_files";
pub const SEARCH: &str = "search";
pub const EDIT_FILE: &str = "edit_file";
pub const CREATE_FILE: &str = "create_file";
pub const RUN_COMMAND: &str = "run_command";

/// Longest `read_file` output; longer reads are cut at a line boundary.
const MAX_READ_BYTES: usize = 32 * 1024;
/// Most paths `list_files` returns.
const MAX_LISTED_FILES: usize = 1000;
const DEFAULT_SEARCH_RESULTS: usize = 50;
const MAX_SEARCH_RESULTS: usize = 200;
/// Per-stream cap on `run_command` stdout / stderr.
pub const MAX_COMMAND_OUTPUT_BYTES: usize = 16 * 1024;

/// A tool failure, reported back to the model as text so it can retry.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ToolError {
    #[error(
        "unknown tool {0:?}; available tools: read_file, list_files, search, edit_file, create_file, run_command"
    )]
    UnknownTool(String),
    #[error("missing required argument {0:?}")]
    MissingArg(&'static str),
    #[error("invalid argument {0:?}: {1}")]
    InvalidArg(&'static str, String),
    #[error("path {0:?} is outside the workspace")]
    OutsideWorkspace(String),
    #[error("path {0:?} is under {1}, which the agent may not write to")]
    Protected(String, &'static str),
    #[error("{0}")]
    Failed(String),
}

/// The tools offered to the model, with JSON-Schema parameters.
pub fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec::function(
            READ_FILE,
            "Read a workspace file (including unsaved editor changes). Optionally only lines startLine..=endLine (1-based).",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path relative to the workspace root"},
                    "startLine": {"type": "integer", "description": "First line to read (1-based)"},
                    "endLine": {"type": "integer", "description": "Last line to read (inclusive)"}
                },
                "required": ["path"]
            }),
        ),
        ToolSpec::function(
            LIST_FILES,
            "List workspace files, optionally filtered by a glob such as `src/**/*.rs`.",
            json!({
                "type": "object",
                "properties": {
                    "glob": {"type": "string", "description": "Glob over workspace-relative paths"}
                }
            }),
        ),
        ToolSpec::function(
            SEARCH,
            "Search workspace files for a literal string (or a regex with regex: true). Returns path:line: text.",
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text to find"},
                    "glob": {"type": "string", "description": "Only search paths matching this glob"},
                    "maxResults": {"type": "integer", "description": "Maximum matches to return (default 50)"},
                    "regex": {"type": "boolean", "description": "Treat query as a regular expression"}
                },
                "required": ["query"]
            }),
        ),
        ToolSpec::function(
            EDIT_FILE,
            "Replace the text `old` with `new` in a file. `old` must be copied exactly from the file and match exactly one place; include a few surrounding lines to make it unique. Requires user approval.",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path relative to the workspace root"},
                    "old": {"type": "string", "description": "Exact existing text to replace"},
                    "new": {"type": "string", "description": "Replacement text"}
                },
                "required": ["path", "old", "new"]
            }),
        ),
        ToolSpec::function(
            CREATE_FILE,
            "Create a new file with the given content. Fails if the file exists. Requires user approval.",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path relative to the workspace root"},
                    "content": {"type": "string", "description": "Full file content"}
                },
                "required": ["path", "content"]
            }),
        ),
        ToolSpec::function(
            RUN_COMMAND,
            "Run a shell command in the IDE and return its exit code and output. Requires user approval.",
            json!({
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command line to run"},
                    "cwd": {"type": "string", "description": "Working directory relative to the workspace root"}
                },
                "required": ["command"]
            }),
        ),
    ]
}

/// Whether the tool needs the user's approval before it runs.
pub fn requires_approval(name: &str) -> bool {
    matches!(name, EDIT_FILE | CREATE_FILE | RUN_COMMAND)
}

/// Resolves `path` (relative to `root`, or absolute) to an absolute path
/// inside the canonicalized `root`.
///
/// Rejects any `..` component, absolute paths outside the root, and paths
/// whose nearest existing ancestor resolves (through symlinks) outside the
/// root — so a not-yet-existing file is confined too. Dangling symlinks on
/// the way are rejected.
pub fn confine(root: &Path, path: &str) -> Result<PathBuf, ToolError> {
    let escape = || ToolError::OutsideWorkspace(path.to_owned());
    if path.trim().is_empty() {
        return Err(ToolError::InvalidArg("path", "must not be empty".into()));
    }
    let root = root
        .canonicalize()
        .map_err(|e| ToolError::Failed(format!("workspace root {}: {e}", root.display())))?;
    let requested = Path::new(path);
    if requested.components().any(|c| c == Component::ParentDir) {
        return Err(escape());
    }
    let cleaned: PathBuf = requested
        .components()
        .filter(|c| *c != Component::CurDir)
        .collect();
    let joined = root.join(cleaned);

    let mut existing = joined.as_path();
    let mut missing = Vec::new();
    let resolved = loop {
        match existing.canonicalize() {
            Ok(canonical) => break canonical,
            Err(_) if existing.symlink_metadata().is_ok() => return Err(escape()),
            Err(_) => {
                let (Some(name), Some(parent)) = (existing.file_name(), existing.parent()) else {
                    return Err(escape());
                };
                missing.push(name);
                existing = parent;
            }
        }
    };
    let mut out = resolved;
    out.extend(missing.iter().rev());
    if out.starts_with(&root) {
        Ok(out)
    } else {
        Err(escape())
    }
}

/// Directories the agent's write tools never touch: git internals (a write
/// to `.git/hooks` would run code) and the core's own state (sessions, log).
/// Matched against every path component, case-insensitively (macOS and
/// Windows file systems usually are).
const PROTECTED_DIRS: [&str; 2] = [".git", ".localpilot"];

/// [`confine`] for `edit_file` / `create_file`: additionally rejects paths
/// under a [`PROTECTED_DIRS`] directory. Checked on the resolved path, so a
/// symlink into `.git` is caught too.
pub fn confine_writable(root: &Path, path: &str) -> Result<PathBuf, ToolError> {
    let abs = confine(root, path)?;
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let rel = abs.strip_prefix(&canonical_root).unwrap_or(&abs);
    for component in rel.components() {
        let Component::Normal(name) = component else {
            continue;
        };
        let name = name.to_string_lossy();
        if let Some(dir) = PROTECTED_DIRS
            .iter()
            .find(|dir| name.eq_ignore_ascii_case(dir))
        {
            return Err(ToolError::Protected(path.to_owned(), dir));
        }
    }
    Ok(abs)
}

/// A parsed tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tool {
    ReadFile {
        path: String,
        start_line: Option<usize>,
        end_line: Option<usize>,
    },
    ListFiles {
        glob: Option<String>,
    },
    Search {
        query: String,
        glob: Option<String>,
        max_results: Option<usize>,
        regex: bool,
    },
    EditFile {
        path: String,
        old: String,
        new: String,
    },
    CreateFile {
        path: String,
        content: String,
    },
    RunCommand {
        command: String,
        cwd: Option<String>,
    },
}

impl Tool {
    /// Parses the model's arguments for tool `name`. Accepts camelCase or
    /// snake_case keys, numbers as JSON numbers or numeric strings, and the
    /// whole arguments object JSON-encoded as a string.
    pub fn parse(name: &str, args: &Value) -> Result<Tool, ToolError> {
        let args = Args::new(args)?;
        Ok(match name {
            READ_FILE => Tool::ReadFile {
                path: args.required("path")?,
                start_line: args.number(&["startLine", "start_line"])?,
                end_line: args.number(&["endLine", "end_line"])?,
            },
            LIST_FILES => Tool::ListFiles {
                glob: args.string(&["glob"])?,
            },
            SEARCH => Tool::Search {
                query: args.required("query")?,
                glob: args.string(&["glob"])?,
                max_results: args.number(&["maxResults", "max_results"])?,
                regex: args.flag("regex")?,
            },
            EDIT_FILE => Tool::EditFile {
                path: args.required("path")?,
                old: args.required("old")?,
                new: args.required("new")?,
            },
            CREATE_FILE => Tool::CreateFile {
                path: args.required("path")?,
                content: args.required("content")?,
            },
            RUN_COMMAND => Tool::RunCommand {
                command: args.required("command")?,
                cwd: args.string(&["cwd"])?,
            },
            other => return Err(ToolError::UnknownTool(other.to_owned())),
        })
    }
}

struct Args(Map<String, Value>);

impl Args {
    fn new(args: &Value) -> Result<Self, ToolError> {
        let invalid = |why: &str| ToolError::InvalidArg("arguments", why.to_owned());
        match args {
            Value::Object(map) => Ok(Args(map.clone())),
            Value::Null => Ok(Args(Map::new())),
            Value::String(text) => match serde_json::from_str(text) {
                Ok(Value::Object(map)) => Ok(Args(map)),
                _ => Err(invalid("expected a JSON object")),
            },
            _ => Err(invalid("expected a JSON object")),
        }
    }

    fn get(&self, keys: &[&'static str]) -> Option<&Value> {
        keys.iter()
            .find_map(|k| self.0.get(*k))
            .filter(|v| !v.is_null())
    }

    fn string(&self, keys: &[&'static str]) -> Result<Option<String>, ToolError> {
        match self.get(keys) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(other) => Err(ToolError::InvalidArg(
                keys[0],
                format!("expected a string, got {other}"),
            )),
        }
    }

    fn required(&self, key: &'static str) -> Result<String, ToolError> {
        self.string(&[key])?.ok_or(ToolError::MissingArg(key))
    }

    fn number(&self, keys: &[&'static str]) -> Result<Option<usize>, ToolError> {
        let invalid = |v: &Value| {
            ToolError::InvalidArg(keys[0], format!("expected a non-negative integer, got {v}"))
        };
        match self.get(keys) {
            None => Ok(None),
            Some(v @ Value::Number(n)) => n
                .as_u64()
                .map(|n| Some(n as usize))
                .ok_or_else(|| invalid(v)),
            Some(v @ Value::String(s)) => s.trim().parse().map(Some).map_err(|_| invalid(v)),
            Some(v) => Err(invalid(v)),
        }
    }

    fn flag(&self, key: &'static str) -> Result<bool, ToolError> {
        match self.get(&[key]) {
            None => Ok(false),
            Some(Value::Bool(b)) => Ok(*b),
            Some(Value::String(s)) if s == "true" || s == "false" => Ok(s == "true"),
            Some(v) => Err(ToolError::InvalidArg(
                key,
                format!("expected a boolean, got {v}"),
            )),
        }
    }
}

/// A successful tool result: `content` goes to the model, `summary` to the
/// chat UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub content: String,
    pub summary: String,
}

/// Workspace-relative display form of `path`, with `/` separators.
pub(crate) fn display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// `read_file`: the file's text from the overlay snapshot (or disk), lines
/// `start_line..=end_line` (1-based, inclusive) if given, capped at 32 KiB.
/// Files on disk over [`MAX_FILE_BYTES`] (the index's limit) are refused
/// without being read.
pub fn read_file(
    overlay: &OverlaySnapshot,
    root: &Path,
    path: &str,
    start_line: Option<usize>,
    end_line: Option<usize>,
) -> Result<ToolOutput, ToolError> {
    let abs = confine(root, path)?;
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let rel = abs
        .strip_prefix(&canonical_root)
        .unwrap_or(&abs)
        .to_path_buf();
    let text = overlay
        .read_capped(&rel, MAX_FILE_BYTES)
        .map_err(|e| ToolError::Failed(format!("cannot read {path}: {e}")))?;
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let total = lines.len();
    let name = display(&rel);
    if total == 0 {
        return Ok(ToolOutput {
            content: format!("{name} is empty."),
            summary: format!("Read {name} (empty)"),
        });
    }
    let first = start_line.unwrap_or(1).max(1);
    let last = end_line.unwrap_or(total).min(total);
    if first > total {
        return Err(ToolError::InvalidArg(
            "startLine",
            format!("{first} is past the end of {name} ({total} lines)"),
        ));
    }
    if last < first {
        return Err(ToolError::InvalidArg(
            "endLine",
            format!("{last} is before startLine {first}"),
        ));
    }
    let mut body = String::new();
    let mut shown = first - 1;
    let mut cut_line = false;
    for line in &lines[first - 1..last] {
        if body.len() + line.len() > MAX_READ_BYTES {
            if body.is_empty() {
                // A single huge line (minified code): keep its head.
                let mut end = MAX_READ_BYTES;
                while !line.is_char_boundary(end) {
                    end -= 1;
                }
                body.push_str(&line[..end]);
                shown += 1;
                cut_line = true;
            }
            break;
        }
        body.push_str(line);
        shown += 1;
    }
    let mut content = format!("{name} (lines {first}-{shown} of {total}):\n{body}");
    if cut_line {
        content.push_str(&format!(
            "\n[line {shown} truncated at {MAX_READ_BYTES} bytes]"
        ));
    } else if shown < last {
        content.push_str(&format!(
            "\n[truncated after line {shown}; read more with startLine/endLine]"
        ));
    }
    Ok(ToolOutput {
        content,
        summary: format!("Read {name} (lines {first}-{shown})"),
    })
}

/// `list_files`: indexed files matching `glob`, one per line.
pub fn list_files(index: &WorkspaceIndex, glob: Option<&str>) -> Result<ToolOutput, ToolError> {
    let files = search::list_files(index, glob).map_err(|e| ToolError::Failed(e.to_string()))?;
    if files.is_empty() {
        return Ok(ToolOutput {
            content: "No files match.".into(),
            summary: "0 files".into(),
        });
    }
    let mut content = files
        .iter()
        .take(MAX_LISTED_FILES)
        .map(|p| display(p))
        .collect::<Vec<_>>()
        .join("\n");
    if files.len() > MAX_LISTED_FILES {
        content.push_str(&format!(
            "\n[{} more files not shown; narrow the glob]",
            files.len() - MAX_LISTED_FILES
        ));
    }
    Ok(ToolOutput {
        content,
        summary: format!("{} files", files.len()),
    })
}

/// `search`: matching lines as `path:line: text`. Invalid patterns are
/// errors; truncation is stated in the output.
pub fn search(
    files: &[RelPath],
    overlay: &OverlaySnapshot,
    query: &str,
    glob: Option<&str>,
    max_results: Option<usize>,
    regex: bool,
) -> Result<ToolOutput, ToolError> {
    if query.is_empty() {
        return Err(ToolError::InvalidArg("query", "must not be empty".into()));
    }
    let max_results = max_results
        .unwrap_or(DEFAULT_SEARCH_RESULTS)
        .clamp(1, MAX_SEARCH_RESULTS);
    let result = search::search(
        files,
        overlay,
        SearchQuery {
            query: query.to_owned(),
            regex,
            glob: glob.map(str::to_owned),
            max_results,
        },
    )
    .map_err(|e| ToolError::Failed(e.to_string()))?;
    if result.matches.is_empty() {
        return Ok(ToolOutput {
            content: "No matches.".into(),
            summary: "0 matches".into(),
        });
    }
    let mut content = result
        .matches
        .iter()
        .map(|m| format!("{}:{}: {}", display(&m.path), m.line, m.text))
        .collect::<Vec<_>>()
        .join("\n");
    if result.truncated {
        content.push_str(&format!(
            "\n[more matches exist beyond the first {max_results}; narrow the query or glob]"
        ));
    }
    let more = if result.truncated { "+" } else { "" };
    Ok(ToolOutput {
        content,
        summary: format!("{}{more} matches", result.matches.len()),
    })
}

/// `run_command` result for the model: exit code plus the last 16 KiB of
/// each stream.
pub fn command_output(result: &RunCommandResult) -> ToolOutput {
    let content = format!(
        "exit code {}\n\nstdout:\n{}\n\nstderr:\n{}",
        result.exit_code,
        tail(&result.stdout, MAX_COMMAND_OUTPUT_BYTES),
        tail(&result.stderr, MAX_COMMAND_OUTPUT_BYTES),
    );
    ToolOutput {
        content,
        summary: format!("exit code {}", result.exit_code),
    }
}

/// The last `max` bytes of `text` (on a char boundary), marked if cut.
fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("[{start} bytes truncated]\n{}", &text[start..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        (dir, root)
    }

    #[test]
    fn confine_rejects_dotdot_absolute_and_symlink_escape() {
        let (dir, root) = root();
        let escape = |p: &str| matches!(confine(&root, p), Err(ToolError::OutsideWorkspace(_)));

        // `..` anywhere, even if it would land back inside.
        assert!(escape("../outside.txt"));
        assert!(escape("src/../../outside.txt"));
        assert!(escape("src/../src/main.rs"));
        // Absolute paths outside the root.
        assert!(escape("/etc/passwd"));
        assert!(escape("/tmp/new-file.txt"));
        // A symlink inside the workspace pointing outside it.
        std::os::unix::fs::symlink("/tmp", root.join("out")).unwrap();
        assert!(escape("out"));
        assert!(escape("out/x.txt"));
        assert!(escape("out/not/yet/there.txt"));
        // Empty paths are invalid.
        assert!(confine(&root, "").is_err());

        // Absolute paths inside the root are fine, also spelled through a
        // non-canonical root (macOS tempdirs live under /var -> /private/var).
        let inside = root.join("src/main.rs");
        assert_eq!(confine(&root, inside.to_str().unwrap()).unwrap(), inside);
        assert_eq!(confine(dir.path(), "src/main.rs").unwrap(), inside);
        // A symlink that stays inside is allowed and resolved.
        std::os::unix::fs::symlink(root.join("src"), root.join("alias")).unwrap();
        assert_eq!(confine(&root, "alias/main.rs").unwrap(), inside);
        assert_eq!(confine(&root, "./src/main.rs").unwrap(), inside);
    }

    #[test]
    fn confine_allows_new_file_in_subdir() {
        let (_dir, root) = root();
        assert_eq!(
            confine(&root, "src/new.rs").unwrap(),
            root.join("src/new.rs")
        );
        assert_eq!(
            confine(&root, "src/deep/er/new.rs").unwrap(),
            root.join("src/deep/er/new.rs")
        );
        assert_eq!(confine(&root, "top.txt").unwrap(), root.join("top.txt"));
    }

    #[test]
    fn specs_cover_every_tool_and_approval_flags() {
        let names: Vec<String> = specs().into_iter().map(|s| s.function.name).collect();
        assert_eq!(
            names,
            [
                "read_file",
                "list_files",
                "search",
                "edit_file",
                "create_file",
                "run_command"
            ]
        );
        for spec in specs() {
            assert_eq!(spec.r#type, "function");
            assert_eq!(spec.function.parameters["type"], "object");
        }
        let edit = specs()
            .into_iter()
            .find(|s| s.function.name == "edit_file")
            .unwrap();
        assert_eq!(
            edit.function.parameters["required"],
            serde_json::json!(["path", "old", "new"])
        );
        for name in ["read_file", "list_files", "search"] {
            assert!(!requires_approval(name), "{name}");
        }
        for name in ["edit_file", "create_file", "run_command"] {
            assert!(requires_approval(name), "{name}");
        }
    }

    #[test]
    fn parse_reports_unknown_tools_and_missing_args() {
        assert_eq!(
            Tool::parse("rm_rf", &serde_json::json!({})),
            Err(ToolError::UnknownTool("rm_rf".into()))
        );
        assert_eq!(
            Tool::parse("read_file", &serde_json::json!({})),
            Err(ToolError::MissingArg("path"))
        );
        assert_eq!(
            Tool::parse("edit_file", &serde_json::json!({"path": "a", "old": "x"})),
            Err(ToolError::MissingArg("new"))
        );
        assert!(matches!(
            Tool::parse(
                "read_file",
                &serde_json::json!({"path": "a", "startLine": "x"})
            ),
            Err(ToolError::InvalidArg("startLine", _))
        ));
        // Models sometimes send snake_case keys, numeric strings, or the
        // arguments object JSON-encoded.
        assert_eq!(
            Tool::parse(
                "read_file",
                &serde_json::json!({"path": "a", "start_line": "3", "endLine": 5})
            ),
            Ok(Tool::ReadFile {
                path: "a".into(),
                start_line: Some(3),
                end_line: Some(5)
            })
        );
        assert_eq!(
            Tool::parse("run_command", &serde_json::json!("{\"command\":\"ls\"}")),
            Ok(Tool::RunCommand {
                command: "ls".into(),
                cwd: None
            })
        );
    }

    #[test]
    fn read_file_reads_overlay_and_line_ranges() {
        let (_dir, root) = root();
        fs::write(root.join("five.txt"), "1\n2\n3\n4\n5\n").unwrap();
        let mut store = crate::overlay::DocumentStore::new(root.clone());
        store.did_open(
            &crate::overlay::path_to_uri(&root.join("src/main.rs")),
            "fn unsaved() {}\n".into(),
            1,
        );
        let overlay = store.overlay_snapshot();

        let out = read_file(&overlay, &root, "src/main.rs", None, None).unwrap();
        assert!(out.content.contains("fn unsaved() {}"), "{}", out.content);
        let out = read_file(&overlay, &root, "five.txt", Some(2), Some(3)).unwrap();
        assert!(out.content.ends_with("2\n3\n"), "{}", out.content);
        assert!(!out.content.contains("4\n"));
        assert!(read_file(&overlay, &root, "five.txt", Some(9), None).is_err());
        assert!(read_file(&overlay, &root, "missing.txt", None, None).is_err());
        assert!(matches!(
            read_file(&overlay, &root, "../x", None, None),
            Err(ToolError::OutsideWorkspace(_))
        ));
    }

    #[test]
    fn read_file_refuses_files_over_the_size_cap_without_reading_them() {
        let (_dir, root) = root();
        // Sparse: MAX_FILE_BYTES + 1 bytes of NULs (valid UTF-8, so only the
        // size check can refuse it).
        let big = fs::File::create(root.join("big.bin")).unwrap();
        big.set_len(MAX_FILE_BYTES + 1).unwrap();
        let at_cap = fs::File::create(root.join("at_cap.txt")).unwrap();
        at_cap.set_len(MAX_FILE_BYTES).unwrap();
        let mut store = crate::overlay::DocumentStore::new(root.clone());
        let overlay = store.overlay_snapshot();

        let err = read_file(&overlay, &root, "big.bin", None, None).unwrap_err();
        let ToolError::Failed(message) = err else {
            panic!("unexpected error {err:?}");
        };
        assert!(message.contains("too large"), "{message}");
        // At the cap it is read (and the output truncated as usual).
        let out = read_file(&overlay, &root, "at_cap.txt", None, None).unwrap();
        assert!(out.content.contains("truncated"), "{}", out.content);

        // An open document is already in memory: no cap.
        let huge = "x\n".repeat(MAX_FILE_BYTES as usize);
        store.did_open(&crate::overlay::path_to_uri(&root.join("big.bin")), huge, 1);
        let overlay = store.overlay_snapshot();
        assert!(read_file(&overlay, &root, "big.bin", Some(1), Some(2)).is_ok());
    }

    #[test]
    fn confine_writable_rejects_git_and_localpilot() {
        let (_dir, root) = root();
        fs::create_dir_all(root.join(".git/hooks")).unwrap();
        let protected =
            |p: &str| matches!(confine_writable(&root, p), Err(ToolError::Protected(..)));

        assert!(protected(".git/hooks/pre-commit"));
        assert!(protected(".git/config"));
        assert!(protected("./.git/new-dir/x"));
        assert!(protected(".GIT/hooks/pre-commit"));
        assert!(protected("vendor/sub/.git/hooks/post-checkout"));
        assert!(protected(".localpilot/sessions/s1.json"));
        assert!(protected(".localpilot/.gitignore"));
        let abs = root.join(".git/hooks/pre-push");
        assert!(protected(abs.to_str().unwrap()));
        // A symlink into .git is resolved first.
        std::os::unix::fs::symlink(root.join(".git"), root.join("innocent")).unwrap();
        assert!(protected("innocent/hooks/pre-commit"));
        // Lookalikes are fine; escapes are still escapes.
        assert!(confine_writable(&root, ".gitignore").is_ok());
        assert!(confine_writable(&root, "src/git/x.rs").is_ok());
        assert!(confine_writable(&root, ".github/workflows/ci.yml").is_ok());
        assert!(matches!(
            confine_writable(&root, "../x"),
            Err(ToolError::OutsideWorkspace(_))
        ));
        // Reading is unaffected.
        assert!(confine(&root, ".git/config").is_ok());
    }

    #[test]
    fn search_and_list_files_format_results_and_errors() {
        let (_dir, root) = root();
        fs::write(root.join("src/lib.rs"), "use std::io;\nfn helper() {}\n").unwrap();
        let index = WorkspaceIndex::build(&root);
        let overlay = crate::overlay::DocumentStore::new(root.clone()).overlay_snapshot();

        let out = list_files(&index, Some("*.rs")).unwrap();
        assert_eq!(out.content, "src/lib.rs\nsrc/main.rs");
        let out = search(&index.files(), &overlay, "fn ", None, None, false).unwrap();
        assert!(
            out.content.contains("src/lib.rs:2: fn helper() {}"),
            "{}",
            out.content
        );
        assert!(
            out.content.contains("src/main.rs:1: fn main() {}"),
            "{}",
            out.content
        );
        let out = search(&index.files(), &overlay, "fn ", None, Some(1), false).unwrap();
        assert!(out.content.contains("more matches"), "{}", out.content);
        let err = search(&index.files(), &overlay, "(", None, None, true).unwrap_err();
        assert!(err.to_string().contains("invalid regex"), "{err}");
        assert!(
            list_files(&index, Some("a[b"))
                .unwrap_err()
                .to_string()
                .contains("invalid glob")
        );
    }

    #[test]
    fn command_output_is_truncated_to_16k_per_stream() {
        let big = "x".repeat(40 * 1024) + "TAIL";
        let out = command_output(&RunCommandResult {
            exit_code: 1,
            stdout: big.clone(),
            stderr: "boom".into(),
        });
        assert!(
            out.content.contains("exit code 1"),
            "{}",
            &out.content[..100]
        );
        assert!(out.content.contains("TAIL"));
        assert!(out.content.contains("boom"));
        assert!(out.content.contains("truncated"));
        assert!(out.content.len() < 17 * 1024 + 200);
    }
}
