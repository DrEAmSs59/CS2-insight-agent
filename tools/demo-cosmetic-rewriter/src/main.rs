use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use demo_cosmetic_rewriter::header::validate_demo_layout;
use demo_cosmetic_rewriter::{
    rewrite_demo_atomically, verify_demo_pair, RewriteOptions, VerifyOptions, WORKER_STACK_SIZE,
};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "demo-cosmetic-rewriter")]
#[command(about = "Offline, identity-scoped CS2 demo cosmetic rewriter")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Rewrite an input demo into a new, atomically promoted output file.
    Rewrite {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        config: PathBuf,
        /// Exact Python executable that has demoparser2 installed.
        #[arg(long)]
        demoparser2_python: Option<PathBuf>,
        /// Explicitly skip the independent demoparser2 compatibility gate.
        #[arg(long, conflicts_with = "demoparser2_python")]
        skip_independent_parser: bool,
        /// Run the slower full before/after source2 snapshot comparison.
        #[arg(long)]
        deep_verify: bool,
    },
    /// Compare an original and rewritten demo with both parsers.
    Verify {
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
    },
    /// Validate frame boundaries and the two outer-header offsets.
    CheckHeader {
        #[arg(long)]
        input: PathBuf,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-cosmetic-worker".to_owned())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || run(cli))
        .context("failed to spawn 64MB demo worker thread")?
        .join()
        .map_err(|_| anyhow::anyhow!("demo worker thread panicked"))?
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Rewrite {
            input,
            output,
            config,
            demoparser2_python,
            skip_independent_parser,
            deep_verify,
        } => {
            let outcome = rewrite_demo_atomically(RewriteOptions {
                input,
                output,
                config,
                demoparser2_python,
                skip_independent_parser,
                deep_verify,
            })?;
            println!("output={}", outcome.output.display());
            println!("sha256={}", outcome.sha256);
            println!(
                "existing_fields={} materialized_fields={}",
                outcome.replacement.total_fields_written,
                outcome
                    .materialization
                    .as_ref()
                    .map_or(0, |report| report.fields_materialized),
            );
            if let Some(verification) = &outcome.verification {
                print_verification(verification);
            }
            println!("independent_parser={}", outcome.independent_parser);
            println!(
                "header_offsets=file_info:{} spawn_groups:{} eof:{}",
                outcome.layout.actual_file_info_offset,
                outcome.layout.actual_spawn_groups_offset,
                outcome.layout.file_len
            );
        }
        Command::Verify {
            original,
            rewritten,
            config,
            demoparser2_python,
            expected_sha256,
        } => {
            let outcome = verify_demo_pair(VerifyOptions {
                original,
                rewritten,
                config,
                demoparser2_python,
                expected_sha256,
            })?;
            println!("sha256={}", outcome.sha256);
            print_verification(&outcome.verification);
            println!("independent_parser={}", outcome.independent_parser);
            println!(
                "header_offsets=file_info:{} spawn_groups:{} eof:{}",
                outcome.layout.actual_file_info_offset,
                outcome.layout.actual_spawn_groups_offset,
                outcome.layout.file_len
            );
        }
        Command::CheckHeader { input } => {
            let layout = validate_demo_layout(&input)?;
            println!(
                "ok file_info={} spawn_groups={} eof={} patch={:?} map={:?}",
                layout.actual_file_info_offset,
                layout.actual_spawn_groups_offset,
                layout.file_len,
                layout.metadata.patch_version,
                layout.metadata.map_name
            );
        }
    }
    Ok(())
}

fn print_verification(summary: &demo_cosmetic_rewriter::verify::VerificationSummary) {
    println!(
        "verified_target_snapshots={} target_handles={} preserved_target_snapshots={} unchanged_non_target_knives={} unchanged_non_target_econ_snapshots={}",
        summary.target_snapshots,
        summary.target_entity_handles,
        summary.preserved_target_snapshots,
        summary.unchanged_non_target_knives,
        summary.unchanged_non_target_econ_snapshots
    );
    for (rule, count) in &summary.rule_entity_counts {
        println!("rule[{rule}].entity_handles={count}");
    }
}
