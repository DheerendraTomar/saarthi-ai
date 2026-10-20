//! Completion cache with typed-prefix hits.
//!
//! Keys are `(uri, prefix, suffix)` as the engine sends them to the model
//! (already truncated to the prompt budgets, so entries stay small). When the
//! user types characters that match the start of a cached suggestion, the
//! rest of that suggestion is served without a model call.

use std::collections::VecDeque;

/// Default number of entries kept.
pub const DEFAULT_CAPACITY: usize = 256;

/// A cache hit: the text to suggest and the matched entry's prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheHit {
    pub text: String,
    pub entry_prefix: String,
}

#[derive(Debug, Clone)]
struct Entry {
    uri: String,
    prefix: String,
    suffix: String,
    completion: String,
}

/// Bounded LRU cache of completions. A linear scan serves both exact and
/// typed-prefix lookups; candidates are filtered by cheap length and
/// equality checks before any prefix comparison.
#[derive(Debug, Clone)]
pub struct CompletionCache {
    cap: usize,
    /// Least recently used first.
    entries: VecDeque<Entry>,
}

impl CompletionCache {
    pub fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            entries: VecDeque::new(),
        }
    }

    /// Exact hit, or a typed-prefix hit: an entry for `uri` with the same
    /// `suffix` whose prefix is a prefix of `prefix`, and whose completion
    /// starts with the text typed since; returns the rest of the completion.
    /// A hit that would leave nothing to suggest is a miss.
    pub fn get(&mut self, uri: &str, prefix: &str, suffix: &str) -> Option<String> {
        self.lookup(uri, prefix, suffix).map(|hit| hit.text)
    }

    /// Like [`get`](Self::get), also returning the prefix of the entry that
    /// matched (the key to [`remove`](Self::remove) it by).
    pub fn lookup(&mut self, uri: &str, prefix: &str, suffix: &str) -> Option<CacheHit> {
        let (index, remainder) = self
            .entries
            .iter()
            .enumerate()
            .rev()
            .find_map(|(i, e)| typed_remainder(e, uri, prefix, suffix).map(|rest| (i, rest)))?;
        let text = remainder.to_owned();
        let entry = self.entries.remove(index)?;
        let hit = CacheHit {
            text,
            entry_prefix: entry.prefix.clone(),
        };
        self.entries.push_back(entry);
        Some(hit)
    }

    /// Stores `completion` for the exact key, replacing any previous value.
    pub fn put(&mut self, uri: &str, prefix: &str, suffix: &str, completion: &str) {
        self.remove(uri, prefix, suffix);
        if self.entries.len() == self.cap {
            self.entries.pop_front();
        }
        self.entries.push_back(Entry {
            uri: uri.to_owned(),
            prefix: prefix.to_owned(),
            suffix: suffix.to_owned(),
            completion: completion.to_owned(),
        });
    }

    /// Drops the entry for the exact key, if any.
    pub fn remove(&mut self, uri: &str, prefix: &str, suffix: &str) {
        self.entries
            .retain(|e| !(e.uri == uri && e.prefix == prefix && e.suffix == suffix));
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// The part of `e.completion` still to suggest at `(uri, prefix, suffix)`.
fn typed_remainder<'e>(e: &'e Entry, uri: &str, prefix: &str, suffix: &str) -> Option<&'e str> {
    let typed_len = prefix.len().checked_sub(e.prefix.len())?;
    if typed_len != 0 && typed_len >= e.completion.len() {
        return None;
    }
    if e.uri != uri || e.suffix != suffix || !prefix.starts_with(e.prefix.as_str()) {
        return None;
    }
    let typed = &prefix[e.prefix.len()..];
    let rest = e.completion.strip_prefix(typed)?;
    (!rest.is_empty()).then_some(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_hit_returns_completion() {
        let mut c = CompletionCache::new(DEFAULT_CAPACITY);
        c.put("u", "foo", "\n", "bar()");
        assert_eq!(c.get("u", "foo", "\n").as_deref(), Some("bar()"));
        assert_eq!(c.get("v", "foo", "\n"), None);
    }

    #[test]
    fn cache_typed_prefix_hit_returns_remainder() {
        let mut c = CompletionCache::new(DEFAULT_CAPACITY);
        c.put("u", "foo", "\n", "bar()");
        assert_eq!(c.get("u", "foob", "\n").as_deref(), Some("ar()"));
        let hit = c.lookup("u", "foob", "\n").unwrap();
        assert_eq!(hit.entry_prefix, "foo");
        c.remove("u", &hit.entry_prefix, "\n");
        assert_eq!(c.get("u", "foob", "\n"), None);
        c.put("u", "foo", "\n", "bar()");
        assert_eq!(c.get("u", "fooba", "\n").as_deref(), Some("r()"));
        // Typed text that diverges from the suggestion is a miss.
        assert_eq!(c.get("u", "foox", "\n"), None);
        // Typing the whole suggestion leaves nothing to show.
        assert_eq!(c.get("u", "foobar()", "\n"), None);
    }

    #[test]
    fn cache_miss_when_suffix_differs() {
        let mut c = CompletionCache::new(DEFAULT_CAPACITY);
        c.put("u", "foo", "\n", "bar()");
        assert_eq!(c.get("u", "foo", ")\n"), None);
        assert_eq!(c.get("u", "foob", ")\n"), None);
    }

    #[test]
    fn evicts_least_recently_used() {
        let mut c = CompletionCache::new(2);
        c.put("u", "a", "", "1");
        c.put("u", "b", "", "2");
        assert!(c.get("u", "a", "").is_some()); // `b` is now oldest
        c.put("u", "c", "", "3");
        assert_eq!(c.len(), 2);
        assert_eq!(c.get("u", "b", ""), None);
        assert_eq!(c.get("u", "a", "").as_deref(), Some("1"));
        assert_eq!(c.get("u", "c", "").as_deref(), Some("3"));
    }

    #[test]
    fn put_replaces_and_remove_drops() {
        let mut c = CompletionCache::new(4);
        c.put("u", "a", "", "1");
        c.put("u", "a", "", "2");
        assert_eq!(c.len(), 1);
        assert_eq!(c.get("u", "a", "").as_deref(), Some("2"));
        c.remove("u", "a", "");
        assert!(c.is_empty());
    }

    #[test]
    fn typed_prefix_respects_char_boundaries() {
        let mut c = CompletionCache::new(4);
        c.put("u", "x = ", "", "\"héllo\"");
        assert_eq!(c.get("u", "x = \"h", "").as_deref(), Some("éllo\""));
        assert_eq!(c.get("u", "x = \"hé", "").as_deref(), Some("llo\""));
    }
}
