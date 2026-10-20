//! `localpilot-core bench`: completion latency on the real machine.
//!
//! Builds the index and engine the way `serve` does, opens one file into
//! the overlay, warms its snippet block and the model (one request, not
//! counted), then times `n` completions with the completion cache off:
//!
//! - `--mode spread` (default, the worst case): at line ends spread evenly
//!   through the file, so almost every prompt has a new prefix;
//! - `--mode typing` (the keystroke path): a new line is opened after the
//!   line nearest the file's middle and the following line of the file is
//!   typed into it one character per request, so consecutive prompts share
//!   a byte-stable prefix and Ollama can reuse its KV cache.
//!
//! Reported per request:
//!
//! - **core overhead**: request start → request body serialized, HTTP send starts;
//! - **TTFT**: request start → first streamed chunk;
//! - **total**: request start → result returned.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::completion::{CompletionEngine, CompletionTiming};
use crate::index::WorkspaceIndex;
use crate::ollama::{OllamaClient, OllamaState};
use crate::overlay::{DocumentStore, path_to_uri};
use crate::protocol::{CompletionRequestParams, ContentChange, Position, Range};
use crate::settings::Settings;

/// Targets from the plan's Global Constraints (milliseconds / megabytes).
pub const TTFT_P50_TARGET_MS: f64 = 250.0;
pub const TTFT_P95_TARGET_MS: f64 = 600.0;
pub const OVERHEAD_P95_TARGET_MS: f64 = 5.0;
pub const IDLE_RSS_TARGET_MB: f64 = 30.0;

/// Command-line options of `bench`.
#[derive(Debug, Clone)]
pub struct BenchArgs {
    pub workspace: PathBuf,
    /// File to complete in, relative to the workspace.
    pub file: String,
    pub n: usize,
    /// Completion model; the settings default if `None`.
    pub model: Option<String>,
    pub json: bool,
    pub mode: Mode,
}

/// Where the timed requests are made (see the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Line ends spread evenly through the file (fresh prefixes; worst case).
    #[default]
    Spread,
    /// One character typed per request at one spot (the keystroke path).
    Typing,
}

/// One timed request: first type `insert` (text at a position), if any,
/// then request a completion at `cursor`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub insert: Option<(Position, String)>,
    pub cursor: Position,
}

/// The edits and cursor positions of one bench run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Edit applied once after opening the document, before snippets warm.
    pub setup: Option<(Position, String)>,
    /// Cursor of the (uncounted) warm-up request.
    pub warmup: Position,
    pub steps: Vec<Step>,
    /// One line for the report.
    pub description: String,
}

/// p50 / p95 / max of one metric, in milliseconds.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// One request's timings in milliseconds (`None`: point not reached).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub overhead_ms: Option<f64>,
    pub ttft_ms: Option<f64>,
    pub total_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub target: String,
    pub value_ms_or_mb: Option<f64>,
    pub pass: bool,
}

/// Everything `bench` prints (the `--json` object).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchReport {
    pub workspace: String,
    pub file: String,
    pub file_lines: usize,
    pub model: String,
    pub ollama_url: String,
    pub mode: Mode,
    pub plan: String,
    pub n: usize,
    pub index_build_ms: f64,
    pub indexed_files: usize,
    pub snippet_refresh_ms: f64,
    pub warmup: Sample,
    /// Requests that produced a first chunk (the TTFT sample size).
    pub streamed: usize,
    /// Requests whose suggestion came back empty (trimmed or no output).
    pub empty_suggestions: usize,
    pub overhead: Option<Stats>,
    pub ttft: Option<Stats>,
    pub total: Option<Stats>,
    pub rss_before_mb: Option<f64>,
    pub rss_after_mb: Option<f64>,
    pub samples: Vec<Sample>,
    pub checks: Vec<Check>,
}

/// Runs the bench and prints the report; exit 0 if every target passes,
/// 1 if any fails, 2 if the bench could not run.
pub fn main(args: BenchArgs) -> ExitCode {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("localpilot-core bench: cannot start async runtime: {err}");
            return ExitCode::from(2);
        }
    };
    let json = args.json;
    match runtime.block_on(run(args)) {
        Ok(report) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).expect("report serializes")
                );
            } else {
                print!("{}", render(&report));
            }
            if report.checks.iter().all(|c| c.pass) {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        Err(err) => {
            eprintln!("localpilot-core bench: {err}");
            ExitCode::from(2)
        }
    }
}

/// Builds the subsystems, warms up, and times `args.n` completions.
pub async fn run(args: BenchArgs) -> Result<BenchReport, String> {
    let rss_before = rss_mb(std::process::id());
    let root = args
        .workspace
        .canonicalize()
        .map_err(|err| format!("workspace {}: {err}", args.workspace.display()))?;
    if Path::new(&args.file).is_absolute() {
        return Err(format!(
            "--file must be relative to the workspace, got {}",
            args.file
        ));
    }
    let path = root.join(&args.file);
    let text =
        std::fs::read_to_string(&path).map_err(|err| format!("file {}: {err}", path.display()))?;
    if args.n == 0 {
        return Err("--n must be at least 1".to_owned());
    }
    let file_lines = line_lengths(&text).len();
    let plan = match args.mode {
        Mode::Spread => {
            if file_lines < args.n {
                eprintln!(
                    "warning: {} has {file_lines} lines, fewer than --n {}; timing {file_lines} requests",
                    args.file, args.n
                );
            }
            spread_plan(&text, args.n)
        }
        Mode::Typing => typing_plan(&text, args.n)
            .ok_or_else(|| format!("{} has no non-blank line to type", args.file))?,
    };

    let mut settings = Settings::default();
    if let Some(model) = &args.model {
        settings.completion_model = model.clone();
    }

    let started = Instant::now();
    let index = WorkspaceIndex::build(&root);
    let index_build_ms = ms(started.elapsed());
    let indexed_files = index.files().len();

    let ollama = OllamaClient::new(settings.ollama_url.clone(), settings.keep_alive.clone());
    let store = Arc::new(RwLock::new(DocumentStore::new(root.clone())));
    let index = Arc::new(RwLock::new(index));
    let engine = CompletionEngine::new(ollama, store.clone(), index, settings.clone());
    engine.set_cache_enabled(false);

    let uri = path_to_uri(&path);
    let mut version = 1;
    let mut type_text = |at: Position, text: &str| {
        version += 1;
        let change = ContentChange {
            range: Some(Range { start: at, end: at }),
            text: text.to_owned(),
        };
        store
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .did_change(&uri, version, vec![change]);
    };
    store
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .did_open(&uri, text.clone(), 1);
    if let Some((at, text)) = &plan.setup {
        type_text(*at, text);
    }
    // As on didOpen in `serve`: computed before any request (so around the
    // top of the file) and awaited, so every timed prompt has the block.
    let started = Instant::now();
    engine.refresh_snippets(&uri).await;
    let snippet_refresh_ms = ms(started.elapsed());

    // Warm-up: loads the model, not counted.
    let (_, timing) = complete(&engine, &uri, plan.warmup, "bench-warmup").await;
    let warmup = sample(&timing);
    if let Some(status) = engine.last_status()
        && status.ollama != OllamaState::Ok
    {
        return Err(format!(
            "Ollama at {} is not usable: {}",
            settings.ollama_url, status.detail
        ));
    }
    if warmup.ttft_ms.is_none() {
        return Err(format!(
            "warm-up request streamed nothing from {} (model {})",
            settings.ollama_url, settings.completion_model
        ));
    }

    let mut samples = Vec::with_capacity(plan.steps.len());
    let mut empty_suggestions = 0;
    for (i, step) in plan.steps.iter().enumerate() {
        if let Some((at, text)) = &step.insert {
            type_text(*at, text);
        }
        let (empty, timing) = complete(&engine, &uri, step.cursor, &format!("bench-{i}")).await;
        if empty {
            empty_suggestions += 1;
        }
        samples.push(sample(&timing));
    }
    let rss_after = rss_mb(std::process::id());

    let overheads: Vec<f64> = samples.iter().filter_map(|s| s.overhead_ms).collect();
    let ttfts: Vec<f64> = samples.iter().filter_map(|s| s.ttft_ms).collect();
    let totals: Vec<f64> = samples.iter().map(|s| s.total_ms).collect();
    let overhead = stats(&overheads);
    let ttft = stats(&ttfts);
    let total = stats(&totals);

    let all_timed = ttfts.len() == samples.len();
    let check = |target: &str, value: Option<f64>, limit: f64, strict: bool| Check {
        target: target.to_owned(),
        value_ms_or_mb: value,
        pass: all_timed && value.is_some_and(|v| if strict { v < limit } else { v <= limit }),
    };
    let rss_check = Check {
        target: format!(
            "bench RSS after run <= {IDLE_RSS_TARGET_MB} MB (idle serve RSS is measured separately)"
        ),
        value_ms_or_mb: rss_after,
        pass: rss_after.is_some_and(|v| v <= IDLE_RSS_TARGET_MB),
    };
    let checks = vec![
        check(
            &format!("TTFT p50 <= {TTFT_P50_TARGET_MS} ms"),
            ttft.map(|s| s.p50_ms),
            TTFT_P50_TARGET_MS,
            false,
        ),
        check(
            &format!("TTFT p95 <= {TTFT_P95_TARGET_MS} ms"),
            ttft.map(|s| s.p95_ms),
            TTFT_P95_TARGET_MS,
            false,
        ),
        check(
            &format!("core overhead p95 < {OVERHEAD_P95_TARGET_MS} ms"),
            overhead.map(|s| s.p95_ms),
            OVERHEAD_P95_TARGET_MS,
            true,
        ),
        rss_check,
    ];

    Ok(BenchReport {
        workspace: root.display().to_string(),
        file: args.file,
        file_lines,
        model: settings.completion_model,
        ollama_url: settings.ollama_url,
        mode: args.mode,
        plan: plan.description,
        n: samples.len(),
        index_build_ms,
        indexed_files,
        snippet_refresh_ms,
        warmup,
        streamed: ttfts.len(),
        empty_suggestions,
        overhead,
        ttft,
        total,
        rss_before_mb: rss_before,
        rss_after_mb: rss_after,
        samples,
        checks,
    })
}

/// One timed completion; `true` if the suggestion was empty.
async fn complete(
    engine: &CompletionEngine,
    uri: &str,
    position: Position,
    request_id: &str,
) -> (bool, CompletionTiming) {
    let params = CompletionRequestParams {
        uri: uri.to_owned(),
        position,
        request_id: request_id.to_owned(),
    };
    let (result, timing) = engine.request_timed(params, CancellationToken::new()).await;
    let empty = result.map_or(true, |r| r.items.is_empty());
    (empty, timing)
}

fn sample(t: &CompletionTiming) -> Sample {
    let since = |at: Option<Instant>| at.map(|at| ms(at.saturating_duration_since(t.started_at)));
    Sample {
        overhead_ms: since(t.prepared_at),
        ttft_ms: since(t.first_token_at),
        total_ms: ms(t.done_at.saturating_duration_since(t.started_at)),
    }
}

fn stats(values: &[f64]) -> Option<Stats> {
    Some(Stats {
        p50_ms: percentile(values, 50.0)?,
        p95_ms: percentile(values, 95.0)?,
        max_ms: values.iter().copied().fold(f64::NAN, f64::max),
    })
}

/// The `p`-th percentile (0–100) with linear interpolation between closest
/// ranks (numpy's default); `None` for no values.
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = (p.clamp(0.0, 100.0) / 100.0) * (sorted.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    Some(sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo as f64))
}

/// UTF-16 length of each line (terminators `\n` / `\r\n` excluded); a
/// trailing newline does not start an extra line.
fn line_lengths(text: &str) -> Vec<u32> {
    let body = text.strip_suffix('\n').unwrap_or(text);
    body.split('\n')
        .map(|line| utf16_len(line.strip_suffix('\r').unwrap_or(line)))
        .collect()
}

/// `n` cursor positions at line ends, spread evenly through the file (the
/// centre of each of `n` equal bands of lines). Distinct; at most one per
/// line, so fewer than `n` if the file is shorter.
pub fn pick_line_ends(text: &str, n: usize) -> Vec<Position> {
    let lengths = line_lengths(text);
    let lines = lengths.len();
    let n = n.min(lines);
    (0..n)
        .map(|k| {
            let line = (2 * k + 1) * lines / (2 * n);
            Position {
                line: line as u32,
                character: lengths[line],
            }
        })
        .collect()
}

/// `--mode spread`: [`pick_line_ends`]; warm-up at the end of line 0.
pub fn spread_plan(text: &str, n: usize) -> Plan {
    let steps: Vec<Step> = pick_line_ends(text, n)
        .into_iter()
        .map(|cursor| Step {
            insert: None,
            cursor,
        })
        .collect();
    Plan {
        setup: None,
        warmup: Position {
            line: 0,
            character: line_lengths(text)[0],
        },
        description: format!("{} line ends spread through the file", steps.len()),
        steps,
    }
}

/// `--mode typing`: opens a new line after the line nearest the middle of
/// the file (setup: newline + the indentation of the next non-blank line),
/// then types that next non-blank line's text one character per step,
/// cycling if `n` is longer. The warm-up is at the start of the new line.
/// `None` if the file has no non-blank line.
pub fn typing_plan(text: &str, n: usize) -> Option<Plan> {
    let body = text.strip_suffix('\n').unwrap_or(text);
    let lines: Vec<&str> = body
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let start = lines.len() / 2;
    let non_blank = |l: &&&str| !l.trim().is_empty();
    let source = lines[start + 1..]
        .iter()
        .find(non_blank)
        .or_else(|| lines[..=start].iter().rev().find(non_blank))?;
    let indent = &source[..source.len() - source.trim_start().len()];
    let typed: Vec<char> = source.trim().chars().collect();
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let setup_at = Position {
        line: start as u32,
        character: utf16_len(lines[start]),
    };
    let mut cursor = Position {
        line: start as u32 + 1,
        character: utf16_len(indent),
    };
    let warmup = cursor;
    let steps = (0..n)
        .map(|k| {
            let c = typed[k % typed.len()];
            let at = cursor;
            cursor.character += c.len_utf16() as u32;
            Step {
                insert: Some((at, c.to_string())),
                cursor,
            }
        })
        .collect();
    Some(Plan {
        setup: Some((setup_at, format!("{newline}{indent}"))),
        warmup,
        steps,
        description: format!(
            "typing {:?} on a new line after line {} (1 char per request)",
            source.trim(),
            start + 1
        ),
    })
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// Resident set size of `pid` in MB, via `ps` (macOS has no `/proc`).
pub fn rss_mb(pid: u32) -> Option<f64> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let kb: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(kb / 1024.0)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// The human-readable table.
pub fn render(r: &BenchReport) -> String {
    let opt = |v: Option<f64>, unit: &str| v.map_or("n/a".to_owned(), |v| format!("{v:.1} {unit}"));
    let row = |name: &str, s: Option<Stats>| match s {
        Some(s) => format!(
            "{name:<16}{:>10.2}{:>10.2}{:>10.2}\n",
            s.p50_ms, s.p95_ms, s.max_ms
        ),
        None => format!("{name:<16}{:>10}{:>10}{:>10}\n", "n/a", "n/a", "n/a"),
    };
    let mut out = String::new();
    out += "LocalPilot core bench\n";
    out += &format!("  workspace     {}\n", r.workspace);
    out += &format!("  file          {} ({} lines)\n", r.file, r.file_lines);
    out += &format!("  model         {} @ {}\n", r.model, r.ollama_url);
    out += &format!(
        "  mode          {} ({})\n",
        match r.mode {
            Mode::Spread => "spread",
            Mode::Typing => "typing",
        },
        r.plan
    );
    out += &format!(
        "  requests      {} (cache off; 1 warm-up not counted); streamed {}, empty suggestions {}\n",
        r.n, r.streamed, r.empty_suggestions
    );
    out += &format!(
        "  index build   {:.1} ms ({} files)\n",
        r.index_build_ms, r.indexed_files
    );
    out += &format!(
        "  snippets      {:.1} ms (warmed before timing)\n",
        r.snippet_refresh_ms
    );
    out += &format!(
        "  warm-up       overhead {}, TTFT {}, total {:.1} ms\n",
        opt(r.warmup.overhead_ms, "ms"),
        opt(r.warmup.ttft_ms, "ms"),
        r.warmup.total_ms
    );
    out += &format!(
        "  RSS           before {}, after {}\n\n",
        opt(r.rss_before_mb, "MB"),
        opt(r.rss_after_mb, "MB")
    );
    out += &format!(
        "{:<16}{:>10}{:>10}{:>10}\n",
        "metric (ms)", "p50", "p95", "max"
    );
    out += &row("core overhead", r.overhead);
    out += &row("TTFT", r.ttft);
    out += &row("total", r.total);
    out += "\n";
    for c in &r.checks {
        out += &format!(
            "{}  {} (measured {})\n",
            if c.pass { "PASS" } else { "FAIL" },
            c.target,
            c.value_ms_or_mb
                .map_or("n/a".to_owned(), |v| format!("{v:.2}"))
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_of_one_value_is_that_value() {
        assert_eq!(percentile(&[7.0], 50.0), Some(7.0));
        assert_eq!(percentile(&[7.0], 95.0), Some(7.0));
    }

    #[test]
    fn percentile_of_nothing_is_none() {
        assert_eq!(percentile(&[], 50.0), None);
    }

    #[test]
    fn percentile_odd_count_median_is_middle() {
        assert_eq!(percentile(&[5.0, 1.0, 3.0], 50.0), Some(3.0));
    }

    #[test]
    fn percentile_even_count_interpolates() {
        assert_eq!(percentile(&[4.0, 1.0, 3.0, 2.0], 50.0), Some(2.5));
        // 20 values 1..=20: rank 0.95 * 19 = 18.05 → 19 + 0.05.
        let v: Vec<f64> = (1..=20).map(f64::from).collect();
        let p95 = percentile(&v, 95.0).unwrap();
        assert!((p95 - 19.05).abs() < 1e-9, "{p95}");
        assert_eq!(percentile(&v, 0.0), Some(1.0));
        assert_eq!(percentile(&v, 100.0), Some(20.0));
    }

    #[test]
    fn picks_n_distinct_line_ends() {
        let text: String = (0..100).map(|i| format!("line {i} é\r\n")).collect();
        let picks = pick_line_ends(&text, 20);
        assert_eq!(picks.len(), 20);
        let mut lines: Vec<u32> = picks.iter().map(|p| p.line).collect();
        lines.dedup();
        assert_eq!(lines.len(), 20, "distinct and ascending: {picks:?}");
        assert!(lines.windows(2).all(|w| w[0] < w[1]));
        for p in &picks {
            let expected = format!("line {} é", p.line).encode_utf16().count() as u32;
            assert_eq!(p.character, expected, "at line end: {p:?}");
        }
        // Spread through the file: first in the first band, last in the last.
        assert!(lines[0] < 5 && lines[19] >= 95, "{lines:?}");
    }

    #[test]
    fn picks_at_most_one_per_line() {
        let picks = pick_line_ends("a\nbb\nccc", 10);
        assert_eq!(
            picks,
            vec![
                Position {
                    line: 0,
                    character: 1
                },
                Position {
                    line: 1,
                    character: 2
                },
                Position {
                    line: 2,
                    character: 3
                },
            ]
        );
        assert!(pick_line_ends("", 5).len() <= 1);
    }

    /// Applies `(position, text)` insertions the way the overlay does
    /// (single-line positions, ASCII test text).
    fn apply(text: &str, at: Position, insert: &str) -> String {
        let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
        let line = &mut lines[at.line as usize];
        line.insert_str(at.character as usize, insert);
        lines.join("\n")
    }

    #[test]
    fn typing_plan_types_the_next_line_one_char_per_step() {
        let text = "a = 1\nb = 2\n\n    call(x)\nz = 0\n";
        // 5 lines → start at line 2 (blank); next non-blank is line 3.
        let plan = typing_plan(text, 9).unwrap();
        let (setup_at, setup) = plan.setup.clone().unwrap();
        assert_eq!(
            setup_at,
            Position {
                line: 2,
                character: 0
            }
        );
        assert_eq!(setup, "\n    ");
        assert_eq!(
            plan.warmup,
            Position {
                line: 3,
                character: 4
            }
        );
        assert_eq!(plan.steps.len(), 9);

        let mut doc = apply(text, setup_at, &setup);
        let mut expected_cursor = plan.warmup;
        for step in &plan.steps {
            let (at, c) = step.insert.clone().expect("typing step inserts");
            assert_eq!(at, expected_cursor, "types at the previous cursor");
            doc = apply(&doc, at, &c);
            expected_cursor.character += 1;
            assert_eq!(step.cursor, expected_cursor, "cursor advances by one");
        }
        // "call(x)" is 7 chars; 9 steps cycle back to its start.
        assert_eq!(doc.split('\n').nth(3), Some("    call(x)ca"));
        assert!(plan.description.contains("call(x)"));
    }

    #[test]
    fn typing_plan_uses_crlf_and_needs_a_non_blank_line() {
        let plan = typing_plan("x\r\ny\r\n", 1).unwrap();
        assert_eq!(plan.setup.unwrap().1, "\r\n");
        assert!(typing_plan("\n  \n\n", 3).is_none());
    }

    #[test]
    fn spread_plan_does_not_edit() {
        let plan = spread_plan("ab\ncd\nef\n", 2);
        assert!(plan.setup.is_none());
        assert!(plan.steps.iter().all(|s| s.insert.is_none()));
        assert_eq!(
            plan.warmup,
            Position {
                line: 0,
                character: 2
            }
        );
    }

    #[tokio::test]
    async fn rejects_absolute_file() {
        let dir = tempfile::tempdir().unwrap();
        let err = run(BenchArgs {
            workspace: dir.path().to_owned(),
            file: "/etc/hosts".to_owned(),
            n: 1,
            model: None,
            json: false,
            mode: Mode::Spread,
        })
        .await
        .unwrap_err();
        assert!(err.contains("relative"), "{err}");
    }
}
