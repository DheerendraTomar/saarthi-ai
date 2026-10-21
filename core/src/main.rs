use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use clap::{Parser, Subcommand};
use localpilot_core::agent::session;
use localpilot_core::bench::{self, BenchArgs, Mode};
use localpilot_core::handlers::AppHandler;
use localpilot_core::rpc::RpcServer;
use tokio::io::{AsyncRead, BufReader, ReadBuf};
use tokio::sync::oneshot;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "localpilot-core", version, about = "LocalPilot sidecar")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve JSON-RPC over stdio for one workspace.
    Serve {
        /// Workspace root; logs go to `<workspace>/.localpilot/core.log`.
        #[arg(long)]
        workspace: PathBuf,
        /// Log filter: a level (`error`, `warn`, `info`, `debug`, `trace`)
        /// or a `tracing` directive such as `localpilot_core=debug`.
        #[arg(long, default_value = "info")]
        log_level: String,
    },
    /// Measure completion latency against the local Ollama.
    Bench {
        /// Workspace root to index.
        #[arg(long)]
        workspace: PathBuf,
        /// File to complete in, relative to the workspace.
        #[arg(long)]
        file: String,
        /// Number of timed completions (after one warm-up request).
        #[arg(long, default_value_t = 20)]
        n: usize,
        /// Completion model (default: the settings default).
        #[arg(long)]
        model: Option<String>,
        /// Completion max tokens (`num_predict`; default: the settings default).
        #[arg(long)]
        max_tokens: Option<u32>,
        /// Print the report as one JSON object.
        #[arg(long)]
        json: bool,
        /// `spread`: line ends across the file (fresh prompts, worst case);
        /// `typing`: one character typed per request at one spot.
        #[arg(long, value_enum, default_value_t = Mode::Spread)]
        mode: Mode,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            workspace,
            log_level,
        } => serve(&workspace, &log_level),
        Command::Bench {
            workspace,
            file,
            n,
            model,
            max_tokens,
            json,
            mode,
        } => bench::main(BenchArgs {
            workspace,
            file,
            n,
            model,
            max_tokens,
            json,
            mode,
        }),
    }
}

/// Serves until `shutdown` or stdin EOF, then exits the process. Stdout is
/// the protocol channel: nothing else is ever written to it.
fn serve(workspace: &Path, log_level: &str) -> ExitCode {
    if let Err(err) = init_logging(workspace, log_level) {
        eprintln!("localpilot-core: {err}");
        return ExitCode::from(2);
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("panic: {info}");
        default_hook(info);
    }));
    tracing::info!(workspace = %workspace.display(), version = env!("CARGO_PKG_VERSION"), "serve starting");

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("localpilot-core: cannot start async runtime: {err}");
            return ExitCode::from(2);
        }
    };
    let outcome = runtime.block_on(async {
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let handler = Arc::new(AppHandler::new(shutdown_tx));
        let input = BufReader::new(UntilShutdown {
            inner: tokio::io::stdin(),
            stop: Some(shutdown_rx),
            stopped: false,
        });
        let served = RpcServer::new(input, tokio::io::stdout(), handler.clone())
            .run()
            .await;
        // Also on stdin EOF without `shutdown`: no pending outcome is lost.
        handler.flush_completion_log().await;
        served
    });
    let code = match outcome {
        Ok(()) => {
            tracing::info!("serve finished");
            0
        }
        Err(err) => {
            tracing::error!("serve failed: {err:#}");
            1
        }
    };
    // Exit directly: dropping the runtime would wait for the blocking thread
    // still parked in a stdin read.
    std::process::exit(code);
}

/// Logs to `<workspace>/.localpilot/core.log` (appending), never to stdout,
/// creating `.localpilot/.gitignore` with it.
fn init_logging(workspace: &Path, log_level: &str) -> Result<(), String> {
    let filter =
        EnvFilter::try_new(log_level).map_err(|err| format!("invalid --log-level: {err}"))?;
    // The canonical root, like the index: the log lands in the same place
    // however the workspace path is spelled.
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let dir = session::ensure_state_dir(&workspace).map_err(|err| {
        format!(
            "cannot create {}: {err}",
            workspace.join(".localpilot").display()
        )
    })?;
    let path = dir.join("core.log");
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("cannot open {}: {err}", path.display()))?;
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(Mutex::new(file))
        .with_ansi(false)
        .try_init()
        .map_err(|err| format!("cannot install logger: {err}"))
}

/// Reads `inner` until `stop` fires, then reports EOF. Ending the input this
/// way lets the RPC server shut down in order: in-flight requests (including
/// `shutdown` itself) finish and every queued response is flushed.
struct UntilShutdown<R> {
    inner: R,
    stop: Option<oneshot::Receiver<()>>,
    stopped: bool,
}

impl<R: AsyncRead + Unpin> AsyncRead for UntilShutdown<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = &mut *self;
        if let Some(stop) = &mut this.stop {
            match Pin::new(stop).poll(cx) {
                Poll::Ready(fired) => {
                    // A dropped sender means shutdown can no longer fire.
                    this.stopped = fired.is_ok();
                    this.stop = None;
                }
                Poll::Pending => {}
            }
        }
        if this.stopped {
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}
