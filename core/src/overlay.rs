//! In-memory overlay of documents the IDE has open (LSP-style `didOpen` /
//! `didChange` / `didClose`).
//!
//! Every read of workspace content (completions, context retrieval, the
//! agent's `read_file`) goes through [`DocumentStore::read`], so unsaved edits
//! are seen before falling back to disk.
//!
//! Positions follow the LSP convention: zero-based lines, `character` in
//! UTF-16 code units. Positions past the end of a line or the document clamp
//! instead of panicking, and a position inside a multi-unit character resolves
//! to the start of that character. Line endings (`\n`, `\r\n`, `\r`) are kept
//! byte-for-byte.

use std::borrow::Cow;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use crate::protocol::{ContentChange, Position, Range};

/// One open document: its text plus line-start byte offsets, rebuilt per change.
#[derive(Debug)]
struct Document {
    /// The URI as the client spelled it.
    uri: String,
    text: String,
    line_starts: Vec<usize>,
    #[allow(dead_code)]
    version: i32,
    /// Logical clock value of the last `did_change`; `None` if never edited.
    last_change: Option<u64>,
}

impl Document {
    fn set_text(&mut self, text: String) {
        self.line_starts = line_starts(&text);
        self.text = text;
    }

    fn offset(&self, pos: Position) -> usize {
        offset_in(&self.text, &self.line_starts, pos)
    }
}

/// Open documents keyed by normalized `file://` URI.
#[derive(Debug)]
pub struct DocumentStore {
    workspace_root: PathBuf,
    docs: HashMap<String, Document>,
    clock: u64,
}

impl DocumentStore {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            docs: HashMap::new(),
            clock: 0,
        }
    }

    pub fn did_open(&mut self, uri: &str, text: String, version: i32) {
        let doc = Document {
            uri: uri.to_string(),
            line_starts: line_starts(&text),
            text,
            version,
            last_change: None,
        };
        self.docs.insert(normalize_uri(uri), doc);
    }

    /// Applies `changes` in order, each against the result of the previous one.
    /// `range: None` replaces the whole document. Unknown URIs are ignored.
    pub fn did_change(&mut self, uri: &str, version: i32, changes: Vec<ContentChange>) {
        let Some(doc) = self.docs.get_mut(&normalize_uri(uri)) else {
            return;
        };
        for change in changes {
            let new_text = match change.range {
                None => change.text,
                Some(Range { start, end }) => {
                    let start = doc.offset(start);
                    let end = doc.offset(end).max(start);
                    let mut t =
                        String::with_capacity(doc.text.len() - (end - start) + change.text.len());
                    t.push_str(&doc.text[..start]);
                    t.push_str(&change.text);
                    t.push_str(&doc.text[end..]);
                    t
                }
            };
            doc.set_text(new_text);
        }
        doc.version = version;
        self.clock += 1;
        doc.last_change = Some(self.clock);
    }

    pub fn did_close(&mut self, uri: &str) {
        self.docs.remove(&normalize_uri(uri));
    }

    /// Reads `path` from the overlay if open, else from disk. Relative paths
    /// resolve against the workspace root.
    pub fn read(&self, path: &Path) -> io::Result<String> {
        let abs = normalize_path(&self.workspace_root.join(path));
        match self.docs.get(&path_to_uri(&abs)) {
            Some(doc) => Ok(doc.text.clone()),
            None => std::fs::read_to_string(&abs),
        }
    }

    /// Owned copy of every open document's text, so a caller can release the
    /// store lock before doing disk I/O (e.g. workspace search).
    pub fn overlay_snapshot(&self) -> OverlaySnapshot {
        OverlaySnapshot {
            workspace_root: self.workspace_root.clone(),
            docs: self
                .docs
                .iter()
                .map(|(uri, d)| (uri_to_path(uri), d.text.clone()))
                .collect(),
        }
    }

    /// The overlay text for `uri`, if open.
    pub fn text(&self, uri: &str) -> Option<String> {
        self.docs.get(&normalize_uri(uri)).map(|d| d.text.clone())
    }

    /// Splits the open document at `pos` into `(prefix, suffix)`.
    pub fn split_at_cursor(&self, uri: &str, pos: Position) -> Option<(String, String)> {
        let doc = self.docs.get(&normalize_uri(uri))?;
        let (prefix, suffix) = doc.text.split_at(doc.offset(pos));
        Some((prefix.to_string(), suffix.to_string()))
    }

    /// Up to `n` URIs of open documents that have been edited, most recently
    /// changed first.
    pub fn recently_edited(&self, n: usize) -> Vec<String> {
        let mut edited: Vec<(u64, &str)> = self
            .docs
            .values()
            .filter_map(|d| d.last_change.map(|t| (t, d.uri.as_str())))
            .collect();
        edited.sort_unstable_by_key(|e| std::cmp::Reverse(e.0));
        edited
            .into_iter()
            .take(n)
            .map(|(_, uri)| uri.to_string())
            .collect()
    }
}

/// Point-in-time copy of the open documents, keyed by normalized absolute
/// path. Reads with the same overlay-then-disk semantics as
/// [`DocumentStore::read`] without needing the store (or its lock).
#[derive(Debug, Clone, Default)]
pub struct OverlaySnapshot {
    workspace_root: PathBuf,
    docs: HashMap<PathBuf, String>,
}

impl OverlaySnapshot {
    /// Reads `path` from the snapshot if it was open, else from disk. Relative
    /// paths resolve against the workspace root.
    /// Open documents are borrowed, not copied.
    pub fn read(&self, path: &Path) -> io::Result<Cow<'_, str>> {
        let abs = normalize_path(&self.workspace_root.join(path));
        match self.docs.get(&abs) {
            Some(text) => Ok(Cow::Borrowed(text)),
            None => std::fs::read_to_string(&abs).map(Cow::Owned),
        }
    }

    /// Number of open documents captured.
    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }
}

/// Byte offset of `pos` in `text` (UTF-16-aware, clamped to the document end).
pub fn offset_of(text: &str, pos: Position) -> usize {
    offset_in(text, &line_starts(text), pos)
}

/// Byte offsets at which each line starts. Line terminators are `\n`, `\r\n`
/// and a lone `\r`.
fn line_starts(text: &str) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut starts = vec![0];
    for (i, &b) in bytes.iter().enumerate() {
        let ends_line = b == b'\n' || (b == b'\r' && bytes.get(i + 1) != Some(&b'\n'));
        if ends_line {
            starts.push(i + 1);
        }
    }
    starts
}

fn offset_in(text: &str, line_starts: &[usize], pos: Position) -> usize {
    let Some(&start) = line_starts.get(pos.line as usize) else {
        return text.len();
    };
    let next = line_starts
        .get(pos.line as usize + 1)
        .copied()
        .unwrap_or(text.len());
    // Content of the line, excluding its terminator.
    let line = text[start..next].trim_end_matches(['\n', '\r']);
    let target = pos.character as usize;
    let mut units = 0;
    for (i, c) in line.char_indices() {
        if units + c.len_utf16() > target {
            return start + i;
        }
        units += c.len_utf16();
    }
    start + line.len()
}

/// Canonical spelling of a `file://` URI, so client encodings that differ only
/// in which characters they escape, or in `.`/`..` segments, map to the same
/// document.
fn normalize_uri(uri: &str) -> String {
    path_to_uri(&normalize_path(&uri_to_path(uri)))
}

/// Lexically normalizes `path`: drops `.` segments and resolves `..` against
/// the preceding segment (never above the root). Does not touch the
/// filesystem, so symlinks are not resolved.
fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Converts a `file://` URI to a path, percent-decoding it. Input without the
/// `file://` scheme is treated as a path.
pub fn uri_to_path(uri: &str) -> PathBuf {
    let rest = uri.strip_prefix("file://").unwrap_or(uri);
    let rest = match rest.strip_prefix("localhost") {
        Some(r) if r.starts_with('/') => r,
        _ => rest,
    };
    bytes_to_path(percent_decode(rest))
}

/// Converts an absolute path to a `file://` URI, percent-encoding every byte
/// outside the unreserved set and `/`.
pub fn path_to_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for &b in path_bytes(path).iter() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    uri
}

fn percent_decode(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = s.get(i + 1..i + 3)
            && hex.bytes().all(|h| h.is_ascii_hexdigit())
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

#[cfg(unix)]
fn path_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn path_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().replace('\\', "/").into_bytes()
}

#[cfg(unix)]
fn bytes_to_path(bytes: Vec<u8>) -> PathBuf {
    use std::os::unix::ffi::OsStringExt;
    PathBuf::from(std::ffi::OsString::from_vec(bytes))
}

#[cfg(not(unix))]
fn bytes_to_path(bytes: Vec<u8>) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(line: u32, character: u32) -> Position {
        Position { line, character }
    }

    fn range(sl: u32, sc: u32, el: u32, ec: u32) -> Option<Range> {
        Some(Range {
            start: pos(sl, sc),
            end: pos(el, ec),
        })
    }

    fn change(range: Option<Range>, text: &str) -> ContentChange {
        ContentChange {
            range,
            text: text.to_string(),
        }
    }

    const URI: &str = "file:///ws/a.rs";

    fn store() -> DocumentStore {
        DocumentStore::new(PathBuf::from("/ws"))
    }

    #[test]
    fn incremental_change_replaces_range() {
        let mut s = store();
        s.did_open(URI, "hello world".into(), 1);
        s.did_change(URI, 2, vec![change(range(0, 6, 0, 11), "rust")]);
        assert_eq!(s.text(URI).as_deref(), Some("hello rust"));
    }

    #[test]
    fn utf16_positions_map_through_emoji() {
        assert_eq!(offset_of("a😀b", pos(0, 3)), "a😀".len());
        let mut s = store();
        s.did_open(URI, "a😀b".into(), 1);
        s.did_change(URI, 2, vec![change(range(0, 3, 0, 4), "c")]);
        assert_eq!(s.text(URI).as_deref(), Some("a😀c"));
    }

    #[test]
    fn range_past_end_is_clamped_not_panic() {
        let mut s = store();
        s.did_open(URI, "one\ntwo\nthree".into(), 1);
        s.did_change(URI, 2, vec![change(range(1, 1, 99, 99), "X")]);
        assert_eq!(s.text(URI).as_deref(), Some("one\ntX"));
        // A position inside a surrogate pair or past a line's end never splits a char.
        assert_eq!(offset_of("a😀b", pos(0, 2)), 1);
        assert_eq!(offset_of("ab\ncd", pos(0, 99)), 2);
    }

    #[test]
    fn read_prefers_overlay_over_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.txt");
        std::fs::write(&path, "disk").unwrap();
        let uri = path_to_uri(&path);
        assert_eq!(uri_to_path(&uri), path);

        let mut s = DocumentStore::new(dir.path().to_path_buf());
        s.did_open(&uri, "mem".into(), 1);
        assert_eq!(s.read(&path).unwrap(), "mem");
        s.did_close(&uri);
        assert_eq!(s.read(&path).unwrap(), "disk");
    }

    #[test]
    fn recently_edited_orders_by_last_change() {
        let mut s = store();
        for u in ["file:///ws/a", "file:///ws/b", "file:///ws/c"] {
            s.did_open(u, String::new(), 1);
        }
        s.did_change("file:///ws/b", 2, vec![change(None, "b")]);
        s.did_change("file:///ws/a", 2, vec![change(None, "a")]);
        s.did_change("file:///ws/c", 2, vec![change(None, "c")]);
        s.did_change("file:///ws/b", 3, vec![change(None, "bb")]);
        assert_eq!(
            s.recently_edited(10),
            vec!["file:///ws/b", "file:///ws/c", "file:///ws/a"]
        );
        assert_eq!(s.recently_edited(2), vec!["file:///ws/b", "file:///ws/c"]);
    }

    #[test]
    fn crlf_preserved_on_split() {
        let mut s = store();
        s.did_open(URI, "a\r\nb".into(), 1);
        let (prefix, suffix) = s.split_at_cursor(URI, pos(1, 0)).unwrap();
        assert_eq!(prefix, "a\r\n");
        assert_eq!(suffix, "b");
        assert!(s.split_at_cursor("file:///ws/missing", pos(0, 0)).is_none());
    }

    #[test]
    fn read_normalizes_dot_segments() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let path = dir.path().join("f.txt");
        std::fs::write(&path, "disk").unwrap();

        let mut s = DocumentStore::new(dir.path().to_path_buf());
        s.did_open(&path_to_uri(&path), "mem".into(), 1);
        assert_eq!(s.read(Path::new("./f.txt")).unwrap(), "mem");
        assert_eq!(s.read(Path::new("sub/../f.txt")).unwrap(), "mem");
        assert_eq!(s.read(&dir.path().join(".").join("f.txt")).unwrap(), "mem");
        // A URI with dot segments addresses the same document.
        let dotted = format!("{}/./sub/../f.txt", path_to_uri(dir.path()));
        assert_eq!(s.text(&dotted).as_deref(), Some("mem"));
    }

    #[test]
    fn sequential_changes_apply_against_previous_result() {
        let mut s = store();
        s.did_open(URI, "ab".into(), 1);
        // The second range only exists after the first change inserts a line.
        s.did_change(
            URI,
            2,
            vec![
                change(range(0, 1, 0, 1), "\nxyz"),
                change(range(1, 1, 1, 3), "Q"),
            ],
        );
        assert_eq!(s.text(URI).as_deref(), Some("a\nxQb"));
    }

    #[test]
    fn percent_decode_requires_hex_digits() {
        assert_eq!(percent_decode("%+1%2F%zz%4"), b"%+1/%zz%4");
    }

    #[test]
    fn uri_round_trip_percent_encodes() {
        let path = PathBuf::from("/Users/me/My Project/naïve#1.rs");
        let uri = path_to_uri(&path);
        assert_eq!(uri, "file:///Users/me/My%20Project/na%C3%AFve%231.rs");
        assert_eq!(uri_to_path(&uri), path);
    }
}
