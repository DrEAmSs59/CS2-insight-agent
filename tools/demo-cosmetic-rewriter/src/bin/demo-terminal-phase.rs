use anyhow::{Context, Result};
use clap::Parser;
use demo_cosmetic_rewriter::{terminal_phase::repair_terminal_phase, WORKER_STACK_SIZE};
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "Offline verified suppression of the CS2 rules-state terminal phase")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
}
fn main() -> Result<()> {
    let args = Cli::parse();
    std::thread::Builder::new()
        .name("demo-terminal-phase".into())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || -> Result<()> {
            let report = repair_terminal_phase(&args.input, &args.output)?;
            println!("{}", serde_json::to_string(&report)?);
            Ok(())
        })
        .context("failed to start terminal-phase worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("terminal-phase worker panicked"))?
}
