//! Fill-in-the-middle prompt assembly.
//!
//! The prompt is `snippet block + tail of prefix`; Ollama's template for the
//! FIM model puts it before the suffix, so as long as the snippet block is
//! byte-identical between requests, consecutive keystrokes share a prompt
//! prefix and Ollama's KV cache skips re-evaluating it.

use crate::index::related::Snippet;
use crate::index::symbols::Lang;
use crate::overlay::WindowBudget;
use crate::settings::Settings;
use crate::tokens;

/// Token budget for the text before the cursor.
pub const PREFIX_TOKENS: usize = 2048;
/// The prefix may grow this far past [`PREFIX_TOKENS`] before its start
/// moves (hysteresis, so typing does not shift the prompt start).
pub const PREFIX_SLACK_TOKENS: usize = 256;
/// Token budget for the text after the cursor.
pub const SUFFIX_TOKENS: usize = 512;

/// The window the engine asks the document store for.
pub const WINDOW_BUDGET: WindowBudget = WindowBudget {
    prefix_tokens: PREFIX_TOKENS,
    prefix_slack_tokens: PREFIX_SLACK_TOKENS,
    suffix_tokens: SUFFIX_TOKENS,
};

/// What is sent to `/api/generate` as `prompt` and `suffix`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FimPrompt {
    pub prompt: String,
    pub suffix: String,
}

/// Tokens left for related snippets once the largest prefix window and the
/// suffix are budgeted: `completion_context_tokens − (2048 + 256) − 512`
/// (768 by default), so the whole prompt stays within the context budget.
pub fn snippet_budget(settings: &Settings) -> usize {
    settings
        .completion_context_tokens
        .saturating_sub(PREFIX_TOKENS + PREFIX_SLACK_TOKENS + SUFFIX_TOKENS)
}

/// Line-comment token of `lang`, used for the snippets' `Path:` headers.
/// Unknown languages get `#`.
pub fn line_comment(lang: Lang) -> &'static str {
    match lang {
        Lang::JavaScript | Lang::TypeScript | Lang::Rust | Lang::Go | Lang::Java | Lang::Kotlin => {
            "//"
        }
        Lang::Python | Lang::Other => "#",
    }
}

/// Builds the FIM prompt for a document in language `lang`. `prompt` is the
/// snippet block — each snippet as `<comment> Path: <path>\n<text>\n\n`
/// with `lang`'s line comment, in the given order, stopping before a snippet
/// that would exceed [`snippet_budget`] — followed by the tail of `prefix`;
/// `suffix` is `take_first(suffix, 512)`.
///
/// A prefix within `PREFIX_TOKENS + PREFIX_SLACK_TOKENS` is kept whole (the
/// engine passes the store's stable, line-aligned window); a longer one is
/// cut back to `PREFIX_TOKENS` at a line boundary. The snippet block is a
/// pure function of `snippets`, `lang` and `settings`.
pub fn build(
    snippets: &[Snippet],
    prefix: &str,
    suffix: &str,
    lang: Lang,
    settings: &Settings,
) -> FimPrompt {
    let start = tokens::stable_tail_start(prefix, PREFIX_TOKENS, PREFIX_SLACK_TOKENS, Some(0));
    let prefix = &prefix[start..];
    let block = snippet_block(snippets, lang, snippet_budget(settings));
    let mut prompt = String::with_capacity(block.len() + prefix.len());
    prompt.push_str(&block);
    prompt.push_str(prefix);
    FimPrompt {
        prompt,
        suffix: tokens::take_first(suffix, SUFFIX_TOKENS).to_owned(),
    }
}

/// The snippet block alone, within `budget_tokens`.
pub fn snippet_block(snippets: &[Snippet], lang: Lang, budget_tokens: usize) -> String {
    let comment = line_comment(lang);
    let mut block = String::new();
    for snippet in snippets {
        let path = snippet.path.to_string_lossy().replace('\\', "/");
        let entry = format!("{comment} Path: {path}\n{}\n\n", snippet.text);
        if tokens::estimate(&block) + tokens::estimate(&entry) > budget_tokens {
            break;
        }
        block.push_str(&entry);
    }
    block
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn snippet(path: &str, text: &str) -> Snippet {
        Snippet {
            path: PathBuf::from(path),
            text: text.to_owned(),
        }
    }

    fn sample() -> Vec<Snippet> {
        vec![
            snippet("lib/util.py", "def helper():\n    return 1"),
            snippet("web/app.ts", "export function run() {}"),
        ]
    }

    #[test]
    fn prompt_prefix_is_byte_stable() {
        let settings = Settings::default();
        let a = build(&sample(), "x = helper(", ")\n", Lang::Python, &settings);
        let b = build(&sample(), "x = helper(", ")\n", Lang::Python, &settings);
        assert_eq!(a, b);
        let block = "# Path: lib/util.py\ndef helper():\n    return 1\n\n\
                     # Path: web/app.ts\nexport function run() {}\n\n";
        assert_eq!(a.prompt, format!("{block}x = helper("));
        assert_eq!(a.suffix, ")\n");

        // Only the prefix tail changes when the user types.
        let c = build(&sample(), "x = helper(a", ")\n", Lang::Python, &settings);
        assert!(c.prompt.starts_with(&a.prompt));
    }

    #[test]
    fn header_comment_follows_the_current_document_language() {
        let p = build(&sample(), "", "", Lang::Rust, &Settings::default());
        assert!(p.prompt.starts_with("// Path: lib/util.py\n"));
        assert!(p.prompt.contains("// Path: web/app.ts\n"));
    }

    #[test]
    fn long_prefix_is_cut_at_a_line_boundary_and_suffix_to_budget() {
        let settings = Settings::default();
        let line = format!("{}\n", "p".repeat(99));
        let prefix = line.repeat((PREFIX_TOKENS + PREFIX_SLACK_TOKENS) * 4 / 100 + 5);
        let suffix = "s".repeat(SUFFIX_TOKENS * 4 + 100);
        let p = build(&[], &prefix, &suffix, Lang::Python, &settings);
        assert!(p.prompt.len() <= PREFIX_TOKENS * 4);
        assert!(prefix.ends_with(&p.prompt));
        assert!(
            p.prompt.starts_with('p') && prefix[..prefix.len() - p.prompt.len()].ends_with('\n')
        );
        assert_eq!(p.suffix.len(), SUFFIX_TOKENS * 4);

        // A window within budget + slack is kept whole.
        let window = &prefix[prefix.len() - (PREFIX_TOKENS + 100) * 4..];
        assert_eq!(
            build(&[], window, "", Lang::Python, &settings).prompt,
            window
        );
    }

    #[test]
    fn snippet_block_respects_budget() {
        let big = snippet("a.py", &"x".repeat(4000));
        let small = snippet("b.py", "y");
        let block = snippet_block(&[big, small.clone()], Lang::Python, 100);
        assert_eq!(block, "");
        let block = snippet_block(&[small], Lang::Python, 100);
        assert_eq!(block, "# Path: b.py\ny\n\n");
        assert_eq!(snippet_budget(&Settings::default()), 768);
    }
}
