//! `localpilot-core bench`: completion latency on the real machine.
//!
//! Builds the index and engine the way `serve` does, opens one file into
//! the overlay, warms its snippet block and the model (one request, not
//! counted), then times `n` completions at line ends spread evenly through
//! the file with the completion cache off. Reported per request:
//!
//! - **core overhead**: request start → HTTP request to Ollama about to be sent;
//! - **TTFT**: request start → first streamed chunk;
//! - **total**: request start → result returned.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::completion::{CompletionEngine, CompletionTiming};
use crate::index::WorkspaceIndex;
use crate::ollama::{OllamaClient, OllamaState};
use crate::overlay::{DocumentStore, path_to_uri};
use crate::protocol::{CompletionRequestParams, Position};
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
    let path = root.join(&args.file);
    let text =
        std::fs::read_to_string(&path).map_err(|err| format!("file {}: {err}", path.display()))?;
    let positions = pick_line_ends(&text, args.n);
    if positions.is_empty() || args.n == 0 {
        return Err("no cursor positions: empty file or --n 0".to_owned());
    }
    let file_lines = line_lengths(&text).len();

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
    store
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .did_open(&uri, text.clone(), 1);
    let started = Instant::now();
    engine.refresh_snippets(&uri).await;
    let snippet_refresh_ms = ms(started.elapsed());

    // Warm-up at the end of the first line: loads the model, not counted.
    let warm_at = Position {
        line: 0,
        character: line_lengths(&text)[0],
    };
    let (_, timing) = complete(&engine, &uri, warm_at, "bench-warmup").await;
    let warmup = sample(&timing);
    if let Some(status) = engine.last_status()
        && status.state != OllamaState::Ok
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

    let mut samples = Vec::with_capacity(positions.len());
    let mut empty_suggestions = 0;
    for (i, &position) in positions.iter().enumerate() {
        let (empty, timing) = complete(&engine, &uri, position, &format!("bench-{i}")).await;
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
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            line.encode_utf16().count() as u32
        })
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
}
