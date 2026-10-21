//! Adaptive completion policy: learned suggestion length and style examples.
//!
//! Inputs are the outcome log's in-memory learning view
//! ([`FeedbackLog::recent`](super::feedback::FeedbackLog::recent)); nothing
//! here does I/O. The engine computes a [`Learned`] and the examples block
//! only when a uri's snippet block is refreshed, never per keystroke.

use crate::index::symbols::Lang;
use crate::tokens;

use super::feedback::{CONTEXT_TAIL_CHARS, Outcome, Record};
use super::prompt;

/// Outcomes per language the policy looks at (the newest ones).
pub const WINDOW: usize = 50;
/// Fewer eligible outcomes than this: the configured values are used.
pub const MIN_OUTCOMES: usize = 10;
/// A length bucket needs this many served suggestions to be chosen.
pub const MIN_BUCKET_SAMPLES: usize = 3;
/// Lower bound of a learned `num_predict` (never 0 tokens).
pub const MIN_NUM_PREDICT: u32 = 16;
/// Upper bound of a learned multi-line cap.
pub const MAX_LINES: u32 = 8;
/// Headroom over the longest accepted text of the chosen bucket.
const NUM_PREDICT_HEADROOM: f64 = 1.5;
/// Style examples per language.
pub const MAX_EXAMPLES: usize = 3;
/// Token budget of all style examples together.
pub const EXAMPLES_TOKENS: usize = 300;
/// An example's suggestion has at least this many lines.
pub const EXAMPLE_MIN_LINES: u32 = 2;

/// The user's settings the policy starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Configured {
    /// `completionMaxTokens`.
    pub max_tokens: u32,
    /// The multi-line cap of the stop rules (8).
    pub max_lines: u32,
}

/// The limits in effect for one language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Learned {
    /// Multi-line cap, in `[1, 8]`.
    pub max_lines: u32,
    /// `num_predict`, in `[16, 2 × completionMaxTokens]`.
    pub num_predict: u32,
}

impl Configured {
    /// The configured values unchanged.
    pub fn as_learned(self) -> Learned {
        Learned {
            max_lines: self.max_lines,
            num_predict: self.max_tokens,
        }
    }
}

/// Length buckets by suggestion lines: `1`, `2–4`, `5–8` (longer counts as
/// `5–8`), with the cap each one stands for.
const BUCKETS: [(u32, u32); 3] = [(1, 1), (2, 4), (5, 8)];

pub struct Policy;

impl Policy {
    /// The learned limits for `lang` from `outcomes` (any order of
    /// languages; oldest first). See the README's "Adaptive completions".
    ///
    /// 1. Take the newest [`WINDOW`] records of `lang`, then drop those
    ///    served with `maxLines == 1` (single-line mode, or while a learned
    ///    cap of 1 was in effect): they say nothing about multi-line caps.
    /// 2. Fewer than [`MIN_OUTCOMES`] left: the configured values.
    /// 3. Bucket by suggestion lines (`1`, `2–4`, `5–8`; longer → `5–8`) and
    ///    score each bucket with ≥ [`MIN_BUCKET_SAMPLES`] records by accepted
    ///    characters per served suggestion (`accepted`: the suggestion,
    ///    `partial`: `acceptedText`, `rejected`/`typedThrough`: 0). The best
    ///    score wins, ties go to the shorter bucket; if no score is above 0
    ///    the shortest bucket wins (mostly rejections → 1 line).
    /// 4. `maxLines` = the bucket's upper bound; `numPredict` = 1.5 × the
    ///    longest accepted text of the bucket in tokens (16 if none), bounded
    ///    to `[16, 2 × completionMaxTokens]` (16 wins if that is empty).
    pub fn from_outcomes(lang: Lang, outcomes: &[Record], configured: Configured) -> Learned {
        let name = lang.as_str();
        let of_lang: Vec<&Record> = outcomes.iter().filter(|r| r.lang == name).collect();
        let window = &of_lang[of_lang.len().saturating_sub(WINDOW)..];
        let eligible: Vec<&Record> = window
            .iter()
            .copied()
            .filter(|r| r.max_lines != Some(1))
            .collect();
        if eligible.len() < MIN_OUTCOMES {
            return configured.as_learned();
        }

        // (served, accepted chars, longest accepted text in tokens)
        let mut stats = [(0usize, 0usize, 0usize); BUCKETS.len()];
        for r in &eligible {
            let at = BUCKETS
                .iter()
                .position(|&(lo, hi)| (lo..=hi).contains(&r.lines))
                .unwrap_or(BUCKETS.len() - 1);
            let accepted = accepted_text(r);
            let s = &mut stats[at];
            s.0 += 1;
            s.1 += accepted.chars().count();
            s.2 = s.2.max(tokens::estimate(accepted));
        }
        let mut best: Option<(usize, f64)> = None;
        for (at, &(served, chars, _)) in stats.iter().enumerate() {
            if served < MIN_BUCKET_SAMPLES {
                continue;
            }
            #[allow(clippy::cast_precision_loss)]
            let score = chars as f64 / served as f64;
            if best.is_none_or(|(_, b)| score > b) {
                best = Some((at, score));
            }
        }
        let Some((at, score)) = best else {
            return configured.as_learned();
        };
        let at = if score > 0.0 { at } else { 0 };

        let ceiling = configured.max_tokens.saturating_mul(2).max(MIN_NUM_PREDICT);
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let wanted = (stats[at].2 as f64 * NUM_PREDICT_HEADROOM).ceil() as u32;
        Learned {
            max_lines: BUCKETS[at].1.clamp(1, MAX_LINES),
            num_predict: wanted.clamp(MIN_NUM_PREDICT, ceiling),
        }
    }
}

/// One style example: a recently accepted multi-line suggestion and the
/// text right before the cursor when it was served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Example {
    pub context_tail: String,
    pub suggestion: String,
}

/// Up to [`MAX_EXAMPLES`] of the most recent `accepted` records of `lang`
/// whose suggestion has ≥ 2 lines, newest first, as long as their rendered
/// block stays within `budget_tokens`.
///
/// An example that does not fit is skipped and older ones are still tried,
/// so the result is the newest set that fits, not merely a prefix.
pub fn examples(lang: Lang, outcomes: &[Record], budget_tokens: usize) -> Vec<Example> {
    let name = lang.as_str();
    let comment = prompt::line_comment(lang);
    let mut picked = Vec::new();
    let mut used = 0;
    for r in outcomes.iter().rev() {
        if picked.len() == MAX_EXAMPLES {
            break;
        }
        if r.lang != name || r.outcome != Outcome::Accepted || r.lines < EXAMPLE_MIN_LINES {
            continue;
        }
        let example = Example {
            context_tail: whole_lines(&r.context_tail).to_owned(),
            suggestion: r.suggestion.clone(),
        };
        let cost = tokens::estimate(&render_one(comment, &example));
        if used + cost <= budget_tokens {
            used += cost;
            picked.push(example);
        }
    }
    picked
}

/// `tail` from its first line start: a tail cut at the full
/// [`CONTEXT_TAIL_CHARS`] most likely begins mid-line, so it starts after
/// its first `\n` (if it has one); a shorter tail is the start of the file.
fn whole_lines(tail: &str) -> &str {
    if tail.chars().count() < CONTEXT_TAIL_CHARS {
        return tail;
    }
    tail.find('\n').map_or(tail, |i| &tail[i + 1..])
}

/// The text the user kept: the whole suggestion if `accepted`, the
/// `acceptedText` if `partial`, nothing otherwise.
fn accepted_text(r: &Record) -> &str {
    match r.outcome {
        Outcome::Accepted => &r.suggestion,
        Outcome::Partial => r.accepted_text.as_deref().unwrap_or(""),
        Outcome::Rejected | Outcome::TypedThrough => "",
    }
}

/// The examples as they go into the snippet block:
/// `<comment> Example\n<contextTail><suggestion>\n\n` each — the
/// suggestion continues the tail, exactly as it did in the file.
pub fn render_examples(lang: Lang, examples: &[Example]) -> String {
    let comment = prompt::line_comment(lang);
    examples
        .iter()
        .map(|e| render_one(comment, e))
        .collect::<String>()
}

fn render_one(comment: &str, e: &Example) -> String {
    format!("{comment} Example\n{}{}\n\n", e.context_tail, e.suggestion)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONF: Configured = Configured {
        max_tokens: 32,
        max_lines: 8,
    };

    fn rec(lang: &str, suggestion: &str, outcome: Outcome) -> Record {
        Record {
            ts: 1,
            request_id: "r".to_owned(),
            lang: lang.to_owned(),
            ext: None,
            prompt_hash: "0".repeat(16),
            context_tail: "def f(x):\n    ".to_owned(),
            suggestion: suggestion.to_owned(),
            lines: super::super::feedback::line_count(suggestion),
            outcome,
            accepted_text: None,
            ttft_ms: None,
            total_ms: 1,
            model: None,
            max_lines: Some(8),
            num_predict: Some(32),
        }
    }

    fn lines(n: usize, width: usize) -> String {
        (0..n)
            .map(|i| format!("    v{i} = {}", "x".repeat(width)))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn fewer_than_10_outcomes_uses_configured() {
        let long = lines(6, 20);
        let few: Vec<Record> = (0..9)
            .map(|_| rec("python", &long, Outcome::Rejected))
            .collect();
        assert_eq!(
            Policy::from_outcomes(Lang::Python, &few, CONF),
            CONF.as_learned()
        );
        // Other languages and single-line-mode records do not count.
        let mut mixed = few.clone();
        mixed.extend((0..20).map(|_| rec("rust", &long, Outcome::Rejected)));
        mixed.extend((0..20).map(|_| {
            let mut r = rec("python", "x)", Outcome::Rejected);
            r.max_lines = Some(1);
            r
        }));
        assert_eq!(
            Policy::from_outcomes(Lang::Python, &mixed, CONF),
            CONF.as_learned()
        );
        // Only the newest 50 records are looked at: 9 eligible among them.
        let mut old = vec![rec("python", &long, Outcome::Accepted); 30];
        old.extend(mixed.iter().filter(|r| r.lang == "python").cloned());
        old.extend((0..21).map(|_| {
            let mut r = rec("python", "x)", Outcome::Accepted);
            r.max_lines = Some(1);
            r
        }));
        assert_eq!(
            Policy::from_outcomes(Lang::Python, &old, CONF),
            CONF.as_learned()
        );
    }

    #[test]
    fn mostly_rejected_long_suggestions_shortens_cap() {
        // Long suggestions are always rejected, one-liners often accepted.
        let long = lines(6, 30);
        let mut outcomes: Vec<Record> = (0..30)
            .map(|_| rec("python", &long, Outcome::Rejected))
            .collect();
        outcomes.extend((0..10).map(|i| {
            let o = if i % 2 == 0 {
                Outcome::Accepted
            } else {
                Outcome::Rejected
            };
            rec("python", "return x * 2", o)
        }));
        let learned = Policy::from_outcomes(Lang::Python, &outcomes, CONF);
        assert_eq!(learned.max_lines, 1);
        assert!(learned.num_predict >= MIN_NUM_PREDICT);
        assert!(learned.num_predict <= 2 * CONF.max_tokens);

        // Everything rejected: the shortest bucket, never 0 tokens.
        let all: Vec<Record> = (0..50)
            .map(|i| rec("python", &lines(1 + i % 8, 10), Outcome::Rejected))
            .collect();
        assert_eq!(
            Policy::from_outcomes(Lang::Python, &all, CONF),
            Learned {
                max_lines: 1,
                num_predict: MIN_NUM_PREDICT
            }
        );
        // typedThrough is not accepted text either.
        let typed: Vec<Record> = (0..20)
            .map(|_| rec("python", &long, Outcome::TypedThrough))
            .collect();
        assert_eq!(
            Policy::from_outcomes(Lang::Python, &typed, CONF).max_lines,
            1
        );
        // Tiny configured budgets still never go below the floor.
        let tiny = Configured {
            max_tokens: 4,
            max_lines: 8,
        };
        let learned = Policy::from_outcomes(Lang::Python, &outcomes, tiny);
        assert!(learned.num_predict >= MIN_NUM_PREDICT && learned.max_lines >= 1);
    }

    #[test]
    fn accepted_long_suggestions_raise_cap_within_bounds() {
        // A 2–4 line habit: cap 4.
        let mid = lines(3, 8);
        let mut outcomes: Vec<Record> = (0..12)
            .map(|_| rec("python", &mid, Outcome::Accepted))
            .collect();
        outcomes.extend((0..12).map(|_| rec("python", "x", Outcome::Rejected)));
        let learned = Policy::from_outcomes(Lang::Python, &outcomes, CONF);
        assert_eq!(learned.max_lines, 4);

        // Long suggestions accepted (generated up to the 32-token limit):
        // the cap stays 8 and num_predict grows past the configured value.
        let long = lines(6, 4); // ~6 lines of ~16 chars ≈ 25 tokens
        let near_limit: String = lines(8, 9); // ≈ 36 tokens
        let mut outcomes: Vec<Record> = (0..15)
            .map(|_| rec("python", &long, Outcome::Accepted))
            .collect();
        outcomes.push(rec("python", &near_limit, Outcome::Accepted));
        outcomes.extend((0..10).map(|_| rec("python", "x", Outcome::Rejected)));
        let learned = Policy::from_outcomes(Lang::Python, &outcomes, CONF);
        assert_eq!(learned.max_lines, 8);
        assert!(
            CONF.max_tokens < learned.num_predict && learned.num_predict <= 2 * CONF.max_tokens,
            "{learned:?}"
        );

        // Huge accepted texts clamp to exactly 2 × completionMaxTokens; a
        // partial accept counts only its accepted text.
        let huge = lines(8, 400);
        let mut outcomes: Vec<Record> = (0..20)
            .map(|_| rec("python", &huge, Outcome::Accepted))
            .collect();
        outcomes.extend((0..10).map(|_| {
            let mut r = rec("python", &huge, Outcome::Partial);
            r.accepted_text = Some("    v0".to_owned());
            r
        }));
        let learned = Policy::from_outcomes(Lang::Python, &outcomes, CONF);
        assert_eq!(
            learned,
            Learned {
                max_lines: 8,
                num_predict: 2 * CONF.max_tokens
            }
        );
        // More than 8 lines counts as the 5–8 bucket; never above 8.
        let over = lines(12, 4);
        let outcomes: Vec<Record> = (0..20)
            .map(|_| rec("python", &over, Outcome::Accepted))
            .collect();
        assert_eq!(
            Policy::from_outcomes(Lang::Python, &outcomes, CONF).max_lines,
            8
        );

        // Short accepted texts shrink num_predict, but not below 16.
        let outcomes: Vec<Record> = (0..20)
            .map(|_| rec("python", "a\nb", Outcome::Accepted))
            .collect();
        assert_eq!(
            Policy::from_outcomes(Lang::Python, &outcomes, CONF),
            Learned {
                max_lines: 4,
                num_predict: MIN_NUM_PREDICT
            }
        );
    }

    #[test]
    fn examples_are_recent_accepted_same_language_within_budget() {
        let ex = |s: &str| rec("python", s, Outcome::Accepted);
        let outcomes = vec![
            ex("old1\nold1"),
            ex("old2\nold2"),
            rec("python", "one line", Outcome::Accepted),
            ex("new1\nnew1"),
            rec("rust", "rust\nrust", Outcome::Accepted),
            rec("python", "rej\nrej", Outcome::Rejected),
            rec("python", "part\npart", Outcome::Partial),
            ex("new2\nnew2"),
            ex("new3\nnew3"),
        ];
        let got = examples(Lang::Python, &outcomes, EXAMPLES_TOKENS);
        let texts: Vec<&str> = got.iter().map(|e| e.suggestion.as_str()).collect();
        assert_eq!(texts, ["new3\nnew3", "new2\nnew2", "new1\nnew1"]);
        assert_eq!(got[0].context_tail, "def f(x):\n    ");

        let block = render_examples(Lang::Python, &got);
        // The suggestion continues the tail: no line break between them.
        assert!(block.starts_with("# Example\ndef f(x):\n    new3\nnew3\n\n"));
        let rust = render_examples(Lang::Rust, &examples(Lang::Rust, &outcomes, 300));
        assert_eq!(rust, "// Example\ndef f(x):\n    rust\nrust\n\n");

        // A full-length tail starts after its first line break (no
        // mid-line fragment); a shorter one is kept whole.
        let mut cut = ex("a\nb");
        cut.context_tail = format!("{}\ndef g():\n    ", "z".repeat(CONTEXT_TAIL_CHARS - 14));
        assert_eq!(cut.context_tail.chars().count(), CONTEXT_TAIL_CHARS);
        let got = examples(Lang::Python, &[cut], EXAMPLES_TOKENS);
        assert_eq!(got[0].context_tail, "def g():\n    ");
        let mut short = ex("a\nb");
        short.context_tail = "x = 1\ny = ".to_owned();
        assert_eq!(
            examples(Lang::Python, &[short], 300)[0].context_tail,
            "x = 1\ny = "
        );

        // Within the budget: a too-large newest example is skipped, the
        // rest still fit; the whole block never exceeds the budget.
        let big = ex(&lines(8, 200));
        let mut with_big = outcomes.clone();
        with_big.push(big);
        let got = examples(Lang::Python, &with_big, EXAMPLES_TOKENS);
        assert!(tokens::estimate(&render_examples(Lang::Python, &got)) <= EXAMPLES_TOKENS);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].suggestion, "new3\nnew3");
        let many: Vec<Record> = (0..10).map(|_| ex(&lines(4, 120))).collect();
        let got = examples(Lang::Python, &many, EXAMPLES_TOKENS);
        assert!(!got.is_empty() && got.len() < 3);
        assert!(tokens::estimate(&render_examples(Lang::Python, &got)) <= EXAMPLES_TOKENS);
        assert!(examples(Lang::Python, &many, 0).is_empty());
    }
}
