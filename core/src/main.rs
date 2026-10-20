use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

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
        #[arg(long)]
        workspace: PathBuf,
    },
    /// Measure completion latency against the configured Ollama.
    Bench,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve { .. } | Command::Bench => {
            eprintln!("not implemented");
            ExitCode::from(2)
        }
    }
}
