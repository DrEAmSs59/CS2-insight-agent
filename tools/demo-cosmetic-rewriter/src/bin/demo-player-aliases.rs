// ---------------------------------------------------------------------------------------------
// Copyright (c) unicbm. All rights reserved.
// Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
// ---------------------------------------------------------------------------------------------

use anyhow::{Context, Result};
use clap::Parser;
use demo_cosmetic_rewriter::{player_aliases::rewrite_player_aliases, WORKER_STACK_SIZE};
use std::{collections::BTreeMap, fs, path::PathBuf};

#[derive(Parser)]
#[command(about = "Offline CS2 player display aliases; never changes Steam IDs")]
struct Cli {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    config: PathBuf,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    std::thread::Builder::new()
        .name("demo-player-aliases".into())
        .stack_size(WORKER_STACK_SIZE)
        .spawn(move || -> Result<()> {
            let aliases: BTreeMap<String, String> = serde_json::from_slice(&fs::read(cli.config)?)?;
            let report = rewrite_player_aliases(&cli.input, &cli.output, aliases)?;
            println!("{}", serde_json::to_string(&report)?);
            Ok(())
        })
        .context("failed to spawn alias rewrite worker")?
        .join()
        .map_err(|_| anyhow::anyhow!("alias rewrite worker panicked"))?
}
