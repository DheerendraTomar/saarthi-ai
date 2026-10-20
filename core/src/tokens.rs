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
}
