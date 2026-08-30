use anyhow::{Context as AnyhowContext, Result};
use clap::Parser as ClapParser;
use demo_cosmetic_rewriter::input_command::extract_input_report;
use std::fs::{self, File};
use std::path::PathBuf;

const WORKER_STACK_SIZE: usize = 64 * 1024 * 1024;

#[derive(Debug, ClapParser)]
#[command(name = "demo-input-hud-track")]
#[command(about = "Extract exact CS2 button states, subticks, weapon selections, and HUD tracks")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    /// Include every raw button update and subtick move in the JSON report.
    #[arg(long)]
    include_evidence: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-input-track-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn input-track worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("input-track worker panicked"))?
}

fn run(cli: Cli) -> Result<()> {
    let report = extract_input_report(&cli.input, cli.include_evidence)?;
    if let Some(parent) = cli
        .output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let output = File::create(&cli.output)
        .with_context(|| format!("failed to create {}", cli.output.display()))?;
    serde_json::to_writer_pretty(output, &report)
        .with_context(|| format!("failed to write {}", cli.output.display()))?;

    println!("report={}", cli.output.display());
    println!("elapsed_seconds={:.3}", report.elapsed_seconds);
    println!(
        "commands={} button_updates={} subtick_steps={} weaponselect_requests={} decode_errors={}",
        report.commands,
        report.button_updates,
        report.subtick_steps,
        report.weaponselect_requests.len(),
        report.decode_errors,
    );
    println!(
        "tracks={} changes={} observed_mask={}",
        report.tracks.len(),
        report
            .tracks
            .iter()
            .map(|track| track.changes)
            .sum::<usize>(),
        report.observed_mask_hex,
    );
    println!(
        "mouse_updates={} mouse_nonzero_commands={} mouse_tracks={} mouse_samples={}",
        report.mouse_updates,
        report.mouse_nonzero_commands,
        report.mouse_tracks.len(),
        report
            .mouse_tracks
            .iter()
            .map(|track| track.samples)
            .sum::<usize>(),
    );
    Ok(())
}
