//! Resolving `edit_file { old, new }` against a document (spec §7.3).

use crate::protocol::{Position, Range};

/// A uniquely located edit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// Range of `doc` to replace (UTF-16 positions).
    pub range: Range,
    /// Replacement text for `range`.
    pub new_text: String,
    /// Unified diff of the whole document, headed with the path.
    pub diff: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EditError {
    #[error(
        "`old` is empty; copy the exact text to replace from the file (use create_file for new files)"
    )]
    Empty,
    #[error("`old` and `new` are identical; nothing to change")]
    NoChange,
    #[error("{}", not_found_message(.nearest))]
    NotFound { nearest: Vec<String> },
    #[error(
        "`old` matches {0} places in the file; include more surrounding lines so it matches exactly one"
    )]
    Ambiguous(usize),
}

fn not_found_message(nearest: &[String]) -> String {
    let mut msg = String::from("`old` was not found in the file.");
    if !nearest.is_empty() {
        msg.push_str(" Closest lines:");
        for line in nearest {
            msg.push_str("\n  ");
            msg.push_str(line);
        }
    }
    msg.push_str("\nRe-read the file with read_file and copy `old` exactly.");
    msg
}

/// Most candidate lines reported in [`EditError::NotFound`].
const MAX_NEAREST: usize = 3;
/// Minimum similarity (0..=1) for a line to count as a near miss.
const MIN_SIMILARITY: f32 = 0.5;

/// Locates `old` in `doc` and turns the replacement into a range edit plus a
/// diff preview headed with `path`.
///
/// Strategies, in order; the first that finds anything decides:
/// 1. exact substring match;
/// 2. whole lines equal after trimming each line (the edit replaces those
///    lines; `new` is re-indented by the indentation difference);
/// 3. match after collapsing every whitespace run to one space.
///
/// Exactly one match resolves; several are [`EditError::Ambiguous`]; none is
/// [`EditError::NotFound`] with the lines most similar to `old`'s first line.
pub fn resolve(path: &str, doc: &str, old: &str, new: &str) -> Result<Resolved, EditError> {
    if old.trim().is_empty() {
        return Err(EditError::Empty);
    }
    if old == new {
        return Err(EditError::NoChange);
    }
    let (start, end, new_text) = exact(doc, old, new)
        .or_else(|| trimmed_lines(doc, old, new))
        .or_else(|| normalised(doc, old, new))
        .unwrap_or_else(|| {
            Err(EditError::NotFound {
                nearest: nearest_lines(doc, old),
            })
        })?;
    let mut edited = String::with_capacity(doc.len() + new_text.len());
    edited.push_str(&doc[..start]);
    edited.push_str(&new_text);
    edited.push_str(&doc[end..]);
    let diff = similar::TextDiff::from_lines(doc, &edited)
        .unified_diff()
        .context_radius(3)
        .header(path, path)
        .to_string();
    Ok(Resolved {
        range: Range {
            start: position_at(doc, start),
            end: position_at(doc, end),
        },
        new_text,
        diff,
    })
}

/// `(start byte, end byte, replacement)` of a unique match.
type Found = Result<(usize, usize, String), EditError>;

/// `None` if nothing matched; otherwise the unique match or `Ambiguous`.
fn unique(
    mut spans: Vec<(usize, usize)>,
    new_text: impl FnOnce(usize, usize) -> String,
) -> Option<Found> {
    match spans.len() {
        0 => None,
        1 => {
            let (start, end) = spans.pop().unwrap();
            Some(Ok((start, end, new_text(start, end))))
        }
        n => Some(Err(EditError::Ambiguous(n))),
    }
}

fn exact(doc: &str, old: &str, new: &str) -> Option<Found> {
    let spans = doc
        .match_indices(old)
        .map(|(i, m)| (i, i + m.len()))
        .collect();
    unique(spans, |_, _| new.to_owned())
}

/// `(content start, content end)` byte spans of each line of `text`, without
/// terminators (`\n`, `\r\n`, lone `\r`).
fn line_spans(text: &str) -> Vec<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut spans = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                spans.push((start, i));
                start = i + 1;
            }
            b'\r' => {
                spans.push((start, i));
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < bytes.len() {
        spans.push((start, bytes.len()));
    }
    spans
}

/// The lines of `text` with blank lines at both ends removed.
fn core_lines(text: &str) -> Vec<&str> {
    let lines: Vec<&str> = line_spans(text).iter().map(|&(s, e)| &text[s..e]).collect();
    let first = lines.iter().position(|l| !l.trim().is_empty());
    let last = lines.iter().rposition(|l| !l.trim().is_empty());
    match (first, last) {
        (Some(first), Some(last)) => lines[first..=last].to_vec(),
        _ => Vec::new(),
    }
}

fn leading_ws(line: &str) -> &str {
    &line[..line.len() - line.trim_start().len()]
}

fn trimmed_lines(doc: &str, old: &str, new: &str) -> Option<Found> {
    let old_lines = core_lines(old);
    let spans = line_spans(doc);
    if old_lines.is_empty() || old_lines.len() > spans.len() {
        return None;
    }
    let k = old_lines.len();
    let matches: Vec<usize> = (0..=spans.len() - k)
        .filter(|&i| {
            old_lines
                .iter()
                .zip(&spans[i..i + k])
                .all(|(o, &(s, e))| doc[s..e].trim() == o.trim())
        })
        .collect();
    let first_old = old_lines
        .iter()
        .find(|l| !l.trim().is_empty())
        .copied()
        .unwrap_or("");
    let found: Vec<(usize, usize)> = matches
        .iter()
        .map(|&i| (spans[i].0, spans[i + k - 1].1))
        .collect();
    unique(found, |start, _| {
        let first_doc = doc[start..].lines().next().unwrap_or("");
        let new = core_lines(new).join("\n");
        let new = reindent(&new, leading_ws(first_old), leading_ws(first_doc));
        with_doc_line_endings(doc, new)
    })
}

/// Shifts `new` by the indentation difference between how the model quoted
/// the code (`quoted`) and how it is indented in the document (`actual`).
fn reindent(new: &str, quoted: &str, actual: &str) -> String {
    if quoted == actual {
        return new.to_owned();
    }
    let lines = new.split('\n');
    if let Some(extra) = actual.strip_prefix(quoted) {
        lines
            .map(|l| {
                if l.trim().is_empty() {
                    l.to_owned()
                } else {
                    format!("{extra}{l}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else if let Some(excess) = quoted.strip_prefix(actual) {
        lines
            .map(|l| l.strip_prefix(excess).unwrap_or(l).to_owned())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        new.to_owned()
    }
}

/// Converts `\n` line breaks in `text` to `\r\n` if `doc` uses CRLF.
fn with_doc_line_endings(doc: &str, text: String) -> String {
    if doc.contains("\r\n") {
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text
    }
}

fn normalised(doc: &str, old: &str, new: &str) -> Option<Found> {
    // `norm` is `doc` with each whitespace run collapsed to one space;
    // `origin[i]` is the byte in `doc` where the char at `norm` byte `i` starts.
    let mut norm = String::with_capacity(doc.len());
    let mut origin = Vec::with_capacity(doc.len());
    let mut in_ws = false;
    for (i, c) in doc.char_indices() {
        if c.is_whitespace() {
            if !in_ws {
                norm.push(' ');
                origin.push(i);
            }
            in_ws = true;
        } else {
            norm.push(c);
            origin.extend(std::iter::repeat_n(i, c.len_utf8()));
            in_ws = false;
        }
    }
    let needle = old.split_whitespace().collect::<Vec<_>>().join(" ");
    let spans = norm
        .match_indices(&needle)
        .map(|(i, m)| {
            // `needle` starts and ends with non-whitespace chars.
            let last = origin[i + m.len() - 1];
            let last_len = doc[last..].chars().next().map_or(0, char::len_utf8);
            (origin[i], last + last_len)
        })
        .collect();
    unique(spans, |_, _| {
        with_doc_line_endings(doc, new.trim().to_owned())
    })
}

/// Up to [`MAX_NEAREST`] `"<line number>: <line>"` entries most similar to
/// the first non-blank line of `old`.
fn nearest_lines(doc: &str, old: &str) -> Vec<String> {
    let Some(target) = old.lines().map(str::trim).find(|l| !l.is_empty()) else {
        return Vec::new();
    };
    let mut scored: Vec<(f32, usize, &str)> = doc
        .lines()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty())
        .map(|(i, l)| {
            let ratio = similar::TextDiff::from_chars(l.trim(), target).ratio();
            (ratio, i, l)
        })
        .filter(|(ratio, _, _)| *ratio >= MIN_SIMILARITY)
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(MAX_NEAREST)
        .map(|(_, i, l)| format!("{}: {}", i + 1, l.trim_end()))
        .collect()
}

/// UTF-16 position of byte offset `offset` in `text` (clamped to the end,
/// moved back to a char boundary). Line terminators are `\n`, `\r\n` and a
/// lone `\r`, as in [`crate::overlay`].
pub fn position_at(text: &str, offset: usize) -> Position {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    let (line, line_start) = line_spans(&text[..offset])
        .iter()
        .enumerate()
        .next_back()
        .map_or((0, 0), |(i, &(start, end))| {
            // A trailing terminator at `offset` puts us on the next line.
            if end < offset {
                (i + 1, offset)
            } else {
                (i, start)
            }
        });
    let character = text[line_start..offset].encode_utf16().count();
    Position {
        line: line as u32,
        character: character as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay::offset_of;

    /// Applies a resolved edit the way the IDE would.
    fn apply(doc: &str, r: &Resolved) -> String {
        let start = offset_of(doc, r.range.start);
        let end = offset_of(doc, r.range.end);
        format!("{}{}{}", &doc[..start], r.new_text, &doc[end..])
    }

    fn pos(line: u32, character: u32) -> Position {
        Position { line, character }
    }

    #[test]
    fn exact_match_resolves() {
        let doc = "fn main() {\n    let s = \"héllo 😀\"; println!(\"{s}\");\n}\n";
        let r = resolve("src/main.rs", doc, "println!(\"{s}\")", "dbg!(s)").unwrap();
        // UTF-16: `é` is 1 unit, `😀` is 2.
        assert_eq!(r.range.start, pos(1, 24));
        assert_eq!(r.range.end, pos(1, 39));
        assert_eq!(r.new_text, "dbg!(s)");
        assert_eq!(
            apply(doc, &r),
            "fn main() {\n    let s = \"héllo 😀\"; dbg!(s);\n}\n"
        );
        assert!(r.diff.contains("--- src/main.rs"), "{}", r.diff);
        assert!(r.diff.contains("+++ src/main.rs"), "{}", r.diff);
        assert!(
            r.diff
                .contains("-    let s = \"héllo 😀\"; println!(\"{s}\");")
        );
        assert!(r.diff.contains("+    let s = \"héllo 😀\"; dbg!(s);"));
    }

    #[test]
    fn trimmed_match_resolves_indented_quote() {
        let doc = "class A:\n    def f(self):\n        x = 1\n        return x\n";
        // The model quoted the body without its indentation.
        let old = "x = 1\nreturn x\n";
        let new = "x = 2\nreturn x * 2\n";
        let r = resolve("a.py", doc, old, new).unwrap();
        assert_eq!(r.range.start, pos(2, 0));
        assert_eq!(r.range.end, pos(3, 16));
        assert_eq!(
            apply(doc, &r),
            "class A:\n    def f(self):\n        x = 2\n        return x * 2\n"
        );

        // Over-indented quote: the extra indentation is removed from `new`.
        let old = "            x = 1\n            return x";
        let new = "            y = 1\n            return y";
        let r = resolve("a.py", doc, old, new).unwrap();
        assert_eq!(
            apply(doc, &r),
            "class A:\n    def f(self):\n        y = 1\n        return y\n"
        );
    }

    #[test]
    fn whitespace_normalised_match_resolves() {
        let doc = "let v = foo(a,  b,\n            c);\nlet w = 1;\n";
        let r = resolve("x.rs", doc, "foo(a, b, c);", "bar(a);").unwrap();
        assert_eq!(r.range.start, pos(0, 8));
        assert_eq!(r.range.end, pos(1, 15));
        assert_eq!(apply(doc, &r), "let v = bar(a);\nlet w = 1;\n");
    }

    #[test]
    fn ambiguous_returns_count() {
        let doc = "a = 1\nb = 2\na = 1\na = 1\n";
        assert_eq!(
            resolve("x.py", doc, "a = 1", "a = 3"),
            Err(EditError::Ambiguous(3))
        );
        // Ambiguity under the fuzzy strategies is reported too.
        let doc = "  x()\n\tx()\n";
        assert_eq!(
            resolve("x.py", doc, " x() ", "y()"),
            Err(EditError::Ambiguous(2))
        );
        let doc = "a  b\na\tb\n";
        assert_eq!(
            resolve("x.py", doc, "a b", "c"),
            Err(EditError::Ambiguous(2))
        );
    }

    #[test]
    fn not_found_returns_nearest_lines() {
        let doc = "fn alpha() {}\nfn compute_total(items: &[u32]) -> u32 {\n    0\n}\n";
        let err = resolve(
            "x.rs",
            doc,
            "fn compute_totals(items: &[u64]) -> u64 {",
            "x",
        )
        .unwrap_err();
        let EditError::NotFound { nearest } = &err else {
            panic!("expected NotFound, got {err:?}");
        };
        assert_eq!(
            nearest.first().map(String::as_str),
            Some("2: fn compute_total(items: &[u32]) -> u32 {")
        );
        assert!(nearest.len() <= 3);
        let msg = err.to_string();
        assert!(msg.contains("not found"), "{msg}");
        assert!(msg.contains("2: fn compute_total"), "{msg}");
    }

    #[test]
    fn empty_old_and_no_change_are_errors() {
        let doc = "a\nb\n";
        assert_eq!(resolve("x", doc, "", "c"), Err(EditError::Empty));
        assert_eq!(resolve("x", doc, " \n\t", "c"), Err(EditError::Empty));
        assert_eq!(resolve("x", doc, "a", "a"), Err(EditError::NoChange));
        assert!(!EditError::Empty.to_string().is_empty());
        assert!(!EditError::NoChange.to_string().is_empty());
    }

    #[test]
    fn crlf_documents_keep_crlf_in_fuzzy_edits() {
        let doc = "if x:\r\n    a()\r\n    b()\r\n";
        let r = resolve("x.py", doc, "a()\nb()", "c()\nd()").unwrap();
        assert_eq!(apply(doc, &r), "if x:\r\n    c()\r\n    d()\r\n");
    }

    #[test]
    fn position_at_counts_utf16_and_line_endings() {
        let text = "ab\r\nc😀d\re";
        assert_eq!(position_at(text, 0), pos(0, 0));
        assert_eq!(position_at(text, 2), pos(0, 2));
        assert_eq!(position_at(text, 4), pos(1, 0));
        assert_eq!(position_at(text, 9), pos(1, 3)); // after 😀
        assert_eq!(position_at(text, 11), pos(2, 0));
        assert_eq!(position_at(text, text.len()), pos(2, 1));
    }
}
