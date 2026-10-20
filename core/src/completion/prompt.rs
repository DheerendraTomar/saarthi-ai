//! Fill-in-the-middle prompt assembly.
//!
//! The prompt is `snippet block + tail of prefix`; Ollama's template for the
//! FIM model puts it before the suffix, so as long as the snippet block is
//! byte-identical between requests, consecutive keystrokes share a prompt
//! prefix and Ollama's KV cache skips re-evaluating it.

use crate::index::related::Snippet;
use crate::index::symbols::Lang;
use crate::settings::Settings;
use crate::tokens;

/// Token budget for the text before the cursor.
pub const PREFIX_TOKENS: usize = 2048;
/// Token budget for the text after the cursor.
pub const SUFFIX_TOKENS: usize = 512;

/// What is sent to `/api/generate` as `prompt` and `suffix`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FimPrompt {
    pub prompt: String,
    pub suffix: String,
}

/// Tokens left for related snippets once prefix and suffix are budgeted:
/// `completion_context_tokens − 2048 − 512` (1024 by default).
pub fn snippet_budget(settings: &Settings) -> usize {
    settings
        .completion_context_tokens
        .saturating_sub(PREFIX_TOKENS + SUFFIX_TOKENS)
}

/// Line-comment token used for the `Path:` header of a snippet in `lang`.
/// Unknown languages get `#`.
pub fn line_comment(lang: Lang) -> &'static str {
    match lang {
        Lang::JavaScript | Lang::TypeScript | Lang::Rust | Lang::Go | Lang::Java | Lang::Kotlin => {
            "//"
        }
        Lang::Python | Lang::Other => "#",
    }
}

/// Builds the FIM prompt. `prompt` is the snippet block — each snippet as
/// `<comment> Path: <path>\n<text>\n\n`, in the given order, stopping before
/// a snippet that would exceed [`snippet_budget`] — followed by
/// `take_last(prefix, 2048)`; `suffix` is `take_first(suffix, 512)`.
/// The snippet block is a pure function of `snippets` and `settings`.
pub fn build(snippets: &[Snippet], prefix: &str, suffix: &str, settings: &Settings) -> FimPrompt {
    let prefix = tokens::take_last(prefix, PREFIX_TOKENS);
    let block = snippet_block(snippets, snippet_budget(settings));
    let mut prompt = String::with_capacity(block.len() + prefix.len());
    prompt.push_str(&block);
    prompt.push_str(prefix);
    FimPrompt {
        prompt,
        suffix: tokens::take_first(suffix, SUFFIX_TOKENS).to_owned(),
    }
}

/// The snippet block alone, within `budget_tokens`.
pub fn snippet_block(snippets: &[Snippet], budget_tokens: usize) -> String {
    let mut block = String::new();
    for snippet in snippets {
        let comment = line_comment(Lang::from_path(&snippet.path));
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
        let a = build(&sample(), "x = helper(", ")\n", &settings);
        let b = build(&sample(), "x = helper(", ")\n", &settings);
        assert_eq!(a, b);
        let block = "# Path: lib/util.py\ndef helper():\n    return 1\n\n\
                     // Path: web/app.ts\nexport function run() {}\n\n";
        assert_eq!(a.prompt, format!("{block}x = helper("));
        assert_eq!(a.suffix, ")\n");

        // Only the prefix tail changes when the user types.
        let c = build(&sample(), "x = helper(a", ")\n", &settings);
        assert!(c.prompt.starts_with(&a.prompt));
    }

    #[test]
    fn prefix_and_suffix_are_truncated_to_budgets() {
        let settings = Settings::default();
        let prefix = "p".repeat(PREFIX_TOKENS * 4 + 100);
        let suffix = "s".repeat(SUFFIX_TOKENS * 4 + 100);
        let p = build(&[], &prefix, &suffix, &settings);
        assert_eq!(p.prompt.len(), PREFIX_TOKENS * 4);
        assert_eq!(p.suffix.len(), SUFFIX_TOKENS * 4);
    }

    #[test]
    fn snippet_block_respects_budget() {
        let big = snippet("a.py", &"x".repeat(4000));
        let small = snippet("b.py", "y");
        let block = snippet_block(&[big, small.clone()], 100);
        assert_eq!(block, "");
        let block = snippet_block(&[small], 100);
        assert_eq!(block, "# Path: b.py\ny\n\n");
        assert_eq!(snippet_budget(&Settings::default()), 1024);
    }
}
