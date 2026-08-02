use anyhow::{Context, Result};
use clap::Parser;
use demo_cosmetic_rewriter::{verify_demo_pair, VerifyOptions, WORKER_STACK_SIZE};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "demo-cosmetic-verifier")]
#[command(about = "Standalone two-parser verifier for rewritten CS2 demos")]
struct Cli {
    #[arg(long)]
    original: PathBuf,
    #[arg(long)]
    rewritten: PathBuf,
    #[arg(long)]
    config: PathBuf,
    #[arg(long)]
    demoparser2_python: PathBuf,
    #[arg(long)]
    expected_sha256: Option<String>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-verifier".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn 64MB verifier thread")?
        .join()
        .map_err(|_| anyhow::anyhow!("verifier thread panicked"))?
}

fn run(cli: Cli) -> Result<()> {
    let outcome = verify_demo_pair(VerifyOptions {
        original: cli.original,
        rewritten: cli.rewritten,
        config: cli.config,
        demoparser2_python: cli.demoparser2_python,
        expected_sha256: cli.expected_sha256,
    })?;
    println!("sha256={}", outcome.sha256);
    println!(
        "target_snapshots={} target_handles={} preserved_target_snapshots={} unchanged_non_target_knives={} unchanged_non_target_econ_snapshots={}",
        outcome.verification.target_snapshots,
        outcome.verification.target_entity_handles,
        outcome.verification.preserved_target_snapshots,
        outcome.verification.unchanged_non_target_knives,
        outcome.verification.unchanged_non_target_econ_snapshots
    );
    for (rule, count) in outcome.verification.rule_entity_counts {
        println!("rule[{rule}].entity_handles={count}");
    }
    println!("independent_parser={}", outcome.independent_parser);
    println!(
        "header_offsets=file_info:{} spawn_groups:{} eof:{}",
        outcome.layout.actual_file_info_offset,
        outcome.layout.actual_spawn_groups_offset,
        outcome.layout.file_len
    );
    Ok(())
}
