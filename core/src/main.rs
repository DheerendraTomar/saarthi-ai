use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use clap::{Parser, Subcommand};
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
    /// Measure completion latency against the configured Ollama.
    Bench,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            workspace,
            log_level,
        } => serve(&workspace, &log_level),
        Command::Bench => {
            eprintln!("not implemented");
            ExitCode::from(2)
        }
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
        RpcServer::new(input, tokio::io::stdout(), handler)
            .run()
            .await
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

/// Logs to `<workspace>/.localpilot/core.log` (appending), never to stdout.
fn init_logging(workspace: &Path, log_level: &str) -> Result<(), String> {
    let filter =
        EnvFilter::try_new(log_level).map_err(|err| format!("invalid --log-level: {err}"))?;
    let dir = workspace.join(".localpilot");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("cannot create {}: {err}", dir.display()))?;
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
