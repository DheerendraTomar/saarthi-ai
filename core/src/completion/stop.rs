//! Streaming stop rules and output clean-up for inline completions.
//!
//! The model runs with `stop = []`; the [`Trimmer`] decides where a
//! suggestion ends as chunks arrive, so the engine can drop the HTTP stream
//! the moment the suggestion is complete instead of waiting for
//! `num_predict` tokens.

/// Maximum number of lines a multi-line suggestion may span.
pub const MAX_LINES: usize = 8;

/// Whether a suggestion may span lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopMode {
    /// The cursor's line has code after the cursor: complete only the line.
    SingleLine,
    /// The rest of the cursor's line is blank: a block may be suggested.
    MultiLine,
}

/// [`StopMode::SingleLine`] if the cursor's line has non-whitespace after
/// the cursor, else [`StopMode::MultiLine`].
pub fn mode_for(_prefix: &str, suffix: &str) -> StopMode {
    let rest_of_line = suffix.split('\n').next().unwrap_or("");
    if rest_of_line.trim().is_empty() {
        StopMode::MultiLine
    } else {
        StopMode::SingleLine
    }
}

/// Accumulates streamed text and detects where the suggestion ends.
///
/// Rules (applied to complete lines only):
/// - `SingleLine`: stop at the first `\n`.
/// - `MultiLine`: stop after [`MAX_LINES`] lines; before a blank line that
///   follows non-blank content whose brackets (`{([` vs `})]`) are balanced
///   (or over-closed) relative to the completion start; or before a line
///   equal (trimmed) to the first non-empty line of the suffix.
///
/// Model `\r` characters are dropped; output uses `\r\n` when
/// [`with_crlf`](Self::with_crlf) is set.
#[derive(Debug, Clone)]
pub struct Trimmer {
    mode: StopMode,
    crlf: bool,
    /// First non-empty suffix line, trimmed; `None` if the suffix is blank.
    suffix_line: Option<String>,
    /// Normalized (`\r`-free) text received so far.
    buf: String,
    /// Byte offset in `buf` where the current, incomplete line starts.
    line_start: usize,
    lines: usize,
    depth: i64,
    seen_content: bool,
    /// Set once a stop rule fired: the final, cleaned-up text.
    done: Option<String>,
}

impl Trimmer {
    /// A trimmer for `mode`. CRLF output is on when `suffix` contains
    /// `\r\n`; use [`with_crlf`](Self::with_crlf) when the engine knows the
    /// document's line ending (e.g. the cursor is at the end of the file).
    pub fn new(mode: StopMode, suffix: &str) -> Self {
        let suffix_line = suffix
            .split('\n')
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(str::to_owned);
        Self {
            mode,
            crlf: suffix.contains("\r\n"),
            suffix_line,
            buf: String::new(),
            line_start: 0,
            lines: 0,
            depth: 0,
            seen_content: false,
            done: None,
        }
    }

    /// Overrides the line-ending style of the output.
    pub fn with_crlf(mut self, crlf: bool) -> Self {
        self.crlf = crlf;
        self
    }

    /// Feeds one streamed delta. Returns `Some(final text)` once a stop rule
    /// fires (and on every later call); the caller should then stop reading.
    pub fn push(&mut self, delta: &str) -> Option<String> {
        if self.done.is_some() {
            return self.done.clone();
        }
        self.buf.extend(delta.chars().filter(|&c| c != '\r'));
        while let Some(nl) = self.buf[self.line_start..].find('\n') {
            let end = self.line_start + nl;
            if let Some(cut) = self.complete_line(end) {
                let text = self.render(&self.buf[..cut]);
                self.done = Some(text);
                return self.done.clone();
            }
        }
        None
    }

    /// The final text when the stream ended without a stop rule firing:
    /// trailing whitespace trimmed, CRLF line endings for CRLF documents.
    pub fn finish(&self) -> String {
        if let Some(done) = &self.done {
            return done.clone();
        }
        let mut end = self.buf.len();
        if self.mode == StopMode::MultiLine && self.duplicates_suffix(&self.buf[self.line_start..])
        {
            end = self.line_start;
        }
        self.render(&self.buf[..end])
    }

    /// Processes the complete line `buf[line_start..end]` (`end` is the
    /// index of its `\n`). Returns the cut offset if a stop rule fires.
    fn complete_line(&mut self, end: usize) -> Option<usize> {
        let start = self.line_start;
        let line = &self.buf[start..end];
        if self.mode == StopMode::SingleLine {
            return Some(end);
        }
        if self.duplicates_suffix(line) {
            return Some(start);
        }
        let blank = line.trim().is_empty();
        if blank && self.seen_content && self.depth <= 0 {
            return Some(start);
        }
        self.depth += bracket_delta(line);
        self.seen_content |= !blank;
        self.lines += 1;
        self.line_start = end + 1;
        (self.lines >= MAX_LINES).then_some(end)
    }

    fn duplicates_suffix(&self, line: &str) -> bool {
        let line = line.trim();
        !line.is_empty() && self.suffix_line.as_deref() == Some(line)
    }

    fn render(&self, text: &str) -> String {
        let text = text.trim_end();
        if self.crlf {
            text.replace('\n', "\r\n")
        } else {
            text.to_owned()
        }
    }
}

/// Opening minus closing brackets on `line`.
fn bracket_delta(line: &str) -> i64 {
    line.chars()
        .map(|c| match c {
            '{' | '(' | '[' => 1,
            '}' | ')' | ']' => -1,
            _ => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(mode: StopMode, suffix: &str, deltas: &[&str]) -> (String, bool) {
        let mut t = Trimmer::new(mode, suffix);
        for d in deltas {
            if let Some(done) = t.push(d) {
                return (done, true);
            }
        }
        (t.finish(), false)
    }

    #[test]
    fn mode_is_single_line_when_code_follows_cursor() {
        assert_eq!(mode_for("foo(", "x)\nbar"), StopMode::SingleLine);
        assert_eq!(mode_for("foo", "  \t\nbar"), StopMode::MultiLine);
        assert_eq!(mode_for("foo", ""), StopMode::MultiLine);
        assert_eq!(mode_for("foo", "\r\nbar"), StopMode::MultiLine);
    }

    #[test]
    fn single_line_stops_at_newline() {
        let (text, stopped) = run(StopMode::SingleLine, "x)\n", &["a, ", "b  \nc = 1", "\n"]);
        assert!(stopped);
        assert_eq!(text, "a, b");
    }

    #[test]
    fn single_line_without_newline_finishes_trimmed() {
        let (text, stopped) = run(StopMode::SingleLine, "x)\n", &["a, b ", " "]);
        assert!(!stopped);
        assert_eq!(text, "a, b");
    }

    #[test]
    fn multiline_stops_after_8_lines() {
        let deltas: Vec<String> = (0..12).map(|i| format!("x{i} = {i}\n")).collect();
        let deltas: Vec<&str> = deltas.iter().map(String::as_str).collect();
        let (text, stopped) = run(StopMode::MultiLine, "", &deltas);
        assert!(stopped);
        assert_eq!(text.lines().count(), MAX_LINES);
        assert_eq!(text.lines().last(), Some("x7 = 7"));
    }

    #[test]
    fn multiline_stops_on_balanced_block_then_blank() {
        // A blank line inside an open block does not stop...
        let (text, stopped) = run(
            StopMode::MultiLine,
            "\n",
            &[
                "if (x) {\n",
                "  a();\n",
                "\n",
                "  b();\n",
                "}\n",
                "\n",
                "next();\n",
            ],
        );
        assert!(stopped);
        assert_eq!(text, "if (x) {\n  a();\n\n  b();\n}");
    }

    #[test]
    fn multiline_blank_line_before_any_content_does_not_stop() {
        let (text, stopped) = run(
            StopMode::MultiLine,
            "",
            &["\n", "    return 1\n", "\n", "x"],
        );
        assert!(stopped);
        assert_eq!(text, "\n    return 1");
    }

    #[test]
    fn stops_when_duplicating_suffix_line() {
        let suffix = "\n}\n\nfn other() {}\n";
        let (text, stopped) = run(
            StopMode::MultiLine,
            suffix,
            &["    let y = x + 1;\n    y\n", "}\n", "fn more() {}\n"],
        );
        assert!(stopped);
        assert_eq!(text, "    let y = x + 1;\n    y");
    }

    #[test]
    fn duplicate_suffix_line_is_dropped_at_end_of_stream() {
        let (text, stopped) = run(StopMode::MultiLine, "\n  }\n", &["    y\n  }"]);
        assert!(!stopped);
        assert_eq!(text, "    y");
    }

    #[test]
    fn crlf_document_gets_crlf_output() {
        let mut t = Trimmer::new(StopMode::MultiLine, "\r\n}\r\n");
        assert_eq!(t.push("    a = 1\r\n"), None);
        assert_eq!(t.push("    b = 2\n"), None);
        assert_eq!(t.finish(), "    a = 1\r\n    b = 2");

        // Cursor at end of file: the engine supplies the line ending.
        let mut t = Trimmer::new(StopMode::MultiLine, "").with_crlf(true);
        t.push("x\ny\n");
        assert_eq!(t.finish(), "x\r\ny");
    }

    #[test]
    fn push_after_stop_returns_same_text() {
        let mut t = Trimmer::new(StopMode::SingleLine, "x");
        assert_eq!(t.push("ab\ncd"), Some("ab".to_owned()));
        assert_eq!(t.push("more"), Some("ab".to_owned()));
        assert_eq!(t.finish(), "ab");
    }
}
