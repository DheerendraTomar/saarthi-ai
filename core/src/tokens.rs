//! Cheap token estimation and budget-based truncation.
//!
//! One token is approximated as 4 bytes of UTF-8. Truncation always cuts on a
//! `char` boundary, so the returned slice may be slightly under budget but is
//! never over it and never panics on multibyte text.

/// Estimated token count: `ceil(bytes / 4)`.
pub fn estimate(text: &str) -> usize {
    text.len().div_ceil(4)
}

/// The longest suffix of `text` that fits in `max_tokens`.
pub fn take_last(text: &str, max_tokens: usize) -> &str {
    let budget = max_tokens.saturating_mul(4);
    if text.len() <= budget {
        return text;
    }
    let mut start = text.len() - budget;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// The longest prefix of `text` that fits in `max_tokens`.
pub fn take_first(text: &str, max_tokens: usize) -> &str {
    let budget = max_tokens.saturating_mul(4);
    if text.len() <= budget {
        return text;
    }
    let mut end = budget;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Start offset of a cache-stable tail of `text` (the text before a cursor).
///
/// `prev` (a start returned earlier for the same document) is kept while it
/// is still a line start in `text` and the tail from it fits in
/// `budget_tokens + slack_tokens`, so typing does not move the start. Else
/// the tail is cut back to at most `budget_tokens`, starting at a line
/// boundary (or, for a single line longer than the budget, at a char
/// boundary). Texts within `budget_tokens` always start at 0.
pub fn stable_tail_start(
    text: &str,
    budget_tokens: usize,
    slack_tokens: usize,
    prev: Option<usize>,
) -> usize {
    let budget = budget_tokens.saturating_mul(4);
    if text.len() <= budget {
        return 0;
    }
    let limit = budget.saturating_add(slack_tokens.saturating_mul(4));
    if let Some(prev) = prev
        && prev <= text.len()
        && text.len() - prev <= limit
        && (prev == 0 || text.as_bytes()[prev - 1] == b'\n')
    {
        return prev;
    }
    // First line start at or after `text.len() - budget` (>= 1 here).
    let min = text.len() - budget;
    match text.as_bytes()[min - 1..].iter().position(|&b| b == b'\n') {
        Some(i) => min + i,
        None => text.len() - take_last(text, budget_tokens).len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_is_ceil_bytes_over_four() {
        assert_eq!(estimate(""), 0);
        assert_eq!(estimate("a"), 1);
        assert_eq!(estimate("abcd"), 1);
        assert_eq!(estimate("abcde"), 2);
        assert_eq!(estimate("é"), 1); // 2 bytes
    }

    #[test]
    fn take_last_respects_char_boundaries() {
        let text = "héllo wörld";
        for budget in 0..=estimate(text) + 1 {
            let tail = take_last(text, budget);
            assert!(text.ends_with(tail), "budget {budget}: {tail:?}");
            assert!(tail.len() <= budget * 4);
        }
        assert_eq!(take_last(text, 100), text);
        assert_eq!(take_last(text, 0), "");
        // 4-byte budget on "wörld" tail: last 4 bytes are "rld" + 1 byte of nothing
        // split; the cut must move forward past the multibyte char.
        assert_eq!(take_last("wörld", 1), "rld");
    }

    #[test]
    fn take_first_respects_char_boundaries() {
        let text = "héllo wörld";
        for budget in 0..=estimate(text) + 1 {
            let head = take_first(text, budget);
            assert!(text.starts_with(head), "budget {budget}: {head:?}");
            assert!(head.len() <= budget * 4);
        }
        assert_eq!(take_first(text, 100), text);
        assert_eq!(take_first(text, 0), "");
        assert_eq!(take_first("abcé", 1), "abc");
    }

    #[test]
    fn emoji_never_panics() {
        let text = "🦀🦀🦀x🦀";
        for budget in 0..=10 {
            assert!(text.ends_with(take_last(text, budget)));
            assert!(text.starts_with(take_first(text, budget)));
        }
    }

    #[test]
    fn stable_tail_start_is_line_aligned_with_hysteresis() {
        let line = "x".repeat(9) + "\n"; // 10 bytes per line
        let text = line.repeat(10); // 100 bytes
        // Within budget: whole text.
        assert_eq!(stable_tail_start(&text, 25, 5, None), 0);
        // Over budget (40 bytes): cut back below it at a line start.
        let start = stable_tail_start(&text, 10, 5, None);
        assert_eq!(start, 60);
        assert!(text.len() - start <= 40);
        // Typing keeps the start until the tail outgrows budget + slack.
        let mut typed = text.clone();
        for _ in 0..20 {
            typed.push('y');
            assert_eq!(stable_tail_start(&typed, 10, 5, Some(start)), start);
        }
        typed.push('y'); // 61 bytes from `start` > 60
        let moved = stable_tail_start(&typed, 10, 5, Some(start));
        assert!(moved > start && typed.len() - moved <= 40);
        assert_eq!(&typed[moved - 1..moved], "\n");
        // A stale start that is no longer a line start is recomputed.
        assert_eq!(stable_tail_start(&text, 10, 5, Some(61)), 60);
        assert_eq!(stable_tail_start(&text, 10, 5, Some(999)), 60);
    }

    #[test]
    fn stable_tail_start_on_one_long_line_respects_char_boundaries() {
        let text = "é".repeat(50); // 100 bytes, no newline
        let start = stable_tail_start(&text, 10, 5, None);
        assert!(text.is_char_boundary(start));
        assert!(text.len() - start <= 40);
    }
}
